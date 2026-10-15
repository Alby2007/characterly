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
// (payment_link is null on API-created sessions). Values mirror PACK_LINKS —
// keep the three in sync with dashboard.js PRODUCTS.
const PACK_META: Record<string, number> = { pack_500: 500, pack_1500: 1500, pack_5000: 5000 };
// The premium price on prod_VRhdA8UQOkzj2r — subscription events are only
// ours if the sub carries this item; foreign products can't touch `plan`.
const PREMIUM_PRICE_ID = "price_1UQoE5GAOUmNDfnhulTyoL1o";

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
  // purchase still lands instead of vanishing into a silent no-op.
  const accountForSession = async (s: Record<string, any>): Promise<string | null> => {
    if (isUuid(s.client_reference_id)) return s.client_reference_id;
    const email = s.customer_details?.email;
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
        const action = classifyCheckout(s as never, { packLinks: PACK_LINKS, premiumLink: PREMIUM_LINK, packMeta: PACK_META });
        if (action.kind === "ignore") break;
        const accountId = await accountForSession(s);
        if (!accountId) {
          // Permanent — nothing to credit. Log so the paid-but-unattributed
          // session is visible in function logs instead of silently acked.
          console.error(
            `checkout ${s.id}: no account (client_reference_id=${s.client_reference_id}, email=${s.customer_details?.email ?? "none"})`,
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
        } else {
          const res = await must(
            sb.rpc("grant_pack", { p_account: accountId, p_tokens: action.tokens, p_ref: action.ref }),
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
        const action = classifySubscription(event.data.object as never, event.type, PREMIUM_PRICE_ID);
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
        // Audit-only: a zero-delta adjust row makes the refund visible in the
        // ledger and ops queries. Tokens aren't clawed back automatically —
        // charge events don't carry the session→pack mapping.
        const ch = event.data.object;
        const acct = ch.customer
          ? await must(
            sb.from("web_profiles").select("id, credit_balance").eq("stripe_customer_id", ch.customer).maybeSingle(),
            "refund lookup",
          )
          : null;
        if (!acct) {
          console.error(`charge.refunded ${ch.id}: unmapped customer ${ch.customer}`);
          break;
        }
        const { error } = await sb.from("credit_ledger").insert({
          account_id: acct.id,
          delta: 0,
          kind: "adjust",
          reason: `stripe_refund:${ch.id}`,
          stripe_ref: `refund:${ch.id}`, // dedupes redelivered refund events
          balance_after: acct.credit_balance,
        });
        if (error && error.code !== "23505") throw new Error(`refund audit: ${error.message}`);
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
