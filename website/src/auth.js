// Shared Supabase auth helpers for the account + dashboard pages.
import { supabase } from "./supabase.js";

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
export const signOut = () => supabase.auth.signOut({ scope: "local" });
export const deleteAccount = () => supabase.rpc("delete_own_account");

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
export const getCreditLedger = (limit = 8) =>
  supabase.from("credit_ledger")
    .select("delta,kind,reason,balance_after,created_at")
    .order("id", { ascending: false })
    .limit(limit);
