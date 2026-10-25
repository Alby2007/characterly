import type { Sql } from "./db.js";
import type { MemoryStore } from "./database.js";
import { FatalJobError, type Job } from "./jobs.js";
import { inc } from "./metrics.js";
import type { CompanionTurnDeps, CompanionTurnOpts } from "./companion-turn.js";
import type { MessageEvent } from "./types.js";

// ── Web turns (v73) ─────────────────────────────────────────────────────────
// A browser send lands as two rows (the user's message + a pending companion
// placeholder) plus a web-turn job. This handler resolves the conversation →
// adoption → companion → account → scope, then runs the shared turn pipeline
// with DB callbacks: sendPersona writes the reply onto the placeholder,
// sendSystem appends a system row. Live interaction — deliberately NOT inside
// runAsBackground: the charge draws on the live hosted reserve.

export type WebTurnPayload = {
  userMessageId?: number;
  companionMessageId?: number;
};

export type WebTurnDeps = {
  sql: Sql;
  store: Pick<MemoryStore, "getCompanionById" | "listingById" | "trackEvent">;
  runTurn: (opts: CompanionTurnOpts) => Promise<void>;
};

type WebMessageRow = {
  role: string; status: string; conversation_id: number;
  web_profile_id: string; scope: string; adoption_id: number | null;
  companion_id: number | null; archived_at: string | Date | null;
  plan: string | null; discord_user_id: string | null; display_name: string | null;
};

export async function runWebTurnJob(_guildId: string, job: Job, deps: WebTurnDeps): Promise<void> {
  const p = job.payload as WebTurnPayload | undefined;
  const companionMessageId = Number(p?.companionMessageId);
  if (!Number.isFinite(companionMessageId) || companionMessageId <= 0) {
    throw new FatalJobError("malformed web-turn payload");
  }
  const rows = await deps.sql<Array<WebMessageRow>>`
    SELECT m.role, m.status, m.conversation_id,
           c.web_profile_id, c.scope, c.adoption_id, c.companion_id, c.archived_at,
           wp.plan, wp.discord_user_id, wp.display_name
    FROM public.web_messages m
    JOIN public.web_conversations c ON c.id = m.conversation_id
    LEFT JOIN public.web_profiles wp ON wp.id = c.web_profile_id
    WHERE m.id = ${companionMessageId}
  `;
  const row = rows[0];
  if (!row || row.role !== "companion") {
    throw new FatalJobError(`web-turn target missing: ${companionMessageId}`);
  }
  // Retries after a landed send (or a deliberately failed one) no-op — the
  // placeholder is the delivery receipt, not the job row.
  if (row.status === "done" || row.status === "failed") return;

  const fail = async (reason: string): Promise<void> => {
    await deps.sql`
      UPDATE public.web_messages SET status = 'failed', fail_reason = ${reason}
      WHERE id = ${companionMessageId} AND status <> 'done'
    `;
  };

  if (row.archived_at) return fail("archived");
  const adRows = await deps.sql<Array<{ dropped_at: string | Date | null }>>`
    SELECT dropped_at FROM public.companion_adoptions WHERE id = ${row.adoption_id ?? -1}
  `;
  const adoption = adRows[0];
  if (!adoption || adoption.dropped_at) return fail("no_companion");
  const companion = row.companion_id != null
    ? await deps.store.getCompanionById(Number(row.companion_id)).catch(() => null)
    : null;
  if (!companion) return fail("no_companion");
  // A banned listing freezes its clones — same gate as the Discord lanes.
  if (companion.adoptedFromListingId) {
    const listing = await deps.store.listingById(companion.adoptedFromListingId).catch(() => null);
    if (listing?.status === "banned") return fail("banned");
  }
  await deps.sql`UPDATE public.web_messages SET status = 'generating' WHERE id = ${companionMessageId} AND status = 'pending'`;

  // The triggering user text — prefer the paired id; fall back to the latest
  // user row before the placeholder (older payload shapes).
  let userMessageId = Number(p?.userMessageId) || 0;
  let userText = "";
  if (userMessageId) {
    const u = await deps.sql<Array<{ content: string }>>`
      SELECT content FROM public.web_messages WHERE id = ${userMessageId} AND role = 'user'`;
    userText = u[0]?.content ?? "";
  } else {
    const u = await deps.sql<Array<{ id: number; content: string }>>`
      SELECT id, content FROM public.web_messages
      WHERE conversation_id = ${row.conversation_id} AND role = 'user' AND id < ${companionMessageId}
      ORDER BY id DESC LIMIT 1`;
    userMessageId = Number(u[0]?.id ?? 0);
    userText = u[0]?.content ?? "";
  }
  if (!userText) return fail("no_trigger");

  const ownerId = row.discord_user_id ?? `web:${row.web_profile_id}`;
  const channelId = `webconv:${row.conversation_id}`;
  const event: MessageEvent = {
    guildId: row.scope,
    channelId,
    messageId: `webmsg:${userMessageId}`,
    authorId: ownerId,
    authorName: (row.display_name ?? "").trim() || "you",
    content: userText,
    createdAt: new Date(),
    mentionsBot: false,
  };

  await deps.runTurn({
    scope: row.scope,
    userId: ownerId,
    channel: { id: channelId },
    companion,
    event,
    images: [],
    account: row.plan ? { plan: row.plan } : null,
    charge: { cost: 2, reason: "web_turn", refundReason: "web_turn_refund", payerAccountId: row.web_profile_id },
    sendPersona: async text => {
      // status guard: if this turn outlived the claim lease and a retry
      // already delivered (or failed) the placeholder, this instance loses
      // the race — returning null makes the turn take the refund path.
      const done = await deps.sql`
        UPDATE public.web_messages SET content = ${text}, status = 'done'
        WHERE id = ${companionMessageId} AND status = 'generating' RETURNING id
      `;
      if (done.length) {
        await deps.sql`
          UPDATE public.web_conversations SET last_activity_at = now() WHERE id = ${row.conversation_id}
        `;
      }
      return done.length ? { id: `webmsg:${companionMessageId}`, createdAt: new Date() } : null;
    },
    sendSystem: async o => {
      // Payloads without a content string (e.g. the Discord api-key CV2 card)
      // have no web rendering — write a generic notice rather than dropping
      // the failure silently.
      const raw = typeof o?.content === "string" ? o.content.trim() : "";
      const content = raw || "Something went wrong on our side — please try sending again.";
      await deps.sql`
        INSERT INTO public.web_messages (conversation_id, role, content, status)
        VALUES (${row.conversation_id}, 'system', ${content}, 'done')
      `;
    },
  });

  // The turn handles its own billing/refunds — but a blocked, empty, or
  // errored turn leaves the placeholder spinning. Flip it so the client can
  // show a definitive state instead of a permanent pending bubble.
  await deps.sql`
    UPDATE public.web_messages SET status = 'failed', fail_reason = 'no_reply'
    WHERE id = ${companionMessageId} AND status = 'generating'
  `;
  void deps.store.trackEvent(row.discord_user_id, "web_turn", row.scope).catch(() => {});
  inc("web_turn.done");
}
