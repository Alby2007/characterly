// Pure decision logic for the Stripe webhook — dependency-free on purpose so
// the same file runs under Deno (the edge function imports it) and Node/tsx
// (src/stripe-webhook.test.ts exercises it). Nothing in here touches the
// network, env, or a database client; index.ts turns the returned actions
// into checked PostgREST calls.

export const TOLERANCE_S = 300;

// Constant-time hex compare — signatures are unguessable anyway, but comparing
// without an early exit keeps the check honest if the input ever isn't.
function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Verify a `Stripe-Signature` header: `t=<unix>,v1=<hmac-sha256(`${t}.${body}`)>`. */
export async function verifyStripeSignature(
  payload: string,
  header: string,
  secret: string,
  toleranceS = TOLERANCE_S,
): Promise<boolean> {
  const entries = header.split(",").map(p => p.trim());
  const t = entries.find(p => p.startsWith("t="))?.slice(2);
  const v1s = entries.filter(p => p.startsWith("v1=")).map(p => p.slice(3));
  // A non-numeric timestamp must not slip past the tolerance gate — NaN
  // comparisons are false, so reject it here rather than at the HMAC stage.
  if (!t || !/^\d+$/.test(t) || !v1s.length) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > toleranceS) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
  const expected = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
  return v1s.some(v => hexEqual(v, expected));
}

export const isUuid = (v: unknown): v is string =>
  typeof v === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export interface CheckoutSessionLike {
  id: string;
  mode?: string | null;
  payment_status?: string | null;
  payment_link?: string | null;
  customer?: string | null;
  subscription?: string | null;
  payment_intent?: string | null;
  client_reference_id?: string | null;
  customer_details?: { email?: string | null } | null;
  metadata?: Record<string, string> | null;
}

/** Launch-event bonus granted once per account on premium checkout while the
 *  window is open (LAUNCH_BONUS_END env). The ledger ref is per-account, so
 *  cancel→resubscribe inside the window can't farm it. */
export const LAUNCH_BONUS_TOKENS = 500;

export type CheckoutAction =
  // The premium link: always record customer/subscription ids (even unpaid —
  // async_payment_failed + a later retry needs the mapping to exist), flip
  // plan only once money settled. "no_payment_required" covers trials/100%-off.
  | { kind: "premium"; grantPlan: boolean; customer: string | null; subscriptionId: string | null; bonusTokens?: number }
  // A token pack: paid only. ref is the session id — the ledger's unique
  // stripe_ref absorbs redelivery. paymentIntent rides onto the ledger row so
  // a later charge.refunded claws back exactly this pack.
  | { kind: "pack"; tokens: number; ref: string; customer: string | null; paymentIntent: string | null }
  | { kind: "ignore"; why: string };

export function classifyCheckout(
  s: CheckoutSessionLike,
  opts: { packLinks: Record<string, number>; premiumLink: string; packMeta?: Record<string, number>; bonusEnd?: number; now?: number },
): CheckoutAction {
  const paid = s.payment_status === "paid" || s.payment_status === "no_payment_required";
  const premium = (grantPlan: boolean): CheckoutAction => ({
    kind: "premium", grantPlan, customer: s.customer ?? null, subscriptionId: s.subscription ?? null,
    ...(grantPlan && opts.bonusEnd !== undefined && (opts.now ?? Date.now()) < opts.bonusEnd
      ? { bonusTokens: LAUNCH_BONUS_TOKENS }
      : {}),
  });
  // Sessions minted by the create-checkout function carry their product in
  // metadata set server-side inside a JWT-authenticated function — it can't
  // be smuggled in by a forwarded link, and payment_link is null on these.
  const meta = s.metadata?.checkout_kind;
  if (meta === "premium") {
    return premium(paid);
  }
  const metaTokens = opts.packMeta?.[meta ?? ""];
  if (metaTokens !== undefined) {
    if (!paid) return { kind: "ignore", why: `checkout ${s.id} not yet paid` };
    return { kind: "pack", tokens: metaTokens, ref: s.id, customer: s.customer ?? null, paymentIntent: s.payment_intent ?? null };
  }
  // Legacy public payment links — kept so deliveries created before the links
  // were deactivated still classify. Keyed on payment_link only — never mode
  // alone. A future subscription product in the account must not leak premium.
  if (s.payment_link === opts.premiumLink) {
    return premium(paid);
  }
  const tokens = opts.packLinks[s.payment_link ?? ""];
  if (tokens === undefined) return { kind: "ignore", why: `unrelated checkout ${s.id}` };
  if (!paid) return { kind: "ignore", why: `checkout ${s.id} not yet paid` };
  return { kind: "pack", tokens, ref: s.id, customer: s.customer ?? null, paymentIntent: s.payment_intent ?? null };
}

export interface ChargeLike {
  id: string;
  customer?: string | null;
  payment_intent?: string | null;
  invoice?: string | null;
  description?: string | null;
  amount?: number | null;
  amount_refunded?: number | null;
  created?: number | null;
}

/** clawback_pack arguments for a charge.refunded event. Matching is exact on
 *  payment_intent; p_charged_at enables the pre-v60 time-window fallback and
 *  is withheld for invoice (subscription) charges so a subscription refund
 *  can never claw a pack. Newer API versions drop charge.invoice, so the
 *  "Subscription creation/update" description is checked too.
 *  amount/amount_refunded drive proration. */
export function clawbackArgs(accountId: string, ch: ChargeLike) {
  const subscriptionCharge = Boolean(ch.invoice) || /^subscription/i.test(ch.description ?? "");
  return {
    p_account: accountId,
    p_charge: ch.id,
    p_payment_intent: ch.payment_intent ?? null,
    p_amount: ch.amount ?? null,
    p_amount_refunded: ch.amount_refunded ?? null,
    p_charged_at: !subscriptionCharge && ch.created ? new Date(ch.created * 1000).toISOString() : null,
  };
}

export interface SubscriptionLike {
  id: string;
  customer?: string | null;
  status?: string;
  items?: { data?: Array<{ price?: { id?: string } | null }> } | null;
}

export type SubscriptionAction =
  | { kind: "activate"; subscriptionId: string; customer: string | null }
  | { kind: "deactivate"; subscriptionId: string }
  | { kind: "ignore"; why: string };

const ACTIVE_STATUSES = new Set(["active", "trialing"]);
// Terminal post-dunning states. past_due/incomplete keep perks while Stripe
// retries the card; canceled/unpaid/paused/incomplete_expired mean Stripe (or
// the customer) gave up — perks must strip or a dead card keeps premium forever.
const DEAD_STATUSES = new Set(["canceled", "unpaid", "paused", "incomplete_expired"]);

export function classifySubscription(
  sub: SubscriptionLike,
  eventType: string,
  premiumPriceIds: ReadonlySet<string>,
): SubscriptionAction {
  if (!sub?.id) return { kind: "ignore", why: "no subscription id" };
  // undefined = the event carried no items list (some deleted payloads omit it).
  const items = sub.items?.data;
  // Every recurring price on the premium product counts (monthly, yearly) —
  // a sub is ours if ANY item carries one.
  const ours = items ? items.some(i => i?.price?.id != null && premiumPriceIds.has(i.price.id)) : undefined;
  // The event name outranks the payload's status field — a deleted event can
  // carry a stale "active" status and must never re-activate.
  if (eventType === "customer.subscription.deleted" || DEAD_STATUSES.has(sub.status ?? "")) {
    // Deactivation only ever matches the stored stripe_subscription_id — an id
    // this codebase wrote — so a missing items list can't widen the blast
    // radius. A present-but-foreign list still vetoes.
    if (ours === false) return { kind: "ignore", why: "not the premium price" };
    return { kind: "deactivate", subscriptionId: sub.id };
  }
  if (ACTIVE_STATUSES.has(sub.status ?? "")) {
    // Activation can match on stripe_customer_id alone, so it must be certain
    // the sub is ours — an absent or foreign items list can't grant premium.
    if (ours !== true) return { kind: "ignore", why: "unverified subscription item" };
    return { kind: "activate", subscriptionId: sub.id, customer: sub.customer ?? null };
  }
  return { kind: "ignore", why: `dunning status ${sub.status}` };
}
