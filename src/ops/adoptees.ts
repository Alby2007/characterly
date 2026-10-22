import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } from "discord.js";
import { config } from "../config.js";
import { inc } from "../metrics.js";
import { logError } from "../secrets.js";
import { sendAsCompanionInChannel } from "../webhooks.js";
import type { Companion, CompanionAdoption } from "../types.js";
import {
  deploymentFor, isHouse, normName, onOpsReset, opsAlert, reconcileMarkedCard, safeTrunc,
  type MemberLike, type OpsDeps, type SendableChannel, type ThreadLike, type TicketThreadLike,
} from "./shared.js";

// ── Adoptee threads (v54) ──────────────────────────────────────────────────
// Each active adoption owns one named private thread under #adoptees — the
// companion's chat surface. Messages there route to the dm:<adopter> pipeline
// (index.ts); this file owns the thread lifecycle: create, greet, reuse,
// lock/unlock, backfill.

/** Resolve the #adoptees text channel — env id first, then a name match in
 *  the house guild so a channel created before the env existed still binds. */
async function adopteesChannel(deps: OpsDeps): Promise<SendableChannel | null> {
  if (config.houseAdopteesChannelId) {
    return deps.fetchChannel(config.houseAdopteesChannelId).catch(() => null);
  }
  const guild = await deps.fetchGuild(config.houseGuildId!).catch(() => null);
  const ch = guild?.channels.cache.find(
    c => c.type === ChannelType.GuildText && normName(c.name) === "adoptees",
  );
  return ch ? deps.fetchChannel(ch.id).catch(() => null) : null;
}

/** The adoption greeting as the companion's first message — webhook persona
 *  when the lane is up, a bold-name bot post as fallback. True = it landed. */
async function greetAdopteeInThread(
  deps: OpsDeps,
  thread: TicketThreadLike,
  parent: SendableChannel,
  companion: Companion,
  greeting: string,
): Promise<boolean> {
  const text = greeting || `*${companion.name} joins you.*`;
  // The webhook host is the real parent channel — a fabricated {type}-only
  // parent would resolve the host but die inside fetchWebhooks.
  const sent = deps.botId
    ? await sendAsCompanionInChannel(
        { id: thread.id, type: ChannelType.PrivateThread, parent: parent as unknown as { type: ChannelType } },
        companion, text, deps.botId,
      ).catch(() => null)
    : null;
  if (sent) return true;
  return thread.send({ content: `**${companion.name}**\n${text}`, allowedMentions: { parse: [] } })
    .then(() => true)
    .catch(e => { inc("ops.adoptee_greet_error"); logError("adoptee greeting failed", e); return false; });
}

export type EnsureAdopteeThreadResult =
  | { thread: TicketThreadLike; greeted: boolean; created: boolean }
  | { needsInvite: true }
  | { deferred: true }
  | { failed: true };

/** The pinned manage row every adoptee thread carries — one Danger Drop
 *  button keyed to the adoption's companion, reusing the market:drop path. */
export function adopteeManagePayload(companion: Companion) {
  return {
    content: `*Manage **${companion.name || "Companion"}** —*`,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`market:drop:${companion.id}`)
        .setLabel(safeTrunc(`Drop ${companion.name || "companion"}`, 80))
        .setStyle(ButtonStyle.Danger),
    )],
    allowedMentions: { parse: [] },
  };
}

/** Backfill the pinned manage row on threads created before it existed —
 *  a pinned row is left alone, an unpinned one is re-pinned, a missing one
 *  is posted + pinned. Detection is the `market:drop:` custom id itself:
 *  only the bot can post components, so no author check is needed.
 *  fetchPinned is queried first — the pinned set can't scroll away, so an
 *  empty answer reliably means "post it"; the last-N scan is the fallback
 *  for fakes/surfaces without pin fetch. */
async function ensureAdopteeManageRow(thread: TicketThreadLike, companion: Companion): Promise<void> {
  const pinned = await thread.messages?.fetchPinned?.().catch(() => null) ?? null;
  const fetched = pinned ?? await thread.messages?.fetch({ limit: 30 }).catch(() => null);
  if (!fetched) return;
  for (const entry of fetched) {
    const m = (Array.isArray(entry) ? entry[1] : entry) as { pinned?: boolean; components?: unknown[]; pin?(): Promise<unknown> } | undefined;
    if (m && JSON.stringify(m.components ?? []).includes("market:drop:")) {
      if (!m.pinned) await m.pin?.().catch(e => { inc("ops.adoptee_manage_error"); logError("adoptee manage row pin failed", e); });
      return;
    }
  }
  const sent = await thread.send(adopteeManagePayload(companion))
    .catch(e => { inc("ops.adoptee_manage_error"); logError("adoptee manage row failed", e); return null; });
  await (sent as { pin?(): Promise<unknown> } | null)?.pin?.().catch(() => {});
}

/** Resolve the adoptees surface for a guild: the house channel resolves from
 *  env/name (adopteesChannel); partner deployments carry the channel id on
 *  their row. Returns null when the surface is gone — callers fall back. */
async function adopteesChannelFor(deps: OpsDeps, guildId: string | null): Promise<SendableChannel | null> {
  if (!guildId || guildId === config.houseGuildId) return adopteesChannel(deps);
  const dep = deploymentFor(guildId);
  if (!dep || dep.status !== "active" || !dep.adopteesChannelId) return null;
  return deps.fetchChannel(dep.adopteesChannelId).catch(() => null);
}

/** Create (or reuse) the private adoptee thread for an adoption. Idempotent —
 *  a live `chat_thread_id` short-circuits unless `reopen` is asked (re-adopt
 *  unarchives the locked thread so the history continues). The companion
 *  introduces themselves on creation — that's what unlocks server summoning.
 *
 *  v59 multi-server: the thread is homed where the adoption was adopted
 *  (chat_guild_id; NULL = house). `ctx.targetGuildId` overrides at adopt
 *  time before the row is stamped. A thread is only reachable while the
 *  adopter is a member of its host guild AND the deployment is still live —
 *  otherwise it archives (partner admins shouldn't keep reading it) and the
 *  adoption relocates to the house, where ensure rebuilds on next touch. */
export async function ensureAdopteeThread(
  deps: OpsDeps,
  ctx: {
    adoption: CompanionAdoption;
    companion: Companion;
    listing?: { id: number; greeting: string } | null;
    username?: string;
    reopen?: boolean;
    /** Where the Add was clicked — overrides adoption.chatGuildId so the
     *  intent survives even if the thread create fails afterwards. */
    targetGuildId?: string | null;
    /** Explicit chat intent (the Meet surfaces). Without it, an adoption
     *  that never got its greeting is left threadless — healers must not
     *  materialize a room nobody asked to enter. */
    allowCreate?: boolean;
  },
): Promise<EnsureAdopteeThreadResult> {
  const { adoption, companion } = ctx;
  // Deferred creation: a never-introduced adoption with no thread is
  // intentionally roomless — every active-thread slot is precious. Once
  // introduced, a missing thread is just a deleted surface and rebuilds
  // normally below; a live thread reattaches regardless of either flag.
  if (!adoption.chatThreadId && !adoption.dmIntroducedAt && !ctx.allowCreate) {
    return { deferred: true };
  }
  const houseId = config.houseGuildId ?? null;
  let targetId = ctx.targetGuildId !== undefined
    ? (ctx.targetGuildId ?? houseId)
    : (adoption.chatGuildId ?? houseId);
  if (!targetId) return { failed: true };

  /** Relocate this adoption to the house: clear the dead thread + guild so
   *  the next ensure (here and later) aims home. */
  const relocateToHouse = async () => {
    targetId = houseId;
    if (adoption.chatGuildId || adoption.chatThreadId) {
      await deps.store.setAdoptionLocation(adoption.id, { guildId: null, channelId: null, threadId: null }).catch(() => inc("ops.adoptee_thread_error"));
      adoption.chatGuildId = null; adoption.chatChannelId = null; adoption.chatThreadId = null;
    }
  };

  if (adoption.chatThreadId) {
    const existing = await deps.fetchChannel(adoption.chatThreadId).catch(() => null);
    if (existing) {
      const ex = existing as TicketThreadLike;
      // A live thread is only usable while the adopter is a member of its
      // host guild — leaving drops private-thread membership silently —
      // AND while the host deployment is still active. A row disabled
      // outside removeDeployment (manual SQL, a status flip) leaves an open
      // thread whose channel no longer matches isAdopteeThread — reusing it
      // would drop private DM-scope chat into the normal guild pipeline.
      const member = await deps.fetchMember(targetId, adoption.userId).catch(() => null);
      const hostLive = targetId === houseId || deploymentFor(targetId)?.status === "active";
      if (member && hostLive) {
        // Always unlock on reattach, not just explicit reopens: a leave
        // (handleDeploymentMemberRemove) locks the thread, and rejoining
        // without the unlock leaves the member able to read but not type.
        // Active-only locks are either this one or ctx.reopen's — banned
        // and dropped adoptions never reach this branch.
        await ex.setLocked?.(false).catch(() => {});
        // Private-thread membership lapses when the adopter leaves and
        // rejoins — re-add idempotently so a live thread reappears for them,
        // and resurface anything Discord auto-archived out from under them.
        await ex.setArchived?.(false).catch(() => {});
        await ex.members?.add?.(adoption.userId).catch(e => {
          inc("ops.adoptee_reattach_error"); logError("adoptee thread re-attach failed", e);
        });
        // Threads created before the manage row shipped get it backfilled.
        await ensureAdopteeManageRow(ex, companion).catch(() => inc("ops.adoptee_thread_error"));
        return { thread: ex, greeted: false, created: false };
      }
      // Adopter gone from the host server or the host deployment is dead —
      // seal the stale thread so partner admins aren't left reading it,
      // then rebuild in the house.
      await ex.setLocked?.(true).catch(() => {});
      await ex.setArchived?.(true).catch(() => {});
      await relocateToHouse();
    } else {
      // Deleted thread (mod cleanup) — rebuild in the SAME host guild while
      // it's still viable; the deployment-gone check below relocates.
      adoption.chatThreadId = null;
    }
  }

  // Partner target sanity: the deployment must still be active and the
  // adopter still a member. Anything less collapses the target to the house.
  if (targetId !== houseId) {
    const dep = deploymentFor(targetId);
    const member = dep?.status === "active"
      ? await deps.fetchMember(targetId, adoption.userId).catch(() => null)
      : null;
    if (!member) await relocateToHouse();
  }
  if (!targetId) return { failed: true };

  // The adopter must be a member of the target guild to see their private
  // thread — everyone else gets pointed at the house invite.
  const member = await deps.fetchMember(targetId, adoption.userId).catch(() => null);
  if (!member) return { needsInvite: true };
  const parent = await adopteesChannelFor(deps, targetId);
  if (!parent) {
    // Partner surface deleted out from under the deployment — house
    // fallback keeps the adoption usable; the sweep flags the broken row.
    if (targetId !== houseId) {
      await relocateToHouse();
      if (!houseId) return { failed: true };
      const houseMember = await deps.fetchMember(houseId, adoption.userId).catch(() => null);
      if (!houseMember) return { needsInvite: true };
      const houseParent = await adopteesChannelFor(deps, houseId);
      if (!houseParent || typeof houseParent.threads?.create !== "function") {
        inc("ops.adoptee_thread_missing_channel");
        return { failed: true };
      }
      return createAdopteeThread(deps, ctx, houseParent, houseId);
    }
    inc("ops.adoptee_thread_missing_channel");
    return { failed: true };
  }
  return createAdopteeThread(deps, ctx, parent, targetId);
}

/** The create half of ensureAdopteeThread — opens the private thread under
 *  `parent`, stamps the adoption's home, greets, and pins the manage row. */
async function createAdopteeThread(
  deps: OpsDeps,
  ctx: { adoption: CompanionAdoption; companion: Companion; listing?: { id: number; greeting: string } | null },
  parent: SendableChannel,
  guildId: string,
): Promise<EnsureAdopteeThreadResult> {
  const { adoption, companion } = ctx;
  if (typeof parent.threads?.create !== "function") {
    inc("ops.adoptee_thread_missing_channel");
    return { failed: true };
  }
  // Companion name only — these threads are private to one adopter, so the
  // username suffix just added noise to an already-personal row.
  const name = safeTrunc(companion.name || "Companion", 95);
  const thread = await parent.threads.create({
    name,
    type: ChannelType.PrivateThread,
    invitable: false,
    // 3 days by default (env pinned to Discord's 60/1440/4320/10080 set) —
    // auto-archive is the recycler for the guild's ~1,000 active-thread
    // slots; a lapsed adopter's next post unarchives the thread anyway.
    autoArchiveDuration: config.adopteeThreadArchiveMinutes,
  }).catch(e => { inc("ops.adoptee_thread_error"); logError("adoptee thread create failed", e); return null; });
  if (!thread) return { failed: true };
  const added = await thread.members?.add(adoption.userId).then(() => true).catch(() => false) ?? false;
  if (!added) {
    // An invisible thread is worse than none — drop it and fail loudly.
    await thread.setLocked?.(true).catch(() => {});
    await thread.setArchived?.(true).catch(() => {});
    return { failed: true };
  }
  const isHouseTarget = guildId === config.houseGuildId;
  await deps.store.setAdoptionLocation(adoption.id, {
    guildId: isHouseTarget ? null : guildId,
    channelId: parent.id ?? null,
    threadId: thread.id,
  }).catch(e => {
    inc("ops.adoptee_thread_error"); logError("adoption thread stamp failed", e);
  });
  const greeted = await greetAdopteeInThread(
    deps, thread, parent, companion, ctx.listing?.greeting ?? "",
  );
  if (greeted) await deps.store.markDmIntroduced(adoption.id).catch(() => inc("ops.adoptee_thread_error"));
  // Pinned manage row — Drop is the one destructive act every adopter
  // eventually needs, and burying it in a 16-item slash enum made it
  // undiscoverable. The market:drop handler reuses the shared path (row
  // tombstones itself and archives the thread).
  const manageMsg = await thread.send(adopteeManagePayload(companion))
    .catch(e => { inc("ops.adoptee_manage_error"); logError("adoptee manage row failed", e); return null; });
  await (manageMsg as { pin?(): Promise<unknown> } | null)?.pin?.().catch(() => {});
  inc("ops.adoptee_thread_created");
  return { thread, greeted, created: true };
}

/** Archive+lock (or reopen) an adoptee thread — drop/ban and unflag/re-adopt
 *  hooks. `note` posts before archiving: sends fail on archived threads. */
export async function setAdopteeThreadLocked(
  deps: OpsDeps,
  threadId: string | null,
  locked: boolean,
  note?: string,
): Promise<void> {
  if (!threadId) return;
  const thread = await deps.fetchChannel(threadId).catch(() => null) as TicketThreadLike | null;
  if (!thread) return;
  if (locked) {
    if (note) await thread.send({ content: note, allowedMentions: { parse: [] } }).catch(() => {});
    await thread.setLocked?.(true).catch(() => {});
    await thread.setArchived?.(true).catch(() => {});
  } else {
    await thread.setLocked?.(false).catch(() => {});
    await thread.setArchived?.(false).catch(() => {});
  }
}

/** Ensure a user's active adoptions have their threads AND that the adopter
 *  is still a member of each — leaving the guild drops private-thread
 *  membership, so join hooks and interactive paths both drain through here
 *  (create missing, re-attach live, rebuild deleted). `opts.guildId` scopes
 *  to adoptions hosted in one deployment (member-add in a partner guild only
 *  re-attaches threads living there); NULL means the house. */
export async function ensureAdopteeThreadsForUser(userId: string, deps: OpsDeps, opts: { guildId?: string | null } = {}): Promise<void> {
  const rows = await deps.store.activeAdoptionsForUser?.(userId, opts.guildId).catch(() => []) ?? [];
  for (const row of rows) {
    // Deferred adoptions stay threadless until intent — the ensure paths
    // heal threads that once existed, they don't pre-build unmet ones.
    if (!row.adoption.chatThreadId && !row.adoption.dmIntroducedAt) continue;
    await ensureAdopteeThread(deps, row).catch(e => {
      inc("ops.adoptee_thread_error"); logError("ensure adoptee thread failed", e);
    });
  }
}

/** Boot/interval sweep — same shape as greetPendingInstalls: bounded batch,
 *  per-row fault tolerance, permanent dedupe via chat_thread_id. Non-members
 *  are skipped silently; the member-add hook catches them when they join.
 *  Each row's chat_guild_id picks the host guild — the house takes whatever
 *  is un-homed (NULL) or whose deployment died. */
export async function backfillAdopteeThreads(deps: OpsDeps): Promise<void> {
  if (!deps) return;
  const missing = await deps.store.activeAdoptionsMissingThreads(10).catch(e => {
    inc("ops.adoptee_backfill_error"); logError("adoptee backfill query failed", e); return [];
  });
  for (const row of missing) {
    const hostGuild = row.adoption.chatGuildId ?? config.houseGuildId;
    if (!hostGuild) continue;
    const member = await deps.fetchMember(hostGuild, row.adoption.userId).catch(() => null);
    if (!member) continue;
    await ensureAdopteeThread(deps, { ...row, username: member.user.username }).catch(e => {
      inc("ops.adoptee_thread_error"); logError("adoptee backfill create failed", e);
    });
  }
}
// ── Floodgate ────────────────────────────────────────────────────────────────
// Discord caps a guild at ~1,000 ACTIVE threads — every kind shares one pool
// (archived ones don't count): #adoptees children, tickets, forum posts.
// The gauge reads both signals on this sweep: the house's #adoptees count at
// HOUSE_THREAD_WARN, or the guild-wide total at HOUSE_GUILD_THREAD_WARN,
// posts+pins a card in #adoptees diverting users to self-serve deployments;
// it only comes down once BOTH counts drop below their CLEAR thresholds.
// The bands between are hysteresis — the 5-minute sweep can't flap the card
// off and on around a wobbling count.

const PRESSURE_CARD_MARKER = "Char.ly floodgate";

const pressureState = { active: false, count: null as number | null, guildTotal: null as number | null };
/** Last swept pressure state — the adopt reply reads this instead of
 *  re-fetching threads per interaction (the sweep is the sole writer).
 *  `count` is #adoptees children; `guildTotal` is every active thread in the
 *  house — the number that actually approaches Discord's ceiling. */
export function houseAdopteesPressure(): { active: boolean; count: number | null; guildTotal: number | null } {
  return { ...pressureState };
}

onOpsReset(() => { pressureState.active = false; pressureState.count = null; pressureState.guildTotal = null; });

async function countHouseThreads(deps: OpsDeps): Promise<{ adoptees: number; total: number } | null> {
  if (!config.houseGuildId || !config.houseAdopteesChannelId) return null;
  const guild = await deps.fetchGuild(config.houseGuildId).catch(() => null);
  if (!guild?.channels.fetchActiveThreads) return null;
  const res = await guild.channels.fetchActiveThreads()
    .catch(e => { logError("house active threads fetch failed", e); return null; });
  if (!res) return null;
  let adoptees = 0;
  let total = 0;
  for (const entry of res.threads as Iterable<ThreadLike | [unknown, ThreadLike]>) {
    const t = Array.isArray(entry) ? entry[1] : entry;
    total += 1;
    if (t.parentId === config.houseAdopteesChannelId) adoptees += 1;
  }
  return { adoptees, total };
}

export async function ensureAdopteePressureCard(deps: OpsDeps): Promise<void> {
  if (!config.houseAdopteesChannelId || !deps.botId) return;
  const counts = await countHouseThreads(deps);
  // Fetch failed — keep the last good counts (nulling the gauges on a
  // transient blip would report "active, count unknown" to deploystatus).
  if (!counts) return;
  pressureState.count = counts.adoptees;
  pressureState.guildTotal = counts.total;
  if (counts.adoptees < config.houseThreadClearCount && counts.total < config.houseGuildThreadClearCount) {
    pressureState.active = false;
  } else if (counts.adoptees >= config.houseThreadWarnCount || counts.total >= config.houseGuildThreadWarnCount) {
    pressureState.active = true;
  }
  const ch = await deps.fetchChannel(config.houseAdopteesChannelId).catch(() => null);
  if (!ch?.send) return;
  // The card stands only while pressure is active AND self-serve deployment
  // can remediate it — with the flag off it's a pinned dead-end, so
  // stand:false strips any stale copy. The gauges above track regardless.
  await reconcileMarkedCard(deps, ch, {
    match: PRESSURE_CARD_MARKER,
    stand: pressureState.active && !!config.marketDeployEnabled,
    pin: true,
    payload: {
      content:
        "**The house is filling up — run your own shelf.**\n" +
        "Discord caps a server at ~1,000 live threads, and this one is getting close. You can host your own Characterly instead — it takes about five minutes.\n\n" +
        "**1.** Create a Discord server (just you works)\n" +
        "**2.** Add Characterly to it — button below\n" +
        "**3.** Enable **Community** in Server Settings (the shelf needs a forum)\n" +
        "**4.** Run `/marketplace deploy`\n\n" +
        "A `characterly.app` category appears — your own shelf, your own private adoptee threads, no house limits.\n" +
        `*${PRESSURE_CARD_MARKER}*`,
      ...(deps.botInviteUrl ? {
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setLabel("Add Characterly to a server").setStyle(ButtonStyle.Link).setURL(deps.botInviteUrl),
        )],
      } : {}),
      allowedMentions: { parse: [] },
    },
  }).catch(e => { inc("ops.pressure_error"); logError("pressure card post failed", e); });
}
