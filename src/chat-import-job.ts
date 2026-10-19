import type { Brain } from "./brain.js";
import type { MemoryStore } from "./database.js";
import type { ChatTurn } from "./chathist.js";
import { BudgetExceeded, CreditsExhausted } from "./budget.js";
import { FatalJobError, MAX_JOB_ATTEMPTS } from "./jobs.js";
import { inc } from "./metrics.js";
import { logError } from "./secrets.js";

// ── Chat-import job handler ─────────────────────────────────────────────────
// Distills an uploaded transcript into the companion's journal: ~30-turn
// windows → first-person entries + a rolling summary → the final summary
// lands as the pinned 'bond' entry. Turns delete at done — distill-and-
// discard, we keep the memory not the corpus. Resumes from processed_turns
// on retry; BudgetExceeded parks the job at the UTC boundary like extract.
// Hosted-lane imports bill per window — same ledger as turns, so the hosted
// fleet cap can't be drained through the import path at zero token cost.

export type ChatImportJobPayload = { importId: number };

/** One credit per distilled window — the metered cost of the LLM call it buys. */
export const CHAT_IMPORT_CREDITS_PER_WINDOW = 1;

export interface ChatImportJobDeps {
  store: MemoryStore;
  brainFor: (scope: string) => Promise<Brain | null>;
  /** Hosted-vs-BYOK lane check — only hosted work spends tokens. */
  isHostedScope?: (scope: string) => boolean;
  /** Max ~30-turn windows per import — bounds hosted spend per transcript. */
  maxWindows: number;
  windowSize: number;
  /** Completion/progress DM — faked in tests, real client.send in prod. */
  sendDm: (userId: string, content: string) => Promise<void>;
}

export async function runChatImportJob(
  scope: string,
  payload: ChatImportJobPayload,
  deps: ChatImportJobDeps,
  attempts = 0,
): Promise<void> {
  if (!payload?.importId) throw new FatalJobError("malformed chat-import payload");
  const { store } = deps;
  const imp = await store.chatImportById(payload.importId);
  if (!imp) { inc("jobs.dropped_stale"); return; }
  if (imp.status === "done" || imp.status === "failed") { inc("jobs.dropped_stale"); return; }
  if (imp.status === "queued" && !await store.claimChatImport(imp.id)) {
    // claimChatImport moves queued→distilling atomically; a false return here
    // means a parallel claim won — leave the job to the winner's run.
    inc("jobs.dropped_stale");
    return;
  }

  const dmScope = `dm:${imp.ownerUserId}`;
  const companion = await store.getCompanionById(imp.companionId);
  if (!companion) {
    await store.failChatImport(imp.id, "companion no longer exists");
    return;
  }
  if (!imp.turns.length) {
    await store.failChatImport(imp.id, "no turns to distill");
    return;
  }
  const brain = await deps.brainFor(dmScope);
  if (!brain) {
    // Dormant scope — no keys at all. Retrying can't help; mark failed.
    await store.failChatImport(imp.id, "no AI brain available");
    return;
  }

  const charName = imp.speakers.char || companion.name;
  const userName = imp.speakers.user || "you";
  const windowSize = deps.windowSize || 30;
  const maxWindows = deps.maxWindows || 50;
  const totalWindows = Math.min(Math.ceil(imp.turns.length / windowSize), maxWindows);
  const turns = imp.turns.slice(0, totalWindows * windowSize);
  const lastTs = imp.turns[turns.length - 1]?.ts
    ?? (typeof imp.meta?.lastTs === "string" ? imp.meta.lastTs : null)
    ?? new Date().toISOString();
  // Resume point + carried summary — a retried job picks up where it left off.
  const startTurn = Math.min(imp.processedTurns, turns.length);
  let summary = imp.meta && typeof imp.meta.rollingSummary === "string" ? imp.meta.rollingSummary : "";
  // Imported entries carry no aboutSubjects (the schema emits none) — the
  // consent gate passes trivially; the importer consented by uploading.
  const alwaysConsent = async () => true;

  const hosted = deps.isHostedScope?.(dmScope) ?? false;
  try {
    for (let i = startTurn; i < turns.length; i += windowSize) {
      // Per-window billing on the hosted lane — charging inside the loop (not
      // per import) keeps resume honest: processed windows were paid for,
      // unprocessed ones weren't. A failed window refunds like an unsent turn.
      let chargedWindow = false;
      let chargedPurchased = 0;
      if (hosted) {
        // Unlinked mid-import can't park-and-resume forever — that's a
        // permanent state, not an empty balance. Fail the row outright.
        if (!await store.accountForDiscordUser(imp.ownerUserId)) {
          await store.failChatImport(imp.id, "account unlinked mid-import");
          return;
        }
        const spent = await store.spendCredits(imp.ownerUserId, CHAT_IMPORT_CREDITS_PER_WINDOW, "chat_import");
        if (!spent.ok) {
          // Out of tokens — not a fault. Park until the UTC grant like any
          // capped job; the import stays 'distilling' and resumes tomorrow.
          throw new CreditsExhausted(dmScope, spent.balance);
        }
        chargedWindow = true;
        chargedPurchased = spent.purchased ?? 0;
      }
      try {
        const window = turns.slice(i, i + windowSize);
        const windowText = window
          .map((t: ChatTurn) => `${t.speaker === "user" ? userName : charName}: ${t.text}`)
          .join("\n");
        const out = await brain.distillHistoryWindow({
          name: companion.name,
          voicePersona: companion.voicePersona,
          coreTraits: companion.coreTraits,
          charName, userName, windowText, summary,
        });
        summary = out.summary;
        const windowEnd = window[window.length - 1]?.ts ?? lastTs;
        // The importer is always a subject of their own history — stamping
        // them makes opt-out deletion (forgetJournalAbout on the dm scope) and
        // the about-first recall sort treat imported entries like live ones.
        const owned = out.entries.map(e => ({
          ...e,
          aboutSubjects: [...new Set([imp.ownerUserId, ...(e.aboutSubjects ?? [])])],
        }));
        const saved = await store.saveImportedJournalEntries(
          companion.id, dmScope, owned, imp.id, windowEnd, alwaysConsent,
        );
        await store.updateChatImportProgress(imp.id, i + window.length, saved.length, summary);
      } catch (error) {
        if (chargedWindow) {
          await store.refundCredits(imp.ownerUserId, CHAT_IMPORT_CREDITS_PER_WINDOW, "chat_import_refund", chargedPurchased)
            .catch(e => logError("chat-import credit refund failed", e));
        }
        throw error;
      }
    }

    // The last rolling summary is the relationship's shape — pin it as the
    // bond entry, high importance, dated to the transcript's end.
    if (summary) {
      await store.saveImportedJournalEntries(
        companion.id, dmScope,
        [{ kind: "bond", content: `Before Characterly — ${summary}`, importance: 0.95, aboutSubjects: [imp.ownerUserId] }],
        imp.id, lastTs, alwaysConsent,
      );
    }
    await store.completeChatImport(imp.id);
    const done = await store.chatImportById(imp.id);
    if (!done) { inc("jobs.dropped_stale"); return; } // deleted mid-run — undo already handled cleanup, skip the DM.
    const kept = done.keptCount;
    inc("jobs.chat_import_done");
    await deps.sendDm(
      imp.ownerUserId,
      `I finished reading our old chats — **${kept} moment${kept === 1 ? "" : "s"}** from **${imp.filename}** are part of me now${summary ? ", plus what we were to each other" : ""}. The file itself is gone — I keep the memories, not the transcript.`,
    ).catch(e => logError("chat-import completion DM failed", e));
  } catch (error) {
    // Last attempt spent — the row can't keep pretending it runs. A parked
    // BudgetExceeded is the exception: it's rescheduled, not dying.
    if (!(error instanceof FatalJobError) && !(error instanceof BudgetExceeded) && attempts >= MAX_JOB_ATTEMPTS) {
      await store.failChatImport(imp.id, "distill failed after retries").catch(() => {});
    }
    throw error; // BudgetExceeded + transient faults rethrow for the worker's own retry/backoff.
  }
}
