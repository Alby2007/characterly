import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits } from "discord.js";
import { config } from "../config.js";
import { inc } from "../metrics.js";
import { logError } from "../secrets.js";
import { CURATED_TAGS, PARTNER_TAG_SET, archiveListingPosts, postActiveListingsToDeployments } from "../marketplace.js";
import type { MemoryStore } from "../database.js";
import type { CompanionListing, GuildDeployment } from "../types.js";
import { ensureAdopteePressureCard, ensureAdopteeThreadsForUser } from "./adoptees.js";
import { ensureOpenThreads, permHas } from "./layout.js";
import {
  deploymentFor, deploymentRows, deployedGuildIds, isHouse, marketplaceForumIds, normName, opsAlert, reconcileMarkedCard, refreshDeploymentCache, registerSweep, safeTrunc, untrackDeployment,
  type ForumTagLike, type GuildChannelLike, type GuildLike, type MemberLike, type OpsDeps, type SendableChannel, type ThreadLike, type TicketThreadLike,
} from "./shared.js";

// ── Marketplace tag sweep ────────────────────────────────────────────────────
// The forum's moderated badges are earned, not set once — a listing stops
// being new, ratings climb past the threshold, velocity spikes. This sweep
// recomputes the managed tags against live stats on the watchdog cadence and
// only writes when the applied set differs. Tag state lives on the threads
// (appliedTags); a badge only exists while the listing is active.
//
// Tag NAMES are the contract between Discord-side config and this code —
// matched case-insensitively; a missing name skips its rule silently.
// CURATED_TAGS lives in ./marketplace.js (the shared leaf module).

/** One forum's badge reconcile — the per-mirror unit of runTagSweep.
 *  `byThread` maps EVERY deployment's live post threads to their listing so
 *  a partner forum's threads resolve identically to the house's. */
async function sweepForumTags(
  deps: OpsDeps,
  forumChannelId: string,
  byThread: Map<string, CompanionListing>,
  stats: Map<number, { avg: number; count: number }>,
  velocity: Map<number, number>,
): Promise<number> {
  const channel = await deps.fetchChannel(forumChannelId).catch(() => null);
  const available = channel?.availableTags ?? [];
  const threadsApi = channel?.threads;
  if (!available.length || !threadsApi?.fetchActive) return 0;

  const tagId = (name: string) => available.find(t => t.name.toLowerCase() === name.toLowerCase())?.id;
  const newId = tagId(CURATED_TAGS.new);
  const topId = tagId(CURATED_TAGS.topRated);
  const trendId = tagId(CURATED_TAGS.trending);
  const managed = new Set([newId, topId, trendId].filter((t): t is string => !!t));
  // Only Staff Pick exists (it's manual — the sweep never manages it) or the
  // forum has no curated tags at all: nothing to compute.
  if (!managed.size) return 0;

  const fetched = await threadsApi.fetchActive().catch(() => null);
  if (!fetched) return 0;
  const rawThreads = (fetched as { threads: Map<string, ThreadLike> | Iterable<[string, ThreadLike]> | Iterable<ThreadLike> }).threads;
  const threads: ThreadLike[] = [...(rawThreads instanceof Map ? rawThreads.values() : rawThreads)]
    .map(t => Array.isArray(t) ? (t as [string, ThreadLike])[1] : (t as ThreadLike));

  const now = Date.now();
  const newCutoffMs = config.marketNewTagDays * 86_400_000;
  let changed = 0;
  for (const thread of threads) {
    const applied = new Set(thread.appliedTags ?? []);
    const target = new Set(applied);
    const listing = byThread.get(thread.id);
    if (newId) {
      const age = thread.createdTimestamp ? now - thread.createdTimestamp : Number.POSITIVE_INFINITY;
      if (listing && age <= newCutoffMs) target.add(newId); else target.delete(newId);
    }
    if (topId) {
      const s = listing ? stats.get(listing.id) : undefined;
      if (listing && s && s.count >= config.marketTopRatingMin && s.avg >= config.marketTopRatingAvg) target.add(topId);
      else target.delete(topId);
    }
    if (trendId) {
      const n = listing ? velocity.get(listing.id) ?? 0 : 0;
      if (listing && n >= config.marketTrendingCount) target.add(trendId);
      else target.delete(trendId);
    }
    if (target.size === applied.size && [...target].every(t => applied.has(t))) continue;
    // Cap at Discord's 5-tag limit — managed badges first, creator tags fill
    // what's left. Staff Pick and creator tags are never removed here.
    const managedWanted = [newId, topId, trendId].filter((t): t is string => !!t && target.has(t));
    const rest = [...target].filter(t => !managed.has(t));
    const ok = await thread.setAppliedTags?.([...managedWanted, ...rest].slice(0, 5))
      .then(() => true).catch(() => false);
    if (ok) { changed++; inc("ops.tag_sweep"); }
  }
  return changed;
}

export async function runTagSweep(deps: OpsDeps): Promise<number> {
  const forumIds = [...marketplaceForumIds()];
  if (!forumIds.length) return 0;

  // Bulk inputs once per sweep — the listing map now spans every deployment's
  // posts (listing_posts), with forum_thread_id folding in for rows whose
  // backfill hasn't landed yet.
  const posts = await deps.store.listActiveListingPosts().catch(() => [] as Awaited<ReturnType<MemoryStore["listActiveListingPosts"]>>);
  const byThread = new Map<string, CompanionListing>();
  for (const { listing, post } of posts) if (post.threadId) byThread.set(post.threadId, listing);
  const legacy = await deps.store.listActiveListingsWithThreads().catch(() => [] as Awaited<ReturnType<MemoryStore["listActiveListingsWithThreads"]>>);
  for (const l of legacy) if (l.forumThreadId && !byThread.has(l.forumThreadId)) byThread.set(l.forumThreadId, l);
  // Stats/velocity are computed lazily per forum before, but the queries are
  // shared — pull once up front; per-forum sweeps may still no-op early when
  // a forum lacks the curated tags entirely.
  const stats = await deps.store.ratingStatsByListing().catch(() => new Map<number, { avg: number; count: number }>());
  const velocity = await deps.store.recentAdoptionCounts(config.marketTrendingWindowH * 3_600_000).catch(() => new Map<number, number>());

  let changed = 0;
  for (const forumId of forumIds) {
    changed += await sweepForumTags(deps, forumId, byThread, stats, velocity)
      .catch(e => { inc("ops.sweep_error"); logError(`tag sweep failed for forum ${forumId}`, e); return 0; });
  }
  return changed;
}

export function startTagSweep(deps: OpsDeps): { stop: () => void } {
  return registerSweep("tags", () => runTagSweep(deps), config.hostHealthIntervalMs);
}
// ── Partner deployments (v59) ──────────────────────────────────────────────
// A deployed server gets one "Characterly" category holding the mirrored
// shelf (#characters forum) and the private adoptee-thread surface
// (#adoptees). Layout is created idempotently — rows land on
// guild_deployments, posts fan out via listing_posts. MARKET_DEPLOY_ENABLED
// gates the whole feature; the house server never goes through this path
// (its layout is WANTED_LAYOUT + env).

/** Guild-scoped partner command — registered ONLY in deployments granted via
 *  `/ops deploygrant`, never in the global command list (the feature stays
 *  invisible until announced). ManageGuild = the server's admins. Defined
 *  here (not commands.ts) so the grant action registers it without an
 *  ops→commands import cycle. */
const DEPLOY_CATEGORY_NAME = "characterly.app";
const DEPLOY_MARKET_NAME = "characters";
const DEPLOY_ADOPTEES_NAME = "adoptees";
const DEPLOY_LOGIN_NAME = "log-in";
const LOGIN_CARD_MARKER = "Char.ly log-in card";
// Bump when the card's copy or the site URL changes — the reconcile edits a
// stale card in place instead of leaving outdated text pinned forever.
const LOGIN_CARD_VERSION = 1;

const DEPLOY_REQUIRED_PERMS: Array<{ bit: bigint; label: string }> = [
  { bit: PermissionFlagsBits.ViewChannel, label: "View Channels" },
  { bit: PermissionFlagsBits.ManageChannels, label: "Manage Channels" },
  { bit: PermissionFlagsBits.ManageThreads, label: "Manage Threads" },
  { bit: PermissionFlagsBits.ManageWebhooks, label: "Manage Webhooks" },
  { bit: PermissionFlagsBits.SendMessages, label: "Send Messages" },
  { bit: PermissionFlagsBits.SendMessagesInThreads, label: "Send Messages in Threads" },
  { bit: PermissionFlagsBits.CreatePrivateThreads, label: "Create Private Threads" },
];

export interface DeployOutcome {
  ok: boolean;
  error?: string;
  created?: string[];
  posted?: number;
  failed?: number;
}

/** Idempotent surface reconcile for one deployed guild: find-or-create the
 *  category, the #characters forum (tags merged by name — existing tag ids
 *  preserved since applied tags reference them), the locked-down #adoptees
 *  and #log-in channels. Returns the resolved ids for the deployment row. */
async function ensureDeploymentLayout(
  guild: GuildLike,
  row: GuildDeployment | null,
): Promise<{ categoryId: string; marketplaceChannelId: string; adopteesChannelId: string; loginChannelId: string; created: string[] } | null> {
  const created: string[] = [];
  const everyone = guild.id; // @everyone overwrite id == guild id
  const findChan = (type: number, name: string) =>
    guild.channels.cache.find(c => c.type === type && normName(c.name) === normName(name));
  const byId = (id: string | null | undefined) =>
    id ? guild.channels.cache.find(c => c.id === id) : undefined;

  let category = byId(row?.categoryId) ?? findChan(ChannelType.GuildCategory, DEPLOY_CATEGORY_NAME)
    ?? findChan(ChannelType.GuildCategory, "Characterly"); // pre-rename deploys
  if (!category) {
    category = await guild.channels.create({ name: DEPLOY_CATEGORY_NAME, type: ChannelType.GuildCategory })
      .catch(e => { logError("deploy category create failed", e); return undefined; });
    if (!category) return null;
    created.push(`category ${DEPLOY_CATEGORY_NAME}`);
  } else if (category.name !== DEPLOY_CATEGORY_NAME && category.edit) {
    await category.edit({ name: DEPLOY_CATEGORY_NAME })
      .then(() => created.push(`category → ${DEPLOY_CATEGORY_NAME}`))
      .catch(e => logError("deploy category rename failed", e));
  }

  // #characters — forum, Gallery view, comments open but only the bot posts.
  let forum = byId(row?.marketplaceChannelId) ?? findChan(ChannelType.GuildForum, DEPLOY_MARKET_NAME);
  const forumOverwrites = [{
    id: everyone,
    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessagesInThreads],
    deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.CreatePrivateThreads],
  }];
  if (!forum) {
    forum = await guild.channels.create({
      name: DEPLOY_MARKET_NAME,
      type: ChannelType.GuildForum,
      parent: category.id,
      topic: "The Characterly shelf — every companion here can be adopted with one click. Comment on a card, or hit Add.",
      availableTags: PARTNER_TAG_SET.map(t => ({ name: t.name, moderated: t.moderated })),
      defaultForumLayout: 2, // GalleryView — covers carry the shelf.
      permissionOverwrites: forumOverwrites,
    }).catch(e => { logError("deploy forum create failed", e); return undefined; });
    if (!forum) return null;
    created.push(`#${DEPLOY_MARKET_NAME}`);
  } else {
    // Reconcile an existing forum: seed any missing taxonomy names (existing
    // tags pass through with their ids — applied tags reference them), and
    // force Gallery layout like the house reconciler does. Overwrites also
    // reconcile — a pre-made "characters" forum with open perms would let
    // anyone create threads on the shelf.
    await ensureOpenThreads(forum, created, `#${DEPLOY_MARKET_NAME}`, everyone);
    const existing = (forum.availableTags ?? []).map(t => ({ id: t.id, name: t.name, moderated: t.moderated ?? false }));
    const missing = PARTNER_TAG_SET.filter(t => !existing.some(e => e.name.toLowerCase() === t.name.toLowerCase()))
      .map(t => ({ name: t.name, moderated: t.moderated }));
    if (missing.length && forum.setAvailableTags) {
      await forum.setAvailableTags([...existing, ...missing])
        .then(() => created.push(`tags +${missing.length}`))
        .catch(e => logError("deploy forum tag reconcile failed", e));
    }
    if (forum.defaultForumLayout !== 2) {
      await forum.edit?.({ defaultForumLayout: 2 }).catch(() => {});
    }
  }

  // #adoptees — visible channel (threads are what's private), silent for
  // members: no posting, no thread creation; thread members can still type
  // inside their own private thread.
  let adoptees = byId(row?.adopteesChannelId) ?? findChan(ChannelType.GuildText, DEPLOY_ADOPTEES_NAME);
  if (!adoptees) {
    adoptees = await guild.channels.create({
      name: DEPLOY_ADOPTEES_NAME,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: [{
        id: everyone,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessagesInThreads],
        deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.CreatePrivateThreads],
      }],
    }).catch(e => { logError("deploy adoptees create failed", e); return undefined; });
    if (!adoptees) return null;
    created.push(`#${DEPLOY_ADOPTEES_NAME}`);
  } else {
    // Found-by-name channels keep their own overwrites otherwise — a pre-made
    // "adoptees" channel with default perms would let anyone post or open
    // public threads in the adoptee surface.
    await ensureOpenThreads(adoptees, created, `#${DEPLOY_ADOPTEES_NAME}`, everyone);
  }

  // #log-in — a read-only signpost, not a gate: adoption outside the house
  // only needs a linked account, so this channel just carries the card.
  let login = byId(row?.loginChannelId) ?? findChan(ChannelType.GuildText, DEPLOY_LOGIN_NAME);
  if (!login) {
    login = await guild.channels.create({
      name: DEPLOY_LOGIN_NAME,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: [{
        id: everyone,
        allow: [PermissionFlagsBits.ViewChannel],
        deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.CreatePrivateThreads],
      }],
    }).catch(e => { logError("deploy log-in create failed", e); return undefined; });
    if (!login) return null;
    created.push(`#${DEPLOY_LOGIN_NAME}`);
  } else {
    await ensureOpenThreads(login, created, `#${DEPLOY_LOGIN_NAME}`, everyone);
  }

  return { categoryId: category.id, marketplaceChannelId: forum.id, adopteesChannelId: adoptees.id, loginChannelId: login.id, created };
}

/** The pinned card every deployed #log-in carries — marked + deduped like
 *  resource posts so reconcile stays idempotent. It explains the one thing
 *  the channel can't do itself: link a Characterly account. */
async function ensureDeploymentLoginCard(deps: OpsDeps, channelId: string): Promise<void> {
  const ch = await deps.fetchChannel(channelId).catch(() => null);
  if (!ch?.send || !deps.botId) return;
  const payload = {
    content:
      "**Log in & link.**\n" +
      "Adopting companions needs a free Characterly account — it takes a minute.\n\n" +
      `**1.** Create one at **${config.siteUrl}**\n` +
      "**2.** Run `/link` — it hands you a one-time code\n" +
      "**3.** Paste the code in your dashboard under **Discord**\n\n" +
      "Then hit **Add** on any character in the shelf — their private thread opens under **#adoptees**.\n" +
      `*${LOGIN_CARD_MARKER} · v${LOGIN_CARD_VERSION}*`,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setLabel("Open characterly.app").setStyle(ButtonStyle.Link).setURL(config.siteUrl),
    )],
    allowedMentions: { parse: [] },
  };
  await reconcileMarkedCard(deps, ch, {
    match: LOGIN_CARD_MARKER,
    version: LOGIN_CARD_VERSION,
    payload,
    pin: true,
  }).catch(e => { inc("ops.login_card_error"); logError("login card post failed", e); });
}

/** The `/marketplace deploy` workhorse: validate the guild (granted, COMMUNITY,
 *  bot perms), reconcile the layout, activate the row, then fan the whole
 *  catalog into the new forum. Safe to re-run — a retry only fills gaps. */
export async function deployMarketplace(deps: OpsDeps, guildId: string, deployerId?: string): Promise<DeployOutcome> {
  if (!config.marketDeployEnabled) return { ok: false, error: "Partner deployment isn't open yet." };
  if (guildId === config.houseGuildId) return { ok: false, error: "This server is already Characterly's home — the shelf lives here natively." };
  const row = await deps.store.deploymentFor(guildId).catch(() => null);
  if (!row || row.status === "disabled") {
    return { ok: false, error: "This server isn't approved for deployment — a Characterly operator grants that first." };
  }
  const guild = await deps.fetchGuild(guildId).catch(() => null);
  if (!guild) return { ok: false, error: "I can't reach this server — am I still a member?" };
  if (!(guild.features ?? []).includes("COMMUNITY")) {
    return { ok: false, error: "Enable **Community** first (Server Settings → Enable Community) — the shelf is a forum channel, and forums require it." };
  }
  const me = guild.members?.me ?? await guild.members?.fetchMe?.().catch(() => null) ?? null;
  if (!permHas(me?.permissions, PermissionFlagsBits.Administrator)) {
    const missing = DEPLOY_REQUIRED_PERMS.filter(p => !permHas(me?.permissions, p.bit)).map(p => p.label);
    if (missing.length) {
      return { ok: false, error: `I'm missing permissions: **${missing.join(", ")}** — grant them (or Administrator) and run this again.` };
    }
  }

  const layout = await ensureDeploymentLayout(guild, row).catch(e => {
    logError("deployment layout failed", e);
    return null;
  });
  if (!layout) {
    await deps.store.upsertDeployment({ guildId, status: row.status, lastError: "layout reconcile failed" }).catch(() => inc("ops.deploy_error"));
    return { ok: false, error: "Couldn't create the Characterly surfaces — check my permissions and try again." };
  }
  await deps.store.upsertDeployment({
    guildId,
    status: "active",
    categoryId: layout.categoryId,
    marketplaceChannelId: layout.marketplaceChannelId,
    adopteesChannelId: layout.adopteesChannelId,
    loginChannelId: layout.loginChannelId,
    deployedBy: deployerId ?? row.deployedBy,
    lastError: null,
  }).catch(() => inc("ops.deploy_error"));
  await refreshDeploymentCache(deps.store);
  await ensureDeploymentLoginCard(deps, layout.loginChannelId).catch(() => inc("ops.login_card_error"));

  // Fan the whole catalog into the fresh forum. Best-effort: individual post
  // failures land as retryable rows for the sync sweep.
  const dep = deploymentFor(guildId);
  const res = dep
    ? await postActiveListingsToDeployments(deps.fetchChannel, [dep], deps.store,
        async (uid) => {
          const u = await deps.fetchUser?.(uid).catch(() => null);
          return u?.globalName ?? u?.username ?? null;
        }, 100)
    : { posted: 0, failed: 0 };
  inc("ops.deploy");
  return { ok: true, created: layout.created, posted: res.posted, failed: res.failed };
}

/** `/marketplace remove` + ops revoke: the row flips to disabled, live mirror
 *  posts archive (a dead server's catalog shouldn't keep selling), hosted
 *  adoptee threads lock+archive and rehome to the house, and the in-process
 *  cache forgets the surfaces.
 *
 *  The adoptee drain is not optional hygiene: once the row is disabled the
 *  channel leaves `adopteesChannelIds()`, so `isAdopteeThread` stops matching
 *  and a still-open thread falls into the normal guild pipeline — private
 *  DM-scope conversations would be archived as partner-server messages, and
 *  that server's admins could keep reading them. */
export async function removeDeployment(deps: OpsDeps, guildId: string): Promise<{ ok: boolean; error?: string; archived?: number }> {
  if (guildId === config.houseGuildId) return { ok: false, error: "The house server can't be removed." };
  const row = await deps.store.deploymentFor(guildId).catch(() => null);
  if (!row) return { ok: false, error: "No deployment exists for this server." };
  await deps.store.setDeploymentStatus(guildId, "disabled").catch(() => inc("ops.deploy_error"));
  const live = (await deps.store.listingPostsForGuild(guildId).catch(() => [] as Awaited<ReturnType<MemoryStore["listingPostsForGuild"]>>))
    .filter(p => p.status === "live" && p.threadId);
  let archived = 0;
  if (live.length) {
    archived = await archiveListingPosts(deps.fetchChannel, live, {
      note: "This server has left the Characterly marketplace — this listing is archived here. It's still live on the main shelf.",
    });
    for (const p of live) await deps.store.markListingPost(p.listingId, guildId, "archived").catch(() => inc("market.post_registry_error"));
  }
  // Adoptee threads homed here: seal and rehome. The row's location fields
  // clear so the next ensure (backfill sweep or interactive touch) rebuilds
  // a fresh thread under the house #adoptees.
  let rehomed = 0;
  for (const adoption of await deps.store.adoptionsInGuild(guildId).catch(() => [] as Awaited<ReturnType<MemoryStore["adoptionsInGuild"]>>)) {
    if (adoption.chatThreadId) {
      const thread = await deps.fetchChannel(adoption.chatThreadId).catch(() => null) as TicketThreadLike | null;
      if (thread) {
        await thread.setLocked?.(true).catch(() => {});
        await thread.setArchived?.(true).catch(() => {});
      }
    }
    await deps.store.setAdoptionLocation(adoption.id, { guildId: null, channelId: null, threadId: null }).catch(() => inc("ops.adoptee_thread_error"));
    rehomed++;
  }
  await refreshDeploymentCache(deps.store);
  inc("ops.deploy_remove");
  return { ok: true, archived: archived + rehomed };
}

/** Deployment sync sweep — the janitor for mirrors: ensures partner layouts
 *  still exist (deleted forum → recreate + re-stamp the row), retries failed
 *  posts, and backfills listings a deployment missed. Runs alongside the tag
 *  sweep; the kill switch short-circuits it. */
export async function syncDeployments(deps: OpsDeps): Promise<void> {
  await refreshDeploymentCache(deps.store).catch(() => inc("ops.deploy_error"));
  // Partner-side mirror work is the flag's domain — off means no reconcile,
  // no backfill, no fan-out. The cache refresh above and the house floodgate
  // below are NOT partner work: Discord's ~1,000 active-thread ceiling
  // applies to the house whether or not deployments exist, so the gauge
  // must keep sweeping either way.
  if (config.marketDeployEnabled) {
    // Seed the mirror map from forum_thread_id BEFORE the missing-posts queue
    // computes — pre-v59 listings have no listing_posts row, and without this
    // they all read "missing" in the house deployment: the sweep would post a
    // duplicate house thread for every one of them.
    if (config.houseGuildId) {
      await deps.store.backfillListingPosts(config.houseGuildId).catch(e => {
        inc("ops.sweep_error"); logError("listing_posts backfill failed", e);
      });
    }
    const partners = deploymentRows().filter(d => d.status === "active" && d.guildId !== config.houseGuildId);
    for (const dep of partners) {
      const guild = await deps.fetchGuild(dep.guildId).catch(() => null);
      if (!guild) {
        await deps.store.setDeploymentStatus(dep.guildId, dep.status, "guild unreachable").catch(() => inc("ops.deploy_error"));
        continue;
      }
      // Self-heal: an admin deleting #characters shouldn't silently freeze the
      // mirror — the layout reconcile re-creates and re-stamps the row.
      const forumOk = dep.marketplaceChannelId
        ? await deps.fetchChannel(dep.marketplaceChannelId).then(c => !!c).catch(() => false)
        : false;
      const adopteesOk = dep.adopteesChannelId
        ? await deps.fetchChannel(dep.adopteesChannelId).then(c => !!c).catch(() => false)
        : false;
      const loginOk = dep.loginChannelId
        ? await deps.fetchChannel(dep.loginChannelId).then(c => !!c).catch(() => false)
        : false;
      if (!forumOk || !adopteesOk || !loginOk) {
        const layout = await ensureDeploymentLayout(guild, dep).catch(() => null);
        if (layout) {
          await deps.store.upsertDeployment({
            guildId: dep.guildId,
            status: dep.status,
            categoryId: layout.categoryId,
            marketplaceChannelId: layout.marketplaceChannelId,
            adopteesChannelId: layout.adopteesChannelId,
            loginChannelId: layout.loginChannelId,
            lastError: null,
          }).catch(() => inc("ops.deploy_error"));
          await refreshDeploymentCache(deps.store).catch(() => inc("ops.deploy_error"));
          // House #log-in is the verify gate, not a deployment signpost —
          // never post the partner card there even if the house self-heals.
          if (!isHouse(dep.guildId)) {
            await ensureDeploymentLoginCard(deps, layout.loginChannelId).catch(() => inc("ops.login_card_error"));
          }
          // A recreated forum took every mirror thread it hosted down with it —
          // the rows still read 'live' against dead threads and would never
          // requeue. Clear them so the backfill below reposts the catalog.
          if (layout.marketplaceChannelId !== dep.marketplaceChannelId) {
            await deps.store.resetListingPostsForGuild(dep.guildId).catch(e => {
              inc("ops.sweep_error"); logError("listing_posts reset failed", e);
            });
          }
        } else {
          await deps.store.setDeploymentStatus(dep.guildId, dep.status, "layout reconcile failed").catch(() => inc("ops.deploy_error"));
        }
      }
    }
    // Backfill + retry: every active deployment gets the catalog rows it's missing.
    const active = deploymentRows().filter(d => d.status === "active");
    await postActiveListingsToDeployments(deps.fetchChannel, active, deps.store,
      async (uid) => {
        const u = await deps.fetchUser?.(uid).catch(() => null);
        return u?.globalName ?? u?.username ?? null;
      }).catch(e => { inc("ops.sweep_error"); logError("deployment sync fan-out failed", e); });
  }

  // Floodgate — measure house thread pressure on every pass, deployments
  // or not (see the flag note above).
  await ensureAdopteePressureCard(deps).catch(e => { inc("ops.pressure_error"); logError("pressure card reconcile failed", e); });
}
export function startDeploymentSync(deps: OpsDeps, intervalMs = 300_000): { stop: () => void } {
  return registerSweep("deployments", () => syncDeployments(deps), intervalMs);
}

/** Re-attach adoptee threads when a member joins a DEPLOYED partner server —
 *  the house has its own hook; this one only handles threads homed in the
 *  guild joined. */
export async function handleDeploymentMemberAdd(member: MemberLike, deps: OpsDeps): Promise<void> {
  if (member.user.bot) return;
  const dep = deploymentFor(member.guild.id);
  if (!dep || dep.status !== "active" || dep.guildId === config.houseGuildId) return;
  await ensureAdopteeThreadsForUser(member.user.id, deps, { guildId: dep.guildId }).catch(e => {
    inc("ops.adoptee_thread_error"); logError("partner member-add adoptee ensure failed", e);
  });
}

/** Leaving a deployed guild drops private-thread membership silently — lock
 *  + archive the threads hosted there so partner admins aren't left reading
 *  a dead member's chats. The adoption rows stay (chat_guild_id intact);
 *  rejoin re-opens, and other surfaces relocate to the house on next touch. */
export async function handleDeploymentMemberRemove(member: MemberLike, deps: OpsDeps): Promise<void> {
  if (member.user.bot) return;
  const dep = deploymentFor(member.guild.id);
  if (!dep || dep.status !== "active" || dep.guildId === config.houseGuildId) return;
  const rows = await deps.store.activeAdoptionsForUser?.(member.user.id, dep.guildId)
    .catch(() => []) ?? [];
  for (const row of rows) {
    const tid = row.adoption.chatThreadId;
    if (!tid) continue;
    const thread = await deps.fetchChannel(tid).catch(() => null) as TicketThreadLike | null;
    if (!thread) continue;
    await thread.setLocked?.(true).catch(() => {});
    await thread.setArchived?.(true).catch(() => {});
    inc("ops.adoptee_thread_departed");
  }
}
