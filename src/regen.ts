// ── Regenerate — the right-click reply retry ──────────────────────────────────
// "Regenerate" is a message context-menu command: right-click → Apps on the
// companion's latest reply redoes the turn in place. This module is the pure
// resolver — it decides WHICH companion turn a context-menu target points at
// and whether the retry is allowed. index.ts owns the orchestration (billing,
// generation, the edit) because everything it needs lives next to
// runCompanionTurn.
//
// Scope: dm: lanes only — the bot DM (awakened companions) and registered
// adoptee threads (adopted companions, scope dm:<adopter>). Guild channels are
// deliberately out: the retry affordance is a 1:1 surface, matching the
// swipe-model products this feature parallels.

import type { MessageContextMenuCommandInteraction } from "discord.js";
import { MemoryStore } from "./database.js";
import type { Companion } from "./types.js";

export type RegenTarget = {
  lane: "dm" | "adoptee";
  scope: string;
  channelId: string;
  requesterId: string;
  companion: Companion;
  /** The reply under the cursor — edited in place on success. */
  targetMessageId: string;
  /** The reply's archived text — used to keep it out of the new context. */
  targetContent: string;
  /** The turn the reply answered — the archived human message before it. */
  trigger: {
    messageId: string;
    authorId: string;
    authorName: string;
    content: string;
    createdAt: string;
    replyToId: string | null;
  };
};

export type RegenRefusal =
  | "lane"          // not a DM and not a registered adoptee thread
  | "not_companion" // the target isn't an archived companion reply
  | "not_yours"     // an adoptee thread belonging to someone else
  | "inactive"      // no companion, or it's still mid-onboarding
  | "banned"        // adopted clone of a banned listing (same freeze as turns)
  | "moved_on"      // newer messages exist after the target — not the tail
  | "gone";         // the trigger message left the archive (deleted, purged)

export const REGEN_REFUSALS: Record<RegenRefusal, string> = {
  lane: "Regenerate only works on your companion's replies — in DMs or adoptee threads.",
  not_companion: "That message isn't a companion reply.",
  not_yours: "Only the person talking to that companion can regenerate its replies.",
  inactive: "That companion isn't awake yet.",
  banned: "That companion is locked — its listing was removed from the marketplace.",
  moved_on: "The conversation already moved on — regenerate the newest reply.",
  gone: "The original message is gone — there's nothing to regenerate from.",
};

/** Resolve a context-menu invocation to the exchange it would redo, or the
 *  refusal reason. No side effects — the caller decides what follows. */
export async function resolveRegenTarget(
  interaction: Pick<MessageContextMenuCommandInteraction, "user" | "guildId" | "channelId" | "targetMessage" | "client">,
  store: Pick<MemoryStore, "companionThreadForChannel" | "getCompanionByOwner" | "listingById" | "regenExchangeTail">,
): Promise<{ ok: true; target: RegenTarget } | { ok: false; reason: RegenRefusal }> {
  const target = interaction.targetMessage;
  const requesterId = interaction.user.id;
  const channelId = interaction.channelId;

  let lane: RegenTarget["lane"];
  let scope: string;
  let companion: Companion | null;
  const adoptee = await store.companionThreadForChannel(channelId).catch(() => null);
  if (adoptee) {
    // The thread renders the adopter's dm: pipeline — they're the only human
    // in the bond, so anyone else (staff peeking in) can't redo its turns.
    if (adoptee.adoption.userId !== requesterId) return { ok: false, reason: "not_yours" };
    lane = "adoptee";
    scope = `dm:${adoptee.adoption.userId}`;
    companion = adoptee.companion;
  } else if (!interaction.guildId) {
    // Bot DM — the companion's replies are the only bot-authored voice here,
    // and they send as the app account.
    if (target.author.id !== interaction.client.user?.id) return { ok: false, reason: "not_companion" };
    lane = "dm";
    scope = `dm:${requesterId}`;
    companion = await store.getCompanionByOwner(requesterId).catch(() => null);
  } else {
    return { ok: false, reason: "lane" };
  }
  if (!companion || companion.onboardingState !== "active") return { ok: false, reason: "inactive" };
  if (companion.adoptedFromListingId) {
    const listing = await store.listingById(companion.adoptedFromListingId).catch(() => null);
    if (listing?.status === "banned") return { ok: false, reason: "banned" };
  }

  // The archive is authoritative: companion replies always land as
  // companion:<id> — system cards, notices and human messages can't qualify.
  const compSubj = MemoryStore.companionSubjectId(companion.id);
  const tail = await store.regenExchangeTail(scope, channelId, compSubj, target.id);
  if (!tail.target || tail.target.authorId !== compSubj) return { ok: false, reason: "not_companion" };
  if (tail.newerCount > 0) return { ok: false, reason: "moved_on" };
  if (!tail.trigger) return { ok: false, reason: "gone" };
  return {
    ok: true,
    target: {
      lane,
      scope,
      channelId,
      requesterId,
      companion,
      targetMessageId: target.id,
      targetContent: tail.target.content,
      trigger: {
        messageId: tail.trigger.id,
        authorId: tail.trigger.authorId,
        authorName: tail.trigger.authorName,
        content: tail.trigger.content,
        createdAt: tail.trigger.createdAt,
        replyToId: tail.trigger.replyToId,
      },
    },
  };
}
