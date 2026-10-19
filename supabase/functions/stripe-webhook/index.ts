// Stripe → Supabase webhook for Characterly billing.
//
// Fulfillment ONLY happens here (never on the success page): payment links
// redirect to the dashboard, but this function is what actually grants tokens
// or flips plan. Runs on the service role so RLS is bypassed deliberately —
// the trust boundary is Stripe's webhook signature, verified with WebCrypto
// (HMAC-SHA256 over `${t}.${payload}`, 5-minute tolerance). No Stripe API key
// is needed: the handler never calls back into Stripe.
//
// Routing decisions live in ./core.ts — a dependency-free module so the same
// file runs under Deno here and Node/tsx in src/stripe-webhook.test.ts.
//
// Secrets: STRIPE_WEBHOOK_SECRET (from the endpoint you register in Stripe).
// SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are auto-injected by Supabase.
// verify_jwt=false is pinned in supabase/config.toml — redeploys must not
// re-enable JWT auth or every Stripe delivery starts failing with 401s.

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  clawbackArgs,
  classifyCheckout,
  classifySubscription,
  isUuid,
  verifyStripeSignature,
} from "./core.ts";

// payment_link id → tokens granted. One entry per pack link — keyed on the
// link (not amount) so sales tax can't shift the mapping.
const PACK_LINKS: Record<string, number> = {
  plink_1UQoEjGAOUmNDfnhMeoNAPIc: 500,
  plink_1UQoEkGAOUmNDfnhYvMpdQJ9: 1500,
  plink_1UQoEkGAOUmNDfnhOBczc2JV: 5000,
};
// The premium subscription link — sessions from it get mode === "subscription".
const PREMIUM_LINK = "plink_1UQoEiGAOUmNDfnh04xXiYkf";
// checkout_kind metadata → tokens, for sessions minted by create-checkout
// (payment_link is null on API-created sessions). The retired pack sizes stay
// mapped so a session minted just before a resize still fulfils at the
// amount it was sold at; current keys mirror dashboard.js PRODUCTS.
const PACK_META: Record<string, number> = {
  pack_500: 500, pack_1500: 1500, pack_5000: 5000,
  pack_750: 750, pack_2500: 2500, pack_7500: 7500,
};
// The premium prices on prod_VRhdA8UQOkzj2r (monthly + yearly) — subscription
// events are only ours if the sub carries one; foreign products can't touch `plan`.
const PREMIUM_PRICE_IDS: ReadonlySet<string> = new Set([
  "price_1UQoE5GAOUmNDfnhulTyoL1o", // monthly $7.99
  "price_1URprSGAOUmNDfnhEoiONeTP", // yearly $79.99
]);
// Launch event: premium checkouts before this instant also grant a one-time
// token bonus (see core.ts LAUNCH_BONUS_TOKENS). Unset = no bonus.
const LAUNCH_BONUS_END = (() => {
  const v = Deno.env.get("LAUNCH_BONUS_END");
  const t = v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : undefined;
})();

// supabase-js resolves { data, error } instead of throwing on PostgREST/RPC
// failures — an unchecked result returns 200 to Stripe and drops the event
// forever. Every call goes through must() so a failed write actually retries.
async function must<T>(p: PromiseLike<{ data: T; error: { code?: string; message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.code ?? ""} ${error.message}`);
  return data as T;
}

Deno.serve(async (request) => {
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!secret) return new Response("not configured", { status: 500 });

  const payload = await request.text();
  const sig = request.headers.get("stripe-signature") ?? "";
  if (!(await verifyStripeSignature(payload, sig, secret))) {
    return new Response("bad signature", { status: 400 });
  }

  let event: { type: string; data: { object: Record<string, unknown> } };
  try {
    event = JSON.parse(payload);
  } catch {
    // A signed-but-malformed body can't happen from Stripe — 400, not a retry.
    return new Response("bad json", { status: 400 });
  }
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Payment links are public — a forwarded or bare link loses the
  // client_reference_id. Fall back to the email typed at checkout so the
  // purchase still lands instead of vanishing into a silent no-op — but only
  // for token packs: a mistyped/forged email on a premium checkout would
  // otherwise flip a stranger's plan, and every legit premium session minted
  // by create-checkout always carries client_reference_id anyway.
  const accountForSession = async (s: Record<string, any>, allowEmailFallback: boolean): Promise<string | null> => {
    if (isUuid(s.client_reference_id)) return s.client_reference_id;
    const email = allowEmailFallback ? s.customer_details?.email : null;
    if (!email) return null;
    return await must(
      sb.rpc("account_id_for_email", { p_email: email }),
      "account_id_for_email",
    );
  };

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const s = event.data.object;
        const action = classifyCheckout(s as never, { packLinks: PACK_LINKS, premiumLink: PREMIUM_LINK, packMeta: PACK_META, bonusEnd: LAUNCH_BONUS_END });
        if (action.kind === "ignore") break;
        const accountId = await accountForSession(s, action.kind === "pack");
        if (!accountId) {
          // Permanent — nothing to credit. Log so the paid-but-unattributed
          // session is visible in function logs instead of silently acked.
          // The email is masked: function logs are operator-visible but the
          // address isn't needed to investigate — the session id is.
          const maskedEmail = String(s.customer_details?.email ?? "none").replace(/(.).*(@.*)/, "$1***$2");
          console.error(
            `checkout ${s.id}: no account (client_reference_id=${s.client_reference_id}, email=${maskedEmail})`,
          );
          break;
        }
        if (action.kind === "premium") {
          const updated = await must(
            sb.from("web_profiles").update({
              stripe_customer_id: action.customer,
              stripe_subscription_id: action.subscriptionId,
              ...(action.grantPlan ? { plan: "premium" } : {}),
              updated_at: new Date().toISOString(),
            }).eq("id", accountId).select("id"),
            "premium checkout",
          );
          if (!updated?.length) console.error(`checkout ${s.id}: no web_profiles row for ${accountId}`);
          if (action.bonusTokens) {
            // Per-account ref: redelivery dedupes AND cancel→resubscribe can't
            // re-farm the bonus inside the window. Its own ledger kind: never
            // mistaken for a pack by a refund clawback.
            const res = await must(
              sb.rpc("grant_pack", { p_account: accountId, p_tokens: action.bonusTokens, p_ref: `launch-bonus:${accountId}`, p_kind: "grant_bonus" }),
              "launch bonus",
            );
            if (!res?.ok) console.error(`launch bonus rejected for ${accountId}: ${JSON.stringify(res)}`);
          }
        } else {
          const res = await must(
            sb.rpc("grant_pack", { p_account: accountId, p_tokens: action.tokens, p_ref: action.ref, p_payment_intent: action.paymentIntent }),
            "grant_pack",
          );
          if (!res?.ok) console.error(`grant_pack rejected ${action.ref}: ${JSON.stringify(res)}`);
          // Keep the customer id for later subscription events even on packs.
          if (action.customer) {
            await must(
              sb.from("web_profiles").update({ stripe_customer_id: action.customer })
                .eq("id", accountId).is("stripe_customer_id", null),
              "customer mapping",
            );
          }
        }
        break;
      }

      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const action = classifySubscription(event.data.object as never, event.type, PREMIUM_PRICE_IDS);
        if (action.kind === "ignore") break;
        if (action.kind === "activate") {
          // customer→account was recorded at checkout; matching by either id
          // lets a sub created before the mapping existed still heal.
          const clauses = [`stripe_subscription_id.eq.${action.subscriptionId}`];
          if (action.customer) clauses.push(`stripe_customer_id.eq.${action.customer}`);
          const updated = await must(
            sb.from("web_profiles").update({
              plan: "premium",
              stripe_subscription_id: action.subscriptionId,
              ...(action.customer ? { stripe_customer_id: action.customer } : {}),
              updated_at: new Date().toISOString(),
            }).or(clauses.join(",")).select("id"),
            "subscription activate",
          );
          if (!updated?.length) console.error(`sub ${action.subscriptionId} activated but matched no web_profiles row`);
        } else {
          // Only the tracked subscription can revoke — a stale or duplicate
          // sub ending must not strip a plan a different live sub pays for.
          await must(
            sb.from("web_profiles").update({
              plan: "free",
              stripe_subscription_id: null,
              updated_at: new Date().toISOString(),
            }).eq("stripe_subscription_id", action.subscriptionId),
            "subscription deactivate",
          );
        }
        break;
      }

      case "charge.refunded": {
        // clawback_pack debits exactly the pack this charge paid for (matched
        // on payment_intent; pre-v60 packs by grant time), prorated by
        // amount_refunded, under the account lock — tokens a buyer already
        // spent become allowance debt the next daily grants pay down. With no
        // matching pack it still writes the zero-delta audit row (e.g.
        // subscription charge refunds).
        const ch = event.data.object;
        const acct = ch.customer
          ? await must(
            sb.from("web_profiles").select("id").eq("stripe_customer_id", ch.customer).maybeSingle(),
            "refund lookup",
          )
          : null;
        if (!acct) {
          console.error(`charge.refunded ${ch.id}: unmapped customer ${ch.customer}`);
          break;
        }
        const res = await must(
          sb.rpc("clawback_pack", clawbackArgs(acct.id, ch as never)),
          "clawback_pack",
        );
        if (!res?.ok) console.error(`clawback_pack rejected ${ch.id}: ${JSON.stringify(res)}`);
        break;
      }

      case "checkout.session.async_payment_failed":
        console.error(`async payment failed: ${event.data.object?.id}`);
        break;
    }
    return new Response("ok");
  } catch (e) {
    // 500 so Stripe retries — a dropped event is a missing grant.
    return new Response(`error: ${e}`, { status: 500 });
  }
});
