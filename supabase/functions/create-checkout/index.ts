// Authenticated checkout minting for Characterly billing.
//
// Payment links are public URLs — anyone holding one can check out, so they
// can't enforce "packs are a Premium perk" (or stop a premium user buying a
// second subscription). This function replaces them: the dashboard calls it
// with the user's JWT, we check plan server-side, then mint a Stripe Checkout
// Session that only this account can use — client_reference_id is forced to
// the caller's own web_profiles id, never trusted from the request.
//
// Sessions carry metadata.checkout_kind — the stripe-webhook function keys
// fulfillment on it (payment_link is null on API-created sessions).
//
// Secrets: STRIPE_SECRET_KEY (restricted key — checkout:write only),
// SITE_URL (checkout return URLs). SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY +
// SUPABASE_ANON_KEY are auto-injected. verify_jwt stays at its default (true)
// — an unauthenticated call must never mint a session.

import { createClient } from "npm:@supabase/supabase-js@2";

// Product allowlist — the request names a product, never a price or amount.
// Catalog price ids (documented in docs/operations.md → Billing); premium
// must use the existing price because the webhook's classifySubscription
// verifies subscription events by price id.
const PREMIUM_PRICE = "price_1UQoE5GAOUmNDfnhulTyoL1o";
const PRODUCTS: Record<string, { mode: "payment" | "subscription"; meta: string; price: string; needsPremium: boolean }> = {
  premium: { mode: "subscription", meta: "premium", price: PREMIUM_PRICE, needsPremium: false },
  pack_500: { mode: "payment", meta: "pack_500", price: "price_1UQoE5GAOUmNDfnhwHI9mwm7", needsPremium: true },
  pack_1500: { mode: "payment", meta: "pack_1500", price: "price_1UQoE6GAOUmNDfnh2W16RjDr", needsPremium: true },
  pack_5000: { mode: "payment", meta: "pack_5000", price: "price_1UQoE6GAOUmNDfnh0egnY8GD", needsPremium: true },
};

const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("SITE_URL") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (request.method !== "POST") return json({ error: "POST only" }, 405);

  // Secrets paste in with stray whitespace more often than you'd think — a
  // newline in the key makes the Authorization header throw inside fetch().
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY")?.trim();
  const site = Deno.env.get("SITE_URL")?.trim().replace(/\/+$/, "");
  if (!stripeKey || !site) return json({ error: "not configured" }, 500);

  const jwt = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "auth required" }, 401);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt);
  if (authErr || !user) return json({ error: "bad token" }, 401);

  let product: string;
  try {
    product = (await request.json())?.product;
  } catch {
    return json({ error: "bad body" }, 400);
  }
  const p = PRODUCTS[product];
  if (!p) return json({ error: "unknown product" }, 400);

  const { data: profile, error: pErr } = await sb
    .from("web_profiles")
    .select("id, plan, stripe_customer_id")
    .eq("id", user.id)
    .maybeSingle();
  if (pErr || !profile) return json({ error: "no profile" }, 400);

  const premium = profile.plan === "premium";
  if (p.needsPremium && !premium) return json({ error: "token packs require Premium" }, 403);
  if (product === "premium" && premium) return json({ error: "already premium" }, 409);

  const params = new URLSearchParams({
    mode: p.mode,
    client_reference_id: profile.id,
    "line_items[0][price]": p.price,
    "line_items[0][quantity]": "1",
    // The whole catalog carries the SaaS tax code under Managed Payments —
    // API sessions must opt in or Stripe rejects the price outright.
    "managed_payments[enabled]": "true",
    "metadata[checkout_kind]": p.meta,
    success_url: `${site}/dashboard#billing`,
    cancel_url: `${site}/dashboard#billing`,
    // Reuse the known Stripe customer so sub events + refund audits map to
    // the same identity; otherwise collect the email (only when the account
    // has one — an empty string is a Stripe 400) and, for payments where no
    // Customer is created by default, force creation so charge.refunded can
    // map the charge back to this account.
    ...(profile.stripe_customer_id
      ? { customer: profile.stripe_customer_id }
      : { ...(user.email ? { customer_email: user.email } : {}), ...(p.mode === "payment" ? { customer_creation: "always" } : {}) }),
  });

  let res: Response;
  try {
    res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${stripeKey}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
  } catch (e) {
    console.error(`checkout create threw for ${user.id}: ${e}`);
    return json({ error: `checkout unavailable — ${e instanceof Error ? e.message : e}` }, 502);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.url) {
    const why = body?.error?.message ?? `stripe ${res.status}`;
    console.error(`checkout create failed for ${user.id}: ${res.status} ${JSON.stringify(body)}`);
    return json({ error: `checkout unavailable — ${why}` }, 502);
  }
  return json({ url: body.url });
});
