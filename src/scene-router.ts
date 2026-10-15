import { detectDismissal, detectWakeWord, roomAddressCue } from "./perception.js";
import { inc } from "./metrics.js";
import type { ConversationTracker } from "./conversation.js";
import type { Decision, GuildCompanion, MessageEvent } from "./types.js";

// ── Multi-Companion Scene Router ──────────────────────────────────────────────
// Coordinates which personal companion (if any) speaks on a given guild
// message. Replaces the single-bot assumption in guild channels:
//  - Pure companion mode: 0 summoned companions in the guild → silence.
//  - Direct wake-word name match or reply to a companion's webhook message
//    routes to that companion (+0.85) and suppresses unaddressed companions.
//  - Owner affinity gives a companion a +0.15 boost when its owner is engaged
//    or asking a question.
//  - Companion-to-companion banter is allowed up to `maxChainDepth` (default 2)
//    when Companion A names Companion B or they share an open conversation,
//    then hard-stops until a human speaks again.

export function companionConvoKey(guildId: string, channelId: string, companionId: number): string {
  return `${guildId}:${channelId}:companion:${companionId}`;
}

export function channelFloorKey(guildId: string, channelId: string): string {
  return `${guildId}:${channelId}`;
}

export type SceneTurnInput = {
  event: MessageEvent;
  companions: GuildCompanion[];
  /** Set when the message replies to a webhook message authored by a companion. */
  repliedToCompanionId?: number;
  /** Set when the message replies to a human user (not a companion). */
  repliedToHumanUserId?: string;
  /** Discord user IDs @-mentioned in the message (excluding the bot). */
  mentionedUserIds?: string[];
  /** Set when the incoming message itself was authored by a companion webhook. */
  senderCompanionId?: number;
  /** 0 for human messages; increments on each consecutive companion reply. */
  chainDepth?: number;
};

export type SceneSelection = {
  companion: GuildCompanion;
  convoKey: string;
  floorKey: string;
  isAddressed: boolean;
  engaged: boolean;
  dismissed: boolean;
  decision: Decision;
  nextChainDepth: number;
};

export function selectCompanionForTurn(
  input: SceneTurnInput,
  convo: ConversationTracker,
  opts: {
    speakThreshold: number;
    maxChainDepth: number;
    engagement: boolean;
    wakeWord?: boolean;
    now?: () => number;
  },
): SceneSelection | null {
  const { event, companions } = input;
  const chainDepth = input.chainDepth ?? 0;
  const now = opts.now ?? Date.now;
  const wakeEnabled = opts.wakeWord ?? true;

  if (!companions.length) return null;

  const floorKey = channelFloorKey(event.guildId, event.channelId);
  const fromCompanion = input.senderCompanionId !== undefined;

  // Record this turn on the shared channel floor so share-of-voice reflects
  // total companion traffic vs human traffic in the channel.
  convo.noteMessage(floorKey, fromCompanion, event.authorId);

  // Hard cap on consecutive companion-to-companion turns — deterministic loop
  // guard. chainDepth counts c2c hops only (the human-triggered reply records
  // 0), so MAX=2 permits human→A, A→B, B→A and blocks hop 3 — matching the
  // documented "max consecutive companion-to-companion replies".
  if (fromCompanion && chainDepth >= opts.maxChainDepth) {
    inc("scene.chain_capped");
    return null;
  }

  // Identify which companions are explicitly named in the message text.
  const namedIds = new Set<number>();
  if (wakeEnabled) {
    for (const c of companions) {
      if (c.name && detectWakeWord(event.content, [c.name])) {
        namedIds.add(c.id);
      }
    }
  }

  const anyCompanionExplicitlyTargeted =
    namedIds.size > 0 || input.repliedToCompanionId !== undefined;

  const candidates: Array<SceneSelection & { isOwner: boolean }> = [];

  for (const c of companions) {
    // A companion never replies to its own webhook message.
    if (input.senderCompanionId === c.id) continue;

    const cKey = companionConvoKey(event.guildId, event.channelId, c.id);
    // Companions are addressed ONLY by their own name or by replying to their
    // webhook message — never by @-mentioning the Companionly system bot.
    const isAddressed =
      namedIds.has(c.id) ||
      input.repliedToCompanionId === c.id;

    // If the speaker explicitly addressed a different companion, stay out of the way.
    if (anyCompanionExplicitlyTargeted && !isAddressed) continue;

    // Enroll human speakers when they address this companion.
    if (!fromCompanion && opts.engagement && isAddressed) {
      if (convo.addressed(cKey, event.authorId)) inc("convo.opened");
    }

    let engaged = opts.engagement && convo.isParticipant(cKey, event.authorId);
    const mentionedOthers = (input.mentionedUserIds?.length ?? 0) > 0;
    const repliedToOtherHuman =
      input.repliedToHumanUserId !== undefined &&
      input.repliedToCompanionId === undefined;

    if (
      engaged &&
      !isAddressed &&
      (roomAddressCue(event.content) || repliedToOtherHuman || mentionedOthers)
    ) {
      engaged = false;
    }

    // Deterministic dismissal ("shut up", "shush", etc.)
    let dismissed = false;
    if (!fromCompanion && (isAddressed || engaged) && detectDismissal(event.content)) {
      convo.leave(cKey, event.authorId);
      inc("convo.leave.dismissal");
      engaged = false;
      dismissed = true;
      if (!isAddressed) continue;
    }

    // Companion-to-companion turns require an explicit name-drop/reply OR an
    // already-open conversation on the first hop.
    if (fromCompanion && !isAddressed && !(engaged && chainDepth === 0)) {
      continue;
    }

    const isOwner = event.authorId === c.ownerUserId;
    const isQuestion = event.content.trimEnd().endsWith("?");
    const reasons: string[] = [];
    let score = 0.05;

    if (isAddressed) {
      score += 0.85;
      reasons.push("direct address");
    } else if (engaged) {
      score += 0.70;
      reasons.push("in conversation");
    }

    if (isOwner && (engaged || isQuestion || isAddressed)) {
      score += 0.15;
      reasons.push("owner affinity");
    }

    if (isQuestion) {
      score += 0.10;
      reasons.push("question");
    }

    if (fromCompanion) {
      score -= 0.15 * (chainDepth + 1);
      reasons.push("companion chain decay");
    }

    const lastSpokeAt = convo.lastSpokeAt(cKey);
    const elapsed = lastSpokeAt === undefined ? Infinity : Math.max(0, now() - lastSpokeAt);
    const recencyWindowMs = 120_000;
    if (!isAddressed && !engaged && elapsed < recencyWindowMs) {
      score -= 0.25 * (1 - elapsed / recencyWindowMs);
      reasons.push("spoke recently");
    }

    // Floor voices are recorded on the shared channel key, but conversation
    // participants enroll on this companion's key — a participant of THIS
    // conversation is a floor speaker, not a bystander. Without the exclusion
    // every engaged 1:1 counts its own human as floor traffic and the
    // companion mutes itself mid-conversation.
    const ownParticipants = engaged ? new Set(convo.participants(cKey)) : undefined;
    const floorShare = convo.bystanderVoices(floorKey, ownParticipants) > 0 ? convo.botShare(floorKey) : 0;
    if (!isAddressed && engaged && floorShare >= 0.35) {
      score -= 0.25;
      reasons.push("holding the floor");
    }

    const clamped = Math.max(0, Math.min(1, score));
    const decision: Decision = {
      shouldSpeak: clamped >= opts.speakThreshold,
      score: clamped,
      reasons,
    };

    if (decision.shouldSpeak) {
      candidates.push({
        companion: c,
        convoKey: cKey,
        floorKey,
        isAddressed,
        engaged,
        dismissed,
        decision,
        nextChainDepth: fromCompanion ? chainDepth + 1 : 0,
        isOwner,
      });
    }
  }

  if (!candidates.length) return null;

  // Priority: directly addressed > speaker is companion's owner > highest score > lowest companion ID.
  candidates.sort((a, b) =>
    Number(b.isAddressed) - Number(a.isAddressed) ||
    Number(b.isOwner) - Number(a.isOwner) ||
    b.decision.score - a.decision.score ||
    a.companion.id - b.companion.id,
  );

  const winner = candidates[0];
  return {
    companion: winner.companion,
    convoKey: winner.convoKey,
    floorKey: winner.floorKey,
    isAddressed: winner.isAddressed,
    engaged: winner.engaged,
    dismissed: winner.dismissed,
    decision: winner.decision,
    nextChainDepth: winner.nextChainDepth,
  };
}
