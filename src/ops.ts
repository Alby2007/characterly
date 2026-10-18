import os from "node:os";
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, ForumLayoutType, ModalBuilder, PermissionFlagsBits, TextInputBuilder, TextInputStyle, type ButtonInteraction, type ChatInputCommandInteraction, type ModalSubmitInteraction } from "discord.js";
import { config } from "./config.js";
import { inc } from "./metrics.js";
import { logError, redactSecrets } from "./secrets.js";
import { checkListingFields, checkMessageContent } from "./safety.js";
import { CURATED_TAGS, marketplaceAssetPath, postListingThread } from "./marketplace.js";
import { uploadAvatarFile } from "./avatars.js";
import { SEED_LISTINGS } from "./seed-personas.js";
import { sendAsCompanionInChannel } from "./webhooks.js";
import type { MemoryStore } from "./database.js";
import type { Companion, CompanionAdoption } from "./types.js";

// ── House ops ────────────────────────────────────────────────────────────────
// The bot is also the private operator of OUR community server and its own
// host — member ops, deterministic automod, channel layout, and host health.
// Every path gates on HOUSE_GUILD_ID: this is never a per-guild feature, and
// /ops is allowlisted to OPS_USER_IDS (person-level — it controls the box).
// Lives outside index.ts so it can be unit-tested; index.ts wires the
// listeners and passes live singletons through OpsDeps.

export const isHouse = (guildId: string | null | undefined): boolean =>
  !!config.houseGuildId && guildId === config.houseGuildId;

/** True when the channel is a thread inside the marketplace forum — the
 *  listing comment surface. Used to keep comments out of the memory/reply
 *  pipeline (index.ts) and to scope the "Report message" context command. */
export const isMarketplaceThread = (channel: { isThread?(): boolean; parentId?: string | null } | null | undefined): boolean =>
  !!channel?.isThread?.() && channel.parentId === config.marketplaceChannelId;

/** True when the channel is a thread under the house's #adoptees channel —
 *  an adopted companion's private chat surface (v54). Env id wins; the name
 *  match covers deployments that created the channel before the env existed
 *  (the layout reconciles it under the marketplace category either way). */
export const isAdopteeThread = (channel: { isThread?(): boolean; parentId?: string | null; parent?: { name?: string | null } | null } | null | undefined): boolean => {
  if (!channel?.isThread?.()) return false;
  if (config.houseAdopteesChannelId) return channel.parentId === config.houseAdopteesChannelId;
  return normName(channel.parent?.name ?? "") === "adoptees";
};

// Narrow structural shapes — tests hand fakes, index.ts casts the real objects.
interface ForumTagLike {
  id: string;
  name: string;
  moderated?: boolean | null;
}

interface ThreadLike {
  id: string;
  appliedTags?: string[];
  createdTimestamp?: number | null;
  setAppliedTags?(tags: string[]): Promise<unknown>;
}

/** The ticket thread surface — created private, joined by the opener. */
interface TicketThreadLike {
  id: string;
  members?: { add(userId: string): Promise<unknown> };
  send(payload: unknown): Promise<unknown>;
  setLocked?(locked: boolean): Promise<unknown>;
  setArchived?(archived: boolean): Promise<unknown>;
  /** Real threads — the manage-row backfill inspects recent messages.
   *  discord.js Collections yield [snowflake, message] pairs; plain iterables
   *  yield messages — both shapes are unwrapped at the call site. */
  messages?: {
    fetch(opts: { limit: number }): Promise<Iterable<unknown>>;
  };
}

interface SendableChannel {
  send(payload: unknown): Promise<unknown>;
  /** Present on real text channels — the verify-gate idempotency probe.
   *  discord.js Collections yield [snowflake, message] pairs; plain iterables
   *  yield messages — both shapes are unwrapped at the call site. */
  messages?: {
    fetch(opts: { limit: number }): Promise<Iterable<
      { author?: { id?: string }; components?: unknown[]; embeds?: unknown[]; edit?(o: { embeds: unknown[] }): Promise<unknown>; delete?(): Promise<unknown> } |
      [unknown, { author?: { id?: string }; components?: unknown[]; embeds?: unknown[]; edit?(o: { embeds: unknown[] }): Promise<unknown>; delete?(): Promise<unknown> }]
    >>;
  };
  /** Forum channels only — the tag taxonomy the marketplace sweep manages. */
  availableTags?: ForumTagLike[];
  threads?: {
    fetchActive(): Promise<{ threads: Map<string, ThreadLike> | Iterable<[string, ThreadLike]> | Iterable<ThreadLike> }>;
    /** Text channels only — the ticket system creates private threads. */
    create?(opts: { name: string; type?: number; invitable?: boolean; autoArchiveDuration?: number }): Promise<TicketThreadLike>;
  };
}

export interface GuildChannelLike {
  id: string;
  name: string;
  type: number;
  parentId?: string | null;
  /** Forum channels carry this — reconciled against WANTED_LAYOUT so the
   * marketplace rides Gallery View even after a manual flip. */
  defaultForumLayout?: number;
  edit?(opts: { defaultForumLayout?: number }): Promise<unknown>;
  /** Category's own overwrites — copied to created children so a rebuilt
   * mods/ops channel doesn't come up world-readable. */
  /** True when the channel's overwrites match its parent's (Discord "synced").
   *  Read BEFORE mutating the parent — a stale-cache mismatch can read false
   *  post-edit. */
  permissionsLocked?: boolean | null;
  permissionOverwrites?: {
    // Real discord.js Collections iterate [id, overwrite] tuples; fakes pass
    // bare overwrite arrays — overwriteEntries() below normalizes both.
    cache?: Iterable<unknown>;
    edit?(id: string, perms: { [perm: string]: boolean | null }): Promise<unknown>;
  };
}

export interface GuildLike {
  id: string;
  channels: {
    cache: { find(fn: (c: GuildChannelLike) => boolean): GuildChannelLike | undefined };
    create(opts: { name: string; type: number; parent?: string; permissionOverwrites?: Array<{ id: string; allow: unknown; deny: unknown }> }): Promise<GuildChannelLike>;
  };
  roles?: {
    cache?: { find(fn: (r: { id: string; name: string }) => boolean): { id: string; name: string } | undefined };
  };
}

export interface MemberLike {
  pending?: boolean | null;
  user: { id: string; bot?: boolean | null; username?: string; createdTimestamp?: number };
  guild: { id: string };
  roles: {
    add(id: string): Promise<unknown>;
    remove?(id: string): Promise<unknown>;
    cache?: { has(id: string): boolean };
  };
  kick?(reason?: string): Promise<unknown>;
}

export interface AutomodMessage {
  id: string;
  guildId: string | null;
  channelId: string;
  content: string;
  url?: string;
  author: { id: string; bot?: boolean | null; username?: string; createdTimestamp?: number };
  member: {
    permissions: { has(flag: bigint): boolean };
    timeout?(ms: number, reason?: string): Promise<unknown>;
  } | null;
  mentions: { users: { size: number }; roles?: { size: number }; everyone: boolean };
  delete(): Promise<unknown>;
}

export interface OpsDeps {
  store: MemoryStore;
  fetchChannel: (id: string) => Promise<SendableChannel | null>;
  fetchGuild: (id: string) => Promise<GuildLike | null>;
  /** Guild member lookups for the verify button + link sweep. */
  fetchMember: (guildId: string, userId: string) => Promise<MemberLike | null>;
  listMembers: (guildId: string) => Promise<MemberLike[]>;
  /** The bot's own user id — gate-card idempotency checks message authorship. */
  botId: string | null;
  exec: (cmd: string) => Promise<{ stdout: string; stderr: string }>;
  exit: (code: number) => void;
  /** Timed SELECT 1 — index.ts runs it on the shared pool. */
  dbPing: () => Promise<number>;
  /** Mean event-loop lag in ms since the last sample (index.ts owns the histogram). */
  lagMs: () => number;
  gitSha: string | null;
}

// Module deps for handleOpsCommand (commands.ts can't receive them) — index.ts
// calls initOps once at ClientReady. Direct functions always take deps.
let opsDeps: OpsDeps | null = null;
export function initOps(d: OpsDeps): void { opsDeps = d; }
/** Module-level access for interaction handlers in commands.ts — ops deps
 *  are wired at ClientReady, long before any interaction can arrive. */
export function getOpsDeps(): OpsDeps | null { return opsDeps; }

// Test-only: raid/burst windows and breach latches are module state.
export function resetOpsState(): void {
  joinTimes.length = 0;
  lastRaidAlertAt = 0;
  welcomed.clear();
  burstWindow.clear();
  lastActedAt.clear();
  activeBreaches.clear();
}

async function opsChannel(deps: OpsDeps): Promise<SendableChannel | null> {
  if (!config.opsChannelId) return null;
  return deps.fetchChannel(config.opsChannelId).catch(() => null);
}

/** Alerts never ping — `parse: []` mutes any mentions inside the text. */
export async function opsAlert(deps: OpsDeps, text: string): Promise<void> {
  const ch = await opsChannel(deps);
  await ch?.send({ content: text.slice(0, 1900), allowedMentions: { parse: [] } })
    .catch(e => { inc("ops.alert_error"); logError("ops alert send failed", e); });
}

// ── Member ops ───────────────────────────────────────────────────────────────

const RAID_WINDOW_MS = 60_000;
const joinTimes: number[] = [];
let lastRaidAlertAt = 0;

// Member now means *verified* — the role is granted by the gate-channel
// button after a linked-account check, not on join/screening. onboard is
// welcome-post only: point them at rules → verify. Returns whether a greeting
// actually posted so the screening flip can retry joins the raid window ate.
const welcomed = new Set<string>();

async function onboardMember(member: MemberLike, deps: OpsDeps, opts: { welcome?: boolean } = {}): Promise<boolean> {
  // `welcome:false` — a hot raid window shouldn't flood the welcome channel
  // with one public greeting per raider.
  if (opts.welcome === false || !config.houseWelcomeChannelId) return false;
  const ch = await deps.fetchChannel(config.houseWelcomeChannelId).catch(() => null);
  if (!ch) return false;
  const rules = config.houseRulesChannelId ? `<#${config.houseRulesChannelId}>` : "the rules";
  const gate = config.houseVerifyChannelId ? `, then verify in <#${config.houseVerifyChannelId}> to unlock the rest` : "";
  return ch.send({
    content: `Welcome <@${member.user.id}> to Characterly — read ${rules} first${gate}. Your personal companion starts in the bot's DMs.`,
    allowedMentions: { users: [member.user.id] },
  }).then(() => true)
    .catch(e => { inc("ops.welcome_error"); logError("house welcome failed", e); return false; });
}

export async function handleHouseMemberAdd(member: MemberLike, deps: OpsDeps): Promise<void> {
  if (!isHouse(member.guild.id) || member.user.bot) return;
  // Raid bookkeeping counts every join — pending or not — since a raid is a
  // join-rate problem. Alert once per hot window; auto-kick only when armed.
  const now = Date.now();
  joinTimes.push(now);
  while (joinTimes.length && now - joinTimes[0] > RAID_WINDOW_MS) joinTimes.shift();
  const raidHot = joinTimes.length > config.automodRaidJoins;
  if (raidHot) {
    if (config.automodRaidKick && member.kick) {
      await member.kick("automod: raid window").catch(e => logError("raid kick failed", e));
      await opsAlert(deps, `🚨 **Raid** — auto-kicked <@${member.user.id}> (${joinTimes.length} joins in 60s)`);
      inc("ops.raid_kick");
      return;
    }
    if (now - lastRaidAlertAt > RAID_WINDOW_MS) {
      lastRaidAlertAt = now;
      await opsAlert(deps, `🚨 **Possible raid** — ${joinTimes.length} joins in 60s (auto-kick OFF; set AUTOMOD_RAID_KICK=1 to arm)`);
      inc("ops.raid_alert");
    }
  }
  // Welcome at join, screening or not — pending members can read channels even
  // though they can't interact, so "read rules → verify" lands when it matters.
  if (await onboardMember(member, deps, { welcome: !raidHot })) welcomed.add(member.user.id);
  // Deferred adoptee threads — adopters who joined the house AFTER adopting
  // elsewhere (import paths) get their private threads opened on arrival.
  await ensureAdopteeThreadsForUser(member.user.id, deps).catch(e => {
    inc("ops.adoptee_thread_error"); logError("member-add adoptee ensure failed", e);
  });
}

export async function handleHouseMemberUpdate(
  // `roles` is absent on uncached partials — treat unknown as "no role held"
  // so a verified grant still triggers the adoptee-threads re-attach.
  oldMember: Pick<MemberLike, "pending"> & { roles?: MemberLike["roles"] },
  newMember: MemberLike,
  deps: OpsDeps,
): Promise<void> {
  if (!isHouse(newMember.guild.id) || newMember.user.bot) return;
  // The screening flip is a fallback welcome: joins already greet on add, so
  // this only fires for members the raid window suppressed (or a send that
  // failed). `welcomed` dedupes; strict === true on the old side so an
  // uncached partial can't greet an existing member.
  if (oldMember.pending === true && newMember.pending === false) {
    if (!welcomed.has(newMember.user.id) && await onboardMember(newMember, deps)) welcomed.add(newMember.user.id);
    // Screening just cleared — retry deferred adoptee threads in case the
    // pending member couldn't be added to a private thread at join.
    await ensureAdopteeThreadsForUser(newMember.user.id, deps).catch(e => {
      inc("ops.adoptee_thread_error"); logError("member-update adoptee ensure failed", e);
    });
  }
  // Verification lands as a Member-role grant — and it's the moment the
  // adoptee-threads re-attach becomes possible: rejoiners arrive role-less
  // (roles don't persist across leave/join) and can't be re-added to private
  // threads under a @everyone-hidden parent until they hold Member. Covers
  // verify-gate grants and manual mod grants alike.
  const memberRole = config.houseMemberRoleId;
  if (memberRole
    && newMember.roles?.cache?.has?.(memberRole) === true
    && oldMember.roles?.cache?.has?.(memberRole) !== true) {
    await ensureAdopteeThreadsForUser(newMember.user.id, deps).catch(e => {
      inc("ops.adoptee_thread_error"); logError("member-role adoptee ensure failed", e);
    });
  }
}

export async function handleHouseMemberRemove(member: MemberLike, deps: OpsDeps): Promise<void> {
  if (!isHouse(member.guild.id) || member.user.bot) return;
  welcomed.delete(member.user.id); // a rejoin earns a fresh welcome
  await opsAlert(deps, `👋 **${member.user.username ?? member.user.id}** left the server.`);
}

// ── Verify gate ──────────────────────────────────────────────────────────────
// Member = verified: a persistent card in HOUSE_VERIFY_CHANNEL_ID carries the
// house:verify button; clicking it checks for a linked Characterly account and
// grants the role. The lobby + #faqs + #support-ticket is all @everyone sees,
// so the card must read sensibly to members still pending rules screening.

const VERIFY_CUSTOM_ID = "house:verify";

// Clickwrap consent — bump TERMS_VERSION in the same commit that edits the
// documents: an acceptance is only valid for the version the user saw, and the
// button customId carries it (house:consent:<v>) so the recorded version is
// honest even if a stale ephemeral survives a doc update. URLs mirror
// website/src/config.js LINKS — keep them in step.
export const TERMS_VERSION = 1;
// Hosted charter pages on the site (rendered from the repo's TERMS.md /
// PRIVACY.md at build time — content stays single-sourced there).
export const TERMS_URL = `${config.siteUrl.replace(/\/+$/, "")}/terms`;
export const PRIVACY_URL = `${config.siteUrl.replace(/\/+$/, "")}/privacy`;
const CONSENT_CUSTOM_ID = "house:consent";

/** Post the verify card if the gate channel doesn't already carry one —
 *  and delete duplicate copies of it while we're looking. */
export async function ensureVerifyGate(deps: OpsDeps): Promise<boolean> {
  if (!config.houseVerifyChannelId) return false;
  const ch = await deps.fetchChannel(config.houseVerifyChannelId).catch(() => null);
  if (!ch) return false;
  const recent = await ch.messages?.fetch({ limit: 20 }).catch(() => null);
  if (recent) {
    let kept = false;
    for (const entry of recent) {
      // discord.js message fetches return a Collection — iterating yields
      // [snowflake, Message] pairs, not messages. Unwrap before probing.
      const m = (Array.isArray(entry) ? entry[1] : entry) as { author?: { id?: string }; components?: unknown[]; delete?(): Promise<unknown> };
      if (m.author?.id !== deps.botId || !JSON.stringify(m.components ?? []).includes(VERIFY_CUSTOM_ID)) continue;
      if (kept) await m.delete?.().catch(() => {}); // stale duplicate card — self-heal
      else kept = true;
    }
    if (kept) return false; // card already up
  }
  await ch.send({
    embeds: [new EmbedBuilder()
      .setTitle("Verify your Characterly account")
      .setDescription(
        "This server is members-only past this point — link your free Characterly account to unlock it.\n\n" +
        "**How:** create an account at " + config.siteUrl + ", run `/link` in the bot's DMs, then click below.\n" +
        "_Just joined? Accept the rules first — the button unlocks once you have._\n" +
        "_Verifying asks you to accept our Terms & Privacy Policy._",
      )],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(VERIFY_CUSTOM_ID).setLabel("Verify — I'm a Characterly member").setStyle(ButtonStyle.Success),
    )],
    allowedMentions: { parse: [] },
  });
  return true;
}

/** house:* buttons — routed from handleMemoryButton; deps are module-init'd.
 *  house:verify starts the gate; house:consent:<v> is the clickwrap "I accept"
 *  inside the ephemeral prompt. Both share the same gate chain — customIds are
 *  forgeable and member/account state moves between clicks, so the consent
 *  click re-checks everything before recording + granting. */
export async function handleHouseButton(interaction: ButtonInteraction): Promise<unknown> {
  const deps = opsDeps;
  if (!deps) return interaction.reply({ content: "Ops isn't initialized yet — the bot is still starting.", ephemeral: true });
  const consentClick = interaction.customId.startsWith(CONSENT_CUSTOM_ID + ":");
  if (interaction.customId !== VERIFY_CUSTOM_ID && !consentClick) return;
  if (!isHouse(interaction.guildId)) {
    return interaction.reply({ content: "That button only works in our community server.", ephemeral: true });
  }
  if (!config.houseMemberRoleId) {
    return interaction.reply({ content: "Verification isn't configured yet — tell an admin HOUSE_MEMBER_ROLE_ID is unset.", ephemeral: true });
  }
  const member = await deps.fetchMember(interaction.guildId!, interaction.user.id).catch(() => null);
  if (!member) return interaction.reply({ content: "Couldn't find you in this server — try rejoining.", ephemeral: true });
  if (member.pending === true) {
    return interaction.reply({ content: "Accept the server rules first — then click again.", ephemeral: true });
  }
  // null = definitively unlinked; a throw = the lookup broke — tell them to
  // retry rather than confidently claiming "no account" during an outage.
  const account = await deps.store.accountForDiscordUser(interaction.user.id).catch(() => undefined);
  if (account === undefined) {
    return interaction.reply({ content: "Couldn't check your account right now — try again in a moment.", ephemeral: true });
  }
  // BYOK-only users adopt without linking — verify on the strength of a
  // personal key; consent records against discord_user_id (account_id null).
  if (!account && !(await deps.store.getGuildKey(`dm:${interaction.user.id}`).catch(() => null))) {
    return interaction.reply({
      content: `No linked Characterly account found — create one free at ${config.siteUrl}, run \`/link\` in the bot's DMs, then click **Verify** again.`,
      ephemeral: true,
    });
  }
  const accountId = account?.id ?? null;

  if (consentClick) {
    // Record the version stamped on THIS button — it's the one the user saw.
    // A stale button still records honestly, but the version check below will
    // re-prompt rather than granting on superseded terms.
    const consentVersion = Number(interaction.customId.slice(CONSENT_CUSTOM_ID.length + 1));
    if (Number.isInteger(consentVersion) && consentVersion >= 1) {
      const recorded = await deps.store.recordTosAcceptance(
        interaction.user.id, accountId, consentVersion, "discord_verify",
      ).then(() => true).catch(e => {
        inc("ops.consent_error");
        logError("consent record failed", e);
        return false;
      });
      if (!recorded) {
        return interaction.reply({ content: "Couldn't record your acceptance — click **I accept** again in a moment.", ephemeral: true });
      }
      inc("ops.consent_accepted");
    }
  }

  // Consent gate — applies to verify clicks AND post-record consent clicks.
  // accountId is passed so a web-signup acceptance on the linked account
  // counts here — one acceptance covers the whole product.
  const acceptance = await deps.store.tosAcceptance(interaction.user.id, accountId).catch(() => undefined);
  if (acceptance === undefined) {
    return interaction.reply({ content: "Couldn't check your acceptance status — try again in a moment.", ephemeral: true });
  }
  if (!acceptance || acceptance.version < TERMS_VERSION) {
    inc("ops.consent_prompted");
    return interaction.reply({
      content:
        `Before you're in, please read and accept the **[Terms of Service](${TERMS_URL})** and **[Privacy Policy](${PRIVACY_URL})**.\n\n` +
        `Clicking **I accept** means you've read and agree to both — it's recorded against your account (v${TERMS_VERSION}).`,
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`${CONSENT_CUSTOM_ID}:${TERMS_VERSION}`).setLabel("I accept the Terms & Privacy Policy").setStyle(ButtonStyle.Primary),
      )],
      ephemeral: true,
    });
  }

  if (member.roles.cache?.has(config.houseMemberRoleId)) {
    return interaction.reply({ content: "Already verified — you're in.", ephemeral: true });
  }
  const granted = await member.roles.add(config.houseMemberRoleId).then(() => true).catch(e => {
    inc("ops.verify_error");
    logError("verify role grant failed", e);
    return false;
  });
  if (!granted) {
    return interaction.reply({ content: "The role grant didn't stick — tell an admin to check my permissions.", ephemeral: true });
  }
  inc("ops.verified");
  await opsAlert(deps, `✅ <@${interaction.user.id}> verified — Member granted.`);
  return interaction.reply({ content: "Verified — the rest of the server is open to you. Welcome to Characterly!", ephemeral: true });
}

// ── Link sweep ───────────────────────────────────────────────────────────────
// Unlink is a website-side write the bot can't observe — so the sweep polls:
// every interval, every holder of the Member role is re-checked against
// accountForDiscordUser; a null (unlinked) result revokes the role. Bounded
// by the account cache (60s) + sweep interval — worst-case ~6 min lag.

export async function runMemberLinkSweep(deps: OpsDeps): Promise<number> {
  const roleId = config.houseMemberRoleId;
  if (!config.houseGuildId || !roleId || !deps.store.creditsSupported) return 0; // self-host: synthetic accounts for everyone
  const members = await deps.listMembers(config.houseGuildId).catch(e => {
    inc("ops.sweep_error");
    logError("member link sweep fetch failed", e);
    return [] as MemberLike[];
  });
  let revoked = 0;
  for (const m of members) {
    if (m.user.bot || !m.roles.cache?.has(roleId) || !m.roles.remove) continue;
    // null means definitively unlinked; a THROW means "unknown" — a transient
    // DB hiccup must never masquerade as unlinking, or an outage mass-revokes
    // every Member role. Fail-safe is keep-the-role.
    const account = await deps.store.accountForDiscordUser(m.user.id).catch(e => {
      inc("ops.sweep_error");
      logError("member link check failed", e);
      return undefined;
    });
    if (account === undefined) continue;
    if (account) {
      // Linked but unconsented — the verify gate only admits accounts that have
      // accepted the current Terms/Privacy version, so Members without one are
      // out of policy (e.g. verified before the gate existed, or the docs
      // bumped). Same fail-safe as the link check: a lookup error keeps the
      // role — only a definitive missing/stale acceptance revokes.
      const acceptance = await deps.store.tosAcceptance(m.user.id, account.id).catch(e => {
        inc("ops.sweep_error");
        logError("member consent check failed", e);
        return undefined;
      });
      if (acceptance === undefined || (acceptance && acceptance.version >= TERMS_VERSION)) continue;
      await m.roles.remove(roleId).catch(e => logError("member role revoke failed", e));
      revoked++;
      inc("ops.consent_revoked");
      await opsAlert(deps, `🔻 <@${m.user.id}> hasn't accepted Terms & Privacy Policy v${TERMS_VERSION} — Member role removed (re-verify in the gate channel).`);
      continue;
    }
    await m.roles.remove(roleId).catch(e => logError("member role revoke failed", e));
    revoked++;
    inc("ops.verify_revoked");
    await opsAlert(deps, `🔻 <@${m.user.id}> unlinked their Characterly account — Member role removed.`);
  }
  return revoked;
}

export function startLinkSweep(deps: OpsDeps): { stop: () => void } {
  const timer = setInterval(() => {
    runMemberLinkSweep(deps).catch(e => { inc("ops.sweep_error"); logError("member link sweep failed", e); });
  }, config.hostHealthIntervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

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

export async function runTagSweep(deps: OpsDeps): Promise<number> {
  if (!config.marketplaceChannelId) return 0;
  const channel = await deps.fetchChannel(config.marketplaceChannelId).catch(() => null);
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

  // Bulk inputs — three queries per sweep regardless of thread count.
  const listings = await deps.store.listActiveListingsWithThreads().catch(() => [] as Awaited<ReturnType<MemoryStore["listActiveListingsWithThreads"]>>);
  const byThread = new Map(listings.filter(l => l.forumThreadId).map(l => [l.forumThreadId!, l] as const));
  const stats = topId ? await deps.store.ratingStatsByListing().catch(() => new Map<number, { avg: number; count: number }>()) : new Map<number, { avg: number; count: number }>();
  const velocity = trendId ? await deps.store.recentAdoptionCounts(config.marketTrendingWindowH * 3_600_000).catch(() => new Map<number, number>()) : new Map<number, number>();

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

export function startTagSweep(deps: OpsDeps): { stop: () => void } {
  const timer = setInterval(() => {
    runTagSweep(deps).catch(e => { inc("ops.sweep_error"); logError("marketplace tag sweep failed", e); });
  }, config.hostHealthIntervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

// ── Auto-moderation ──────────────────────────────────────────────────────────
// Deterministic rules, house guild only. Runs before archive/LLM work so a
// deleted scam never enters the memory pipeline or spends a credit.

const INVITE_RE = /(?:discord\.gg\/|discord(?:app)?\.com\/invites?\/)/i;
const LINK_RE = /https?:\/\/[^\s<>"']+/i;
const SCAM_PATTERNS: Array<{ rule: string; re: RegExp }> = [
  { rule: "nitro scam", re: /\b(?:free|claim|redeem|won|win)\b[^.\n]{0,30}\bnitro\b|\bnitro\b[^.\n]{0,30}\b(?:free|claim|redeem|giveaway)\b/i },
  { rule: "crypto scam", re: /\b(?:airdrop|seed[\s-]?phrase|wallet[\s-]?drain|connect\s+your\s+wallet|claim\s+(?:your\s+)?(?:crypto|tokens?))\b/i },
  { rule: "steam scam", re: /\bsteam\b[^.\n]{0,30}\b(?:gift|giveaway|free)\b|\b(?:free|won|win)\b[^.\n]{0,30}\bsteam\b/i },
  { rule: "earn-money scam", re: /\b(?:earn|make)\s+\$\s?\d[\d,]*\s*(?:a|per|every)\s+(?:day|week|hour|month)\b/i },
];

const burstWindow = new Map<string, number[]>();
// Per-author action cooldown — a sustained spammer re-trips the rules on
// every message; within the cooldown we still delete but skip the repeat
// timeout + alert so the ops channel isn't flooded.
const ACTION_COOLDOWN_MS = 60_000;
const lastActedAt = new Map<string, number>();

/** Returns true when automod acted (message deleted / member sanctioned) —
 * the caller skips all further handling for the message. */
export async function automodMessage(message: AutomodMessage, deps: OpsDeps): Promise<boolean> {
  if (!isHouse(message.guildId)) return false;
  if (message.author.bot) return false;
  // Manage Messages holders are trusted — a mod posting an invite link to
  // the rules channel shouldn't eat a timeout.
  if (message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) return false;

  const jump = message.url ?? `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
  const excerpt = message.content.trim().slice(0, 120).replace(/\n+/g, " ");

  const act = async (rule: string, timeoutMs?: number): Promise<boolean> => {
    const now = Date.now();
    const last = lastActedAt.get(message.author.id) ?? 0;
    lastActedAt.set(message.author.id, now);
    if (lastActedAt.size > 10_000) lastActedAt.clear();
    if (now - last < ACTION_COOLDOWN_MS) {
      // Same offender, same burst — keep deleting, don't re-alert/re-timeout.
      await message.delete().catch(() => {});
      inc("ops.automod_suppressed");
      return true;
    }
    const deleted = await message.delete().then(() => true).catch(() => false);
    let timedOut = false;
    if (timeoutMs && message.member?.timeout) {
      timedOut = await message.member.timeout(timeoutMs, `automod: ${rule}`).then(() => true).catch(() => false);
    }
    const action = [deleted && "deleted", timedOut && `timeout ${Math.round(timeoutMs! / 60_000)}m`].filter(Boolean).join(" + ") || "flagged (no perms)";
    inc("ops.automod");
    await opsAlert(deps, `🛡️ **${rule}** — <@${message.author.id}> in <#${message.channelId}> → ${action}\n> ${excerpt}\n${jump}`);
    return true;
  };

  // Invite links — the fastest phishing vector on a community server.
  if (INVITE_RE.test(message.content)) return act("invite link");
  // Scam classes — same defensive-regex style as safety.ts's listing blocklist.
  for (const { rule, re } of SCAM_PATTERNS) {
    if (re.test(message.content)) return act(rule, 10 * 60_000);
  }
  // Hard-line content — the listing blocklist applied to live chat: slurs,
  // minor-safety text, self-harm promotion, illegal content get deleted and
  // timeout the author, in comments and everywhere else in the house guild.
  const contentHit = checkMessageContent(message.content);
  if (!contentHit.ok) return act(`hard-line content (${contentHit.category})`, 30 * 60_000);
  // Mass mention — or @everyone/here from a member who lacks the permission.
  // Role mentions count too — a dozen @role pings is the same spam shape.
  const overMentions = message.mentions.users.size + (message.mentions.roles?.size ?? 0) > config.automodMentionMax;
  const illegalEveryone = message.mentions.everyone &&
    !(message.member?.permissions.has(PermissionFlagsBits.MentionEveryone) ?? false);
  if (overMentions || illegalEveryone) return act("mass mention");
  // Burst spam — rolling per-user window.
  const now = Date.now();
  const times = burstWindow.get(message.author.id) ?? [];
  while (times.length && now - times[0] > config.automodBurstWindowMs) times.shift();
  times.push(now);
  burstWindow.set(message.author.id, times);
  if (burstWindow.size > 5_000) burstWindow.clear();
  if (times.length > config.automodBurstCount) return act("burst spam", 5 * 60_000);
  // New accounts posting links are almost never legitimate.
  const created = message.author.createdTimestamp;
  if (created && LINK_RE.test(message.content) &&
    now - created < config.automodNewAccountDays * 86_400_000) {
    return act("new-account link");
  }
  return false;
}

// ── Support tickets ──────────────────────────────────────────────────────────
// A persistent card in #support-ticket carries the Open button; the modal
// intake creates one private thread per ticket. The opener sees it via thread
// membership, staff via ManageThreads (granted channel-locally by
// staffModerate in WANTED_LAYOUT). support_tickets rows dedupe one-open-per-
// user — the partial unique index is the arbiter, so a double-submit or a
// button-click race can't open two threads. Ticket threads are excluded from
// automod + memory in index.ts's handleMessage.

const TICKET_OPEN_ID = "ticket:open";
const TICKET_MODAL_ID = "ticket:new";
const TICKET_CLOSE_ID = "ticket:close";
const TICKET_CHANNEL = "support-ticket";

function ticketChannel(guild: GuildLike): GuildChannelLike | undefined {
  return guild.channels.cache.find(
    c => c.type === ChannelType.GuildText && normName(c.name) === normName(TICKET_CHANNEL));
}

/** Post the ticket panel once — same keep-first/delete-rest self-heal as the
 *  verify gate: the button's customId is the marker inside components JSON. */
export async function ensureTicketPanel(deps: OpsDeps, guild: GuildLike): Promise<boolean> {
  if (!isHouse(guild.id)) return false;
  const ch = ticketChannel(guild);
  if (!ch?.id) return false;
  const sendable = await deps.fetchChannel(ch.id).catch(() => null);
  if (!sendable?.send) return false;
  const recent = await sendable.messages?.fetch({ limit: 20 }).catch(() => null);
  if (recent) {
    let kept = false;
    for (const entry of recent) {
      const m = (Array.isArray(entry) ? entry[1] : entry) as { author?: { id?: string }; components?: unknown[]; delete?(): Promise<unknown> };
      if (m.author?.id !== deps.botId || !JSON.stringify(m.components ?? []).includes(TICKET_OPEN_ID)) continue;
      if (kept) await m.delete?.().catch(() => {}); // stale duplicate card — self-heal
      else kept = true;
    }
    if (kept) return false;
  }
  await sendable.send({
    embeds: [new EmbedBuilder()
      .setTitle("Open a support ticket")
      .setDescription(
        "Need a human? Open a ticket — billing, account trouble, bugs, or anything the FAQs didn't cover.\n\n" +
        "A private thread opens between you and the staff team — nobody else can see it, and nothing in it feeds companion memory. One open ticket at a time.\n\n" +
        "_Just joined? Accept the server rules first — the button works once you have._",
      )],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(TICKET_OPEN_ID).setLabel("Open a ticket").setStyle(ButtonStyle.Primary),
    )],
    allowedMentions: { parse: [] },
  });
  return true;
}

export function buildTicketModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(TICKET_MODAL_ID)
    .setTitle("Open a support ticket")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("subject").setLabel("Subject")
          .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)
          .setPlaceholder("Billing, account, bug, something else…")),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("details").setLabel("What do you need?")
          .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)
          .setPlaceholder("The more detail the better — links, error text, what you tried.")),
    );
}

/** ticket:* buttons — routed from handleMemoryButton; deps are module-init'd.
 *  ticket:open dedupe-checks then shows the intake modal; ticket:close lives
 *  inside the ticket thread and needs the opener or staff perms. */
export async function handleTicketButton(interaction: ButtonInteraction): Promise<unknown> {
  const deps = opsDeps;
  if (!deps) return interaction.reply({ content: "Ops isn't initialized yet — the bot is still starting.", ephemeral: true });
  if (!isHouse(interaction.guildId)) {
    return interaction.reply({ content: "That button only works in our community server.", ephemeral: true });
  }
  if (interaction.customId === TICKET_OPEN_ID) {
    // Dedupe before the modal — re-checked on submit too (the unique index
    // is the real arbiter; this just saves the user the typing).
    const existing = await deps.store.openSupportTicketFor(interaction.user.id).catch(() => undefined);
    if (existing === undefined) {
      return interaction.reply({ content: "Couldn't check your tickets right now — try again in a moment.", ephemeral: true });
    }
    if (existing) {
      return interaction.reply({ content: `You already have an open ticket — <#${existing.threadId}>.`, ephemeral: true });
    }
    if (typeof interaction.showModal !== "function") {
      return interaction.reply({ content: "Ticket intake needs a newer Discord client — describe your issue to a Mod directly.", ephemeral: true });
    }
    return interaction.showModal(buildTicketModal());
  }
  if (interaction.customId === TICKET_CLOSE_ID) {
    const channel = interaction.channel as unknown as {
      id: string; isThread?(): boolean; send?(payload: unknown): Promise<unknown>;
      setLocked?(locked: boolean): Promise<unknown>; setArchived?(archived: boolean): Promise<unknown>;
    } | null;
    if (!channel?.isThread?.()) {
      return interaction.reply({ content: "That button only works inside a ticket thread.", ephemeral: true });
    }
    const ticket = await deps.store.supportTicketByThread(channel.id).catch(() => undefined);
    if (ticket === undefined) {
      return interaction.reply({ content: "Couldn't look up this ticket — try again in a moment.", ephemeral: true });
    }
    if (!ticket || ticket.status !== "open") {
      return interaction.reply({ content: "That ticket's already closed.", ephemeral: true });
    }
    // Opener or staff — ManageThreads/ManageGuild/Administrator all count.
    const perms = (interaction as { memberPermissions?: { has?(b: bigint): boolean } }).memberPermissions;
    const staff = !!(perms?.has?.(PermissionFlagsBits.ManageThreads)
      || perms?.has?.(PermissionFlagsBits.ManageGuild)
      || perms?.has?.(PermissionFlagsBits.Administrator));
    if (interaction.user.id !== ticket.openerId && !staff) {
      return interaction.reply({ content: "Only the ticket opener or staff can close it.", ephemeral: true });
    }
    await deps.store.closeSupportTicket(ticket.threadId, interaction.user.id)
      .catch(e => { inc("ops.ticket_error"); logError("ticket close failed", e); });
    await interaction.update({ components: [] }).catch(() => {}); // strip the button
    // Close note first — a locked+archived thread refuses further messages.
    await channel.send?.({
      content: `🔒 Ticket closed by <@${interaction.user.id}>. This thread is archived — open a new ticket if anything else comes up.`,
      allowedMentions: { users: [interaction.user.id] },
    }).catch(() => {});
    await channel.setLocked?.(true).catch(() => {});
    await channel.setArchived?.(true).catch(() => {});
    await opsAlert(deps, `🔒 **Ticket closed** — <#${ticket.threadId}> (${ticket.subject.slice(0, 140)}) by <@${interaction.user.id}>`);
    inc("ops.ticket_closed");
    return undefined;
  }
  return undefined;
}

/** ticket:new modal submit — creates the private thread, adds the opener,
 *  files the row, alerts staff. Ordered so a DB failure never leaves an
 *  untracked open thread. */
export async function handleTicketModal(interaction: ModalSubmitInteraction): Promise<unknown> {
  if (interaction.customId !== TICKET_MODAL_ID) return undefined;
  const deps = opsDeps;
  if (!deps || !isHouse(interaction.guildId)) {
    return interaction.reply({ content: "Tickets only open from our community server.", ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: true }).catch(() => {});
  const subject = interaction.fields.getTextInputValue("subject").slice(0, 100).trim();
  const details = interaction.fields.getTextInputValue("details").slice(0, 1000).trim();
  if (!subject || !details) {
    return interaction.editReply({ content: "Both fields are required — click Open a ticket to try again." });
  }
  const existing = await deps.store.openSupportTicketFor(interaction.user.id).catch(() => undefined);
  if (existing === undefined) {
    return interaction.editReply({ content: "Couldn't check your tickets right now — try again in a moment." });
  }
  if (existing) {
    return interaction.editReply({ content: `You already have an open ticket — <#${existing.threadId}>.` });
  }
  const guild = await deps.fetchGuild(interaction.guildId!).catch(() => null);
  const ch = guild ? ticketChannel(guild) : undefined;
  const sendable = ch ? await deps.fetchChannel(ch.id).catch(() => null) : null;
  if (!ch || typeof sendable?.threads?.create !== "function") {
    return interaction.editReply({ content: "The ticket desk isn't set up yet — tell an admin #support-ticket is missing." });
  }
  const slug = interaction.user.username.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20) || "member";
  const thread = await sendable.threads.create({
    name: `ticket-${slug}`.slice(0, 90),
    type: ChannelType.PrivateThread,
    invitable: false,
    autoArchiveDuration: 10080, // a week — active threads never auto-lock mid-ticket
  }).catch(e => { inc("ops.ticket_error"); logError("ticket thread create failed", e); return null; });
  if (!thread) {
    return interaction.editReply({ content: "Couldn't open the ticket thread — try again in a moment." });
  }
  const row = await deps.store.createSupportTicket(interaction.guildId!, interaction.user.id, thread.id, subject, details)
    .catch(e => { inc("ops.ticket_error"); logError("ticket insert failed", e); return null; });
  if (!row) {
    // Dedupe race lost or DB failure — archive the orphan thread either way.
    await thread.setLocked?.(true).catch(() => {});
    await thread.setArchived?.(true).catch(() => {});
    const again = await deps.store.openSupportTicketFor(interaction.user.id).catch(() => null);
    return interaction.editReply({
      content: again
        ? `You already have an open ticket — <#${again.threadId}>.`
        : "Couldn't file the ticket — try again in a moment.",
    });
  }
  const added = await thread.members?.add(interaction.user.id).then(() => true).catch(() => false) ?? false;
  await thread.send({
    content: `<@${interaction.user.id}>`,
    embeds: [new EmbedBuilder()
      .setTitle(`🎫 ${subject.slice(0, 200)}`)
      .setDescription(details)
      .setFooter({ text: `Ticket opened by ${interaction.user.username} — only you and staff can see this thread.` })],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(TICKET_CLOSE_ID).setLabel("Close ticket").setStyle(ButtonStyle.Danger),
    )],
    allowedMentions: { users: [interaction.user.id] },
  }).catch(e => { inc("ops.ticket_error"); logError("ticket opener send failed", e); });
  // Staff ping rides the ops channel — the Mod role mention notifies while
  // the thread link lets them jump straight in.
  const modRole = guild!.roles?.cache?.find(r => normName(r.name) === normName("Mod"));
  const chOps = await opsChannel(deps);
  await chOps?.send({
    content: `🎫 **Ticket opened** — <@${interaction.user.id}>: ${subject.slice(0, 140)} → <#${thread.id}>${added ? "" : " ⚠️ member-add failed, invite them manually"}`,
    allowedMentions: modRole ? { roles: [modRole.id], users: [interaction.user.id] } : { users: [interaction.user.id] },
  }).catch(e => { inc("ops.ticket_error"); logError("ticket alert failed", e); });
  inc("ops.ticket_opened");
  return interaction.editReply({
    content: `Ticket opened — <#${thread.id}>. Only you and staff can see it; we'll reply there.`,
  });
}

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
  | { failed: true };

/** The pinned manage row every adoptee thread carries — one Danger Drop
 *  button keyed to the adoption's companion, reusing the market:drop path. */
export function adopteeManagePayload(companion: Companion) {
  return {
    content: `*Manage **${companion.name || "Companion"}** —*`,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`market:drop:${companion.id}`)
        .setLabel(`Drop ${companion.name || "companion"}`.slice(0, 80))
        .setStyle(ButtonStyle.Danger),
    )],
    allowedMentions: { parse: [] },
  };
}

/** Backfill the pinned manage row on threads created before it existed —
 *  a pinned row is left alone, an unpinned one is re-pinned, a missing one
 *  is posted + pinned. Detection is the `market:drop:` custom id itself:
 *  only the bot can post components, so no author check is needed. */
async function ensureAdopteeManageRow(thread: TicketThreadLike, companion: Companion): Promise<void> {
  if (typeof thread.messages?.fetch !== "function") return;
  const fetched = await thread.messages.fetch({ limit: 30 }).catch(() => null);
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

/** Create (or reuse) the private adoptee thread for an adoption. Idempotent —
 *  a live `chat_thread_id` short-circuits unless `reopen` is asked (re-adopt
 *  unarchives the locked thread so the history continues). The companion
 *  introduces themselves on creation — that's what unlocks server summoning. */
export async function ensureAdopteeThread(
  deps: OpsDeps,
  ctx: {
    adoption: CompanionAdoption;
    companion: Companion;
    listing?: { id: number; greeting: string } | null;
    username?: string;
    reopen?: boolean;
  },
): Promise<EnsureAdopteeThreadResult> {
  const { adoption, companion } = ctx;
  if (!isHouse(config.houseGuildId)) return { failed: true };
  if (adoption.chatThreadId) {
    const existing = await deps.fetchChannel(adoption.chatThreadId).catch(() => null);
    if (existing) {
      const ex = existing as TicketThreadLike;
      if (ctx.reopen) await ex.setLocked?.(false).catch(() => {});
      // Private-thread membership lapses when the adopter leaves and rejoins
      // the house — re-add idempotently so a live thread reappears for them,
      // and resurface anything Discord auto-archived out from under them.
      await ex.setArchived?.(false).catch(() => {});
      await ex.members?.add?.(adoption.userId).catch(e => {
        inc("ops.adoptee_reattach_error"); logError("adoptee thread re-attach failed", e);
      });
      // Threads created before the manage row shipped get it backfilled.
      await ensureAdopteeManageRow(ex, companion).catch(() => {});
      return { thread: ex, greeted: false, created: false };
    }
    // Deleted thread (mod cleanup) — fall through and rebuild.
  }
  // The adopter must be a house member to see their private thread — everyone
  // else gets pointed at the invite (backfill picks them up on join).
  const member = await deps.fetchMember(config.houseGuildId!, adoption.userId).catch(() => null);
  if (!member) return { needsInvite: true };
  const parent = await adopteesChannel(deps);
  if (!parent || typeof parent.threads?.create !== "function") {
    inc("ops.adoptee_thread_missing_channel");
    return { failed: true };
  }
  // Companion name only — these threads are private to one adopter, so the
  // username suffix just added noise to an already-personal row.
  const name = (companion.name || "Companion").slice(0, 95);
  const thread = await parent.threads.create({
    name,
    type: ChannelType.PrivateThread,
    invitable: false,
    autoArchiveDuration: 10080,
  }).catch(e => { inc("ops.adoptee_thread_error"); logError("adoptee thread create failed", e); return null; });
  if (!thread) return { failed: true };
  const added = await thread.members?.add(adoption.userId).then(() => true).catch(() => false) ?? false;
  if (!added) {
    // An invisible thread is worse than none — drop it and fail loudly.
    await thread.setLocked?.(true).catch(() => {});
    await thread.setArchived?.(true).catch(() => {});
    return { failed: true };
  }
  await deps.store.setAdoptionThread(adoption.id, thread.id).catch(e => {
    inc("ops.adoptee_thread_error"); logError("adoption thread stamp failed", e);
  });
  const greeted = await greetAdopteeInThread(
    deps, thread, parent, companion, ctx.listing?.greeting ?? "",
  );
  if (greeted) await deps.store.markDmIntroduced(adoption.id).catch(() => {});
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

/** Ensure every active adoption of a user has its thread AND that the adopter
 *  is still a member of it — leaving the guild drops private-thread
 *  membership, so the join hook and the interactive paths both drain the full
 *  active set through here (create missing, re-attach live, rebuild deleted). */
export async function ensureAdopteeThreadsForUser(userId: string, deps: OpsDeps): Promise<void> {
  const rows = await deps.store.activeAdoptionsForUser(userId).catch(() => []);
  for (const row of rows) {
    await ensureAdopteeThread(deps, row).catch(e => {
      inc("ops.adoptee_thread_error"); logError("ensure adoptee thread failed", e);
    });
  }
}

/** Boot/interval sweep — same shape as greetPendingInstalls: bounded batch,
 *  per-row fault tolerance, permanent dedupe via chat_thread_id. Non-members
 *  are skipped silently; the member-add hook catches them when they join. */
export async function backfillAdopteeThreads(deps: OpsDeps): Promise<void> {
  if (!deps || !config.houseGuildId) return;
  const missing = await deps.store.activeAdoptionsMissingThreads(10).catch(e => {
    inc("ops.adoptee_backfill_error"); logError("adoptee backfill query failed", e); return [];
  });
  for (const row of missing) {
    const member = await deps.fetchMember(config.houseGuildId!, row.adoption.userId).catch(() => null);
    if (!member) continue;
    await ensureAdopteeThread(deps, { ...row, username: member.user.username }).catch(e => {
      inc("ops.adoptee_thread_error"); logError("adoptee backfill create failed", e);
    });
  }
}

// ── Channel ops ──────────────────────────────────────────────────────────────
// The wanted layout mirrors the live hub server. Matching is name-only after
// NFKC+lowercase normalization (channel names may carry emoji, categories may
// be styled) — a mis-parented channel is adopted, never duplicated.

export const WANTED_LAYOUT: Array<{
  category: string;
  /** readOnly: true/"member" denies typing for the Member role at the category
   *  level (synced children inherit); "everyone" instead writes @everyone
   *  ViewChannel-allow + typing denies — a category the unverified can read
   *  but nobody posts in. */
  readOnly?: boolean | "member" | "everyone";
  /** Channel readOnly: "member" (default when true) denies the Member role;
   *  "everyone" denies @everyone — for channels the unverified can see (lobby,
   *  and #faqs: the channel overwrite allows ViewChannel where the category
   *  denies it); "openthreads" is "everyone" except SendMessagesInThreads is
   *  allowed — private ticket threads stay typeable by their members while
   *  the channel itself stays silent; "staff" is "everyone" plus send-access
   *  for the Mod/Admin
   *  roles. `hidden` is the inverse: @everyone loses ViewChannel on that
   *  channel — used to keep select channels gated inside a visible category.
   *  `staffModerate` layers staff ManageThreads onto a channel — for
   *  private-thread surfaces (#support-ticket) where staff must see + join
   *  threads they aren't members of. `true` grants all house staff roles; a
   *  string[] narrows the grant (unlisted staff roles get the bits revoked).
   *  `memberThreads` lets the Member role SEND inside threads while every
   *  create stays denied — #adoptees, where adopters chat in private
   *  threads only the bot opens. `memberPosts` is the forum version —
   *  Members can create + reply to posts (pair it with `hidden` to gate the
   *  board behind verify). */
  channels: Array<{ name: string; type: ChannelType; readOnly?: true | "member" | "everyone" | "openthreads" | "staff"; hidden?: true; staffModerate?: true | string[]; memberThreads?: true; memberPosts?: true }>;
}> = [
  {
    category: "SYSTEM",
    channels: [
      { name: "welcome", type: ChannelType.GuildText, readOnly: "everyone" },
      { name: "announcements", type: ChannelType.GuildAnnouncement, readOnly: true },
      { name: "rules", type: ChannelType.GuildText },
      { name: "log-in", type: ChannelType.GuildText }, // the verify gate lives here
      { name: "updates", type: ChannelType.GuildText, readOnly: true },
      { name: "events", type: ChannelType.GuildText, readOnly: true },
      // Staff-posted billboard — everyone reads, Mods/Admins write.
      { name: "characterly-web", type: ChannelType.GuildText, readOnly: "staff" },
    ],
  },
  {
    category: "CHARACTER MARKETPLACE",
    channels: [
      { name: "characters", type: ChannelType.GuildForum },
      // Adopted companions' private chat threads — gated until verify
      // (hidden: @everyone loses ViewChannel; the memberThreads grant keeps
      // verified Members viewing + typing inside bot-opened threads).
      { name: "adoptees", type: ChannelType.GuildText, hidden: true, staffModerate: ["Admin"], memberThreads: true },
    ],
  },
  {
    // Visible pre-verify — the shelf tour prospective members read before
    // linking. get-companionly + how-to-publish-bots stay gated (post-verify).
    category: "RESOURCES",
    readOnly: "everyone",
    channels: [
      { name: "what-is-characterly", type: ChannelType.GuildText },
      { name: "what-is-companionly", type: ChannelType.GuildText },
      { name: "get-companionly", type: ChannelType.GuildText, hidden: true },
      { name: "privacy-policy", type: ChannelType.GuildText },
      { name: "how-to-publish-bots", type: ChannelType.GuildText, hidden: true },
    ],
  },
  {
    category: "HELP",
    readOnly: true,
    channels: [
      { name: "faqs", type: ChannelType.GuildText, readOnly: "everyone" },
      // The ticket desk — visible pre-verify so "can't log in" cases can
      // still reach staff; the panel card is the only thing in it since
      // @everyone can't post or create threads. Conversation lives in
      // private threads: openers type via the openthreads send-allow (thread
      // membership already hides everyone else's tickets).
      { name: "support-ticket", type: ChannelType.GuildText, readOnly: "openthreads", staffModerate: true },
      // The suggestion board — a forum hidden until verify; Members post,
      // reply, and vote, staff pin/close. Gallery view so screenshot
      // attachments render as covers.
      { name: "suggest-a-feature", type: ChannelType.GuildForum, hidden: true, memberPosts: true, staffModerate: true },
    ],
  },
  {
    category: "SERVICES",
    channels: [
      { name: "admins-chat", type: ChannelType.GuildText },
      { name: "mods-chat", type: ChannelType.GuildText },
    ],
  },
];

const normName = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** Typing perms denied on read-only surfaces — messages, thread replies, and
 *  forum-post/thread creation. ViewChannel stays allowed. */
const READONLY_DENY_BITS = [
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.CreatePrivateThreads,
] as const;
const READONLY_DENY_PERMS = {
  SendMessages: false,
  SendMessagesInThreads: false,
  CreatePublicThreads: false,
  CreatePrivateThreads: false,
};

function permHas(perms: unknown, bit: bigint): boolean {
  if (typeof perms === "bigint") return (perms & bit) === bit;
  const d = perms as { has?(b: bigint): boolean } | null | undefined;
  return typeof d?.has === "function" && d.has(bit);
}

/** Normalize a permissionOverwrites cache to overwrite objects — discord.js
 *  Collections iterate [id, overwrite] tuples, test fakes pass bare arrays. */
function overwriteEntries(overwrites: GuildChannelLike["permissionOverwrites"]): Array<{ id: string; allow: unknown; deny: unknown }> {
  return [...(overwrites?.cache ?? [])].map(o => {
    const t = o as unknown[];
    return (Array.isArray(t) ? t[1] : o) as { id: string; allow: unknown; deny: unknown };
  });
}

/** Deny a role's typing perms on a channel/category while keeping
 *  ViewChannel. Member-scoped denies leave mods/admins/the bot posting —
 *  member-facing announcements go through the bot (`/ops announce`) anyway.
 *  @everyone-scoped denies are for lobby channels the unverified can see;
 *  there only Administrator holders (the bot, admin role) can still post. */
async function ensureReadOnly(ch: GuildChannelLike, created: string[], label: string, roleId: string | undefined): Promise<void> {
  const overwrites = ch.permissionOverwrites;
  if (!roleId || typeof overwrites?.edit !== "function") return;
  const cur = overwriteEntries(overwrites).find(o => o.id === roleId);
  // Requires the ViewChannel allow too — a deny-all overwrite (e.g. a synced
  // category's @everyone hide) must still get ViewChannel written, or a
  // "everyone" readOnly channel stays invisible instead of visible-silent.
  if (cur && READONLY_DENY_BITS.every(b => permHas(cur.deny, b)) && permHas(cur.allow, PermissionFlagsBits.ViewChannel)) return;
  await overwrites.edit(roleId, { ViewChannel: true, ...READONLY_DENY_PERMS })
    .then(() => { created.push(`🔒 ${label}`); })
    .catch(() => {});
}

/** "openthreads" read-only — the ticket desk. @everyone reads the channel and
 *  can't post or open threads, but SendMessagesInThreads stays allowed so the
 *  opener (and staff) can actually talk inside the private ticket thread —
 *  thread membership is already the visibility gate, so nothing else leaks. */
async function ensureOpenThreads(ch: GuildChannelLike, created: string[], label: string, roleId: string | undefined): Promise<void> {
  const overwrites = ch.permissionOverwrites;
  if (!roleId || typeof overwrites?.edit !== "function") return;
  const cur = overwriteEntries(overwrites).find(o => o.id === roleId);
  const denyBits = READONLY_DENY_BITS.filter(b => b !== PermissionFlagsBits.SendMessagesInThreads);
  if (cur && denyBits.every(b => permHas(cur.deny, b))
    && permHas(cur.allow, PermissionFlagsBits.ViewChannel)
    && permHas(cur.allow, PermissionFlagsBits.SendMessagesInThreads)) return;
  await overwrites.edit(roleId, {
    ViewChannel: true,
    SendMessagesInThreads: true,
    SendMessages: false,
    CreatePublicThreads: false,
    CreatePrivateThreads: false,
  }).then(() => { created.push(`🎫 ${label}`); })
    .catch(() => {});
}

/** Inverse of ensureReadOnly for visible categories: deny @everyone
 *  ViewChannel (+ typing — an invisible channel can't be posted in anyway,
 *  and it stays silent if a stray allow ever re-exposes it). */
async function ensureHiddenFromEveryone(ch: GuildChannelLike, created: string[], label: string, roleId: string | undefined): Promise<void> {
  const overwrites = ch.permissionOverwrites;
  if (!roleId || typeof overwrites?.edit !== "function") return;
  const cur = overwriteEntries(overwrites).find(o => o.id === roleId);
  if (cur && permHas(cur.deny, PermissionFlagsBits.ViewChannel)
    && READONLY_DENY_BITS.every(b => permHas(cur.deny, b))) return;
  await overwrites.edit(roleId, { ViewChannel: false, ...READONLY_DENY_PERMS })
    .then(() => { created.push(`🙈 ${label}`); })
    .catch(() => {});
}

/** "Staff" surface — everyone reads, only Mod/Admin write: @everyone gets the
 *  visible-silent overwrite, then each staff role (looked up by name — the
 *  house's are canonical) gets an explicit send allow that overrides the deny. */
async function ensureStaffOnly(ch: GuildChannelLike, created: string[], label: string, guild: GuildLike): Promise<void> {
  await ensureReadOnly(ch, created, label, guild.id);
  const overwrites = ch.permissionOverwrites;
  if (typeof overwrites?.edit !== "function") return;
  for (const name of ["Mod", "Admin"]) {
    const role = guild.roles?.cache?.find(r => normName(r.name) === normName(name));
    if (!role) continue;
    const cur = overwriteEntries(overwrites).find(o => o.id === role.id);
    if (cur && permHas(cur.allow, PermissionFlagsBits.SendMessages)) continue;
    await overwrites.edit(role.id, { ViewChannel: true, SendMessages: true, SendMessagesInThreads: true })
      .then(() => { created.push(`✍️ ${label} → ${name}`); })
      .catch(() => {});
  }
}

/** Member gets SendMessagesInThreads on a thread-surface — adopters chat
 *  inside their own private threads. CreatePrivateThreads stays denied
 *  everywhere, so the bot is the only thread opener and every thread maps
 *  back to a registered adoption. */
async function ensureMemberThreadChat(ch: GuildChannelLike, created: string[], label: string, roleId: string | undefined): Promise<void> {
  const overwrites = ch.permissionOverwrites;
  if (!roleId || typeof overwrites?.edit !== "function") return;
  const cur = overwriteEntries(overwrites).find(o => o.id === roleId);
  if (cur && permHas(cur.allow, PermissionFlagsBits.SendMessagesInThreads)
    && permHas(cur.deny, PermissionFlagsBits.CreatePrivateThreads)) return;
  await overwrites.edit(roleId, {
    ViewChannel: true,
    SendMessagesInThreads: true,
    SendMessages: false,
    CreatePublicThreads: false,
    CreatePrivateThreads: false,
  }).then(() => { created.push(`🗨 ${label} → Member threads`); })
    .catch(() => {});
}

/** Forum surface the Member role fully uses: verified members create posts,
 *  reply inside them, and react — while `hidden` keeps @everyone out.
 *  CreatePublicThreads is allowed because in a forum, posts ARE threads;
 *  only private threads stay denied. Every bit is written explicitly so the
 *  overwrite converges even if a stale typing-deny (e.g. an inherited
 *  readOnly-member sync) is sitting on the role. */
async function ensureMemberPosts(ch: GuildChannelLike, created: string[], label: string, roleId: string | undefined): Promise<void> {
  const overwrites = ch.permissionOverwrites;
  if (!roleId || typeof overwrites?.edit !== "function") return;
  const cur = overwriteEntries(overwrites).find(o => o.id === roleId);
  if (cur
    && permHas(cur.allow, PermissionFlagsBits.ViewChannel)
    && permHas(cur.allow, PermissionFlagsBits.SendMessages)
    && permHas(cur.allow, PermissionFlagsBits.SendMessagesInThreads)
    && permHas(cur.allow, PermissionFlagsBits.CreatePublicThreads)
    && permHas(cur.deny, PermissionFlagsBits.CreatePrivateThreads)) return;
  await overwrites.edit(roleId, {
    ViewChannel: true,
    SendMessages: true,
    SendMessagesInThreads: true,
    CreatePublicThreads: true,
    CreatePrivateThreads: false,
  }).then(() => { created.push(`💡 ${label} → Member posts`); })
    .catch(() => {});
}

/** Granted staff roles get ManageThreads on a surface — private threads are
 *  only visible to members + ManageThreads holders, and the house roles may
 *  not carry the perm guild-wide. SendMessagesInThreads lets staff reply
 *  once joined; ViewChannel is already covered but cheap to restate. House
 *  staff roles NOT in grantNames get the managed bits denied — a convergent
 *  revoke, so narrowing a surface's grant list actually narrows it on the
 *  next reconcile (an explicit deny also wins over later stray allows). */
const HOUSE_STAFF_ROLES = ["Mod", "Admin"] as const;
async function ensureStaffModerate(
  ch: GuildChannelLike, created: string[], label: string, guild: GuildLike,
  grantNames: readonly string[] = HOUSE_STAFF_ROLES,
): Promise<void> {
  const overwrites = ch.permissionOverwrites;
  if (typeof overwrites?.edit !== "function") return;
  for (const name of HOUSE_STAFF_ROLES) {
    const role = guild.roles?.cache?.find(r => normName(r.name) === normName(name));
    if (!role) continue;
    const cur = overwriteEntries(overwrites).find(o => o.id === role.id);
    if (!grantNames.some(n => normName(n) === normName(name))) {
      if (cur && (permHas(cur.allow, PermissionFlagsBits.ManageThreads) || permHas(cur.allow, PermissionFlagsBits.SendMessagesInThreads))) {
        await overwrites.edit(role.id, { ManageThreads: false, SendMessagesInThreads: false })
          .then(() => { created.push(`🔒 ${label} → ${name} thread perms revoked`); })
          .catch(() => {});
      }
      continue;
    }
    if (cur && permHas(cur.allow, PermissionFlagsBits.ManageThreads)) continue;
    await overwrites.edit(role.id, { ViewChannel: true, SendMessagesInThreads: true, ManageThreads: true })
      .then(() => { created.push(`🧵 ${label} → ${name} manages threads`); })
      .catch(() => {});
  }
}

/** Create missing categories + channels by name. Idempotent — returns the
 * names of what it created ([] when the layout is already complete). */
export async function ensureHouseLayout(guild: GuildLike): Promise<string[]> {
  if (!isHouse(guild.id)) return [];
  const created: string[] = [];
  for (const group of WANTED_LAYOUT) {
    let cat = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory && normName(c.name) === normName(group.category),
    );
    if (!cat) {
      cat = await guild.channels.create({ name: group.category, type: ChannelType.GuildCategory });
      created.push(`📁 ${group.category}`);
    }
    // Read-only categories get the Member typing deny at the PARENT — synced
    // children inherit it, and writing channel-level overwrites would desync
    // them. Snapshot child sync-state BEFORE mutating the parent (discord.js
    // compares live overwrites, so the flag can flip false post-edit), and run
    // the parent edit before creates so children copy the denied set.
    const syncBefore = new Map<string, boolean>();
    if (group.readOnly) {
      for (const wanted of group.channels) {
        const ch = guild.channels.cache.find(c => normName(c.name) === normName(wanted.name));
        if (ch) syncBefore.set(normName(wanted.name), ch.permissionsLocked === true);
      }
      // "everyone" categories are unverified-readable: @everyone gets
      // ViewChannel + typing denies at the parent — one overwrite covers
      // unverified readers and members alike (no Member send-allow exists
      // anywhere that could override it).
      const readOnlyRoleId = group.readOnly === "everyone" ? guild.id : config.houseMemberRoleId;
      await ensureReadOnly(cat, created, `📁 ${group.category}`, readOnlyRoleId);
    }
    for (const wanted of group.channels) {
      // Prefer a name match whose TYPE matches too — a stale same-named
      // channel (e.g. a text channel later replaced by a forum) must not
      // absorb the reconcile's edits. Falls back to name-only so channels
      // created under an older declaration still reconcile.
      const exists = guild.channels.cache.find(c => normName(c.name) === normName(wanted.name) && c.type === wanted.type)
        ?? guild.channels.cache.find(c => normName(c.name) === normName(wanted.name));
      let target = exists;
      if (!exists) {
        // New channels inherit the category's overwrites — a fresh
        // mods/ops channel must not come up with default (public) perms.
        const overwrites = cat.permissionOverwrites?.cache
          ? overwriteEntries(cat.permissionOverwrites).map(o => ({ id: o.id, allow: o.allow, deny: o.deny }))
          : undefined;
        target = await guild.channels.create({ name: wanted.name, type: wanted.type, parent: cat.id, permissionOverwrites: overwrites });
        created.push(`#${wanted.name}`);
      } else if (
        wanted.type === ChannelType.GuildForum
        && exists.defaultForumLayout !== ForumLayoutType.GalleryView
        && typeof exists.edit === "function"
      ) {
        // Gallery View is what turns listing-card attachments into covers on
        // the forum's main page — reconcile it like the rest of the layout.
        await exists.edit({ defaultForumLayout: ForumLayoutType.GalleryView })
          .then(() => { created.push(`⚙ ${wanted.name} → gallery view`); })
          .catch(() => {});
      }
      // Explicit readOnly channels (mixed parents like SYSTEM) and children
      // that weren't synced to a readOnly parent need their own deny.
      // "everyone" targets the @everyone role — its id is the guild id.
      if (target && wanted.readOnly === "staff") {
        await ensureStaffOnly(target, created, `#${wanted.name}`, guild);
      } else if (target && wanted.readOnly === "openthreads") {
        await ensureOpenThreads(target, created, `#${wanted.name}`, guild.id);
        // Members need the same open-threads grant — a leftover Member deny
        // (from an older readOnly-member layout) would override the
        // @everyone allow and silence verified ticket openers.
        await ensureOpenThreads(target, created, `#${wanted.name} · Member`, config.houseMemberRoleId);
      } else if (target && (wanted.readOnly || (group.readOnly === true && syncBefore.get(normName(wanted.name)) !== true))) {
        const roleId = wanted.readOnly === "everyone" ? guild.id : config.houseMemberRoleId;
        await ensureReadOnly(target, created, `#${wanted.name}`, roleId);
      }
      // `hidden` overrides a visible category: the channel gets its own
      // @everyone ViewChannel deny (desyncing it), so it stays gated until
      // the Member role lands while its siblings stay readable.
      if (target && wanted.hidden) await ensureHiddenFromEveryone(target, created, `#${wanted.name}`, guild.id);
      if (target && wanted.staffModerate) await ensureStaffModerate(target, created, `#${wanted.name}`, guild, wanted.staffModerate === true ? undefined : wanted.staffModerate);
      if (target && wanted.memberThreads) await ensureMemberThreadChat(target, created, `#${wanted.name}`, config.houseMemberRoleId);
      if (target && wanted.memberPosts) await ensureMemberPosts(target, created, `#${wanted.name}`, config.houseMemberRoleId);
    }
  }
  return created;
}

// ── Resource posts ───────────────────────────────────────────────────────────
// Static explainer embeds — mostly RESOURCES channels, plus #adoptees' pinned
// orientation post. Every post's footer carries
// `Char.ly resources · <channel> · vN` — the reconcile keeps exactly
// one marked message per channel: extras are deleted, a stale version is
// edited in place (no repost spam), and a missing one is posted fresh.

const RESOURCE_MARKER = "Char.ly resources";

function markedEmbeds(post: { channel: string; version: number; embeds(): EmbedBuilder[] }): ReturnType<EmbedBuilder["toJSON"]>[] {
  return post.embeds().map(e =>
    e.setFooter({ text: `${RESOURCE_MARKER} · ${post.channel} · v${post.version}` }).toJSON());
}

export const RESOURCE_POSTS: Array<{ channel: string; version: number; embeds(): EmbedBuilder[] }> = [
  {
    channel: "what-is-characterly",
    version: 2,
    embeds: () => [new EmbedBuilder()
      .setTitle("What is Characterly?")
      .setDescription(
        "Characterly is a marketplace of AI companions that lives inside Discord.\n\n" +
        `Browse **#characters**, pick someone you like, and hit **Add** — they get their own private thread under **#adoptees** just for the two of you, and you can summon them into your servers too. Every companion keeps its own private memory of *you*, so your version of a character is yours alone.\n\n` +
        "**For everyone**\n" +
        "• Browse a gallery of characters — cover art, genre tags, ratings, and community picks\n" +
        "• One click to adopt — a private thread opens for the two of you in **#adoptees**\n" +
        "• Ratings and comments keep the shelf honest\n\n" +
        "**For creators**\n" +
        "• Publish your own characters — your name stays on the card\n" +
        "• Up to 3 genre tags, a gallery cover, an editable persona\n" +
        "• Reports, flags, and staff review keep the shelf clean",
      )],
  },
  {
    channel: "what-is-companionly",
    version: 2,
    embeds: () => [new EmbedBuilder()
      .setTitle("What is Companionly?")
      .setDescription(
        "Companionly is *your* companion — not picked off a shelf, but awakened by you.\n\n" +
        "DM me and we'll have a short conversation about who they should be. They wake up with a name, a voice, and a bond that starts with you — and from then on they're permanent and yours.\n\n" +
        "• **Awakened, not adopted** — their personality comes from your first conversation\n" +
        "• **Lives in your DMs** — talk anytime; they remember your history together\n" +
        "• **Bring them anywhere** — summon them into servers running Characterly\n" +
        "• **One per account** — a bond, not a collection\n" +
        "• **Publishable** — `/companion publish` puts them on the shelf as a character others can adopt",
      )],
  },
  {
    channel: "get-companionly",
    version: 2,
    embeds: () => [new EmbedBuilder()
      .setTitle("Get Companionly")
      .setDescription(
        "Everything starts in DMs — here's the five-minute path.\n\n" +
        `**1. Verify** — click **Verify** in ${config.houseVerifyChannelId ? `<#${config.houseVerifyChannelId}>` : "**#log-in**"}. It links your free Characterly account (that's what moderation and your data controls hang off) and unlocks the server.\n` +
        "**2. Say hi** — DM me and talk. The first conversation awakens your Companion.\n" +
        `**3. Browse the shelf** — ${config.marketplaceChannelId ? `<#${config.marketplaceChannelId}>` : "**#characters**"} is the marketplace. **Add** any character you want alongside yours.\n` +
        "**4. Bring them to a server** — where the bot's installed, `/companion summon` pulls them into the channel.\n" +
        "**5. Publish** — `/companion publish` or `/companion create` when you have a character worth sharing.",
      )],
  },
  {
    channel: "privacy-policy",
    version: 4,
    embeds: () => [new EmbedBuilder()
      .setTitle("Privacy — the short version")
      .setDescription(
        (config.siteUrl
          ? `The full policy is at [${config.siteUrl.replace(/\/+$/, "").replace(/^https?:\/\//, "")}/privacy](${PRIVACY_URL}). `
          : "") +
        "The day-to-day version:\n\n" +
        "• **Servers see nothing until enabled** — no messages are archived until a server admin runs `/memory-resume`\n" +
        "• **Personal memory is opt-in** — derived facts, profile attributes, and relationship notes only exist for members who run `/profile-build` or `/opt-in`\n" +
        "• **Retention is bounded** — raw messages are held 30 days, then permanently deleted\n" +
        "• **Companion memory is yours** — your bond memories stay private to you and never leak into servers or other users' companions\n" +
        "• **Adoptee chats are private, not staff-blind** — companions you adopt chat in private `#adoptees` threads; unlike DMs, Discord private threads are also visible to server admins (safety + support only, no automod inside — mods can't see them)\n" +
        "• **You hold the delete key** — `/opt-out` wipes derived data, `/forget` removes one memory, `/memory-export` shows everything held\n" +
        "• **Removing the bot wipes the server** — every row it stored there goes with it",
      )],
  },
  {
    channel: "how-to-publish-bots",
    version: 2,
    embeds: () => [new EmbedBuilder()
      .setTitle("Publish a character")
      .setDescription(
        "Two ways onto the shelf:\n\n" +
        "**`/companion publish`** — publish your awakened companion as a character others can adopt. The modal takes a display name, tagline, greeting, and an optional cover image URL — the cover becomes its gallery art.\n\n" +
        "**`/companion create`** — author a character from scratch, no awakened companion needed.\n\n" +
        "**After it's live**\n" +
        "• **Edit persona** on the card — voice, traits, bond, backstory\n" +
        "• **Cover image** on the card — set or clear the gallery art anytime\n" +
        "• **Tags** on the card — up to 3 genre tags so browsers find it\n" +
        "• Adopters get independent copies — their memories and journals are theirs; your card keeps your name\n\n" +
        "**The rules** — keep it SFW. Personas are screened on publish; listings can be flagged and moderators can delist. A linked account is required so creators own what they ship.",
      )],
  },
  {
    channel: "adoptees",
    version: 2,
    embeds: () => [new EmbedBuilder()
      .setTitle("Where your adopted companions live")
      .setDescription(
        "Every character you adopt from **#characters** gets a private thread right here — only you, them, and our Admin team can see it.\n\n" +
        "**How the chats work**\n" +
        "• Talk normally — it's a real conversation. Your companion keeps a private memory of *you*, so they always pick up where you left off.\n" +
        "• One thread per adoption — adopt another character, get another thread.\n" +
        "• Thread privacy is enforced by Discord, not just politeness — other members can't see yours at all.\n\n" +
        "**Useful commands**\n" +
        "• `/companion list` — your roster (adopted + your awakened companion)\n" +
        "• `/companion homes` — jump back into a companion's thread\n" +
        "• `/companion summon` — bring one along to other servers with the bot\n" +
        "• `/companion drop` — release one (12h cooldown before re-adopting the same character)",
      )],
  },
  {
    channel: "faqs",
    version: 3,
    embeds: () => [
      new EmbedBuilder()
        .setTitle("Getting started")
        .setDescription(
          "**How do I get a companion?**\n" +
          "DM me and just talk — that first conversation awakens your personal companion, with a name, a voice, and a bond that's yours. Or grab someone off the shelf: hit **Add** on any listing in " + (config.marketplaceChannelId ? `<#${config.marketplaceChannelId}>` : "**#characters**") + ".\n\n" +
          "**Why did Add tell me to verify first?**\n" +
          `Adopting needs a linked Characterly account — it's what ties your companions, tokens, and data controls to you. Click **Verify** in ${config.houseVerifyChannelId ? `<#${config.houseVerifyChannelId}>` : "**#log-in**"}, it takes about 30 seconds, then come back and Add away.\n\n` +
          "**Do I have to pay?**\n" +
          "Nope — every account gets **30 free tokens a day**, no card, no setup. If you start running out, **Premium ($7.99/mo)** bumps you to 150 a day plus live memory and web tools, and unlocks token packs in the dashboard. (Tinkerers can plug in their own API key with `/companion key`, but you never need to.)\n\n" +
          "**How many companions can I have?**\n" +
          "One awakened companion — that bond is permanent. On top of that, free accounts keep one adopted character at a time; Premium removes the cap.\n\n" +
          "**Where do they hang out?**\n" +
          "In your DMs, always. To bring one into a server where I'm installed, run `/companion summon` — they'll chat with everyone there, not just you.",
        ),
      new EmbedBuilder()
        .setTitle("Characters & the marketplace")
        .setDescription(
          "**Can I make my own character?**\n" +
          "Three ways: `/companion publish` turns your awakened companion into a listing, `/companion create` builds one from scratch, and `/companion import` pulls in a character card file you already have.\n\n" +
          "**How do I edit a listing?**\n" +
          "Right on its card — the buttons let you rewrite the persona, swap the cover art (that's the pretty picture in gallery view), and tag up to 3 genres so browsers can find it.\n\n" +
          "**Why is a companion ignoring me?**\n" +
          "A few possibilities: an admin may have quieted the channel (`/quiet-channel` silences them but they still observe), paused companions server-wide, or ignored the channel entirely — or you're out of tokens. The dashboard shows your balance.\n\n" +
          "**What do the stars and comments do?**\n" +
          "They keep the shelf honest — rate the ones you've adopted, comment on the listing thread, and the good ones bubble up as **Top Rated**. Report anything off and staff takes a look.\n\n" +
          "**What happens if I drop one?**\n" +
          "Dropping frees your adoption slot but starts a **12-hour cooldown** before you can re-adopt that same character — so don't rage-quit on a bad day.",
        ),
      new EmbedBuilder()
        .setTitle("Privacy & your account")
        .setDescription(
          "**Can it read my messages?**\n" +
          "Only where admins allow it. Servers see nothing until someone runs `/memory-resume`, facts about *you* only form after you opt in (`/profile-build` or `/opt-in`), and raw messages are deleted after 30 days anyway.\n\n" +
          "**Who sees my companion's memories?**\n" +
          "Just you. Whatever your companion learns in your DMs or your private **#adoptees** thread stays scoped to that conversation — it never leaks into servers or to other people's versions of the same character.\n\n" +
          "**How do I delete my data?**\n" +
          "`/opt-out` wipes everything derived about you, `/forget` removes one specific memory, and the dashboard's Delete section closes the whole account if you want a clean break.\n\n" +
          "**Something broken?**\n" +
          "**#support-ticket** gets a human. Got an idea instead? **#suggest-a-feature** — we actually read it.",
        ),
    ],
  },
  {
    channel: "characterly-web",
    version: 1,
    embeds: () => [new EmbedBuilder()
      .setTitle("Characterly on the web")
      .setDescription(
        `Everything your account does lives at **[${config.siteUrl.replace(/\/+$/, "").replace(/^https?:\/\//, "")}](${config.siteUrl})** —\n\n` +
        "• **Dashboard** — token balance, Premium, token packs\n" +
        "• **Imports** — upload a character card or a chat transcript and your companion becomes them / remembers it\n" +
        "• **Settings** — memory preferences, consent, your linked Discord\n" +
        "• **Delete** — your data, gone on request\n\n" +
        "Your Discord ↔ web link is what ties it together — `/link` in my DMs if you haven't yet.",
      )],
  },
];

/** Reconcile the RESOURCES explainer posts — one marked message per channel,
 *  stale versions edited in place, extras deleted, missing posted. Returns
 *  what it did ([] when everything's current). */
export async function ensureResourcePosts(deps: OpsDeps, guild: GuildLike): Promise<string[]> {
  if (!isHouse(guild.id) || !deps.botId) return [];
  const out: string[] = [];
  for (const post of RESOURCE_POSTS) {
    const found = guild.channels.cache.find(c => normName(c.name) === normName(post.channel));
    if (!found) continue;
    const ch = await deps.fetchChannel(found.id).catch(() => null);
    if (!ch) continue;
    const markerRe = new RegExp(`${RESOURCE_MARKER} · ${post.channel} · v(\\d+)`);
    const recent = await ch.messages?.fetch({ limit: 20 }).catch(() => null);
    let kept = false;
    if (recent) {
      for (const entry of recent) {
        const m = (Array.isArray(entry) ? entry[1] : entry) as {
          author?: { id?: string }; embeds?: unknown[];
          edit?(o: { embeds: unknown[] }): Promise<unknown>; delete?(): Promise<unknown>;
        };
        if (m.author?.id !== deps.botId) continue;
        const match = JSON.stringify(m.embeds ?? []).match(markerRe);
        if (!match) continue;
        if (kept) { await m.delete?.().catch(() => {}); continue; }
        kept = true;
        if (Number(match[1]) < post.version && typeof m.edit === "function") {
          await m.edit({ embeds: markedEmbeds(post) })
            .then(() => { out.push(`✏️ #${post.channel} → v${post.version}`); })
            .catch(() => {});
        }
      }
    }
    if (!kept) {
      const embeds = markedEmbeds(post);
      await ch.send({ embeds, allowedMentions: { parse: [] } })
        .then(() => { out.push(`📝 #${post.channel}`); })
        .catch(() => {});
    }
  }
  return out;
}

// ── Host self-ops ────────────────────────────────────────────────────────────

export interface HostHealth {
  uptimeSec: number;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  heapPct: number;
  lagMs: number;
  diskPct: number | null;
  dbPingMs: number | null;
  queuePending: number | null;
  queueDead: number | null;
  gitSha: string | null;
}

export async function collectHostHealth(deps: OpsDeps): Promise<HostHealth> {
  const mem = process.memoryUsage();
  const heapTotalMb = mem.heapTotal / 1_048_576;
  const heapUsedMb = mem.heapUsed / 1_048_576;
  let diskPct: number | null = null;
  try {
    const { stdout } = await deps.exec("df -P /");
    const line = stdout.trim().split("\n").pop() ?? "";
    const m = line.match(/(\d+)%/);
    if (m) diskPct = Number(m[1]);
  } catch { /* non-Linux host — disk stays null */ }
  const dbPingMs = await deps.dbPing().catch(() => null);
  // Fleet-wide queue depth — a pileup in any guild is the host's problem,
  // not just the house guild's.
  const queue = await deps.store.queueStats(null).catch(() => null);
  return {
    uptimeSec: process.uptime(),
    rssMb: mem.rss / 1_048_576,
    heapUsedMb,
    heapTotalMb,
    heapPct: heapTotalMb ? (heapUsedMb / heapTotalMb) * 100 : 0,
    lagMs: deps.lagMs(),
    diskPct,
    dbPingMs,
    queuePending: queue?.pending ?? null,
    queueDead: queue?.dead ?? null,
    gitSha: deps.gitSha,
  };
}

// Breach latches — a key enters on first breach (alert) and leaves on
// recovery (notice), so a sustained breach alerts exactly once.
const activeBreaches = new Set<string>();

export async function runWatchdogTick(deps: OpsDeps): Promise<HostHealth> {
  const h = await collectHostHealth(deps);
  const breaches: Array<[string, string]> = [];
  if (h.heapPct > config.hostHeapPct) breaches.push(["heap", `heap ${h.heapPct.toFixed(0)}% > ${config.hostHeapPct}%`]);
  if (h.diskPct !== null && h.diskPct > config.hostDiskPct) breaches.push(["disk", `disk ${h.diskPct}% > ${config.hostDiskPct}%`]);
  if (h.lagMs > config.hostLagMs) breaches.push(["lag", `event-loop lag ${Math.round(h.lagMs)}ms > ${config.hostLagMs}ms`]);
  if (h.dbPingMs === null) breaches.push(["db", "database ping failed"]);
  for (const [key, detail] of breaches) {
    if (!activeBreaches.has(key)) {
      activeBreaches.add(key);
      inc("ops.breach");
      await opsAlert(deps, `⚠️ **Host breach** — ${detail} (sha \`${h.gitSha ?? "?"}\`)`);
    }
  }
  for (const key of [...activeBreaches]) {
    if (!breaches.some(([k]) => k === key)) {
      activeBreaches.delete(key);
      await opsAlert(deps, `✅ **Host recovered** — ${key} back under limit`);
    }
  }
  return h;
}

export function startHostWatchdog(deps: OpsDeps): { stop: () => void } {
  const timer = setInterval(() => {
    runWatchdogTick(deps).catch(e => { inc("ops.watchdog_error"); logError("host watchdog tick failed", e); });
  }, config.hostHealthIntervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

// ── /ops ─────────────────────────────────────────────────────────────────────

function healthEmbed(h: HostHealth): EmbedBuilder {
  const fmt = (n: number | null, suffix = "") => n === null ? "n/a" : `${n}${suffix}`;
  const up = h.uptimeSec;
  const uptime = up >= 86400 ? `${(up / 86400).toFixed(1)}d` : up >= 3600 ? `${(up / 3600).toFixed(1)}h` : `${Math.floor(up / 60)}m`;
  return new EmbedBuilder()
    .setTitle("Characterly host — status")
    .addFields(
      { name: "Uptime", value: `${uptime} · sha \`${h.gitSha ?? "?"}\``, inline: true },
      { name: "Heap", value: `${h.heapUsedMb.toFixed(0)}/${h.heapTotalMb.toFixed(0)} MB (${h.heapPct.toFixed(0)}%)`, inline: true },
      { name: "RSS", value: `${h.rssMb.toFixed(0)} MB`, inline: true },
      { name: "Event-loop lag", value: `${h.lagMs.toFixed(0)} ms`, inline: true },
      { name: "Disk /", value: fmt(h.diskPct, "%"), inline: true },
      { name: "DB ping", value: h.dbPingMs === null ? "FAIL" : `${h.dbPingMs} ms`, inline: true },
      { name: "Job queue", value: `${h.queuePending ?? "?"} pending · ${h.queueDead ?? "?"} dead`, inline: true },
    );
}

/** Chunk a long log tail into fenced <2000-char replies — Discord's limit. */
function chunkText(text: string, max = 1800): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (cur.length + line.length + 1 > max) { chunks.push(cur); cur = ""; }
    cur += (cur ? "\n" : "") + line.slice(0, max);
  }
  if (cur) chunks.push(cur);
  // Tail is what matters — cap at 6 chunks (10k chars) and drop the oldest.
  return chunks.slice(-6);
}

export async function handleOpsCommand(interaction: ChatInputCommandInteraction): Promise<unknown> {
  if (!opsDeps) {
    return interaction.reply({ content: "Ops isn't initialized yet — the bot is still starting.", ephemeral: true });
  }
  const deps = opsDeps;
  if (!config.opsUserIds.includes(interaction.user.id)) {
    inc("ops.denied");
    return interaction.reply({ content: "That command is restricted to operators.", ephemeral: true });
  }
  if (interaction.guildId && !isHouse(interaction.guildId)) {
    return interaction.reply({ content: "`/ops` only runs in the house server (or in DM).", ephemeral: true });
  }
  const action = interaction.options.getString("action", true);

  if (action === "status") {
    const h = await collectHostHealth(deps);
    return interaction.reply({ embeds: [healthEmbed(h)], ephemeral: true });
  }

  if (action === "logs") {
    const n = Math.min(Math.max(interaction.options.getInteger("lines") ?? 30, 1), 200);
    await interaction.deferReply({ ephemeral: true });
    const { stdout, stderr } = await deps.exec(`journalctl -u characterly -n ${n} --no-pager`)
      .catch(e => ({ stdout: "", stderr: `journalctl failed: ${String((e as Error)?.message ?? e)}` }));
    const out = redactSecrets((stdout || stderr || "(no output)").trim());
    const chunks = chunkText(out);
    await interaction.editReply("```\n" + chunks[0] + "\n```");
    for (const c of chunks.slice(1)) {
      await interaction.followUp({ ephemeral: true, content: "```\n" + c + "\n```" });
    }
    return;
  }

  if (action === "restart") {
    await interaction.reply({ content: "Restarting — systemd brings me back in a few seconds.", ephemeral: true });
    setTimeout(() => deps.exit(1), 300).unref?.();
    return;
  }

  if (action === "deploy") {
    await interaction.deferReply({ ephemeral: true });
    const repoDir = config.opsRepoDir.replace(/^~(?=$|\/)/, os.homedir());
    try {
      await deps.exec(`cd "${repoDir}" && git pull --ff-only && npm ci`);
    } catch (e) {
      const detail = redactSecrets(String((e as { stderr?: string; message?: string })?.stderr ?? (e as Error)?.message ?? e)).slice(0, 1400);
      // Report where the tree actually sits: a successful `git pull` followed
      // by a failed `npm ci` leaves HEAD advanced with mismatched deps —
      // "still on <sha>" would be a lie, and the next incidental restart
      // could land new code on old modules.
      const head = await deps.exec(`cd "${repoDir}" && git rev-parse --short HEAD`).then(r => r.stdout.trim()).catch(() => "?");
      return interaction.editReply(`Deploy failed — tree is at \`${head}\`, running \`${deps.gitSha ?? "?"}\`. If the pull landed and \`npm ci\` failed, fix deps or \`git checkout ${deps.gitSha ?? "<old>"}\` before the next restart:\n\`\`\`\n${detail}\n\`\`\``);
    }
    const sha = await deps.exec(`cd "${repoDir}" && git rev-parse --short HEAD`).then(r => r.stdout.trim()).catch(() => "?");
    deps.gitSha = sha;
    await interaction.editReply(`Deployed \`${sha}\` — restarting onto it now.`);
    setTimeout(() => deps.exit(1), 300).unref?.();
    return;
  }

  if (action === "announce") {
    const text = interaction.options.getString("text")?.trim();
    if (!text) return interaction.reply({ content: "Give me the announcement text.", ephemeral: true });
    if (!config.houseAnnounceChannelId) return interaction.reply({ content: "HOUSE_ANNOUNCE_CHANNEL_ID isn't set.", ephemeral: true });
    const ch = await deps.fetchChannel(config.houseAnnounceChannelId).catch(() => null);
    if (!ch) return interaction.reply({ content: "Can't reach the announcements channel — check my permissions.", ephemeral: true });
    const sent = await ch.send({ content: text.slice(0, 1900), allowedMentions: { parse: [] } }).then(() => true).catch(e => {
      logError("ops announce failed", e);
      return false;
    });
    if (!sent) return interaction.reply({ content: "Send failed — check my channel permissions.", ephemeral: true });
    return interaction.reply({ content: `Posted in <#${config.houseAnnounceChannelId}>.`, ephemeral: true });
  }

  if (action === "layout") {
    if (!config.houseGuildId) return interaction.reply({ content: "HOUSE_GUILD_ID isn't set.", ephemeral: true });
    const guild = await deps.fetchGuild(config.houseGuildId).catch(() => null);
    if (!guild) return interaction.reply({ content: "Can't reach the house server.", ephemeral: true });
    const created = await ensureHouseLayout(guild).catch(e => {
      logError("house layout failed", e);
      return null;
    });
    if (created === null) return interaction.reply({ content: "Layout check failed — see logs.", ephemeral: true });
    const posted = await ensureResourcePosts(deps, guild).catch(e => {
      logError("resource posts failed", e);
      return null;
    });
    const panel = await ensureTicketPanel(deps, guild).catch(e => {
      logError("ticket panel failed", e);
      return null;
    });
    const did = [...created, ...(posted ?? []), ...(panel ? ["🎫 ticket panel"] : [])];
    return interaction.reply({
      content: did.length ? `Did: ${did.join(", ")}` : "Layout + resource posts already current — nothing to do.",
      ephemeral: true,
    });
  }

  if (action === "seedmarket") {
    if (!config.marketplaceChannelId) return interaction.reply({ content: "MARKETPLACE_CHANNEL_ID isn't set.", ephemeral: true });
    if (!deps.botId) return interaction.reply({ content: "I can't resolve my own user id yet.", ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    // Idempotent — personas already listed under the bot account are skipped,
    // so re-runs only fill gaps (safe after edits or new personas).
    const existing = await deps.store.listMyListings(deps.botId).catch(() => null);
    if (!existing) return interaction.editReply("Couldn't read existing listings — check the database.");
    const byName = new Map(existing.map(l => [l.name.toLowerCase(), l]));
    const cardAs = { client: interaction.client, user: interaction.client.user ?? interaction.user };
    const results: string[] = [];
    for (const p of SEED_LISTINGS) {
      let listing = byName.get(p.name.toLowerCase());
      if (listing) {
        // Recovery: a seed left delisted (rollback leftover from a failed
        // first run) relists — unless a mod took it down, which relistListing
        // refuses on its own. A row missing its thread gets a fresh card.
        if (listing.status === "delisted") {
          const rel = await deps.store.relistListing(listing.id, deps.botId, SEED_LISTINGS.length).catch(() => null);
          if (!rel?.ok) { results.push(`· ${p.name} — delisted, relist refused (${rel?.reason ?? "error"})`); continue; }
          listing = rel.listing;
        }
        if (listing.status !== "active") { results.push(`· ${p.name} — status ${listing.status}, left alone`); continue; }
        if (!listing.forumThreadId) {
          const tid = await postListingThread(cardAs, listing, deps.store, { tagNames: p.tags, coverFile: p.coverFile });
          if (!tid) { results.push(`✖ ${p.name} — thread recovery failed`); continue; }
          await deps.store.setListingThread(listing.id, tid).catch(() => {});
          results.push(`✔ ${p.name} — recovered (thread re-posted)`);
          continue;
        }
        // Cover retrofit — seed threads posted before the art existed carry no
        // attachment; attach it to the OP card so the gallery cover appears.
        // A name mismatch means the art changed → replace wholesale.
        if (p.coverFile) {
          type StarterMsg = { attachments?: { some(fn: (a: { name?: string | null }) => boolean): boolean }; edit(opts: { files: AttachmentBuilder[] }): Promise<unknown> };
          const asset = marketplaceAssetPath(p.coverFile);
          const thread = await interaction.client.channels.fetch(listing.forumThreadId).catch(() => null);
          const starter = thread && "fetchStarterMessage" in thread
            ? (await (thread as { fetchStarterMessage(): Promise<unknown> }).fetchStarterMessage().catch(() => null)) as StarterMsg | null
            : null;
          if (asset && starter && !starter.attachments?.some(a => a.name === p.coverFile)) {
            const ok = await starter.edit({ files: [new AttachmentBuilder(asset, { name: p.coverFile })] }).then(() => true).catch(() => false);
            results.push(ok ? `✔ ${p.name} — cover patched` : `✖ ${p.name} — cover patch failed`);
            continue;
          }
        }
        // Avatar retrofit — adoptee threads read coalesce(clone, listing)
        // avatars, so hosting the seeded cover here gives every existing +
        // future clone a durable face without touching their rows.
        if (!listing.avatarUrl && p.coverFile) {
          const hosted = await uploadAvatarFile(marketplaceAssetPath(p.coverFile) ?? "");
          const patched = hosted && await deps.store.updateListing(listing.id, deps.botId!, {
            name: listing.name, tagline: listing.tagline, voicePersona: listing.voicePersona,
            coreTraits: listing.coreTraits, ownerDynamic: listing.ownerDynamic,
            backstory: listing.backstory, greeting: listing.greeting, avatarUrl: hosted,
          }).catch(() => null);
          results.push(patched ? `· ${p.name} — already listed (avatar hosted)` : `· ${p.name} — already listed`);
          continue;
        }
        results.push(`· ${p.name} — already listed`);
        continue;
      }
      // Our own curated text still passes through the same deterministic
      // screen a user publish would — the standard is the standard.
      const screen = checkListingFields(p);
      if (!screen.ok) { results.push(`✖ ${p.name} — blocked by the listing screen (${screen.field}: ${screen.category})`); continue; }
      // Upload the cover art first so the listing carries a durable avatar_url
      // from birth — Discord CDN URLs expire, the Supabase object doesn't.
      const hosted = p.coverFile ? await uploadAvatarFile(marketplaceAssetPath(p.coverFile) ?? "") : null;
      const res = await deps.store.createListing(deps.botId, { ...p, avatarUrl: hosted ?? p.avatarUrl }).catch(() => null);
      if (!res?.ok) { results.push(`✖ ${p.name} — listing create failed`); continue; }
      const threadId = await postListingThread(cardAs, res.listing, deps.store, { tagNames: p.tags, coverFile: p.coverFile });
      if (!threadId) {
        await deps.store.delistListing(res.listing.id).catch(() => {});
        results.push(`✖ ${p.name} — thread post failed (rolled back)`);
        continue;
      }
      await deps.store.setListingThread(res.listing.id, threadId).catch(() => {});
      inc("market.published");
      results.push(`✔ ${p.name} — ${p.tags.join(", ")}`);
      await new Promise(r => setTimeout(r, 300)); // forum pacing — thread creates aren't free
    }
    const made = results.filter(r => r.startsWith("✔")).length;
    return interaction.editReply(`**Seed roster** — ${made} created, ${results.length - made} skipped/failed:\n${results.join("\n")}`.slice(0, 1990));
  }

  return interaction.reply({ content: `Unknown /ops action: ${action}`, ephemeral: true });
}
