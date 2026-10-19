import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  clawbackArgs,
  classifyCheckout,
  classifySubscription,
  isUuid,
  verifyStripeSignature,
  type SubscriptionLike,
} from "../supabase/functions/stripe-webhook/core.ts";

// The webhook's decision logic is pure (core.ts has no Deno/network deps) so
// it runs under tsx here — signature verification is hand-rolled crypto and
// event routing decides real money; both need real tests.

const SECRET = "whsec_test_secret_value";
const PACK_LINKS = { plink_pack500: 500, plink_pack1500: 1500 };
const PREMIUM_LINK = "plink_premium";
const PREMIUM_PRICE = "price_premium";
// classifySubscription takes every premium price id (monthly + yearly share
// the same plan effect); the fixture only needs two distinct ids.
const PREMIUM_PRICES = new Set([PREMIUM_PRICE, "price_premium_yearly"]);

function sign(payload: string, t: number, secret = SECRET): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

test("verifyStripeSignature accepts a correctly signed fresh event", async () => {
  const payload = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
  const header = sign(payload, Math.floor(Date.now() / 1000));
  assert.equal(await verifyStripeSignature(payload, header, SECRET), true);
});

test("verifyStripeSignature rejects a tampered payload, wrong secret, stale timestamp, junk", async () => {
  const payload = `{"id":"evt_1"}`;
  const t = Math.floor(Date.now() / 1000);
  assert.equal(await verifyStripeSignature(`{"id":"evt_2"}`, sign(payload, t), SECRET), false, "tampered body");
  assert.equal(await verifyStripeSignature(payload, sign(payload, t, "whsec_wrong"), SECRET), false, "wrong secret");
  assert.equal(await verifyStripeSignature(payload, sign(payload, t - 400), SECRET), false, "stale timestamp");
  assert.equal(await verifyStripeSignature(payload, "garbage", SECRET), false, "malformed header");
  assert.equal(await verifyStripeSignature(payload, "", SECRET), false, "missing header");
  // NaN timestamps must not slip past the tolerance check.
  assert.equal(await verifyStripeSignature(payload, "t=abc,v1=beef", SECRET), false, "non-numeric t");
  // A valid signature with a different (correct) v1 among decoys still passes.
  const good = sign(payload, t);
  assert.equal(await verifyStripeSignature(payload, `${good},v1=decoy`, SECRET), true, "multiple v1 tolerated");
});

test("isUuid gates client_reference_id before it reaches a uuid column", () => {
  assert.equal(isUuid("3f2f4b0e-9b1a-4f5c-8d6e-7a8b9c0d1e2f"), true);
  assert.equal(isUuid("not-a-uuid"), false);
  assert.equal(isUuid(""), false);
  assert.equal(isUuid(null), false);
  assert.equal(isUuid(42), false);
});

test("classifyCheckout: paid pack session grants tokens idempotently on session id", () => {
  const a = classifyCheckout(
    { id: "cs_1", payment_status: "paid", payment_link: "plink_pack500", client_reference_id: "u" },
    { packLinks: PACK_LINKS, premiumLink: PREMIUM_LINK },
  );
  assert.deepEqual(a, { kind: "pack", tokens: 500, ref: "cs_1", customer: null, paymentIntent: null });
});

test("classifyCheckout: unpaid pack sessions wait for async_payment_succeeded", () => {
  const a = classifyCheckout(
    { id: "cs_2", payment_status: "unpaid", payment_link: "plink_pack500" },
    { packLinks: PACK_LINKS, premiumLink: PREMIUM_LINK },
  );
  assert.equal(a.kind, "ignore");
});

test("classifyCheckout: unknown or missing payment_link never grants", () => {
  for (const link of [null, "plink_other", undefined]) {
    const a = classifyCheckout(
      { id: "cs_3", payment_status: "paid", payment_link: link },
      { packLinks: PACK_LINKS, premiumLink: PREMIUM_LINK },
    );
    assert.equal(a.kind, "ignore", `link=${link}`);
  }
});

test("classifyCheckout: premium link records mapping always, plan only once paid", () => {
  const paid = classifyCheckout(
    { id: "cs_4", payment_status: "paid", payment_link: PREMIUM_LINK, customer: "cus_1", subscription: "sub_1", mode: "subscription" },
    { packLinks: PACK_LINKS, premiumLink: PREMIUM_LINK },
  );
  assert.deepEqual(paid, { kind: "premium", grantPlan: true, customer: "cus_1", subscriptionId: "sub_1" });
  // Unpaid/async/trial must still write the mapping or subscription events
  // can never find the account again.
  const unpaid = classifyCheckout(
    { id: "cs_5", payment_status: "unpaid", payment_link: PREMIUM_LINK, customer: "cus_1", subscription: "sub_1", mode: "subscription" },
    { packLinks: PACK_LINKS, premiumLink: PREMIUM_LINK },
  );
  assert.deepEqual(unpaid, { kind: "premium", grantPlan: false, customer: "cus_1", subscriptionId: "sub_1" });
  const trial = classifyCheckout(
    { id: "cs_6", payment_status: "no_payment_required", payment_link: PREMIUM_LINK, customer: "cus_1", subscription: "sub_1" },
    { packLinks: PACK_LINKS, premiumLink: PREMIUM_LINK },
  );
  assert.equal((trial as { grantPlan: boolean }).grantPlan, true, "trial/100%-off grants premium");
});

test("classifyCheckout: launch bonus applies to paid premium inside the window only", () => {
  const session = { id: "cs_b", payment_status: "paid", customer: "cus_1", subscription: "sub_1", metadata: { checkout_kind: "premium" } };
  const inWindow = classifyCheckout(session, { packLinks: PACK_LINKS, premiumLink: PREMIUM_LINK, bonusEnd: 2000, now: 1000 });
  if (inWindow.kind !== "premium") throw new Error("expected premium");
  assert.equal(inWindow.bonusTokens, 500);
  // Window closed or unset → no bonus field at all.
  const after = classifyCheckout(session, { packLinks: PACK_LINKS, premiumLink: PREMIUM_LINK, bonusEnd: 1000, now: 2000 });
  assert.equal((after as { bonusTokens?: number }).bonusTokens, undefined);
  const unset = classifyCheckout(session, { packLinks: PACK_LINKS, premiumLink: PREMIUM_LINK, now: 1000 });
  assert.equal((unset as { bonusTokens?: number }).bonusTokens, undefined);
  // Unpaid checkouts never bonus even inside the window.
  const unpaid = classifyCheckout({ ...session, payment_status: "unpaid" }, { packLinks: PACK_LINKS, premiumLink: PREMIUM_LINK, bonusEnd: 2000, now: 1000 });
  assert.equal((unpaid as { bonusTokens?: number }).bonusTokens, undefined);
});

test("classifyCheckout: a foreign subscription checkout does not grant premium", () => {
  const a = classifyCheckout(
    { id: "cs_7", payment_status: "paid", payment_link: "plink_other_sub", mode: "subscription" },
    { packLinks: PACK_LINKS, premiumLink: PREMIUM_LINK },
  );
  assert.equal(a.kind, "ignore");
});

// API-minted sessions (create-checkout) carry metadata.checkout_kind instead
// of a payment_link — the public links are deactivated, so this is the live path.
const PACK_META = { pack_500: 500, pack_1500: 1500 };
const OPTS = { packLinks: PACK_LINKS, premiumLink: PREMIUM_LINK, packMeta: PACK_META };

test("clawbackArgs: exact PI + proration; subscription charges never get the time-window fallback", () => {
  const pack = clawbackArgs("acc", { id: "ch_1", payment_intent: "pi_1", amount: 499, amount_refunded: 250, created: 1_700_000_000 });
  assert.deepEqual(pack, {
    p_account: "acc", p_charge: "ch_1", p_payment_intent: "pi_1",
    p_amount: 499, p_amount_refunded: 250, p_charged_at: new Date(1_700_000_000_000).toISOString(),
  });
  assert.equal(clawbackArgs("acc", { id: "ch_2", invoice: "in_1", created: 1_700_000_000 }).p_charged_at, null);
  assert.equal(clawbackArgs("acc", { id: "ch_3", description: "Subscription update", created: 1_700_000_000 }).p_charged_at, null);
});

test("classifyCheckout: metadata-minted pack sessions grant like payment-link ones", () => {
  const a = classifyCheckout(
    { id: "cs_m1", payment_status: "paid", payment_link: null, metadata: { checkout_kind: "pack_500" } },
    OPTS,
  );
  assert.deepEqual(a, { kind: "pack", tokens: 500, ref: "cs_m1", customer: null, paymentIntent: null });
  const withPi = classifyCheckout(
    { id: "cs_m3", payment_status: "paid", payment_link: null, payment_intent: "pi_123", metadata: { checkout_kind: "pack_500" } },
    OPTS,
  );
  assert.equal(withPi.kind === "pack" && withPi.paymentIntent, "pi_123", "the PI rides to the ledger for exact refund matching");
  const unpaid = classifyCheckout(
    { id: "cs_m2", payment_status: "unpaid", payment_link: null, metadata: { checkout_kind: "pack_1500" } },
    OPTS,
  );
  assert.equal(unpaid.kind, "ignore", "async pack waits for payment");
});

test("classifyCheckout: metadata premium session grants plan once paid", () => {
  const a = classifyCheckout(
    { id: "cs_m3", payment_status: "paid", payment_link: null, customer: "cus_9", subscription: "sub_9", metadata: { checkout_kind: "premium" } },
    OPTS,
  );
  assert.deepEqual(a, { kind: "premium", grantPlan: true, customer: "cus_9", subscriptionId: "sub_9" });
});

test("classifyCheckout: unknown/empty metadata never grants", () => {
  for (const metadata of [null, {}, { checkout_kind: "pack_9999" }, { checkout_kind: "premium2" }] as Array<Record<string, string> | null>) {
    const a = classifyCheckout(
      { id: "cs_m4", payment_status: "paid", payment_link: null, metadata },
      OPTS,
    );
    assert.equal(a.kind, "ignore", JSON.stringify(metadata));
  }
  // Metadata classifies before the legacy link map — a session spoofing both
  // can't double-credit: it takes the metadata branch only.
  const both = classifyCheckout(
    { id: "cs_m5", payment_status: "paid", payment_link: "plink_pack500", metadata: { checkout_kind: "pack_500" } },
    OPTS,
  );
  assert.equal((both as { tokens?: number }).tokens, 500, "metadata path wins; ref still dedupes the grant");
});

const premiumSub = (status: string, over: Partial<SubscriptionLike> = {}): SubscriptionLike => ({
  id: "sub_1",
  customer: "cus_1",
  status,
  items: { data: [{ price: { id: PREMIUM_PRICE } }] },
  ...over,
});

test("classifySubscription: active/trialing activate, terminal states deactivate", () => {
  for (const s of ["active", "trialing"]) {
    assert.deepEqual(
      classifySubscription(premiumSub(s), "customer.subscription.updated", PREMIUM_PRICES),
      { kind: "activate", subscriptionId: "sub_1", customer: "cus_1" },
      s,
    );
  }
  for (const s of ["canceled", "unpaid", "paused", "incomplete_expired"]) {
    assert.deepEqual(
      classifySubscription(premiumSub(s), "customer.subscription.updated", PREMIUM_PRICES),
      { kind: "deactivate", subscriptionId: "sub_1" },
      s,
    );
  }
  assert.equal(
    classifySubscription(premiumSub("active"), "customer.subscription.deleted", PREMIUM_PRICES).kind,
    "deactivate",
  );
});

test("classifySubscription: the yearly price is premium too", () => {
  const yearly = premiumSub("active");
  yearly.items = { data: [{ price: { id: "price_premium_yearly" } }] };
  assert.equal(classifySubscription(yearly, "customer.subscription.updated", PREMIUM_PRICES).kind, "activate");
  yearly.status = "canceled";
  assert.equal(classifySubscription(yearly, "customer.subscription.updated", PREMIUM_PRICES).kind, "deactivate");
});

test("classifySubscription: dunning statuses keep perks while Stripe retries", () => {
  for (const s of ["past_due", "incomplete"]) {
    assert.equal(classifySubscription(premiumSub(s), "customer.subscription.updated", PREMIUM_PRICES).kind, "ignore", s);
  }
});

test("classifySubscription: foreign products and unverifiable items never touch plan", () => {
  const foreign = premiumSub("active");
  foreign.items = { data: [{ price: { id: "price_other" } }] };
  for (const evt of ["customer.subscription.updated", "customer.subscription.deleted"]) {
    assert.equal(classifySubscription(foreign, evt, PREMIUM_PRICES).kind, "ignore", evt);
  }
  // Missing items: an activate can't prove it's ours → ignore; a deactivate is
  // safe because it only matches stored subscription ids we wrote ourselves.
  const bare = { id: "sub_9", customer: "cus_9", status: "active" };
  assert.equal(classifySubscription(bare, "customer.subscription.updated", PREMIUM_PRICES).kind, "ignore");
  assert.equal(
    classifySubscription({ ...bare, status: "canceled" }, "customer.subscription.deleted", PREMIUM_PRICES).kind,
    "deactivate",
  );
});
