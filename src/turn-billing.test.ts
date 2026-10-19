import assert from "node:assert/strict";
import test from "node:test";
import { TurnLedger, chargeHostedTurn, screenAdoptedReply } from "./turn-billing.js";
import { SAFE_REFUSAL } from "./safety.js";

function fakeStore(opts: { usage?: number; spendOk?: boolean; linked?: boolean; purchased?: number } = {}) {
  const refunds: Array<{ id: string; n: number; reason: string; purchased: number }> = [];
  const spends: Array<{ id: string; n: number; reason: string }> = [];
  const store = {
    hostedUsageToday: async () => opts.usage ?? 0,
    spendCredits: async (id: string, n: number, reason: string) => {
      spends.push({ id, n, reason });
      return { ok: opts.spendOk ?? true, balance: 40, purchased: opts.purchased ?? 0 };
    },
    refundCredits: async (id: string, n: number, reason: string, purchased = 0) => {
      refunds.push({ id, n, reason, purchased });
      return { ok: true, balance: 0 };
    },
    accountForDiscordUser: async () => (opts.linked ?? true ? { id: "a", plan: "free" as const, creditBalance: 0, purchasedBalance: 0 } : null),
  };
  return { store, refunds, spends };
}

const base = { payerId: "u", cost: 2, reason: "dm_turn", refundReason: "dm_turn_refund", premium: false, hostedDailyLlmCap: 100 };

test("chargeHostedTurn: free lane sheds at 90% of the fleet cap, premium keeps going", async () => {
  const { store, spends } = fakeStore({ usage: 90 });
  assert.deepEqual(await chargeHostedTurn(store, base), { ok: false, reason: "pressure" });
  assert.equal(spends.length, 0, "a shed turn never debits");
  const prem = await chargeHostedTurn(store, { ...base, premium: true });
  assert.equal(prem.ok, true);
});

test("chargeHostedTurn: empty wallet vs unlinked pick different refusals", async () => {
  assert.deepEqual(await chargeHostedTurn(fakeStore({ spendOk: false }).store, base), { ok: false, reason: "insufficient" });
  assert.deepEqual(await chargeHostedTurn(fakeStore({ spendOk: false, linked: false }).store, base), { ok: false, reason: "unlinked" });
});

test("TurnLedger refunds exactly once, to the bucket the spend came from, never after a reply", async () => {
  const { store, refunds } = fakeStore({ purchased: 1 });
  const charge = await chargeHostedTurn(store, base);
  assert.ok(charge.ok);
  charge.ledger.refund();
  charge.ledger.refund();
  assert.deepEqual(refunds, [{ id: "u", n: 2, reason: "dm_turn_refund", purchased: 1 }]);

  const second = await chargeHostedTurn(store, base);
  assert.ok(second.ok);
  second.ledger.markReplied();
  second.ledger.refund();
  assert.equal(refunds.length, 1, "a delivered turn is never clawed back");

  TurnLedger.free("u").refund(); // BYOK lane — no-op, no store
  assert.equal(refunds.length, 1);
});

test("screenAdoptedReply: flag swaps in the refusal and refunds; errors fail open; awakened skip", async () => {
  const { store, refunds } = fakeStore();
  const charge = await chargeHostedTurn(store, base);
  assert.ok(charge.ok);
  const adopted = { kind: "adopted" as const, name: "Vex", voicePersona: "dry", backstory: "" };
  const flagger = { safetyVerdict: async () => ({ verdict: "flag" as const }) };
  assert.equal(await screenAdoptedReply({ companion: adopted, text: "bad", screener: flagger, ledger: charge.ledger, lane: "dm" }), SAFE_REFUSAL);
  assert.equal(refunds.length, 1);

  const broken = { safetyVerdict: async () => { throw new Error("provider down"); } };
  assert.equal(await screenAdoptedReply({ companion: adopted, text: "fine", screener: broken, ledger: TurnLedger.free("u"), lane: "dm" }), "fine");

  let called = false;
  const spy = { safetyVerdict: async () => { called = true; return { verdict: "flag" as const }; } };
  const awakened = { ...adopted, kind: "awakened" as const };
  assert.equal(await screenAdoptedReply({ companion: awakened, text: "hi", screener: spy, ledger: TurnLedger.free("u"), lane: "dm" }), "hi");
  assert.equal(called, false, "awakened companions aren't screened");
});
