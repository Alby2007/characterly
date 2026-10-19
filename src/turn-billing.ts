import type { Brain } from "./brain.js";
import type { MemoryStore } from "./database.js";
import { inc } from "./metrics.js";
import { SAFE_REFUSAL } from "./safety.js";
import { logError } from "./secrets.js";
import type { Companion } from "./types.js";

// ── Hosted-turn billing, shared by every reply lane ───────────────────────────
// The DM lane, #adoptees threads, and guild replies all bill the same way:
// shed the free lane under fleet pressure, debit upfront, refund exactly once
// if no reply lands, and screen adopted companions' replies (a flag swaps in
// the neutral refusal and refunds). Keeping it in one place means a billing
// fix can't land in one lane and miss the other.

export type TurnBillingStore = Pick<MemoryStore, "hostedUsageToday" | "spendCredits" | "refundCredits" | "accountForDiscordUser">;

/** Free lanes shed once hosted:global passes this fraction of the fleet cap;
 *  premium keeps spending until the hard cap trips inside the metered wrap. */
export const HOSTED_PRESSURE_SHED = 0.9;

/** The tokens one turn took, refundable exactly once and never after a reply
 *  actually landed (a bookkeeping throw after send must not claw back a
 *  delivered turn). A ledger with charged=0 (BYOK) is a no-op everywhere. */
export class TurnLedger {
  replied = false;
  constructor(
    private readonly store: Pick<MemoryStore, "refundCredits"> | null,
    readonly payerId: string,
    private readonly refundReason: string,
    public charged = 0,
    public purchased = 0,
    readonly balance = 0,
  ) {}

  static free(payerId: string): TurnLedger {
    return new TurnLedger(null, payerId, "", 0, 0, 0);
  }

  markReplied(): void {
    this.replied = true;
  }

  /** Fire-and-forget but never silent — a failed refund is real money. */
  refund(): void {
    if (!this.charged || this.replied || !this.store) return;
    const n = this.charged;
    const purchased = this.purchased;
    this.charged = 0;
    this.purchased = 0;
    this.store.refundCredits(this.payerId, n, this.refundReason, purchased).catch(e => {
      inc("credits.refund_error");
      logError(`credit refund failed for ${this.payerId} (${this.refundReason})`, e);
    });
  }
}

export type ChargeOutcome =
  | { ok: true; ledger: TurnLedger }
  | { ok: false; reason: "pressure" | "insufficient" | "unlinked" };

/** Debit a hosted turn. "unlinked" means the spend found no account (a cached
 *  link can outlive a dashboard unlink by a minute — the live miss inside
 *  spendCredits evicted it, so the re-check picks the right notice). */
export async function chargeHostedTurn(
  store: TurnBillingStore,
  opts: { payerId: string; cost: number; reason: string; refundReason: string; premium: boolean; hostedDailyLlmCap: number },
): Promise<ChargeOutcome> {
  if (!opts.premium && (await store.hostedUsageToday()) >= opts.hostedDailyLlmCap * HOSTED_PRESSURE_SHED) {
    inc("gate.hosted_pressure");
    return { ok: false, reason: "pressure" };
  }
  const spend = await store.spendCredits(opts.payerId, opts.cost, opts.reason);
  if (!spend.ok) {
    inc("credits.insufficient");
    const stillLinked = await store.accountForDiscordUser(opts.payerId).catch(() => null);
    return { ok: false, reason: stillLinked ? "insufficient" : "unlinked" };
  }
  return { ok: true, ledger: new TurnLedger(store, opts.payerId, opts.refundReason, opts.cost, spend.purchased ?? 0, spend.balance) };
}

/** Adopted companions are third-party authored personas — their replies get
 *  a safety screen on every lane. Fail-open on screen error (a provider
 *  hiccup sends the reply and logs the gap); a flag swaps in the neutral
 *  refusal and refunds the turn — the bad persona is the marketplace's
 *  problem, not the adopter's charge. */
export async function screenAdoptedReply(opts: {
  companion: Pick<Companion, "kind" | "name" | "voicePersona" | "backstory">;
  text: string;
  screener: Pick<Brain, "safetyVerdict"> | null;
  ledger: TurnLedger;
  lane: string;
}): Promise<string> {
  const { companion, text, screener, ledger } = opts;
  if (!text || companion.kind !== "adopted" || !screener) return text;
  try {
    const verdict = await screener.safetyVerdict({
      kind: "reply",
      subject: `${companion.name} — ${companion.voicePersona}${companion.backstory ? ` (${companion.backstory.slice(0, 300)})` : ""}`,
      replyText: text,
    });
    if (verdict.verdict === "flag") {
      inc("safety.reply_flagged");
      ledger.refund();
      return SAFE_REFUSAL;
    }
  } catch (error) {
    inc("safety.screen_error");
    logError(`${opts.lane} adopted reply safety screen failed`, error);
  }
  return text;
}
