// Shared Supabase auth + data helpers for the account and dashboard pages.
// Ported from website/src/auth.js; behaviour is unchanged except where noted
// (FIX: lines close the inventory's Appendix B items).
import { supabase } from "./supabase";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "../lib/config";

const origin = () => window.location.origin;

export const getSession = async () => (await supabase.auth.getSession()).data.session;
export const getUser = async () => (await supabase.auth.getUser()).data.user;
export const onAuthChange = (cb: (event: string, session: unknown) => void) =>
  supabase.auth.onAuthStateChange((event, session) => cb(event, session));

// ── Post-auth destination ────────────────────────────────────────────────────
// `?next=` carries the path the user wanted. Only same-origin paths are
// honoured: protocol-relative "//evil.com", "javascript:…" and malformed
// values fall back to the dashboard.
export function safeNext(next: string | null): string | null {
  if (next && /^\/[^/\\]/.test(next) && !next.includes(":")) return next;
  return null;
}
export const authRedirectTarget = () =>
  safeNext(new URLSearchParams(window.location.search).get("next")) ?? "/dashboard";

// Redirect to sign-in, remembering where we were. FIX: keeps query and hash so
// the Premium path lands back on #billing.
export async function requireAuth() {
  const user = await getUser();
  if (!user) {
    const here = window.location.pathname + window.location.search + window.location.hash;
    window.location.href = `/account?next=${encodeURIComponent(here)}`;
    return null;
  }
  return user;
}

// ── Email / password ─────────────────────────────────────────────────────────
// FIX: confirmation emails honour `next` instead of always landing on /dashboard.
export const signIn = (email: string, password: string) => supabase.auth.signInWithPassword({ email, password });
export const signUp = (email: string, password: string, displayName: string) =>
  supabase.auth.signUp({
    email, password,
    options: { data: { display_name: displayName }, emailRedirectTo: origin() + authRedirectTarget() },
  });
export const magicLink = (email: string) =>
  supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true, emailRedirectTo: origin() + authRedirectTarget() },
  });
export const resendVerification = (email: string) =>
  supabase.auth.resend({ type: "signup", email, options: { emailRedirectTo: origin() + authRedirectTarget() } });
export const resetPassword = (email: string) =>
  supabase.auth.resetPasswordForEmail(email, { redirectTo: `${origin()}/account?mode=recovery` });
export const updatePassword = (password: string) => supabase.auth.updateUser({ password });

/** Reject if `p` doesn't settle within `ms`: supabase-js calls carry no
 * timeout, and a wedged call must not freeze the UI behind a modal. */
export const withTimeout = <T>(p: PromiseLike<T>, ms: number, label = "Request"): Promise<T> =>
  Promise.race([Promise.resolve(p), new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out. Try again.`)), ms))]);

// supabase-js signOut() can hang (a dead session wedges the navigator.locks
// auth lock, and every later auth call queues behind it). Local logout is
// just dropping storage keys: do that synchronously and fire the server-side
// revocation in the background. Callers navigate immediately.
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

// Delete never rides the SDK's session path (see signOut): read the token
// directly and POST the rpc raw.
const storedAccessToken = (): string | null => {
  for (const key of Object.keys(localStorage)) {
    if (!/^sb-.*-auth-token$/.test(key)) continue;
    try { return JSON.parse(localStorage.getItem(key) ?? "null")?.access_token ?? null; } catch { return null; }
  }
  return null;
};
export const deleteAccount = async (): Promise<{ error: Error | null }> => {
  const live = await withTimeout(supabase.auth.getSession(), 2000).catch(() => null);
  const token = live?.data?.session?.access_token ?? storedAccessToken();
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
const discordOpts = (next?: string) => ({
  provider: "discord" as const,
  options: { redirectTo: origin() + (next ?? authRedirectTarget()) },
});
// New sign-in → lands on `next` (default /dashboard). The landing-page button
// passes "/dashboard?welcome=1" so the first-run guide opens.
export const signInWithDiscord = (next?: string) => supabase.auth.signInWithOAuth(discordOpts(next));
// Attach Discord to the currently signed-in account (no new session).
export const linkDiscord = () => supabase.auth.linkIdentity(discordOpts(window.location.pathname + window.location.search));
// Supabase refuses to drop a user's last identity.
export const unlinkDiscord = (identity: any) => supabase.auth.unlinkIdentity(identity);
// Clear a code-claimed link (no auth identity exists to unlink).
export const unlinkDiscordLink = () => supabase.rpc("unlink_discord");

// ── Profile + identities ─────────────────────────────────────────────────────
export type Profile = {
  id: string; display_name: string | null; discord_user_id: string | null;
  discord_username: string | null; discord_avatar_url: string | null;
  plan: string | null; credit_balance: number | null; purchased_balance: number | null;
  creator_slug: string | null; creator_name: string | null; creator_bio: string | null; creator_public: boolean | null;
};
export async function getProfile(userId: string): Promise<Profile | null> {
  // Named columns only: the client never needs stripe ids or grant timestamps.
  const { data, error } = await supabase
    .from("web_profiles")
    .select("id, display_name, discord_user_id, discord_username, discord_avatar_url, plan, credit_balance, purchased_balance, creator_slug, creator_name, creator_bio, creator_public")
    .eq("id", userId).maybeSingle();
  if (error) throw error;
  return data as Profile | null;
}
export async function updateDisplayName(userId: string, name: string) {
  const { error } = await supabase
    .from("web_profiles")
    .update({ display_name: name, updated_at: new Date().toISOString() })
    .eq("id", userId);
  if (error) throw error;
}
export const getIdentities = () => supabase.auth.getUserIdentities();
export const claimLinkCode = (code: string) => supabase.rpc("claim_link_code", { p_code: code });

// ── Tokens + companion settings ──────────────────────────────────────────────
// Settings and BYOK status resolve the caller's own linked discord_user_id
// server-side; the client never names a user id.
export const getBotSettings = () => supabase.rpc("my_bot_settings");
export const saveBotSettings = (patch: Record<string, unknown>) => supabase.rpc("upsert_my_settings", { patch });
export const getByokStatus = () => supabase.rpc("my_byok_status");
// The daily grant is lazy (it fires inside spend txs), so a raw balance read
// lies: 0 for a never-spent account, yesterday's remainder before the first
// chat of the day. claim_daily_grant runs the same grant under the account
// row lock on read — call it before rendering balances.
export const claimDailyGrant = () => supabase.rpc("claim_daily_grant");
// Live feedback for the creator-page address field: { available, reason?, slug }
export const creatorSlugAvailable = (slug: string) => supabase.rpc("creator_slug_available", { p_slug: slug });
export const getCreditLedger = (limit = 8) =>
  supabase.from("credit_ledger")
    .select("delta,kind,reason,balance_after,created_at")
    .order("id", { ascending: false })
    .limit(limit);

// ── Character-card import ────────────────────────────────────────────────────
export const importCompanionCard = (payload: unknown) => supabase.rpc("import_companion_card", { p_payload: payload });
export const uploadCardAvatar = (uid: string, sha256: string, bytes: Uint8Array) =>
  supabase.storage.from("card-avatars").upload(`${uid}/${sha256}.png`, bytes, { contentType: "image/png", upsert: true });
export const cardAvatarUrl = (path: string) => supabase.storage.from("card-avatars").getPublicUrl(path).data.publicUrl;

// ── Chat-history import ──────────────────────────────────────────────────────
// FIX: one shared roster fetch — the memory panel and history importer used to
// call my_companions separately.
let rosterPromise: Promise<any> | null = null;
export const myCompanions = () => (rosterPromise ??= Promise.resolve(supabase.rpc("my_companions")));
export const myChatImports = () => supabase.rpc("my_chat_imports");
export const importChatHistory = (payload: unknown) => supabase.rpc("import_chat_history", { p_payload: payload });
export const deleteChatImport = (p_id: number) => supabase.rpc("delete_chat_import", { p_id });

// ── Memory editor ────────────────────────────────────────────────────────────
// Every call resolves the caller's own dm:<id> lane server-side and refuses
// anything outside their roster.
export const myMemoryOverview = (companionId: number) => supabase.rpc("my_memory_overview", { p_companion_id: companionId });
export const pinMemory = (id: number, pinned: boolean) => supabase.rpc("memory_pin", { p_id: id, p_pinned: pinned });
export const updateMemory = (id: number, content: string) => supabase.rpc("memory_update", { p_id: id, p_content: content });
export const forgetMemory = (id: number) => supabase.rpc("memory_forget", { p_id: id });
export const pinJournalEntry = (id: number, pinned: boolean) => supabase.rpc("journal_pin", { p_id: id, p_pinned: pinned });
export const forgetJournalEntry = (id: number) => supabase.rpc("journal_forget", { p_id: id });
export const saveStorySummary = (companionId: number, channelId: string, summary: string) =>
  supabase.rpc("story_summary_save", { p_companion_id: companionId, p_channel_id: channelId, p_summary: summary });

// ── Terms/Privacy consent ────────────────────────────────────────────────────
export const getConsent = () => supabase.rpc("my_consent", { p_document: "terms" });
export const recordConsent = (version: number) => supabase.rpc("record_consent", { p_document: "terms", p_version: version });

/** Post-auth clickwrap: resolves at once when the account already accepted
 * ≥ currentVersion, else shows #consent-gate and holds until acceptance is
 * recorded. Fails closed: an rpc error shows the gate. */
export async function ensureConsent(currentVersion: number): Promise<true> {
  const { data, error } = await getConsent();
  if (!error && (data ?? 0) >= currentVersion) return true;
  const gate = document.getElementById("consent-gate") as HTMLDialogElement | null;
  if (!gate) return true;
  gate.showModal();
  return new Promise(resolve => {
    const btn = document.getElementById("consent-accept") as HTMLButtonElement;
    const err = document.getElementById("consent-error") as HTMLElement;
    // The gate can't be dismissed with Esc: acceptance or sign-out only.
    gate.addEventListener("cancel", e => e.preventDefault());
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      err.hidden = true;
      const { error: recErr } = await recordConsent(currentVersion);
      btn.disabled = false;
      if (recErr) {
        err.textContent = "Couldn't record that. Try again in a moment.";
        err.hidden = false;
        return;
      }
      gate.close();
      resolve(true);
    });
  });
}

/** Fire-and-forget funnel beacon (allowlisted server-side in src/worker.ts). */
export const beacon = (e: string, p?: string) => {
  try { navigator.sendBeacon?.("/track", JSON.stringify(p ? { e, p } : { e })); } catch { /* never block UI */ }
};
