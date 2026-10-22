import { config } from "../config.js";
import { inc } from "../metrics.js";
import { logError } from "../secrets.js";
import type { MemoryStore } from "../database.js";
import type { FleetCapBreakdown } from "../fleet-cap.js";
import type { GuildDeployment } from "../types.js";
import type { GuildOnboardingEditOptions } from "discord.js";

/** Normalize a channel/role name for comparison — NFKC + lowercase +
 *  non-alphanumeric strip (Discord renders full-width variants). */
export const normName = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

// The documents' live URLs — shared by the verify gate's consent copy and
// the resource posts, so they live here rather than in either module.
export const TERMS_URL = `${config.siteUrl.replace(/\/+$/, "")}/terms`;
export const PRIVACY_URL = `${config.siteUrl.replace(/\/+$/, "")}/privacy`;

// ── House ops ────────────────────────────────────────────────────────────────
// The bot is also the private operator of OUR community server and its own
// host — member ops, deterministic automod, channel layout, and host health.
// Every path gates on HOUSE_GUILD_ID: this is never a per-guild feature, and
// /ops is allowlisted to OPS_USER_IDS (person-level — it controls the box).
// Lives outside index.ts so it can be unit-tested; index.ts wires the
// listeners and passes live singletons through OpsDeps.

export const isHouse = (guildId: string | null | undefined): boolean =>
  !!config.houseGuildId && guildId === config.houseGuildId;

/** Names every house feature that's configured off, and the env var(s)
 *  missing — each feature gates on its own envs and degrades silently, so
 *  a partial config otherwise reads as "the card just didn't post". Returns
 *  [] when the layer itself is off: HOUSE_GUILD_ID unset is a legitimate
 *  mode (self-host), not a defect. Surfaced as boot warnings + a field in
 *  `/ops status`. */
export function validateHouseConfig(): string[] {
  if (!config.houseGuildId) return [];
  const issues: string[] = [];
  const flag = (feature: string, vars: Array<[unknown, string]>) => {
    const missing = vars.filter(([v]) => !v).map(([, n]) => n);
    if (missing.length) issues.push(`${feature} — ${missing.join(" + ")} unset`);
  };
  flag("verify gate + role sweeps", [[config.houseVerifyChannelId, "HOUSE_VERIFY_CHANNEL_ID"], [config.houseMemberRoleId, "HOUSE_MEMBER_ROLE_ID"]]);
  flag("welcome posts", [[config.houseWelcomeChannelId, "HOUSE_WELCOME_CHANNEL_ID"]]);
  flag("adoptee threads + floodgate", [[config.houseAdopteesChannelId, "HOUSE_ADOPTEES_CHANNEL_ID"]]);
  flag("announce target", [[config.houseAnnounceChannelId, "HOUSE_ANNOUNCE_CHANNEL_ID"]]);
  flag("adopter join link", [[config.houseInviteUrl, "HOUSE_INVITE_URL"]]);
  if (!config.opsChannelId) issues.push("ops alerts dropped — OPS_CHANNEL_ID unset");
  if (!config.opsUserIds.length) issues.push("/ops unusable — OPS_USER_IDS empty");
  if (config.houseThreadWarnCount <= config.houseThreadClearCount)
    issues.push(`floodgate inverted — HOUSE_THREAD_WARN ${config.houseThreadWarnCount} ≤ CLEAR ${config.houseThreadClearCount}`);
  if (config.houseGuildThreadWarnCount <= config.houseGuildThreadClearCount)
    issues.push(`floodgate inverted — HOUSE_GUILD_THREAD_WARN ${config.houseGuildThreadWarnCount} ≤ CLEAR ${config.houseGuildThreadClearCount}`);
  return issues;
}

/** True when the channel is a thread inside ANY deployed marketplace forum —
 *  the listing comment surface. Used to keep comments out of the memory/reply
 *  pipeline (index.ts) and to scope the "Report message" context command.
 *  The env forum short-circuits so tests and pre-cache boots still match. */
export const isMarketplaceThread = (channel: { isThread?(): boolean; parentId?: string | null } | null | undefined): boolean =>
  !!channel?.isThread?.() && !!channel.parentId && marketplaceForumIds().has(channel.parentId);

/** True when the channel is a thread under a deployed #adoptees channel —
 *  an adopted companion's private chat surface (v54/v59). Channel-id match
 *  covers every deployment; the name fallback is house-only — a foreign
 *  guild's "adoptees" channel is just a channel, not our surface. */
export const isAdopteeThread = (channel: { isThread?(): boolean; parentId?: string | null; guildId?: string | null; guild?: { id?: string | null } | null; parent?: { name?: string | null; guildId?: string | null } | null } | null | undefined): boolean => {
  if (!channel?.isThread?.()) return false;
  if (channel.parentId && adopteesChannelIds().has(channel.parentId)) return true;
  if (config.houseAdopteesChannelId && channel.parentId === config.houseAdopteesChannelId) return true;
  const guildId = channel.guildId ?? channel.parent?.guildId ?? channel.guild?.id ?? null;
  return guildId === config.houseGuildId && normName(channel.parent?.name ?? "") === "adoptees";
};

// ── Deployment registry (v59) ────────────────────────────────────────────────
// guild_deployments rows cached in-process: which servers run Characterly
// surfaces (house included — seeded from env at boot). Refreshed by initOps,
// deploy/remove paths, and the sync sweep. Reads are pure-Map; the store is
// only hit on mutation or refresh.

const deploymentCache = new Map<string, GuildDeployment>();

/** House row synthesized from env — present even before the DB seed lands.
 *  The house's log-in channel IS the verify gate (different card, different
 *  flow) — seeding it here keeps the sweep's loginOk check green without
 *  ever reconciling a deployed layout or signpost card into the house. */
export function houseDeployment(): GuildDeployment | null {
  if (!config.houseGuildId) return null;
  return {
    guildId: config.houseGuildId,
    status: "active",
    marketplaceChannelId: config.marketplaceChannelId ?? null,
    adopteesChannelId: config.houseAdopteesChannelId ?? null,
    categoryId: null, loginChannelId: config.houseVerifyChannelId ?? null, grantKind: "ops",
    deployedBy: null, deployedAt: null, lastError: null,
  };
}

/** Rebuild the cache from the DB (house row synthesized/seeded on top). */
export async function refreshDeploymentCache(store: MemoryStore): Promise<void> {
  const rows = await store.deployments().catch(() => null);
  if (!rows) return;
  deploymentCache.clear();
  for (const d of rows) deploymentCache.set(d.guildId, d);
  // The house's row is env-AUTHORITATIVE — a seeded DB row carrying stale
  // channel ids must not shadow the live env values in lookups.
  const house = houseDeployment();
  if (house) deploymentCache.set(house.guildId, house);
}

/** Drop a guild from the in-process map — GuildDelete purges the row; the
 *  cache must forget it in the same beat or a kicked server keeps surfaces. */
export function untrackDeployment(guildId: string): void { deploymentCache.delete(guildId); }

/** The cached deployment row for a guild (house synthesizes one from env). */
export function deploymentFor(guildId: string | null | undefined): GuildDeployment | null {
  if (!guildId) return null;
  const hit = deploymentCache.get(guildId);
  if (hit) return hit;
  return guildId === config.houseGuildId ? houseDeployment() : null;
}

/** Guilds whose Characterly surfaces should be live (granted-but-undeployed
 *  rows don't count — nothing exists there yet). */
export function deployedGuildIds(): Set<string> {
  const out = new Set<string>();
  for (const d of deploymentCache.values()) if (d.status === "active") out.add(d.guildId);
  const house = houseDeployment();
  if (house) out.add(house.guildId);
  return out;
}

/** Every forum channel id hosting mirrored listings (env + deployments). */
export function marketplaceForumIds(): Set<string> {
  const out = new Set<string>();
  if (config.marketplaceChannelId) out.add(config.marketplaceChannelId);
  for (const d of deploymentCache.values()) {
    if (d.status === "active" && d.marketplaceChannelId) out.add(d.marketplaceChannelId);
  }
  return out;
}

/** Every adoptees channel id across deployments (env + deployments). */
export function adopteesChannelIds(): Set<string> {
  const out = new Set<string>();
  if (config.houseAdopteesChannelId) out.add(config.houseAdopteesChannelId);
  for (const d of deploymentCache.values()) {
    if (d.status === "active" && d.adopteesChannelId) out.add(d.adopteesChannelId);
  }
  return out;
}

/** All cached deployment rows — sweeps iterate these; the map itself stays
 *  private so mutations go through refresh/untrack. */
export function deploymentRows(): GuildDeployment[] {
  return [...deploymentCache.values()];
}

// Narrow structural shapes — tests hand fakes, index.ts casts the real objects.
export interface ForumTagLike {
  id: string;
  name: string;
  moderated?: boolean | null;
}

export interface ThreadLike {
  id: string;
  /** The channel a thread hangs under — the floodgate counts #adoptees
   *  children, not the whole guild's active threads. */
  parentId?: string | null;
  appliedTags?: string[];
  createdTimestamp?: number | null;
  setAppliedTags?(tags: string[]): Promise<unknown>;
}

/** The ticket thread surface — created private, joined by the opener. */
export interface TicketThreadLike {
  id: string;
  members?: { add(userId: string): Promise<unknown> };
  send(payload: unknown): Promise<unknown>;
  setLocked?(locked: boolean): Promise<unknown>;
  setArchived?(archived: boolean): Promise<unknown>;
  /** Real threads — the manage-row backfill inspects pinned + recent
   *  messages. discord.js Collections yield [snowflake, message] pairs;
   *  plain iterables yield messages — both shapes are unwrapped at the
   *  call site. */
  messages?: {
    fetch(opts: { limit: number }): Promise<Iterable<unknown>>;
    /** The manage row is pinned — fetchPinned is the dup-proof check; a
     *  recent-message scan can scroll past it on a busy thread. */
    fetchPinned?(): Promise<Iterable<unknown>>;
  };
}

export interface SendableChannel {
  /** Absent on minimal fakes — adoption stamping tolerates the loss. */
  id?: string;
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
  /** Forum channels — the live tag taxonomy deployments reconcile against. */
  availableTags?: ForumTagLike[];
  /** Forum channels — deployments seed + reconcile the marketplace taxonomy. */
  setAvailableTags?(tags: Array<{ id?: string; name: string; moderated?: boolean }>): Promise<unknown>;
  edit?(opts: { defaultForumLayout?: number; name?: string }): Promise<unknown>;
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
  /** Discord feature strings — deployments require "COMMUNITY" (forums). */
  features?: string[];
  channels: {
    cache: { find(fn: (c: GuildChannelLike) => boolean): GuildChannelLike | undefined };
    /** discord.js accepts forum fields on create too — deployments pass
     *  availableTags + defaultForumLayout so #characters lands Gallery-first. */
    create(opts: { name: string; type: number; parent?: string; topic?: string; availableTags?: Array<{ name: string; moderated?: boolean }>; defaultForumLayout?: number; permissionOverwrites?: Array<{ id: string; allow: unknown; deny: unknown }> }): Promise<GuildChannelLike>;
    /** Guild-level active-thread fetch — the floodgate counts live #adoptees
     *  children. Absent on test fakes that don't exercise the floodgate. */
    fetchActiveThreads?(): Promise<{ threads: Map<string, ThreadLike> | Iterable<[string, ThreadLike]> | Iterable<ThreadLike> }>;
  };
  roles?: {
    cache?: { find(fn: (r: { id: string; name: string }) => boolean): { id: string; name: string } | undefined };
  };
  /** The bot's own member — deployments check its permissions before
   *  creating surfaces. `fetchMe` preferred; `me` is the cache path. */
  members?: {
    me?: { permissions?: { has(flag: bigint): boolean } | null } | null;
    fetchMe?(): Promise<{ permissions?: { has(flag: bigint): boolean } | null } | null>;
  };
  /** The Server Guide is the guild's onboarding object (featured channels +
   *  join prompts) — /ops guide reconciles it. Absent on test fakes. */
  editOnboarding?(opts: GuildOnboardingEditOptions): Promise<unknown>;
  /** Guild description — the Server Guide page renders it. */
  setDescription?(description: string): Promise<unknown>;
}

export interface MemberLike {
  pending?: boolean | null;
  user: { id: string; bot?: boolean | null; username?: string; createdTimestamp?: number };
  guild: { id: string };
  /** Join time — the verify-nudge sweep's >24h gate. Absent on minimal
   *  test fakes; a missing timestamp reads as "unknown" → skip. */
  joinedTimestamp?: number | null;
  /** DM the member (verify nudge). Absent on fakes without DM support. */
  send?(payload: unknown): Promise<unknown>;
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
    /** discord.js's channel-overwrite-aware check — a member whose perms
     *  come from an overwrite (not a role) is still staff to automod.
     *  Absent on minimal test fakes; falls back to role-level permissions. */
    permissionsIn?(channelId: string): { has(flag: bigint): boolean } | null;
    timeout?(ms: number, reason?: string): Promise<unknown>;
    /** Present on real members — the escalation ladder's top rung. */
    kick?(reason?: string): Promise<unknown>;
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
  /** User lookup for display names — deployment sweeps credit listing
   *  creators on mirror posts without holding an interaction. */
  fetchUser?: (userId: string) => Promise<{ username?: string; globalName?: string | null } | null>;
  /** The bot's own user id — gate-card idempotency checks message authorship. */
  botId: string | null;
  /** OAuth install link — the floodgate card's "add me to your server" button.
   *  Built from the live application id in index.ts; null where unavailable. */
  botInviteUrl?: string | null;
  exec: (cmd: string) => Promise<{ stdout: string; stderr: string }>;
  exit: (code: number) => void;
  /** Timed SELECT 1 — index.ts runs it on the shared pool. */
  dbPing: () => Promise<number>;
  /** Mean event-loop lag in ms since the last sample (index.ts owns the histogram). */
  lagMs: () => number;
  gitSha: string | null;
  /** Live fleet-cap breakdown for /ops stats — undefined where the provider
   *  isn't wired (tests, a partial deps object). */
  fleetCap?: () => Promise<FleetCapBreakdown>;
}

// Module deps for handleOpsCommand (commands.ts can't receive them) — index.ts
// calls initOps once at ClientReady. Direct functions always take deps.
let opsDeps: OpsDeps | null = null;
export function initOps(d: OpsDeps): void { opsDeps = d; }
/** Module-level access for interaction handlers in commands.ts — ops deps
 *  are wired at ClientReady, long before any interaction can arrive. */
export function getOpsDeps(): OpsDeps | null { return opsDeps; }

// Module reset hooks — each ops module registers a cleaner for its own
// in-memory state (raid/burst windows, breach latches, pressure state) so
// resetOpsState stays centralized without shared.ts importing feature code.
const resetHooks: Array<() => void> = [];
export function onOpsReset(fn: () => void): void { resetHooks.push(fn); }

/** Test-only: module state across the ops layer resets — fakes count on a
 *  clean slate per test. */
export function resetOpsState(): void {
  deploymentCache.clear();
  sweepRegistry.clear();
  for (const fn of resetHooks) fn();
}

// ── Sweep registry ───────────────────────────────────────────────────────────
// Every recurring reconcile (link sweep, ticket reaper, tag sweep, deployment
// sync, host watchdog) is one interval wrapper around an async fn. Registered
// sweeps report last-run/last-ok/last-error so /ops status can show a dead
// sweep instead of discovering it via missing side effects.

export interface SweepHealth {
  name: string;
  runs: number;
  failures: number;
  lastRunAt: number | null;
  lastOkAt: number | null;
  lastError: string | null;
  lastDurationMs: number | null;
}

const sweepRegistry = new Map<string, SweepHealth>();

/** Arm a recurring sweep. The tick is fire-and-report: failures count into
 *  the entry (and the shared error metric + log) but never unhandled-reject. */
export function registerSweep(name: string, fn: () => Promise<unknown>, intervalMs: number): { stop: () => void } {
  const entry: SweepHealth = { name, runs: 0, failures: 0, lastRunAt: null, lastOkAt: null, lastError: null, lastDurationMs: null };
  sweepRegistry.set(name, entry);
  const timer = setInterval(() => {
    const started = Date.now();
    entry.lastRunAt = started;
    entry.runs += 1;
    Promise.resolve()
      .then(fn)
      .then(() => { entry.lastOkAt = Date.now(); entry.lastDurationMs = entry.lastOkAt - started; entry.lastError = null; })
      .catch(e => {
        entry.failures += 1;
        entry.lastError = String((e as Error)?.message ?? e).slice(0, 200);
        inc("ops.sweep_error");
        logError(`sweep ${name} failed`, e);
      });
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/** Read-only snapshot of every registered sweep — /ops status + the house
 *  dashboard render staleness (a sweep that hasn't run in 2× its cadence is
 *  effectively down). */
export function sweepHealth(): SweepHealth[] {
  return [...sweepRegistry.values()];
}

export async function opsChannel(deps: OpsDeps): Promise<SendableChannel | null> {
  if (!config.opsChannelId) return null;
  return deps.fetchChannel(config.opsChannelId).catch(() => null);
}

/** .slice() on a length boundary can split a surrogate pair — the lone
 *  surrogate that remains makes Discord reject the whole send as malformed
 *  JSON (the alert is lost while the action already applied). Truncate on
 *  code points for anything user- or member-authored that reaches the API. */
export function safeTrunc(s: string, max: number): string {
  return s.length <= max ? s : [...s].slice(0, max).join("");
}

/** The channel a severity routes to: "alert" prefers the dedicated
 *  OPS_ALERT_CHANNEL_ID (high-signal — raids, breaches, kicks) and falls
 *  back to the ops channel when unconfigured or unreachable. */
export async function opsAlertChannel(deps: OpsDeps): Promise<SendableChannel | null> {
  if (config.opsAlertChannelId) {
    const ch = await deps.fetchChannel(config.opsAlertChannelId).catch(() => null);
    if (ch?.send) return ch;
  }
  return opsChannel(deps);
}

/** Alerts never ping — `parse: []` mutes any mentions inside the text.
 *  severity "alert" routes to the dedicated alert channel when configured;
 *  everything else lands in the ops log channel. */
export async function opsAlert(deps: OpsDeps, text: string, severity: "info" | "alert" = "info"): Promise<void> {
  const ch = severity === "alert" ? await opsAlertChannel(deps) : await opsChannel(deps);
  await ch?.send({ content: safeTrunc(text, 1900), allowedMentions: { parse: [] } })
    .catch(e => { inc("ops.alert_error"); logError("ops alert send failed", e); });
}

// ── Persistent card lifecycle ────────────────────────────────────────────
// The verify gate, ticket panel, deployment login card, and floodgate card
// share one reconcile: scan the channel's recent messages for bot-authored
// cards carrying a marker (a customId in components, or a footer/content
// line), keep the first, delete duplicates, edit a stale version in place,
// and post (optionally pinned) when absent. Conditional cards — the
// floodgate — pass stand:false to remove every copy instead.

export interface CardMessageLike {
  author?: { id?: string };
  content?: string;
  components?: unknown;
  embeds?: unknown;
  edit?(o: unknown): Promise<unknown>;
  delete?(): Promise<unknown>;
}

function cardBlob(m: CardMessageLike): string {
  return `${m.content ?? ""}\n${JSON.stringify(m.components ?? [])}\n${JSON.stringify(m.embeds ?? [])}`;
}

/** Fetched pages arrive as Collections ([id, message] tuples) on discord.js
 *  and bare iterables in test fakes — unwrap both to messages. */
function cardEntries(recent: Iterable<unknown>): CardMessageLike[] {
  return [...recent].map(e => (Array.isArray(e) ? e[1] : e)) as CardMessageLike[];
}

export interface ReconcileCardResult {
  /** A card was posted this call. */
  posted: boolean;
  /** The kept card was edited in place (stale version). */
  edited: boolean;
}

export async function reconcileMarkedCard(
  deps: OpsDeps,
  ch: SendableChannel,
  opts: {
    /** Substring identifying the card — found in content, components JSON,
     *  or embeds JSON. A customId or footer marker both work. */
    match: string;
    /** False deletes every matching card and posts nothing — the
     *  conditional-card path. Defaults true. */
    stand?: boolean;
    /** Marker preceding `· vN` in the card text — defaults to `match`.
     *  Only consulted when `version` is set. */
    versionMarker?: string;
    /** Cards below this version are edited to `payload` in place;
     *  unmarked cards count as v0. Omit to skip version checks. */
    version?: number;
    /** Message payload for post/edit — required when `stand` is true. */
    payload?: unknown;
    /** Pin a freshly posted card. */
    pin?: boolean;
  },
): Promise<ReconcileCardResult> {
  const { match, stand = true, versionMarker = match, version, payload, pin } = opts;
  if (!deps.botId) return { posted: false, edited: false };
  const recent = await ch.messages?.fetch({ limit: 20 }).catch(() => null);
  if (recent) {
    let kept = false;
    let edited = false;
    const versionRe = version !== undefined ? new RegExp(`${versionMarker} · v(\\d+)`) : null;
    for (const m of cardEntries(recent)) {
      if (m.author?.id !== deps.botId || !cardBlob(m).includes(match)) continue;
      if (!stand) { await m.delete?.().catch(() => {}); continue; }
      if (kept) { await m.delete?.().catch(() => {}); continue; }
      kept = true;
      if (versionRe && m.edit) {
        const v = Number(versionRe.exec(cardBlob(m))?.[1] ?? "0");
        if (v < (version ?? 0)) await m.edit(payload).then(() => { edited = true; }).catch(() => {});
      }
    }
    if (kept || !stand) return { posted: false, edited };
  }
  if (!stand) return { posted: false, edited: false };
  const sent = await ch.send(payload);
  if (pin) await (sent as { pin?(): Promise<unknown> } | null)?.pin?.().catch(() => {});
  return { posted: true, edited: false };
}
