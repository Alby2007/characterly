import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import type postgres from "postgres";
import { MessageFlags, type MessageContextMenuCommandInteraction } from "discord.js";
import { makeTestSql, makeStore } from "./test-helpers.js";
import { MemoryStore } from "./database.js";
import { resolveRegenTarget } from "./regen.js";
import type { Companion } from "./types.js";

// ── Regenerate — resolution + store helpers ─────────────────────────────────
// The context-menu dispatch and orchestration live in index.ts (untestable —
// it boots the client), so the load-bearing logic sits in regen.ts and gets
// covered here end-to-end against the real archive.

const BOT = "bot-1";

function stubCtx(opts: {
  userId?: string;
  guildId?: string | null;
  channelId?: string;
  targetId?: string;
  targetAuthorId?: string;
  webhookId?: string | null;
  components?: unknown[];
  embeds?: unknown[];
  flags?: number;
}): MessageContextMenuCommandInteraction {
  return {
    user: { id: opts.userId ?? "u1" },
    guildId: opts.guildId === undefined ? null : opts.guildId,
    channelId: opts.channelId ?? "c-dm",
    client: { user: { id: BOT } },
    targetMessage: {
      id: opts.targetId ?? "m-reply",
      author: { id: opts.targetAuthorId ?? BOT, bot: true },
      webhookId: opts.webhookId ?? null,
      components: opts.components ?? [],
      embeds: opts.embeds ?? [],
      flags: { has: (f: number) => Boolean((opts.flags ?? 0) & f) },
    },
  } as unknown as MessageContextMenuCommandInteraction;
}

async function insertCompanion(sql: ReturnType<typeof postgres>, opts: {
  owner: string; name?: string; state?: string; kind?: string; listingId?: number;
}): Promise<number> {
  const [row] = await sql`
    INSERT INTO companions (owner_user_id, name, onboarding_state, kind, adopted_from_listing_id)
    VALUES (${opts.owner}, ${opts.name ?? "Nyx"}, ${opts.state ?? "active"}, ${opts.kind ?? "awakened"}, ${opts.listingId ?? null})
    RETURNING id
  `;
  return Number(row.id);
}

/** Archive a human trigger + companion reply as the turn pipeline would. */
async function archiveExchange(store: MemoryStore, scope: string, channelId: string, opts: {
  authorId: string; compSubj: string;
  triggerId?: string; replyId?: string;
  extra?: Array<{ id: string; authorId: string; content?: string; at: string }>;
}) {
  const triggerId = opts.triggerId ?? "m-trig";
  if (triggerId) {
    await store.recordMessage({
      guildId: scope, channelId, messageId: triggerId,
      authorId: opts.authorId, authorName: "User", content: "hello there",
      createdAt: new Date("2026-01-01T00:00:00Z"), mentionsBot: false,
    });
  }
  await store.recordMessage({
    guildId: scope, channelId, messageId: opts.replyId ?? "m-reply",
    authorId: opts.compSubj, authorName: "Nyx", content: "the original take",
    createdAt: new Date("2026-01-01T00:00:10Z"), mentionsBot: false,
  }, triggerId || undefined, false, true);
  for (const m of opts.extra ?? []) {
    await store.recordMessage({
      guildId: scope, channelId, messageId: m.id,
      authorId: m.authorId, authorName: "User", content: m.content ?? "follow-up",
      createdAt: new Date(m.at), mentionsBot: false,
    });
  }
}

test("resolveRegenTarget: DM lane resolves the tail exchange", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const compId = await insertCompanion(sql, { owner: "u1" });
    const scope = "dm:u1";
    const compSubj = MemoryStore.companionSubjectId(compId);
    await archiveExchange(store, scope, "c-dm", { authorId: "u1", compSubj });

    const res = await resolveRegenTarget(stubCtx({ userId: "u1" }), store);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.target.lane, "dm");
    assert.equal(res.target.scope, "dm:u1");
    assert.equal(res.target.companion.id, compId);
    assert.equal(res.target.targetMessageId, "m-reply");
    assert.equal(res.target.targetContent, "the original take");
    assert.equal(res.target.trigger.messageId, "m-trig");
    assert.equal(res.target.trigger.authorId, "u1");
    assert.equal(res.target.trigger.content, "hello there");
  } finally { await sql.end(); }
});

test("resolveRegenTarget: adoptee thread resolves to the adopter's dm scope", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const [listing] = await sql`INSERT INTO companion_listings (creator_user_id, name, status) VALUES ('u-creator', 'Listed', 'active') RETURNING id`;
    const cloneId = await insertCompanion(sql, { owner: "u-adopter", kind: "adopted", listingId: Number(listing.id) });
    await sql`INSERT INTO companion_adoptions (user_id, listing_id, companion_id, chat_thread_id)
              VALUES ('u-adopter', ${listing.id}, ${cloneId}, 't-adoptee')`;
    const compSubj = MemoryStore.companionSubjectId(cloneId);
    await archiveExchange(store, "dm:u-adopter", "t-adoptee", { authorId: "u-adopter", compSubj });

    // Invoked in a guild — the thread lane is resolved by channel, not guild.
    const res = await resolveRegenTarget(
      stubCtx({ userId: "u-adopter", guildId: "g1", channelId: "t-adoptee", webhookId: "wh-1" }), store);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.target.lane, "adoptee");
    assert.equal(res.target.scope, "dm:u-adopter");
    assert.equal(res.target.companion.id, cloneId);
    assert.equal(res.target.trigger.messageId, "m-trig");
  } finally { await sql.end(); }
});

test("resolveRegenTarget: refusals — lane, not_companion, not_yours, inactive, banned, moved_on, gone", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const compId = await insertCompanion(sql, { owner: "u1" });
    const scope = "dm:u1";
    const compSubj = MemoryStore.companionSubjectId(compId);
    await archiveExchange(store, scope, "c-dm", { authorId: "u1", compSubj });

    // lane: a guild channel that isn't a registered adoptee thread.
    const lane = await resolveRegenTarget(stubCtx({ userId: "u1", guildId: "g1", channelId: "c-public" }), store);
    assert.deepEqual(lane, { ok: false, reason: "lane" });

    // not_companion: human-authored target in the DM.
    const human = await resolveRegenTarget(stubCtx({ userId: "u1", targetId: "m-trig", targetAuthorId: "u1" }), store);
    assert.deepEqual(human, { ok: false, reason: "not_companion" });

    // not_companion: a bot-authored DM message that never archived as a reply
    // (system card, crisis response, link prompt).
    const card = await resolveRegenTarget(stubCtx({ userId: "u1", targetId: "m-card" }), store);
    assert.deepEqual(card, { ok: false, reason: "not_companion" });

    // not_companion: DM target authored by someone who isn't our bot.
    const foreign = await resolveRegenTarget(stubCtx({ userId: "u1", targetAuthorId: "other-bot" }), store);
    assert.deepEqual(foreign, { ok: false, reason: "not_companion" });

    // moved_on: a newer human message after the reply.
    const moved = await resolveRegenTarget(stubCtx({ userId: "u1" }), store);
    assert.equal(moved.ok, true); // control — still the tail before we add a row
    await store.recordMessage({
      guildId: scope, channelId: "c-dm", messageId: "m-newer",
      authorId: "u1", authorName: "User", content: "and another thing",
      createdAt: new Date("2026-01-01T00:00:20Z"), mentionsBot: false,
    });
    const moved2 = await resolveRegenTarget(stubCtx({ userId: "u1" }), store);
    assert.deepEqual(moved2, { ok: false, reason: "moved_on" });

    // gone: a reply whose trigger row is missing still resolves — the newest
    // archived human row before it becomes the trigger. Only a channel where
    // NO human row precedes the target refuses.
    await store.recordMessage({
      guildId: scope, channelId: "c-dm", messageId: "m-orphan",
      authorId: compSubj, authorName: "Nyx", content: "later reply",
      createdAt: new Date("2026-01-01T00:00:30Z"), mentionsBot: false,
    }, undefined, false, true);
    const stillResolves = await resolveRegenTarget(
      stubCtx({ userId: "u1", targetId: "m-orphan" }), store);
    assert.equal(stillResolves.ok, true);
    if (stillResolves.ok) assert.equal(stillResolves.target.trigger.messageId, "m-newer");

    // Truly nothing before the target → gone.
    const comp2Id = await insertCompanion(sql, { owner: "u2" });
    const comp2Subj = MemoryStore.companionSubjectId(comp2Id);
    await store.recordMessage({
      guildId: "dm:u2", channelId: "c-dm2", messageId: "m-orphan2",
      authorId: comp2Subj, authorName: "Nyx", content: "orphaned reply",
      createdAt: new Date("2026-01-01T00:00:10Z"), mentionsBot: false,
    }, undefined, false, true);
    const gone = await resolveRegenTarget(
      stubCtx({ userId: "u2", channelId: "c-dm2", targetId: "m-orphan2" }), store);
    assert.deepEqual(gone, { ok: false, reason: "gone" });
  } finally { await sql.end(); }
});

test("resolveRegenTarget: card chrome refused — components on a non-CV2 message", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const compId = await insertCompanion(sql, { owner: "u1" });
    const scope = "dm:u1";
    const compSubj = MemoryStore.companionSubjectId(compId);
    await archiveExchange(store, scope, "c-dm", { authorId: "u1", compSubj });

    // The awakened card archives under compSubj too (reply text + Summon
    // buttons on one row) — an action row on a non-CV2 message marks it as
    // chrome, so regen can't edit the card away.
    const card = await resolveRegenTarget(
      stubCtx({ userId: "u1", components: [{ type: 1 }] }), store);
    assert.deepEqual(card, { ok: false, reason: "not_companion" });

    // A CV2 reply carries components legitimately — still resolvable.
    const cv2 = await resolveRegenTarget(
      stubCtx({ userId: "u1", components: [{ type: 10 }], flags: MessageFlags.IsComponentsV2 }), store);
    assert.equal(cv2.ok, true);

    // A link preview embed attaches to real replies — embeds alone aren't chrome.
    const linked = await resolveRegenTarget(
      stubCtx({ userId: "u1", embeds: [{ type: "link" }] }), store);
    assert.equal(linked.ok, true);
  } finally { await sql.end(); }
});

test("resolveRegenTarget: adoptee thread refuses non-adopter, banned listing, onboarding companion", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const [listing] = await sql`INSERT INTO companion_listings (creator_user_id, name, status) VALUES ('u-creator', 'Listed', 'active') RETURNING id`;
    const cloneId = await insertCompanion(sql, { owner: "u-adopter", kind: "adopted", listingId: Number(listing.id) });
    await sql`INSERT INTO companion_adoptions (user_id, listing_id, companion_id, chat_thread_id)
              VALUES ('u-adopter', ${listing.id}, ${cloneId}, 't-adoptee')`;
    const compSubj = MemoryStore.companionSubjectId(cloneId);
    await archiveExchange(store, "dm:u-adopter", "t-adoptee", { authorId: "u-adopter", compSubj });

    // not_yours: staff/strangers can't redo someone else's companion.
    const stranger = await resolveRegenTarget(
      stubCtx({ userId: "u-stranger", guildId: "g1", channelId: "t-adoptee" }), store);
    assert.deepEqual(stranger, { ok: false, reason: "not_yours" });

    // banned: the listing freeze matches the turn lane's.
    await sql`UPDATE companion_listings SET status = 'banned' WHERE id = ${listing.id}`;
    const banned = await resolveRegenTarget(
      stubCtx({ userId: "u-adopter", guildId: "g1", channelId: "t-adoptee" }), store);
    assert.deepEqual(banned, { ok: false, reason: "banned" });
    await sql`UPDATE companion_listings SET status = 'active' WHERE id = ${listing.id}`;

    // inactive: a mid-onboarding companion's drafts aren't turn replies.
    await sql`UPDATE companions SET onboarding_state = 'onboarding' WHERE id = ${cloneId}`;
    const draft = await resolveRegenTarget(
      stubCtx({ userId: "u-adopter", guildId: "g1", channelId: "t-adoptee" }), store);
    assert.deepEqual(draft, { ok: false, reason: "inactive" });
  } finally { await sql.end(); }
});

test("resolveRegenTarget: DM lane refuses missing companion + other user's DM", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const compId = await insertCompanion(sql, { owner: "u1" });
    await archiveExchange(store, "dm:u1", "c-dm", { authorId: "u1", compSubj: MemoryStore.companionSubjectId(compId) });

    // u2 has no companion at all → inactive.
    const none = await resolveRegenTarget(stubCtx({ userId: "u2" }), store);
    assert.deepEqual(none, { ok: false, reason: "inactive" });

    // u3 has an onboarding-only companion → inactive.
    await insertCompanion(sql, { owner: "u3", state: "onboarding" });
    const draft = await resolveRegenTarget(stubCtx({ userId: "u3" }), store);
    assert.deepEqual(draft, { ok: false, reason: "inactive" });
  } finally { await sql.end(); }
});

test("regenExchangeTail: newest non-companion row before target is the trigger", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const scope = "dm:u9";
    const compSubj = "companion:9";
    await archiveExchange(store, scope, "c-dm", {
      authorId: "u9", compSubj,
      extra: [
        { id: "m-older", authorId: "u9", content: "earlier message", at: "2025-12-31T23:00:00Z" },
        { id: "m-between", authorId: compSubj, content: "a previous reply", at: "2025-12-31T23:30:00Z" },
      ],
    });
    const tail = await store.regenExchangeTail(scope, "c-dm", compSubj, "m-reply");
    assert.equal(tail.newerCount, 0);
    assert.equal(tail.target?.authorId, compSubj);
    // Skips the older companion reply AND the older human row — m-trig wins.
    assert.equal(tail.trigger?.id, "m-trig");

    // Rows in another channel of the same scope don't count as newer.
    await archiveExchange(store, scope, "c-other", { authorId: "u9", compSubj, replyId: "m-elsewhere" });
    const again = await store.regenExchangeTail(scope, "c-dm", compSubj, "m-reply");
    assert.equal(again.newerCount, 0);
  } finally { await sql.end(); }
});

test("regenExchangeTail: reply_to_id names the exact trigger, heuristic when it's gone", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const scope = "dm:u7";
    const compSubj = "companion:7";
    // The reply answered m-trig1 even though a rapid follow-up landed between
    // trigger and reply — the archived reply_to_id is authoritative.
    await store.recordMessage({
      guildId: scope, channelId: "c-dm", messageId: "m-trig1",
      authorId: "u7", authorName: "User", content: "the real question",
      createdAt: new Date("2026-01-01T00:00:00Z"), mentionsBot: false,
    });
    await store.recordMessage({
      guildId: scope, channelId: "c-dm", messageId: "m-trig2",
      authorId: "u7", authorName: "User", content: "a quick follow-up",
      createdAt: new Date("2026-01-01T00:00:05Z"), mentionsBot: false,
    });
    await store.recordMessage({
      guildId: scope, channelId: "c-dm", messageId: "m-reply",
      authorId: compSubj, authorName: "Nyx", content: "the take",
      createdAt: new Date("2026-01-01T00:00:10Z"), mentionsBot: false,
    }, "m-trig1", false, true);

    const tail = await store.regenExchangeTail(scope, "c-dm", compSubj, "m-reply");
    assert.equal(tail.trigger?.id, "m-trig1");

    // Pointer dead (retention purge) — the heuristic takes over.
    await sql`DELETE FROM messages WHERE id = 'm-trig1'`;
    const fallback = await store.regenExchangeTail(scope, "c-dm", compSubj, "m-reply");
    assert.equal(fallback.trigger?.id, "m-trig2");
  } finally { await sql.end(); }
});

test("recordRegen + regenCountToday: per-requester UTC-day count", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    assert.equal(await store.regenCountToday("u1"), 0);
    await store.recordRegen({ requesterId: "u1", scope: "dm:u1", channelId: "c-dm", messageId: "m1", companionId: 5 });
    await store.recordRegen({ requesterId: "u1", scope: "dm:u1", channelId: "c-dm", messageId: "m1", companionId: 5 });
    await store.recordRegen({ requesterId: "u2", scope: "dm:u2", channelId: "c-dm", messageId: "m9", companionId: 7 });
    assert.equal(await store.regenCountToday("u1"), 2);
    assert.equal(await store.regenCountToday("u2"), 1);
    // Yesterday's rows don't count.
    await sql`UPDATE reply_regens SET created_at = now() - interval '2 days' WHERE requester_id = 'u2'`;
    assert.equal(await store.regenCountToday("u2"), 0);
  } finally { await sql.end(); }
});
