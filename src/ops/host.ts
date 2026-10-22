import os from "node:os";
import v8 from "node:v8";
import { AttachmentBuilder, EmbedBuilder, escapeMarkdown, type ChatInputCommandInteraction } from "discord.js";
import { config } from "../config.js";
import { inc } from "../metrics.js";
import { logError, redactSecrets } from "../secrets.js";
import { checkListingFields } from "../safety.js";
import { marketplaceAssetPath, postListingToDeployments } from "../marketplace.js";
import { uploadAvatarFile } from "../avatars.js";
import { SEED_LISTINGS } from "../seed-personas.js";
import { applyServerGuide, ensureHouseLayout, ensureResourcePosts, GUIDE_PROMPT } from "./layout.js";
import { ensureTicketPanel } from "./tickets.js";
import { removeDeployment } from "./deploy.js";
import { houseAdopteesPressure } from "./adoptees.js";
import {
  getOpsDeps, registerSweep, deployedGuildIds, deploymentFor, houseDeployment, isHouse, normName, onOpsReset, opsAlert, refreshDeploymentCache, safeTrunc, sweepHealth, untrackDeployment, validateHouseConfig,
  type OpsDeps, type SendableChannel,
} from "./shared.js";
import type { MemoryStore, OpsStats } from "../database.js";
import type { FleetCapBreakdown } from "../fleet-cap.js";
import type { CompanionListing, GuildDeployment } from "../types.js";

// ── Host self-ops ────────────────────────────────────────────────────────────

export interface HostHealth {
  uptimeSec: number;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  heapLimitMb: number;
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
  // heapTotal is only V8's committed pool — it grows on demand and idles
  // near-full before expanding, so heapUsed/heapTotal reads ~90% on a healthy
  // process. heap_size_limit is the actual ceiling (--max-old-space-size or
  // the memory-derived default); usage against THAT is proximity to OOM.
  const heapLimitMb = v8.getHeapStatistics().heap_size_limit / 1_048_576;
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
    heapLimitMb,
    heapPct: heapLimitMb ? (heapUsedMb / heapLimitMb) * 100 : 0,
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

onOpsReset(() => activeBreaches.clear());

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
      await opsAlert(deps, `⚠️ **Host breach** — ${detail} (sha \`${h.gitSha ?? "?"}\`)`, "alert");
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
  return registerSweep("watchdog", () => runWatchdogTick(deps), config.hostHealthIntervalMs);
}

// ── /ops ─────────────────────────────────────────────────────────────────────

function healthEmbed(h: HostHealth): EmbedBuilder {
  const fmt = (n: number | null, suffix = "") => n === null ? "n/a" : `${n}${suffix}`;
  const up = h.uptimeSec;
  const uptime = up >= 86400 ? `${(up / 86400).toFixed(1)}d` : up >= 3600 ? `${(up / 3600).toFixed(1)}h` : `${Math.floor(up / 60)}m`;
  const configIssues = validateHouseConfig();
  return new EmbedBuilder()
    .setTitle("Characterly host — status")
    .addFields(
      { name: "Uptime", value: `${uptime} · sha \`${h.gitSha ?? "?"}\``, inline: true },
      { name: "Heap", value: `${h.heapUsedMb.toFixed(0)}/${h.heapLimitMb.toFixed(0)} MB (${h.heapPct.toFixed(0)}% of limit; pool ${h.heapTotalMb.toFixed(0)} MB)`, inline: true },
      { name: "RSS", value: `${h.rssMb.toFixed(0)} MB`, inline: true },
      { name: "Event-loop lag", value: `${h.lagMs.toFixed(0)} ms`, inline: true },
      { name: "Disk /", value: fmt(h.diskPct, "%"), inline: true },
      { name: "DB ping", value: h.dbPingMs === null ? "FAIL" : `${h.dbPingMs} ms`, inline: true },
      { name: "Job queue", value: `${h.queuePending ?? "?"} pending · ${h.queueDead ?? "?"} dead`, inline: true },
      ...(config.houseGuildId ? [{ name: "House config", value: configIssues.length ? configIssues.map(i => `⚠ ${i}`).join("\n") : "all wired" }] : []),
      { name: "Sweeps", value: sweepLines() || "none armed" },
    );
}

const ago = (t: number): string => {
  const s = Math.floor((Date.now() - t) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
};

function sweepLines(): string {
  return sweepHealth().map(s =>
    `${s.lastError ? "✗" : "✓"} ${s.name} — ${s.lastError ? `failing: ${safeTrunc(s.lastError, 60)}` : s.lastOkAt ? `ok ${ago(s.lastOkAt)}` : "never ran"}${s.failures ? ` (${s.failures} fail)` : ""}`
  ).join("\n");
}

/** `/ops stats` — the 7-day product picture: activity, funnel (unique users
 *  per step so re-prompts don't inflate), token flow, churn, and the top
 *  durable counters. Parallel branches (summon/adopt/link, house join→verify)
 *  get their own line rather than pretending to be one linear funnel. */
function statsEmbed(s: OpsStats, fleet?: FleetCapBreakdown): EmbedBuilder {
  const f = (e: string) => s.funnel[e]?.users ?? 0;
  const step = (label: string, n: number, prev?: number) =>
    `${label} ${n}${prev !== undefined && prev > 0 ? ` (${Math.round(100 * n / prev)}%)` : ""}`;
  const counters = s.topCounters.slice(0, 10).map(c => `${c.name} ${c.total}`).join("\n") || "(no counter data yet)";
  // During a day-ratchet hold the formula equation doesn't sum to the enforced
  // cap (e.g. a cancellation wave leaves effective above base + today's bonus)
  // — say so instead of printing an equation that doesn't add up.
  const fleetValue = fleet && `${fleet.base.toLocaleString("en-US")} base + ${fleet.bonus.toLocaleString("en-US")} bonus` +
    (fleet.effective === fleet.computed
      ? ` = **${fleet.effective.toLocaleString("en-US")}**`
      : ` = ${fleet.computed.toLocaleString("en-US")} today, day-ratchet holds **${fleet.effective.toLocaleString("en-US")}**`) +
    ` · ${fleet.premiumCount} premium subs · ${fleet.usedToday.toLocaleString("en-US")} used` +
    (fleet.effective > 0 ? ` (${Math.round(100 * fleet.usedToday / fleet.effective)}%)` : "");
  return new EmbedBuilder()
    .setTitle("Characterly stats — last 7 days")
    .addFields(
      { name: "Activity", value: `Today: **${s.dauDm}** DM users, **${s.dauGuilds}** servers · ${s.llmToday} LLM calls (${s.hostedToday} hosted)\nWeek: **${s.wauDm}** DM users, **${s.wauGuilds}** servers` },
      { name: "Funnel (unique users)", value:
        `${step("install", s.installs)} → ${step("greeted", s.greeted, s.installs)} → ${step("onboard", f("onboard_start"), s.greeted)} → ${step("awaken", f("awaken"), f("onboard_start"))}\n` +
        `summon ${f("summon")} · adopt ${s.adopted} · linked ${s.linkClaims} · dead-end summons ${f("summon_deadend")}\n` +
        `${step("house join", f("house_join"))} → ${step("verified", f("verified"), f("house_join"))}` },
      ...(s.tokens ? [{ name: "Tokens", value: `${s.tokens.spent} spent by ${s.tokens.spenders} accounts · ${s.tokens.purchased} pack-bought · ${s.tokens.premium} premium` }] : []),
      ...(fleetValue ? [{ name: "Fleet cap", value: fleetValue }] : []),
      { name: "Churn", value: `${s.deauthorized} uninstalls · ${s.dropped} dropped adoptions · ${f("guild_added")} guilds added / ${f("guild_purged")} purged` },
      { name: "Top counters", value: `\`\`\`\n${counters}\n\`\`\`` },
    );
}

/** Chunk a long log tail into fenced <2000-char replies — Discord's limit. */
function chunkText(text: string, max = 1800): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (cur.length + line.length + 1 > max) { chunks.push(cur); cur = ""; }
    cur += (cur ? "\n" : "") + safeTrunc(line, max);
  }
  if (cur) chunks.push(cur);
  // Tail is what matters — cap at 6 chunks (10k chars) and drop the oldest.
  return chunks.slice(-6);
}

export async function handleOpsCommand(interaction: ChatInputCommandInteraction): Promise<unknown> {
  const deps = getOpsDeps();
  if (!deps) {
    return interaction.reply({ content: "Ops isn't initialized yet — the bot is still starting.", ephemeral: true });
  }
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

  if (action === "stats") {
    await interaction.deferReply({ ephemeral: true });
    const s = await deps.store.opsStats();
    const fleet = await deps.fleetCap?.().catch(() => null);
    return interaction.editReply({ embeds: [statsEmbed(s, fleet ?? undefined)] });
  }

  if (action === "house") {
    if (!config.houseGuildId) {
      return interaction.reply({ content: "No house configured — HOUSE_GUILD_ID is unset.", ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    const [members, s, tickets, rules] = await Promise.all([
      deps.listMembers(config.houseGuildId).catch(() => null),
      deps.store.opsStats().catch(() => null),
      deps.store.listOpenSupportTickets ? deps.store.listOpenSupportTickets(config.houseGuildId).catch(() => []) : Promise.resolve([]),
      deps.store.modActionsByRule ? deps.store.modActionsByRule(config.houseGuildId, 86_400_000).catch(() => []) : Promise.resolve([]),
    ]);
    const verified = members && config.houseMemberRoleId
      ? members.filter(m => m.roles?.cache?.has?.(config.houseMemberRoleId!)).length
      : null;
    const f = (e: string) => s?.funnel[e]?.users ?? 0;
    const joined = f("house_join"), verified7d = f("verified");
    const oldest = tickets[0]?.openedAt; // rows arrive oldest-first
    const pressure = houseAdopteesPressure();
    return interaction.editReply({ embeds: [new EmbedBuilder()
      .setTitle("House — health")
      .addFields(
        { name: "Members", value: members ? `${members.length} total · ${verified ?? "?"} verified` : "member list unavailable", inline: true },
        { name: "Funnel (7d)", value: `join ${joined} → verified ${verified7d}${joined ? ` (${Math.round(100 * verified7d / joined)}%)` : ""}`, inline: true },
        { name: "Tickets", value: tickets.length ? `**${tickets.length}** open · oldest ${ago(new Date(oldest).getTime())}` : "none open", inline: true },
        { name: "Threads", value: pressure.count === null ? "gauge cold — sweep hasn't fetched yet" : `${pressure.count} #adoptees · ${pressure.guildTotal} guild-wide${pressure.active ? " — **FLOODGATE**" : ""}`, inline: true },
        { name: "Automod (24h)", value: rules.length ? rules.map(r => `${r.rule} ${r.n}`).join(" · ") : "quiet — no actions logged" },
        { name: "Sweeps", value: sweepLines() || "none armed" },
      )] });
  }

  if (action === "modlog") {
    const user = interaction.options.getUser("user");
    if (!user) return interaction.reply({ content: "Give me the member (`user` option).", ephemeral: true });
    const rows = deps.store.listModActionsFor
      ? await deps.store.listModActionsFor(user.id, 15).catch(() => null)
      : null;
    if (!rows) return interaction.reply({ content: "The mod ledger isn't readable right now — try again.", ephemeral: true });
    const lines = rows.map(a => {
      const when = `<t:${Math.floor(new Date(a.createdAt).getTime() / 1000)}:R>`;
      const who = a.actor === "automod" ? "automod" : `<@${a.actor}>`;
      // detail is member-authored text (message excerpts) — markdown-escaped
      // so a crafted post can't spoof the log's formatting or ping anyone.
      return `${when} — **${a.action}** by ${who}${a.rule ? ` · ${escapeMarkdown(a.rule)}` : ""}${a.detail ? `\n> ${escapeMarkdown(safeTrunc(a.detail, 160))}` : ""}`;
    });
    return interaction.reply({
      ephemeral: true,
      allowedMentions: { parse: [] },
      content: `**Mod log — <@${user.id}>**${lines.length ? `\n${lines.join("\n")}` : "\n(clean record — no actions on file)"}`,
    });
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
      // Build before exit: `npm start` runs dist/index.js, so a pull without
      // a build would restart onto a stale (or missing) artifact. Prune drops
      // dev deps — tsx stays installed as a runtime dep for the ops:* scripts.
      await deps.exec(`cd "${repoDir}" && git pull --ff-only && npm ci && npm run build && npm prune --omit=dev`);
    } catch (e) {
      const detail = safeTrunc(redactSecrets(String((e as { stderr?: string; message?: string })?.stderr ?? (e as Error)?.message ?? e)), 1400);
      // Report where the tree actually sits: a successful `git pull` followed
      // by a failed `npm ci`/build leaves HEAD advanced with mismatched deps —
      // "still on <sha>" would be a lie, and the next incidental restart
      // could land new code on old modules.
      const head = await deps.exec(`cd "${repoDir}" && git rev-parse --short HEAD`).then(r => r.stdout.trim()).catch(() => "?");
      return interaction.editReply(`Deploy failed — tree is at \`${head}\`, running \`${deps.gitSha ?? "?"}\`. If the pull landed and install/build failed, fix deps or \`git checkout ${deps.gitSha ?? "<old>"}\` before the next restart:\n\`\`\`\n${detail}\n\`\`\``);
    }
    const sha = await deps.exec(`cd "${repoDir}" && git rev-parse --short HEAD`).then(r => r.stdout.trim()).catch(() => "?");
    deps.gitSha = sha;
    await interaction.editReply(`Deployed \`${sha}\` — restarting onto it now.`);
    setTimeout(() => deps.exit(1), 300).unref?.();
    return;
  }

  if (action === "announce") {
    // Slash-command strings can't hold real newlines — \n escapes stand in.
    const text = interaction.options.getString("text")?.trim().replace(/\\n/g, "\n");
    if (!text) return interaction.reply({ content: "Give me the announcement text.", ephemeral: true });
    const chId = interaction.options.getChannel?.("channel")?.id ?? config.houseAnnounceChannelId;
    if (!chId) return interaction.reply({ content: "HOUSE_ANNOUNCE_CHANNEL_ID isn't set.", ephemeral: true });
    const ch = await deps.fetchChannel(chId).catch(() => null);
    if (!ch) return interaction.reply({ content: "Can't reach that channel — check my permissions.", ephemeral: true });
    const sent = await ch.send({ content: safeTrunc(text, 1900), allowedMentions: { parse: [] } }).then(() => true).catch(e => {
      logError("ops announce failed", e);
      return false;
    });
    if (!sent) return interaction.reply({ content: "Send failed — check my channel permissions.", ephemeral: true });
    return interaction.reply({ content: `Posted in <#${chId}>.`, ephemeral: true });
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

  if (action === "guide") {
    if (!config.houseGuildId) return interaction.reply({ content: "HOUSE_GUILD_ID isn't set.", ephemeral: true });
    const guild = await deps.fetchGuild(config.houseGuildId).catch(() => null);
    if (!guild) return interaction.reply({ content: "Can't reach the house server.", ephemeral: true });
    const res = await applyServerGuide(guild).catch(e => {
      inc("ops.guide_error");
      logError("server guide apply failed", e);
      return null;
    });
    // Discord validates server-side: COMMUNITY + safety checks, channel
    // visibility, prompt limits — a rejected patch surfaces here.
    if (!res) return interaction.reply({ content: `Guide apply failed — see logs. Discord validates onboarding server-side (community mode, safety checks, channel visibility).`, ephemeral: true });
    const miss = res.missing.length ? ` · unresolved channels: ${res.missing.map(n => `#${n}`).join(", ")}` : "";
    return interaction.reply({
      content: `Server guide applied — **${res.featuredCount}** featured channels, join prompt "${GUIDE_PROMPT.title}" (**${res.optionCount}** options)${res.described ? " · description set" : " · description unchanged"}${miss}.`,
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
    const fetchChannel = (id: string) => interaction.client.channels.fetch(id).catch(() => null);
    const deployFanout = () => [...deployedGuildIds()].map(id => deploymentFor(id)).filter((d): d is GuildDeployment => !!d);
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
          const fan = await postListingToDeployments(fetchChannel,
            deployFanout(), "the Characterly house", listing, deps.store, { tagNames: p.tags, coverFile: p.coverFile });
          const tid = fan.posted.find(x => x.guildId === config.houseGuildId)?.threadId ?? null;
          if (!tid) { results.push(`✖ ${p.name} — thread recovery failed`); continue; }
          await deps.store.setListingThread(listing.id, tid).catch(() => inc("market.post_registry_error"));
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
      const fan = await postListingToDeployments(fetchChannel,
        deployFanout(), "the Characterly house", res.listing, deps.store, { tagNames: p.tags, coverFile: p.coverFile });
      const threadId = fan.posted.find(x => x.guildId === config.houseGuildId)?.threadId ?? null;
      if (!threadId) {
        await deps.store.delistListing(res.listing.id).catch(() => inc("market.cleanup_error"));
        results.push(`✖ ${p.name} — thread post failed (rolled back)`);
        continue;
      }
      await deps.store.setListingThread(res.listing.id, threadId).catch(() => inc("market.post_registry_error"));
      inc("market.published");
      results.push(`✔ ${p.name} — ${p.tags.join(", ")}`);
      await new Promise(r => setTimeout(r, 300)); // forum pacing — thread creates aren't free
    }
    const made = results.filter(r => r.startsWith("✔")).length;
    return interaction.editReply(safeTrunc(`**Seed roster** — ${made} created, ${results.length - made} skipped/failed:\n${results.join("\n")}`, 1990));
  }

  // Partner deployments — ops controls the grant; the partner admin then runs
  // guild-scoped /marketplace deploy in their own server. Grant also registers
  // that command in the target guild (it's absent from the global list).
  if (action === "deploygrant" || action === "deployrevoke" || action === "deploystatus") {
    const guildId = interaction.options.getString("guild")?.trim();
    if (!guildId) return interaction.reply({ content: "Give me the target server id (`guild` option).", ephemeral: true });
    // The house rejects grant/revoke (its layout is env + WANTED_LAYOUT, not
    // the deployment path) but deploystatus stays reachable — the env-backed
    // row + floodgate gauge are worth reporting.
    if (action !== "deploystatus" && guildId === config.houseGuildId) {
      return interaction.reply({ content: "The house doesn't need a deployment — it IS one.", ephemeral: true });
    }

    if (action === "deploygrant") {
      if (!config.marketDeployEnabled) {
        return interaction.reply({ content: "Partner deployment is disabled (`MARKET_DEPLOY_ENABLED` isn't set) — granting now would register a dead command.", ephemeral: true });
      }
      await deps.store.grantDeployment(guildId, interaction.user.id).catch(() => null);
      // /marketplace is globally registered now — clear the legacy
      // guild-scoped copy so the guild doesn't see a duplicate command.
      try {
        const app = interaction.client.application;
        if (app?.commands?.set) await app.commands.set([], guildId);
      } catch (e) { logError("deploygrant legacy command clear failed", e); }
      await refreshDeploymentCache(deps.store);
      inc("ops.deploygrant");
      return interaction.reply({
        ephemeral: true,
        content: `**Granted** \`${guildId}\` for marketplace deployment. They can run \`/marketplace deploy\` now.`,
      });
    }

    if (action === "deploystatus") {
      // The house may have a seeded row; when it doesn't, synthesize the
      // env-backed deployment so status still reports the house uniformly.
      const row = (await deps.store.deploymentFor(guildId).catch(() => null))
        ?? (guildId === config.houseGuildId ? houseDeployment() : null);
      if (!row) return interaction.reply({ content: `No deployment row for \`${guildId}\`.`, ephemeral: true });
      const posts = await deps.store.listingPostsForGuild(guildId).catch(() => []);
      const counts = posts.reduce<Record<string, number>>((m, p) => { m[p.status] = (m[p.status] ?? 0) + 1; return m; }, {});
      const pressure = houseAdopteesPressure();
      return interaction.reply({
        ephemeral: true,
        content:
          `**Deployment \`${guildId}\`** — status \`${row.status}\` · grant \`${row.grantKind}\`\n` +
          `forum ${row.marketplaceChannelId ? `<#${row.marketplaceChannelId}>` : "—"} · adoptees ${row.adopteesChannelId ? `<#${row.adopteesChannelId}>` : "—"} · log-in ${row.loginChannelId ? `<#${row.loginChannelId}>` : "—"} · category ${row.categoryId ? `<#${row.categoryId}>` : "—"}\n` +
          `posts: ${Object.entries(counts).map(([s, n]) => `${s}=${n}`).join(" ") || "none"}${row.lastError ? `\nlast error: ${row.lastError}` : ""}` +
          (isHouse(guildId) && pressure.count !== null ? `\nfloodgate: ${pressure.active ? "**ACTIVE**" : "inactive"} — ${pressure.count} #adoptees · ${pressure.guildTotal} guild-wide (warn ${config.houseThreadWarnCount}/${config.houseGuildThreadWarnCount} · clear ${config.houseThreadClearCount}/${config.houseGuildThreadClearCount})` : ""),
      });
    }

    // deployrevoke
    const res = await removeDeployment(deps, guildId).catch(e => ({ ok: false as const, error: String((e as Error)?.message ?? e) }));
    // Clear the guild-scoped command either way — a revoked deployment loses
    // /marketplace regardless of archive success.
    try {
      const app = interaction.client.application;
      if (app?.commands?.set) await app.commands.set([], guildId);
    } catch (e) { logError("deployrevoke command clear failed", e); }
    if (!res.ok) return interaction.reply({ content: res.error ?? "Revoke failed.", ephemeral: true });
    inc("ops.deployrevoke");
    return interaction.reply({ ephemeral: true, content: `**Revoked** \`${guildId}\` — ${res.archived ?? 0} mirror posts archived, command unregistered.` });
  }

  return interaction.reply({ content: `Unknown /ops action: ${action}`, ephemeral: true });
}
