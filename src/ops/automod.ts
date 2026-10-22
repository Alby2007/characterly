import { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, escapeMarkdown, type ButtonInteraction } from "discord.js";
import { config } from "../config.js";
import { inc } from "../metrics.js";
import { logError } from "../secrets.js";
import { checkMessageContent, REPORT_CATEGORIES } from "../safety.js";
import { getOpsDeps, isHouse, onOpsReset, opsAlert, opsAlertChannel, safeTrunc, type AutomodMessage, type OpsDeps } from "./shared.js";

// ── Auto-moderation ──────────────────────────────────────────────────────────
// Deterministic rules, house guild only. Runs before archive/LLM work so a
// deleted scam never enters the memory pipeline or spends a credit.

const INVITE_RE = /(?:discord\.gg\/|discord(?:app)?\.com\/invites?\/)/i;
// Capturing variant for extracting the code — /g is required for matchAll.
const INVITE_CODE_RE = /(?:discord\.gg\/|discord(?:app)?\.com\/invites?\/)([\w-]+)/gi;
// The house's own invite code — a member re-sharing it is growth, not
// phishing. Any other code in the same message still trips the rule.
// Invite codes are case-sensitive, so the comparison is exact — a foreign
// invite whose code differs only by case is NOT the house's invite.
// Read lazily (not at module load) so tests can set config.houseInviteUrl.
function houseInviteCode(): string | null {
  const m = config.houseInviteUrl
    ? /(?:discord\.gg\/|discord(?:app)?\.com\/invites?\/)([\w-]+)/i.exec(config.houseInviteUrl)
    : null;
  return m?.[1] ?? null;
}
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

// Escalation ladder (v66): the mod_actions ledger counts prior validated
// offenses inside the window; the action about to happen is count+1.
// Offense-indexed timeout rungs — a rule's own base can outrank the early
// rungs (a scam's 10m beats the generic 5m), and delete-only rules earn
// timeouts from offense 2. The top rung is a kick at AUTOMOD_KICK_THRESHOLD
// (0 disables); a failed kick falls back to the capped timeout.
const ESCALATE_WINDOW_MS = 24 * 60 * 60_000;
const ESCALATE_LADDER_MS = [5 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];

onOpsReset(() => { burstWindow.clear(); lastActedAt.clear(); });

/** Returns true when automod acted (message deleted / member sanctioned) —
 * the caller skips all further handling for the message. */
export async function automodMessage(message: AutomodMessage, deps: OpsDeps): Promise<boolean> {
  if (!isHouse(message.guildId)) return false;
  if (message.author.bot) return false;
  // Manage Messages holders are trusted — a mod posting an invite link to
  // the rules channel shouldn't eat a timeout. permissionsIn folds channel
  // overwrites in — a mod whose ManageMessages is channel-granted (not
  // role-granted) is still staff.
  const effectivePerms = () => {
    try {
      return message.member?.permissionsIn?.(message.channelId) ?? message.member?.permissions ?? null;
    } catch {
      return message.member?.permissions ?? null;
    }
  };
  if (effectivePerms()?.has(PermissionFlagsBits.ManageMessages)) return false;

  const jump = message.url ?? `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
  const excerpt = safeTrunc(message.content.trim(), 120).replace(/\n+/g, " ");

  const act = async (rule: string, timeoutMs?: number): Promise<boolean> => {
    const now = Date.now();
    const last = lastActedAt.get(message.author.id) ?? 0;
    lastActedAt.set(message.author.id, now);
    // Bound the map by evicting cooled-down entries, not clearing — a
    // wholesale clear resets every active offender's cooldown mid-incident
    // and the ops channel re-floods on the very next message.
    if (lastActedAt.size > 10_000) {
      for (const [id, at] of lastActedAt) {
        if (now - at > ACTION_COOLDOWN_MS) lastActedAt.delete(id);
        if (lastActedAt.size <= 5_000) break;
      }
    }
    if (now - last < ACTION_COOLDOWN_MS) {
      // Same offender, same burst — keep deleting, don't re-alert/re-timeout.
      await message.delete().catch(() => {});
      inc("ops.automod_suppressed");
      return true;
    }
    // Escalation: prior validated offenses in the window + this one.
    // A ledger read failure means "no history" — safer to under-escalate
    // than to kick on an unknown count. Optional-chained: partial test
    // stores may not carry the ledger.
    const prior = deps.store.modActionOffenseCount
      ? await deps.store.modActionOffenseCount(message.author.id, ESCALATE_WINDOW_MS).catch(() => 0)
      : 0;
    const offense = 1 + prior;
    const willKick = config.automodKickThreshold > 0 && offense >= config.automodKickThreshold;
    const rung = ESCALATE_LADDER_MS[Math.min(offense, ESCALATE_LADDER_MS.length) - 1];
    const escalatedMs = timeoutMs === undefined && offense < 2 ? undefined : Math.max(timeoutMs ?? 0, rung);
    const deleted = await message.delete().then(() => true).catch(() => false);
    const kicked = willKick && message.member?.kick
      ? await message.member.kick(`automod: ${rule} (offense ${offense})`).then(() => true).catch(() => false)
      : false;
    let timedOut = false;
    if (!kicked && escalatedMs && message.member?.timeout) {
      timedOut = await message.member.timeout(escalatedMs, `automod: ${rule} (offense ${offense})`).then(() => true).catch(() => false);
    }
    const action = [deleted && "deleted", kicked && "kicked", !kicked && timedOut && `timeout ${Math.round(escalatedMs! / 60_000)}m`].filter(Boolean).join(" + ") || "flagged (no perms)";
    inc("ops.automod");
    await deps.store.recordModAction?.({
      guildId: message.guildId!, targetId: message.author.id, actor: "automod",
      action: kicked ? "kick" : timedOut ? "timeout" : deleted ? "delete" : "warn",
      rule, detail: excerpt, messageId: message.id, channelId: message.channelId,
    })?.catch(() => {});
    // A kick is the loud page; routine delete+timeout stays in the log lane.
    await opsAlert(deps, `🛡️ **${rule}** — <@${message.author.id}> in <#${message.channelId}> → ${action} (offense ${offense}/24h)\n> ${excerpt}\n${jump}`,
      kicked ? "alert" : "info");
    return true;
  };

  // Scam classes BEFORE the generic invite rule — scam authors bundle an
  // invite link, and classifying them as "invite link" (delete only) would
  // dodge the scam timeout. Same defensive-regex style as safety.ts's
  // listing blocklist.
  for (const { rule, re } of SCAM_PATTERNS) {
    if (re.test(message.content)) return act(rule, 10 * 60_000);
  }
  // Hard-line content — the listing blocklist applied to live chat: slurs,
  // minor-safety text, self-harm promotion, illegal content get deleted and
  // timeout the author, in comments and everywhere else in the house guild.
  const contentHit = checkMessageContent(message.content);
  if (!contentHit.ok) return act(`hard-line content (${contentHit.category})`, 30 * 60_000);
  // Invite links — the fastest phishing vector on a community server. The
  // house's own invite gets a pass; a post bundling it with any other code
  // (or an unparseable link) is still a violation.
  if (INVITE_RE.test(message.content)) {
    const codes = [...message.content.matchAll(INVITE_CODE_RE)].map(m => m[1]);
    const houseCode = houseInviteCode();
    if (!houseCode || !codes.length || codes.some(c => c !== houseCode)) return act("invite link");
  }
  // Mass mention — or @everyone/here from a member who lacks the permission.
  // Role mentions count too — a dozen @role pings is the same spam shape.
  const overMentions = message.mentions.users.size + (message.mentions.roles?.size ?? 0) > config.automodMentionMax;
  const illegalEveryone = message.mentions.everyone &&
    !(effectivePerms()?.has(PermissionFlagsBits.MentionEveryone) ?? false);
  if (overMentions || illegalEveryone) return act("mass mention");
  // Burst spam — rolling per-user window.
  const now = Date.now();
  const times = burstWindow.get(message.author.id) ?? [];
  while (times.length && now - times[0] > config.automodBurstWindowMs) times.shift();
  times.push(now);
  burstWindow.set(message.author.id, times);
  // Same anti-reset pruning as the action cooldown — evict authors whose
  // burst already decayed rather than wiping every live window at the cap.
  if (burstWindow.size > 5_000) {
    for (const [id, ts] of burstWindow) {
      if (!ts.length || now - ts[ts.length - 1] > config.automodBurstWindowMs) burstWindow.delete(id);
      if (burstWindow.size <= 2_500) break;
    }
  }
  if (times.length > config.automodBurstCount) return act("burst spam", 5 * 60_000);
  // New accounts posting links are almost never legitimate.
  const created = message.author.createdTimestamp;
  if (created && LINK_RE.test(message.content) &&
    now - created < config.automodNewAccountDays * 86_400_000) {
    return act("new-account link");
  }
  return false;
}

// ── House message reports ──────────────────────────────────────────────────
// The "Report message" context command works anywhere in the house, not just
// marketplace threads — a member being harassed in #the-hub needs the same
// flag path listing comments get. Reports file into comment_reports with
// listing_id NULL (the row predates house scope; NULL marks a house report)
// and relay to the ops channel with keep/del/timeout mod buttons whose
// resolutions land in the mod_actions ledger.

export const HOUSE_REPORT_CATEGORIES = REPORT_CATEGORIES.filter(([c]) => c !== "theft");

type ReportableMessage = {
  id: string; content: string; author: { id: string; bot?: boolean | null };
  delete?(): Promise<unknown>;
};

/** house:reportcat:{channelId}:{messageId}:{category} — the category pick on
 *  a house report. Re-verifies everything the entry checked (customIds are
 *  forgeable): house guild, live message, not the reporter's own, not a
 *  bot's. The filed row shares the reporter's daily cap with listing
 *  reports — report-bombing protection doesn't care which lane. */
export async function handleHouseReportCategory(interaction: ButtonInteraction): Promise<unknown> {
  const deps = getOpsDeps();
  if (!deps) return interaction.update({ content: "Ops isn't initialized yet — try again in a moment.", components: [] });
  const parts = interaction.customId.split(":");
  const channelId = parts[2];
  const messageId = parts[3];
  const category = HOUSE_REPORT_CATEGORIES.some(([c]) => c === parts[4]) ? parts[4] : "other";
  if (!isHouse(interaction.guildId)) {
    return interaction.update({ content: "That button only works in our community server.", components: [] });
  }
  const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
  const target = channel && "messages" in channel
    ? await (channel as { messages: { fetch(id: string): Promise<ReportableMessage | null> } }).messages.fetch(messageId).catch(() => null)
    : null;
  if (!target) {
    return interaction.update({ content: "That message is already gone — nothing to report.", components: [] });
  }
  if (target.author.bot) {
    return interaction.update({ content: "That's a bot message — flag it in a ticket if something's wrong with it.", components: [] });
  }
  if (target.author.id === interaction.user.id) {
    return interaction.update({ content: "You can't report your own message.", components: [] });
  }
  const rep = await deps.store.reportComment({
    listingId: null, threadId: channelId, messageId,
    authorUserId: target.author.id, reporterUserId: interaction.user.id, category,
  }, config.marketReportDailyCap).catch(() => null);
  if (!rep?.ok) {
    return interaction.update({
      content: rep === null
        ? "Couldn't file that report right now — try again in a moment."
        : rep.reason === "daily_cap"
          ? `You've filed ${config.marketReportDailyCap} reports today — that's the limit.`
          : "You've already reported that message — the team has it.",
      components: [],
    });
  }
  const catLabel = HOUSE_REPORT_CATEGORIES.find(([c]) => c === category)?.[1] ?? category;
  const modChannel = await opsAlertChannel(deps);
  if (modChannel) {
    // Quoted content can carry mentions — suppress parsing entirely, then
    // allow-list just the author/reporter pings we emit ourselves.
    const excerpt = escapeMarkdown(safeTrunc(target.content.trim().replace(/\n+/g, " "), 400)) || "*(no text)*";
    await modChannel.send({
      allowedMentions: { parse: [], users: [target.author.id, interaction.user.id] },
      content:
        `💬 **${catLabel}** — house report in <#${channelId}>\n` +
        `Author <@${target.author.id}> · reported by <@${interaction.user.id}>\n> ${excerpt}\n` +
        `https://discord.com/channels/${interaction.guildId}/${channelId}/${messageId}`,
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`house:modmsg:keep:${channelId}:${messageId}:${target.author.id}`).setLabel("Keep").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`house:modmsg:del:${channelId}:${messageId}:${target.author.id}`).setLabel("Delete message").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`house:modmsg:timeout:${channelId}:${messageId}:${target.author.id}`).setLabel("Timeout author (10m)").setStyle(ButtonStyle.Danger),
      )],
    }).catch(e => { inc("ops.report_ping_error"); logError("house report relay failed", e); });
  }
  inc("ops.house_reported");
  return interaction.update({ content: `Thanks — your **${catLabel}** report is with the mods.`, components: [] });
}

/** house:modmsg:{action}:{channelId}:{messageId}:{authorId} — staff actions
 *  on a house report relay. The gate is message-management perms (house
 *  staff), NOT ops allowlist — these buttons sit in the ops channel where
 *  mods work. Every resolution writes mod_actions with the clicker as
 *  actor; report_keep is logged for audit but doesn't count as an offense. */
export async function handleHouseModAction(interaction: ButtonInteraction): Promise<unknown> {
  const deps = getOpsDeps();
  if (!deps) return interaction.update({ content: "Ops isn't initialized yet — try again in a moment.", components: [] });
  const parts = interaction.customId.split(":");
  const action = parts[2];
  const channelId = parts[3];
  const messageId = parts[4];
  if (!channelId || !messageId) return interaction.update({ content: "That button is no longer valid.", components: [] });
  const perms = interaction.memberPermissions;
  const isStaff = !!perms?.has?.(PermissionFlagsBits.ManageMessages) || !!perms?.has?.(PermissionFlagsBits.ManageGuild);
  if (!isStaff) return interaction.reply({ content: "Moderator role required.", ephemeral: true });
  const stamp = `by <@${interaction.user.id}> · <t:${Math.floor(Date.now() / 1000)}:R>`;
  // Resolve the reported author from the filed report row once — the
  // customId's author field is forgeable, so it can't be the record of who
  // was acted on (punishment AND ledger read the same resolved id).
  const rec = deps.store.commentReportFor ? await deps.store.commentReportFor(messageId).catch(() => null) : null;
  const authorId = rec?.authorUserId ?? parts[5] ?? "?";
  const log = (action: string, rule: string | null, detail = "") =>
    deps.store.recordModAction?.({
      guildId: interaction.guildId ?? "", targetId: authorId, actor: interaction.user.id,
      action, rule, detail, messageId, channelId,
    })?.catch(() => {});
  // Re-sending the relay's quoted excerpt — mentions were suppressed on the
  // original post; without allowedMentions here the edit would re-parse
  // @everyone/role pings the reporter smuggled into their quote.
  const resolve = (line: string) => interaction.update({
    content: `${interaction.message.content}\n—\n${line}`,
    components: [],
    allowedMentions: { parse: [] },
  });
  if (action === "keep") {
    inc("ops.modmsg_keep");
    await log("report_keep", null);
    return resolve(`**Message kept** — report dismissed ${stamp}`);
  }
  if (action === "del") {
    const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
    const target = channel && "messages" in channel
      ? await (channel as { messages: { fetch(id: string): Promise<ReportableMessage | null> } }).messages.fetch(messageId).then(m => m?.delete?.()).then(() => true).catch(() => false)
      : false;
    inc("ops.modmsg_del");
    await log("report_del", null);
    return resolve(`**Message ${target ? "deleted" : "already gone"}** ${stamp}`);
  }
  if (action === "timeout") {
    const timedOut = !!authorId && authorId !== "?" && interaction.guild
      ? await interaction.guild.members.edit(authorId, {
          communicationDisabledUntil: new Date(Date.now() + 10 * 60_000).toISOString(),
          reason: `house report: ${messageId}`,
        }).then(() => true).catch(() => false)
      : false;
    inc("ops.modmsg_timeout");
    await log("report_timeout", null);
    return resolve(`**Author ${timedOut ? "timed out for 10m" : "timeout failed — they may have left"}** ${stamp}`);
  }
  return interaction.update({ content: "Unknown moderation action.", components: [] });
}
