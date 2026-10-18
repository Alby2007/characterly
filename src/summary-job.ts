import type { Brain } from "./brain.js";
import { config } from "./config.js";
import type { MemoryStore } from "./database.js";
import { FatalJobError } from "./jobs.js";
import { inc } from "./metrics.js";
import { logError } from "./secrets.js";

// ── Story-summary job handler ────────────────────────────────────────────────
// Enqueued by the reply paths when a companion's turn counter crosses
// SUMMARY_REPLY_INTERVAL. Folds the messages that just left the live
// transcript window (everything between covered_until and the newest
// STORY_KEEP_RECENT rows) into the rolling "story so far" recap for that
// (companion, scope, channel). The recap always rides the reply prompt — this
// is the layer that survives past ~25 messages.
//
// Trigger counting happens at enqueue time (bumpStoryCounter +
// claimStoryUpdate reset the counter atomically), so the job itself only has
// to fold the window; a second job queued by an earlier claim finds an empty
// window and drops.

export type SummaryJobPayload = {
  companionId: number;
  channelId: string;
};

export interface SummaryJobDeps {
  store: MemoryStore;
  brainFor: (guildId: string) => Promise<Brain | null>;
}

/** How many companion replies between summary folds. ~10 turns ≈ 20 archived
 *  messages — safely ahead of the 25-message live window's tail. */
export const SUMMARY_REPLY_INTERVAL = 10;
/** Newest messages that stay live transcript and are never summarized —
 *  aligned to recentContext's guild default (25). DM lanes use the wider
 *  dmContextMessages window instead so folded and live ranges don't overlap. */
export const STORY_KEEP_RECENT = 25;
/** Max messages folded per pass. */
export const STORY_WINDOW_LIMIT = 60;

export async function runSummaryJob(scope: string, payload: SummaryJobPayload, deps: SummaryJobDeps): Promise<void> {
  if (!payload?.companionId || !payload.channelId) {
    throw new FatalJobError("malformed summary-update payload");
  }
  const { store } = deps;

  const companion = await store.getCompanionById(payload.companionId);
  if (!companion || companion.onboardingState !== "active") { inc("jobs.dropped_stale"); return; }

  const brain = await deps.brainFor(scope);
  if (!brain) { inc("jobs.dropped_dormant"); return; }

  const existing = await store.getStorySummary(payload.companionId, scope, payload.channelId);
  // The fold boundary must match the lane's live transcript window — a
  // smaller keepRecent here would fold messages that are still on-screen
  // verbatim, duplicating them in the prompt.
  const keepRecent = scope.startsWith("dm:") ? config.dmContextMessages : STORY_KEEP_RECENT;
  const window = await store.storyWindow(scope, payload.channelId, existing?.coveredUntil ?? null, keepRecent, STORY_WINDOW_LIMIT);
  if (!window.length) { inc("jobs.dropped_stale"); return; }

  const transcript = window
    .filter(r => r.content?.trim())
    .map(r => `${r.authorName}: ${r.content}`)
    .join("\n");
  if (!transcript.trim()) { inc("jobs.dropped_stale"); return; }

  const summary = await brain.summarizeConversation({
    name: companion.name,
    voicePersona: companion.voicePersona,
    coreTraits: companion.coreTraits,
    priorSummary: existing?.summary ?? "",
    userEdited: existing?.userEdited ?? false,
    transcript,
    isDm: scope.startsWith("dm:"),
  });
  if (!summary.trim()) return;

  try {
    await store.upsertStorySummary(
      payload.companionId, scope, payload.channelId,
      summary, window[window.length - 1].createdAt,
      existing?.updatedAt ?? null,
    );
    inc("summary.updated");
  } catch (error) {
    inc("summary.save_error");
    logError("Story summary save failed", error);
  }
}
