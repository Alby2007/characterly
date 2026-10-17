// Shared Supabase auth helpers for the account + dashboard pages.
import { supabase } from "./supabase.js";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

const origin = () => window.location.origin;

export const getSession = async () => (await supabase.auth.getSession()).data.session;
export const getUser    = async () => (await supabase.auth.getUser()).data.user;

export function onAuthChange(cb) {
  supabase.auth.onAuthStateChange((event, session) => cb(event, session));
}

// ── Post-auth destination ────────────────────────────────────────────────────
// `?next=` is written by requireAuth() and carries the path the user actually
// wanted. Only same-origin paths are honored — anything else (protocol-relative
// "//evil.com", "javascript:…", malformed) falls back to the dashboard.
export function authRedirectTarget() {
  const next = new URLSearchParams(window.location.search).get("next");
  if (next && /^\/[^/\\]/.test(next) && !next.includes(":")) return next;
  return "/dashboard";
}

// Redirect to the sign-in page, remembering where we were so account.js can
// send the user back after auth.
export async function requireAuth() {
  const user = await getUser();
  if (!user) {
    const next = encodeURIComponent(window.location.pathname);
    window.location.href = `/account?next=${next}`;
    return null;
  }
  return user;
}

// ── Email / password ─────────────────────────────────────────────────────────
export const signIn  = (email, password) => supabase.auth.signInWithPassword({ email, password });
export const signUp  = (email, password, displayName) =>
  supabase.auth.signUp({
    email, password,
    options: { data: { display_name: displayName }, emailRedirectTo: `${origin()}/dashboard` },
  });
export const magicLink = email =>
  supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true, emailRedirectTo: origin() + authRedirectTarget() },
  });
export const resendVerification = email =>
  supabase.auth.resend({ type: "signup", email, options: { emailRedirectTo: `${origin()}/dashboard` } });
export const resetPassword = email =>
  supabase.auth.resetPasswordForEmail(email, { redirectTo: `${origin()}/account?mode=recovery` });
export const updatePassword = newPassword => supabase.auth.updateUser({ password: newPassword });

/** Reject if `p` doesn't settle within `ms` — supabase-js calls carry no
 * timeout, and a wedged network call must not freeze the UI behind a modal. */
export const withTimeout = (p, ms, label = "Request") =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out — try again`)), ms))]);

// supabase-js signOut() can hang forever: even scope:'local' POSTs /logout
// with no timeout, and dead sessions (deleted/expired user) are a known
// upstream wedge (supabase/auth#1518, supabase-js#1700). Worse, the wedged
// call keeps holding the navigator.locks auth lock, so every later auth
// call in the tab queues behind it and hangs too. Never await it: local
// logout is just dropping storage keys — do that synchronously and fire the
// server-side revocation in the background. Callers navigate immediately.
const clearLocalSession = () => {
  for (const key of Object.keys(localStorage)) {
    if (/^sb-.*-auth-token/.test(key)) localStorage.removeItem(key);
  }
};
export const signOut = () => {
  clearLocalSession();
  supabase.auth.signOut({ scope: "local" }).catch(() => {});
  return Promise.resolve();
};

// Delete must never ride the SDK's session path: supabase-js guards token
// reads behind a navigator.locks lock, and a hung auth call holds that lock
// forever — every later rpc/signOut then queues behind it and never resolves.
// Read the stored access token straight from storage and POST the rpc raw.
const storedAccessToken = () => {
  for (const key of Object.keys(localStorage)) {
    if (!/^sb-.*-auth-token$/.test(key)) continue;
    try { return JSON.parse(localStorage.getItem(key))?.access_token ?? null; }
    catch { return null; }
  }
  return null;
};
export const deleteAccount = async () => {
  // Prefer a live (possibly refreshed) SDK token — but bound it, since a
  // wedged auth lock would otherwise hang this before the request is sent.
  const token =
    (await withTimeout(supabase.auth.getSession(), 2000).catch(() => null))?.data?.session?.access_token
    ?? storedAccessToken();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/delete_own_account`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: "{}",
  });
  if (res.ok) return { error: null };
  const body = await res.json().catch(() => null);
  return { error: new Error(body?.message ?? `Delete failed (HTTP ${res.status})`) };
};

// ── Discord OAuth ────────────────────────────────────────────────────────────
const discordOpts = () => ({ provider: "discord", options: { redirectTo: origin() + authRedirectTarget() } });
// New OAuth sign-in → lands on `next` (default dashboard).
export const signInWithDiscord = () => supabase.auth.signInWithOAuth(discordOpts());
// Attach Discord to the CURRENTLY signed-in account (no new session).
export const linkDiscord = () => supabase.auth.linkIdentity(discordOpts());
// Drop the Discord identity (must have ≥2 identities — Supabase enforces).
export const unlinkDiscord = identity => supabase.auth.unlinkIdentity(identity);
// Clear a code-claimed link (no auth identity exists to unlink).
export const unlinkDiscordLink = () => supabase.rpc("unlink_discord");

// ── Profile + identities ─────────────────────────────────────────────────────
export async function getProfile(userId) {
  const { data, error } = await supabase
    .from("web_profiles").select("*").eq("id", userId).maybeSingle();
  if (error) throw error;
  return data;
}
export async function updateDisplayName(userId, name) {
  const { error } = await supabase
    .from("web_profiles")
    .update({ display_name: name, updated_at: new Date().toISOString() })
    .eq("id", userId);
  if (error) throw error;
}
export const getIdentities = () => supabase.auth.getUserIdentities();
export const claimLinkCode = code => supabase.rpc("claim_link_code", { p_code: code });

// ── Tokens + companion settings (hosted lane) ───────────────────────────────
// Balance/plan/grant timestamps come through getProfile (web_profiles row).
// Settings + BYOK status go through rpcs that resolve the caller's own linked
// discord_user_id server-side — never trusted from the client.
export const getBotSettings = () => supabase.rpc("my_bot_settings");
export const saveBotSettings = patch => supabase.rpc("upsert_my_settings", { patch });
export const getByokStatus = () => supabase.rpc("my_byok_status");

// ── Character-card import ───────────────────────────────────────────────────
// Creates the private unlisted listing + adopted companion in one security-
// definer transaction. The client supplies the already-mapped persona fields;
// the server re-bounds everything and stamps provenance itself.
export const importCompanionCard = payload => supabase.rpc("import_companion_card", { p_payload: payload });
export const uploadCardAvatar = (uid, sha256, bytes) =>
  supabase.storage.from("card-avatars").upload(`${uid}/${sha256}.png`, bytes, {
    contentType: "image/png",
    upsert: true,
  });
export const cardAvatarUrl = path => supabase.storage.from("card-avatars").getPublicUrl(path).data.publicUrl;

// ── Terms/Privacy consent ────────────────────────────────────────────────────
// The consent_events table is RLS-locked; both calls go through security
// definer RPCs keyed on auth.uid(). The version constant lives in config.js
// and must stay in sync with TERMS_VERSION in the bot's src/ops.ts.
export const getConsent = () => supabase.rpc("my_consent", { p_document: "terms" });
export const recordConsent = version =>
  supabase.rpc("record_consent", { p_document: "terms", p_version: version });

/** Post-auth clickwrap gate: resolves immediately when the account already
 * accepted ≥ TERMS_VERSION, else shows the #consent-gate overlay and holds
 * until acceptance is recorded. Covers OAuth + magic-link signups that never
 * see the email form's checkbox. Call once per authed page load. */
export async function ensureConsent(currentVersion) {
  const { data, error } = await getConsent();
  // PGRST202 = RPC missing — the consent infra isn't deployed yet, so there is
  // nothing to enforce. Fail open rather than lock accounts out mid-rollout.
  if (error?.code === "PGRST202") return true;
  if (!error && (data ?? 0) >= currentVersion) return true;
  const gate = document.getElementById("consent-gate");
  if (!gate) return true; // Page without the gate markup — nothing to block on.
  gate.hidden = false;
  return new Promise(resolve => {
    const btn = document.getElementById("consent-accept");
    const err = document.getElementById("consent-error");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      err.hidden = true;
      const { error: recErr } = await recordConsent(currentVersion);
      btn.disabled = false;
      if (recErr) {
        err.textContent = "Couldn't record that — try again in a moment.";
        err.hidden = false;
        return;
      }
      gate.hidden = true;
      resolve(true);
    }, { once: false });
  });
}
export const getCreditLedger = (limit = 8) =>
  supabase.from("credit_ledger")
    .select("delta,kind,reason,balance_after,created_at")
    .order("id", { ascending: false })
    .limit(limit);
