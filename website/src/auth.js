import { supabase } from "./supabase.js";

const origin = () => window.location.origin;

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export function onAuthChange(cb) {
  return supabase.auth.onAuthStateChange((_event, session) => cb(session));
}

// Redirects unauthenticated visitors to the account page. Returns the session.
export async function requireAuth() {
  const session = await getSession();
  if (!session) {
    window.location.href = "/account.html?next=dashboard";
    return null;
  }
  return session;
}

export function signIn(email, password) {
  return supabase.auth.signInWithPassword({ email, password });
}

export function signUp(email, password, displayName) {
  return supabase.auth.signUp({
    email,
    password,
    options: {
      data: { display_name: displayName },
      emailRedirectTo: `${origin()}/dashboard.html`,
    },
  });
}

export function magicLink(email) {
  return supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${origin()}/dashboard.html`, shouldCreateUser: true },
  });
}

export function signInWithDiscord() {
  return supabase.auth.signInWithOAuth({
    provider: "discord",
    options: { redirectTo: `${origin()}/dashboard.html` },
  });
}

// Manual identity linking — attaches a Discord identity to the *current*
// account via OAuth (requires "Allow manual linking" enabled in Supabase).
export function linkDiscord() {
  return supabase.auth.linkIdentity({
    provider: "discord",
    options: { redirectTo: `${origin()}/dashboard.html` },
  });
}

export function getIdentities() {
  return supabase.auth.getUserIdentities();
}

export function unlinkDiscord(identity) {
  return supabase.auth.unlinkIdentity(identity);
}

// Claims a /link code minted in Discord — stamps web_profiles.discord_user_id
// via the security-definer rpc (the column itself is not user-writable).
export function claimLinkCode(code) {
  return supabase.rpc("claim_link_code", { p_code: code });
}

export function resetPassword(email) {
  return supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin()}/account.html?mode=recovery`,
  });
}

export function updatePassword(newPassword) {
  return supabase.auth.updateUser({ password: newPassword });
}

export async function updateDisplayName(userId, name) {
  const { error } = await supabase
    .from("web_profiles")
    .update({ display_name: name, updated_at: new Date().toISOString() })
    .eq("id", userId);
  if (error) throw error;
}

export async function getProfile(userId) {
  const { data, error } = await supabase
    .from("web_profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export function deleteAccount() {
  return supabase.rpc("delete_own_account");
}

export function signOut() {
  return supabase.auth.signOut();
}
