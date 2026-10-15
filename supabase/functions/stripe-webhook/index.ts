// Stripe → Supabase webhook for Characterly billing.
//
// Fulfillment ONLY happens here (never on the success page): payment links
// redirect to the dashboard, but this function is what actually grants tokens
// or flips plan. Runs on the service role so RLS is bypassed deliberately —
// the trust boundary is Stripe's webhook signature, verified below with
// WebCrypto (HMAC-SHA256 over `${t}.${payload}`, 5-minute tolerance). No Stripe
// API key is needed: the handler never calls back into Stripe.
//
// Secrets: STRIPE_WEBHOOK_SECRET (from the endpoint you register in Stripe).
// SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are auto-injected by Supabase.

import { createClient } from "npm:@supabase/supabase-js@2";

// payment_link id → tokens granted. One entry per pack link — keyed on the
// link (not amount) so sales tax can't shift the mapping.
const PACK_LINKS: Record<string, number> = {
  plink_1UQoEjGAOUmNDfnhMeoNAPIc: 500,
  plink_1UQoEkGAOUmNDfnhYvMpdQJ9: 1500,
  plink_1UQoEkGAOUmNDfnhOBczc2JV: 5000,
};
// The premium subscription link — sessions from it get mode === "subscription".
const PREMIUM_LINK = "plink_1UQoEiGAOUmNDfnh04xXiYkf";

const TOLERANCE_S = 300;

async function verifySignature(payload: string, header: string, secret: string): Promise<boolean> {
  const parts = new Map(header.split(",").map(p => p.split("=", 2) as [string, string]));
  const t = parts.get("t");
  const v1s = header.split(",").filter(p => p.startsWith("v1=")).map(p => p.slice(3));
  if (!t || !v1s.length) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > TOLERANCE_S) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
  const expected = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
  return v1s.some(v => v === expected);
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!secret) return new Response("not configured", { status: 500 });

  const payload = await req.text();
  const sig = req.headers.get("stripe-signature") ?? "";
  if (!(await verifySignature(payload, sig, secret))) {
    return new Response("bad signature", { status: 400 });
  }

  const event = JSON.parse(payload);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const s = event.data.object;
        if (s.payment_status !== "paid") break; // async methods settle later
        const userId = s.client_reference_id;
        if (!userId) break; // link opened without our ?client_reference_id — nothing to credit

        if (s.mode === "subscription" || s.payment_link === PREMIUM_LINK) {
          await sb.from("web_profiles").update({
            plan: "premium",
            stripe_customer_id: s.customer,
            stripe_subscription_id: s.subscription,
            updated_at: new Date().toISOString(),
          }).eq("id", userId);
        } else {
          const tokens = PACK_LINKS[s.payment_link as string];
          if (tokens) {
            // Idempotent on the session id — redelivery returns duplicate:true.
            await sb.rpc("grant_pack", { p_account: userId, p_tokens: tokens, p_ref: s.id });
            // Keep the customer id for later subscription events even on packs.
            if (s.customer) {
              await sb.from("web_profiles").update({ stripe_customer_id: s.customer }).eq("id", userId).is("stripe_customer_id", null);
            }
          }
        }
        break;
      }

      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        // active/trialing → premium; canceled/deleted → free. past_due and
        // unpaid leave the plan alone while Stripe retries the card — dunning
        // shouldn't strip perks mid-retry, only terminal states do.
        const plan = ["active", "trialing"].includes(sub.status) ? "premium"
          : event.type === "customer.subscription.deleted" || sub.status === "canceled" ? "free" : null;
        if (!plan) break;
        await sb.from("web_profiles").update({
          plan,
          ...(plan === "free" ? { stripe_subscription_id: null } : {}),
          updated_at: new Date().toISOString(),
        }).or(`stripe_customer_id.eq.${sub.customer},stripe_subscription_id.eq.${sub.id}`);
        break;
      }
    }
    return new Response("ok");
  } catch (e) {
    // 500 so Stripe retries — a dropped event is a missing grant.
    return new Response(`error: ${e}`, { status: 500 });
  }
});
