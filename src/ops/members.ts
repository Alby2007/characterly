import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type ButtonInteraction } from "discord.js";
import { config } from "../config.js";
import { linkSteps } from "../copy.js";
import { inc } from "../metrics.js";
import { logError } from "../secrets.js";
import { ensureAdopteeThreadsForUser } from "./adoptees.js";
import { handleHouseModAction, handleHouseReportCategory } from "./automod.js";
import {
  getOpsDeps, registerSweep, isHouse, normName, opsAlert, onOpsReset, reconcileMarkedCard, safeTrunc, TERMS_URL, PRIVACY_URL,
  type MemberLike, type OpsDeps, type SendableChannel,
} from "./shared.js";

// ── Member ops ───────────────────────────────────────────────────────────────

const RAID_WINDOW_MS = 60_000;
const joinTimes: number[] = [];
let lastRaidAlertAt = 0;

// Member now means *verified* — the role is granted by the gate-channel
// button after a linked-account check, not on join/screening. onboard is
// welcome-post only: point them at rules → verify. Returns whether a greeting
// actually posted so the screening flip can retry joins the raid window ate.
const welcomed = new Set<string>();
const WELCOMED_CAP = 20_000;
/** Bound the dedupe set — Sets iterate insertion-first, so evicting the head
 *  drops the oldest entries. Worst case of an evicted id: a rare duplicate
 *  welcome, never an unwelcomed member. */
function markWelcomed(userId: string): void {
  welcomed.add(userId);
  if (welcomed.size > WELCOMED_CAP) {
    for (const v of welcomed) { welcomed.delete(v); if (welcomed.size <= WELCOMED_CAP / 2) break; }
  }
}

onOpsReset(() => { joinTimes.length = 0; lastRaidAlertAt = 0; welcomed.clear(); });

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
      await deps.store.recordModAction?.({
        guildId: member.guild.id, targetId: member.user.id, actor: "automod",
        action: "kick", rule: "raid join", detail: `${joinTimes.length} joins in 60s`,
      })?.catch(() => {});
      await opsAlert(deps, `🚨 **Raid** — auto-kicked <@${member.user.id}> (${joinTimes.length} joins in 60s)`, "alert");
      inc("ops.raid_kick");
      return;
    }
    if (now - lastRaidAlertAt > RAID_WINDOW_MS) {
      lastRaidAlertAt = now;
      await opsAlert(deps, `🚨 **Possible raid** — ${joinTimes.length} joins in 60s (auto-kick OFF; set AUTOMOD_RAID_KICK=1 to arm)`, "alert");
      inc("ops.raid_alert");
    }
  }
  // Welcome at join, screening or not — pending members can read channels even
  // though they can't interact, so "read rules → verify" lands when it matters.
  void deps.store.trackEvent(member.user.id, "house_join", member.guild.id);
  if (await onboardMember(member, deps, { welcome: !raidHot })) markWelcomed(member.user.id);
  // Adopters who joined the house AFTER adopting elsewhere (import paths)
  // get their already-met threads re-opened on arrival — never-met
  // adoptions stay threadless until their Meet click by design.
  await ensureAdopteeThreadsForUser(member.user.id, deps, { guildId: null }).catch(e => {
    inc("ops.adoptee_thread_error"); logError("member-add adoptee ensure failed", e);
  });
}

export async function handleHouseMemberUpdate(
  // `roles` is absent on uncached partials — the grant check below treats
  // that as UNKNOWN and skips the re-attach (see the note inside).
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
    if (!welcomed.has(newMember.user.id) && await onboardMember(newMember, deps)) markWelcomed(newMember.user.id);
    // Screening just cleared — retry adoptee thread reattaches in case the
    // pending member couldn't be added to a private thread at join.
    await ensureAdopteeThreadsForUser(newMember.user.id, deps, { guildId: null }).catch(e => {
      inc("ops.adoptee_thread_error"); logError("member-update adoptee ensure failed", e);
    });
  }
  // Verification lands as a Member-role grant — and it's the moment the
  // adoptee-threads re-attach becomes possible: rejoiners arrive role-less
  // (roles don't persist across leave/join) and can't be re-added to private
  // threads under a @everyone-hidden parent until they hold Member. Covers
  // verify-gate grants and manual mod grants alike.
  //
  // An uncached oldMember arrives without `roles` — that's UNKNOWN state,
  // not "no role held". Treating it as a transition re-runs the whole
  // adoptee-ensure sweep on every unrelated update (nickname, timeout) of
  // every verified member. A real grant on an uncached member is rare and
  // the backfill sweep rebuilds the thread within its next pass.
  const memberRole = config.houseMemberRoleId;
  if (memberRole
    && newMember.roles?.cache?.has?.(memberRole) === true
    && oldMember.roles !== undefined
    && oldMember.roles?.cache?.has?.(memberRole) !== true) {
    await ensureAdopteeThreadsForUser(newMember.user.id, deps, { guildId: null }).catch(e => {
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
const CONSENT_CUSTOM_ID = "house:consent";

// Verify-card version — bump when the embed's copy or the site URL changes so
// ensureVerifyGate edits the live card in place (same pattern as
// RESOURCE_POSTS: footer marker + version compare).
const VERIFY_CARD_VERSION = 2;
const VERIFY_CARD_MARKER = "Char.ly verify gate";

function buildVerifyCard() {
  return {
    embeds: [new EmbedBuilder()
      .setTitle("Verify your Characterly account")
      .setDescription(
        "This server is members-only past this point — link your free Characterly account to unlock it.\n\n" +
        "**How:** " + linkSteps() + ", then click below.\n" +
        "_Just joined? Accept the rules first — the button unlocks once you have._\n" +
        "_Verifying asks you to accept our Terms & Privacy Policy._",
      )
      .setFooter({ text: `${VERIFY_CARD_MARKER} · v${VERIFY_CARD_VERSION}` })],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(VERIFY_CUSTOM_ID).setLabel("Verify — I'm a Characterly member").setStyle(ButtonStyle.Success),
    )],
    allowedMentions: { parse: [] as never[] },
  };
}

/** Post the verify card if the gate channel doesn't already carry one,
 *  delete duplicate copies, and edit the card in place when its version
 *  marker is behind — a stale card used to persist forever (an outdated
 *  site URL once lived in it for weeks). The card is identified by the
 *  button's customId so pre-marker copies still self-heal. */
export async function ensureVerifyGate(deps: OpsDeps): Promise<boolean> {
  if (!config.houseVerifyChannelId) return false;
  const ch = await deps.fetchChannel(config.houseVerifyChannelId).catch(() => null);
  if (!ch) return false;
  const { posted, edited } = await reconcileMarkedCard(deps, ch, {
    match: VERIFY_CUSTOM_ID,
    versionMarker: VERIFY_CARD_MARKER,
    version: VERIFY_CARD_VERSION,
    payload: buildVerifyCard(),
  });
  return posted || edited;
}

/** house:* buttons — routed from handleMemoryButton; deps are module-init'd.
 *  house:verify starts the gate; house:consent:<v> is the clickwrap "I accept"
 *  inside the ephemeral prompt. Both share the same gate chain — customIds are
 *  forgeable and member/account state moves between clicks, so the consent
 *  click re-checks everything before recording + granting. */
export async function handleHouseButton(interaction: ButtonInteraction): Promise<unknown> {
  const deps = getOpsDeps();
  if (!deps) return interaction.reply({ content: "Ops isn't initialized yet — the bot is still starting.", ephemeral: true });
  // house:reportcat / house:modmsg — the report-message flow lives in
  // automod.ts (moderation domain): category pick files the report, mod
  // buttons resolve it with ledger writes.
  if (interaction.customId.startsWith("house:reportcat:")) return handleHouseReportCategory(interaction);
  if (interaction.customId.startsWith("house:modmsg:")) return handleHouseModAction(interaction);
  const consentClick = interaction.customId.startsWith(CONSENT_CUSTOM_ID + ":");
  if (interaction.customId !== VERIFY_CUSTOM_ID && !consentClick) {
    // A stale/unknown house:* id — e.g. a button from a card version that no
    // longer exists. Silent return leaves the clicker with Discord's
    // "interaction failed" toast; say so instead.
    return interaction.reply({ content: "That button's gone stale — the card has moved on. Scroll up for the current one.", ephemeral: true });
  }
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
  // Same error-vs-null split as the account lookup above: a key-lookup throw
  // is "unknown", not "no key" — claim "no account" only on a clean null.
  if (!account) {
    const key = await deps.store.getGuildKey(`dm:${interaction.user.id}`).catch(() => undefined);
    if (key === undefined) {
      return interaction.reply({ content: "Couldn't check your account right now — try again in a moment.", ephemeral: true });
    }
    if (!key) {
      return interaction.reply({
        content: `No linked Characterly account found — ${linkSteps()}, then click **Verify** again.`,
        ephemeral: true,
      });
    }
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
  void deps.store.trackEvent(interaction.user.id, "verified", config.houseGuildId);
  await opsAlert(deps, `✅ <@${interaction.user.id}> verified — Member granted.`);
  // Point the fresh member at the shelf — channel mention resolves when the
  // forum's in cache, plain text otherwise. Adoption is the next step the
  // funnel wants.
  const charsChannel = interaction.guild?.channels?.cache?.find(
    c => normName(c.name) === normName("characters"));
  const shelf = charsChannel ? `<#${charsChannel.id}>` : "**#characters**";
  return interaction.reply({
    ephemeral: true,
    content:
      "✅ **You're in!** Welcome to Characterly.\n\n" +
      `**Next up:** browse ${shelf} — every character on the shelf has an **Add** button that opens a private thread in **#adoptees** just for the two of you.\n` +
      "You can also DM me anytime — the first conversation wakes up *your own* companion.",
  });
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
    if (!account) {
      // The verify gate admits a personal key in place of a linked account,
      // so "no account" isn't proof of unlink — check the same BYOK arm
      // here. Error means "unknown", same fail-safe as the account lookup:
      // keep. A missing key AND a missing account is a real revocation.
      const byok = await deps.store.getGuildKey?.(`dm:${m.user.id}`).catch(e => {
        inc("ops.sweep_error");
        logError("member BYOK check failed", e);
        return undefined;
      });
      if (byok === undefined) continue;
      if (!byok) {
        await m.roles.remove(roleId).catch(e => logError("member role revoke failed", e));
        revoked++;
        inc("ops.verify_revoked");
        await opsAlert(deps, `🔻 <@${m.user.id}> unlinked their Characterly account — Member role removed.`);
        continue;
      }
    }
    // Verified but unconsented — the gate only admits members (linked OR
    // BYOK) who have accepted the current Terms/Privacy version, so holders
    // without one are out of policy (verified before the gate existed, or
    // the docs bumped). Same fail-safe as the link check: a lookup error
    // keeps the role — only a definitive missing/stale acceptance revokes.
    // account.id is null for BYOK holders — tosAcceptance matches on
    // discord_user_id either way.
    const acceptance = await deps.store.tosAcceptance(m.user.id, account?.id ?? null).catch(e => {
      inc("ops.sweep_error");
      logError("member consent check failed", e);
      return undefined;
    });
    if (acceptance === undefined || (acceptance && acceptance.version >= TERMS_VERSION)) continue;
    await m.roles.remove(roleId).catch(e => logError("member role revoke failed", e));
    revoked++;
    inc("ops.consent_revoked");
    await opsAlert(deps, `🔻 <@${m.user.id}> hasn't accepted Terms & Privacy Policy v${TERMS_VERSION} — Member role removed (re-verify in the gate channel).`);
  }
  return revoked;
}

export function startLinkSweep(deps: OpsDeps): { stop: () => void } {
  return registerSweep("memberlinks", () => runMemberLinkSweep(deps), config.hostHealthIntervalMs);
}

// ── Verify nudge ────────────────────────────────────────────────────────────
// house_join is tracked at member-add but nothing follows up — the funnel's
// bottom leaks members who never find the gate. Members unverified >24h get
// ONE DM ever (analytics_events is the dedupe; the window closes long before
// the ~400d prune horizon). Opted-out users are skipped send-side too —
// trackEvent already refuses their rows. Closed DMs mark as attempted-but-
// undelivered since they never reopen.
const VERIFY_NUDGE_AGE_MS = 24 * 3_600_000;
const VERIFY_NUDGE_PER_SWEEP = 25;

export async function runVerifyNudgeSweep(deps: OpsDeps): Promise<void> {
  if (!config.houseVerifyNudge || !config.houseGuildId || !config.houseMemberRoleId || !config.houseVerifyChannelId) return;
  if (typeof deps.store.hasAnalyticsEvent !== "function" || typeof deps.store.analyticsOptedOut !== "function") return;
  const members = await deps.listMembers(config.houseGuildId).catch(e => { inc("ops.sweep_error"); logError("verify nudge member list failed", e); return null; });
  if (!members) return;
  const now = Date.now();
  let sent = 0;
  for (const m of members) {
    if (sent >= VERIFY_NUDGE_PER_SWEEP) break;
    if (m.user.bot || !m.send || m.roles.cache?.has(config.houseMemberRoleId)) continue;
    const joined = m.joinedTimestamp ?? 0;
    if (!joined || now - joined < VERIFY_NUDGE_AGE_MS) continue;
    // Both lookups fail closed — a double-DM is worse than a miss.
    if (await deps.store.analyticsOptedOut(m.user.id).catch(() => true)) continue;
    if (await deps.store.hasAnalyticsEvent(m.user.id, "verify_nudge").catch(() => true)) continue;
    const delivered = await m.send({
      content:
        `👋 You joined the **Characterly** Discord but never verified — tap **Verify** in <#${config.houseVerifyChannelId}> to unlock the server (it takes a few seconds).\n\n` +
        `_If you meant to leave or you're all set, just ignore this — you won't get another._`,
    }).then(() => true).catch(() => false);
    // Mark once-ever even when the DM bounced: closed DMs don't reopen, and
    // the meta keeps delivered-vs-attempted honest in the funnel.
    await deps.store.trackEvent(m.user.id, "verify_nudge", config.houseGuildId, { delivered });
    if (!delivered) continue;
    sent++;
    inc("ops.verify_nudge_sent");
  }
}

export function startVerifyNudgeSweep(deps: OpsDeps): { stop: () => void } {
  return registerSweep("verify-nudge", () => runVerifyNudgeSweep(deps), config.hostHealthIntervalMs);
}
