// The dashboard. Ported from website/src/dashboard.js. Changes:
//   - first-run guide (link Discord → join the server → adopt or import)
//   - billing requires a linked Discord account (also enforced server-side
//     in supabase/functions/create-checkout)
//   - native <dialog> for the consent gate and delete confirmation
//   - removed the dead ?checkout return handler (Stripe returns to #billing)
import {
  requireAuth, getProfile, updateDisplayName, updatePassword, deleteAccount, signOut,
  linkDiscord, getIdentities, unlinkDiscord, unlinkDiscordLink, claimLinkCode, withTimeout,
  getBotSettings, saveBotSettings, getByokStatus, getCreditLedger, ensureConsent, myCompanions, beacon,
  claimDailyGrant, creatorSlugAvailable,
  type Profile,
} from "./auth";
import { CREATOR_SLUG_RE, creatorSlugify } from "../../../src/authored-screen.ts";
import { supabase } from "./supabase";
import { showLoader, hideLoader } from "./loader";
import { TERMS_VERSION, PLANS } from "../lib/config";
import { initImportCard } from "./import-card";
import { initImportHistory } from "./import-history";
import { initMemories } from "./memories";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll(sel)] as T[];
const guard = <T>(p: Promise<T>, ms = 8000) => withTimeout(p, ms).catch(e => console.warn("dashboard section failed:", e));
const goHome = async () => { try { await signOut(); } finally { location.href = "/"; } };

// The page renders with the loading screen up (dashboard.astro). Coming back
// from Discord, say what's actually happening; and never leave the visitor
// stuck behind it if something below throws.
{
  const q = new URLSearchParams(location.search);
  if (q.has("code") || q.has("welcome") || location.hash.includes("access_token")) showLoader("Signing you in…");
  setTimeout(hideLoader, 12_000);
}
const user = await requireAuth();
if (!user) { showLoader("Taking you to sign in…"); throw new Error("redirecting"); }
// Hoisted functions don't keep the `user` narrowing; a const id does.
const userId = user.id;

// Clickwrap: Discord and magic-link signups never see the email form's
// checkbox, so acceptance is captured here. Sign-out is the only other exit.
$("#consent-signout").addEventListener("click", goHome);
await ensureConsent(TERMS_VERSION);

// Wired first: nothing network-bound below may leave sign-out or delete inert.
for (const b of $$("[data-signout]")) b.addEventListener("click", goHome);

// ── Delete account ─────────────────────────────────────────────────────────
const modal = $<HTMLDialogElement>("#delete-modal");
const confirmInput = $<HTMLInputElement>("#delete-confirm");
const deleteBtn = $<HTMLButtonElement>("#delete-do");
const deleteErr = $("#delete-error");
$("#btn-delete").addEventListener("click", () => {
  confirmInput.value = "";
  deleteBtn.disabled = true;
  deleteErr.hidden = true;
  modal.showModal();
  confirmInput.focus();
});
$("#delete-cancel").addEventListener("click", () => modal.close());
modal.addEventListener("click", e => { if (e.target === modal) modal.close(); });
confirmInput.addEventListener("input", () => { deleteBtn.disabled = confirmInput.value.trim().toUpperCase() !== "DELETE"; });
deleteBtn.addEventListener("click", async () => {
  deleteBtn.disabled = true;
  deleteErr.hidden = true;
  // Bounded: a hung request must surface. Retrying is safe (deleting an
  // already-deleted user succeeds).
  const { error } = await withTimeout(deleteAccount(), 10000, "Delete").catch(e => ({ error: e as Error }));
  if (error) {
    deleteErr.textContent = error.message || "Delete didn't go through. Try again.";
    deleteErr.hidden = false;
    deleteBtn.disabled = false;
    return;
  }
  await signOut();
  location.href = "/";
});

// ── Profile ────────────────────────────────────────────────────────────────
// profileFailed distinguishes "the read failed" from "no profile row": only
// the former shows the load error, so a transient failure never masquerades
// as an unlinked account.
let profile: Profile | null = null;
let profileFailed = false;
try { profile = await withTimeout(getProfile(userId), 8000); } catch { profileFailed = true; }
const fallbackName = () => profile?.display_name || user.user_metadata?.display_name || (user.email ?? "").split("@")[0] || "there";
const hour = new Date().getHours();
$("#dash-greeting").textContent = hour < 5 ? "Up late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
$("#dash-name").textContent = fallbackName();
$("#profile-email").textContent = user.email ?? "Signed in with Discord";
$("#profile-avatar").textContent = fallbackName().charAt(0).toUpperCase();
$<HTMLInputElement>("#input-name").value = profile?.display_name || user.user_metadata?.display_name || "";
$("#profile-since").textContent = `Member since ${new Date(user.created_at).toLocaleDateString(undefined, { month: "long", year: "numeric" })}`;

$("#form-name").addEventListener("submit", async e => {
  e.preventDefault();
  const err = $("#profile-error");
  err.hidden = true;
  err.classList.remove("ok");
  const name = $<HTMLInputElement>("#input-name").value.trim();
  try {
    await updateDisplayName(user.id, name);
    if (profile) profile.display_name = name;
    $("#dash-name").textContent = fallbackName();
    $("#profile-avatar").textContent = fallbackName().charAt(0).toUpperCase();
    err.textContent = "Saved.";
    err.classList.add("ok");
    err.hidden = false;
  } catch (ex: any) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

// ── Discord identity ───────────────────────────────────────────────────────
// OAuth errors come back on the redirect URL, in the query or the hash.
const urlParams = new URLSearchParams(location.search);
const hashParams = new URLSearchParams(location.hash.slice(1));
const oauthError = urlParams.get("error_description") || hashParams.get("error_description") || urlParams.get("error") || hashParams.get("error");
const showDiscordError = (message: string) => { const el = $("#discord-error"); el.textContent = message; el.hidden = false; };
if (oauthError) {
  showDiscordError(decodeURIComponent(oauthError).replace(/\+/g, " "));
  history.replaceState(null, "", location.pathname + (urlParams.has("welcome") ? "?welcome=1" : ""));
}

for (const b of $$<HTMLButtonElement>("[data-link-discord]")) {
  b.addEventListener("click", async () => {
    b.disabled = true;
    const { error } = await linkDiscord();
    if (error) { b.disabled = false; showDiscordError(error.message); }
  });
}

const linked = () => Boolean(profile?.discord_user_id);
// We hold no profile data at all and the read failed: hide the sections
// rather than show a false "not linked" state. A stale profile beats none.
const profileUnknown = () => profileFailed && !profile;
const setAvatar = (slot: HTMLElement, url: unknown, name: string) => {
  slot.replaceChildren();
  if (typeof url === "string" && url.startsWith("https://")) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    slot.append(img);
  } else {
    slot.textContent = (name || "#").charAt(0).toUpperCase();
  }
};

async function renderDiscordCard() {
  const { data } = await getIdentities();
  const identities = data?.identities ?? [];
  const discordIdentity = identities.find(i => i.provider === "discord");
  // Two link paths: an OAuth identity, or a /link code that stamped
  // web_profiles.discord_user_id without creating an identity row.
  const codeLinkedId = profile?.discord_user_id;
  const badge = $("#discord-badge");
  if (discordIdentity || codeLinkedId) {
    badge.textContent = "Linked";
    badge.className = "badge badge-ok";
    $("#discord-linked").hidden = false;
    $("#discord-unlinked").hidden = true;
    if (discordIdentity) {
      const d: any = discordIdentity.identity_data ?? {};
      const name = d.full_name || d.name || d.custom_claims?.global_name || "Discord user";
      $("#discord-name").textContent = name;
      $("#discord-sub").textContent = "Linked with Discord sign-in";
      setAvatar($("#discord-avatar"), d.avatar_url, name);
    } else {
      // Code-linked: the bot snapshots username/avatar at /link time.
      const name = profile?.discord_username || "Discord account";
      $("#discord-name").textContent = name;
      $("#discord-sub").textContent = `Linked with a code · ID ${codeLinkedId}`;
      setAvatar($("#discord-avatar"), profile?.discord_avatar_url, name);
    }
    const canUnlink = discordIdentity ? identities.length >= 2 : true;
    $("#btn-unlink-discord").hidden = !canUnlink;
    $("#discord-unlink-note").hidden = canUnlink;
    $("#btn-unlink-discord").onclick = async () => {
      if (!confirm("Unlink your Discord account? Premium and tokens tied to it stop applying until you link again.")) return;
      const { error } = discordIdentity ? await unlinkDiscord(discordIdentity) : await unlinkDiscordLink();
      if (error) return showDiscordError(error.message);
      await refreshAll();
    };
  } else {
    badge.textContent = "Not linked";
    badge.className = "badge";
    $("#discord-linked").hidden = true;
    $("#discord-unlinked").hidden = false;
  }
}

$("#form-link-code").addEventListener("submit", async e => {
  e.preventDefault();
  const msg = $("#link-code-msg");
  msg.hidden = true;
  const code = $<HTMLInputElement>("#input-link-code").value.trim();
  if (!code) return;
  beacon("link_attempt");
  const { error } = await claimLinkCode(code);
  if (error) {
    // The rpc raises "tag: message"; show the message half.
    msg.textContent = error.message.includes(":") ? error.message.split(":").slice(1).join(":").trim() : error.message;
    msg.hidden = false;
    return;
  }
  $<HTMLInputElement>("#input-link-code").value = "";
  await refreshAll();
});

// ── Billing ────────────────────────────────────────────────────────────────
// create-checkout mints the Stripe session server-side, checks the plan, and
// forces client_reference_id to the caller's own account.
async function openCheckout(product: string, btn: HTMLButtonElement) {
  const msg = $("#billing-msg");
  msg.hidden = true;
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "Opening checkout…";
  try {
    const { data, error } = await supabase.functions.invoke("create-checkout", { body: { product } });
    if (error || !data?.url) {
      // Non-2xx bodies carry the real reason on error.context.
      let detail = (error as any)?.message ?? "checkout failed";
      try { detail = (await (error as any)?.context?.json())?.error ?? detail; } catch { /* keep generic */ }
      throw new Error(detail);
    }
    location.href = data.url;
  } catch (e: any) {
    msg.textContent = `Checkout didn't open (${e.message}). Try again in a moment.`;
    msg.hidden = false;
    btn.disabled = false;
    btn.textContent = label;
  }
}
const PRODUCTS: Array<[string, string]> = [
  ["#btn-subscribe", "premium"], ["#btn-subscribe-yearly", "premium_yearly"],
  ["#btn-pack-750", "pack_750"], ["#btn-pack-2500", "pack_2500"], ["#btn-pack-7500", "pack_7500"],
];
for (const [sel, product] of PRODUCTS) {
  const b = $<HTMLButtonElement>(sel);
  b.addEventListener("click", () => {
    if (b.disabled) return;
    beacon("checkout_click", product);
    openCheckout(product, b);
  });
}

function renderBilling() {
  const premium = profile?.plan === "premium";
  const plan = $("#billing-plan");
  plan.textContent = premium ? "Premium" : "Free";
  plan.className = premium ? "badge badge-go" : "badge";
  // Perks follow the Discord link, so buying needs one. On a failed profile
  // read, show neither body nor the false "link Discord" prompt.
  $("#billing-body").hidden = !linked() || profileUnknown();
  $("#billing-locked").hidden = linked() || profileUnknown();
  if (!linked() || profileUnknown()) return;
  const sub = $<HTMLButtonElement>("#btn-subscribe");
  sub.disabled = premium;
  sub.textContent = premium ? "Premium is active" : `Go Premium · $${PLANS.premium.monthly}/month`;
  sub.classList.toggle("btn-go", !premium);
  const yearly = $<HTMLButtonElement>("#btn-subscribe-yearly");
  yearly.disabled = premium;
  yearly.hidden = premium;
  for (const sel of ["#btn-pack-750", "#btn-pack-2500", "#btn-pack-7500"]) $<HTMLButtonElement>(sel).disabled = !premium;
  $("#pack-note").hidden = premium;
}

// ── Tokens ─────────────────────────────────────────────────────────────────
const LEDGER_LABELS: Record<string, string> = { grant_daily: "Daily refill", grant_weekly: "Weekly refill", grant_bonus: "Bonus", purchase: "Token pack", refund: "Refund", adjust: "Adjustment" };
const REASON_LABELS: Record<string, string> = { dm_turn: "DM chat", guild_turn: "Server chat", c2c: "Companion chat", onboarding_turn: "Companion draft", chat_import: "Chat import", dm_turn_refund: "Chat refund", guild_turn_refund: "Chat refund" };

// The daily grant tops the balance up on the first chat after UTC midnight;
// the live countdown is the useful "when".
const nextRefillAt = () => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.getTime(); };
const fmtCountdown = (ms: number) => { const m = Math.max(0, Math.ceil(ms / 60000)); const h = Math.floor(m / 60); return h ? `${h}h ${m % 60}m` : `${m}m`; };
let grantTimer: number | null = null;
function renderGrantLine() {
  const premium = profile?.plan === "premium";
  const wait = fmtCountdown(nextRefillAt() - Date.now());
  $("#tokens-grant").textContent = `Refills to ${premium ? PLANS.premium.dailyTokens : PLANS.free.dailyTokens} each day. Next refill in ${wait} (midnight UTC).`;
}

async function renderTokens() {
  $("#tokens-body").hidden = !linked() || profileUnknown();
  $("#tokens-locked").hidden = linked() || profileUnknown();
  const premium = profile?.plan === "premium";
  const plan = $("#tokens-plan");
  plan.textContent = premium ? "Premium" : "Free";
  plan.className = premium ? "badge badge-go" : "badge";
  if (!linked() || profileUnknown()) return;
  // Balance reads go through the claim rpc — the lazy grant fires on read,
  // so the number can never lag the spendable reality (0 for a never-spent
  // account, stale remainder before today's first chat).
  const { data: claim } = await claimDailyGrant().then(r => r, () => ({ data: null })) as any;
  if (profile && claim && typeof claim.credit_balance === "number") {
    profile.credit_balance = claim.credit_balance;
    profile.purchased_balance = claim.purchased_balance;
  }
  const total = Number(profile?.credit_balance ?? 0);
  const purchased = Math.min(Math.max(Number(profile?.purchased_balance ?? 0), 0), Math.max(total, 0));
  $("#tokens-balance").textContent = total.toLocaleString();
  // Packs and bonuses persist on top of the daily allowance: show the split.
  const split = $("#tokens-split");
  split.hidden = purchased <= 0;
  split.textContent = `${(total - purchased).toLocaleString()} daily · ${purchased.toLocaleString()} from packs and bonuses, which never expire (daily tokens are spent first).`;
  renderGrantLine();
  grantTimer ??= window.setInterval(renderGrantLine, 30_000);
  const ul = $("#tokens-ledger");
  const { data: ledger } = await getCreditLedger(8).then(r => r, () => ({ data: null }));
  ul.replaceChildren(...(ledger ?? []).map((row: any) => {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = row.kind === "spend" ? (REASON_LABELS[row.reason] ?? "Chat") : (LEDGER_LABELS[row.kind] ?? row.kind);
    const delta = document.createElement("span");
    delta.textContent = `${row.delta > 0 ? "+" : ""}${row.delta}`;
    delta.className = row.delta > 0 ? "pos" : "neg";
    li.append(label, delta);
    return li;
  }));
}

// ── Companion settings ─────────────────────────────────────────────────────
async function renderBotSettings() {
  const { data: s } = await getBotSettings().then(r => r, () => ({ data: null })) as any;
  const ok = Boolean(s?.linked ?? linked());
  $("#botset-controls").hidden = !ok || profileUnknown();
  $("#botset-locked").hidden = ok || profileUnknown();
  if (!ok) return;
  $<HTMLInputElement>("#set-c2c").checked = s?.c2c_enabled !== false;
  $<HTMLInputElement>("#set-alerts").checked = s?.low_credit_alerts !== false;
  const { data: byok } = await getByokStatus().then(r => r, () => ({ data: null })) as any;
  $("#byok-status").textContent = byok?.has_key
    ? `Your own AI key is connected${byok.validated_at ? " and verified" : ""}, so your chats don't spend tokens.`
    : "No personal AI key, so chats spend hosted tokens. Connect one in Discord with /companion key.";
}
for (const [sel, key] of [["#set-c2c", "c2c_enabled"], ["#set-alerts", "low_credit_alerts"]] as const) {
  $<HTMLInputElement>(sel).addEventListener("change", async e => {
    const input = e.target as HTMLInputElement;
    const msg = $("#botset-msg");
    msg.hidden = true;
    const { error } = await saveBotSettings({ [key]: input.checked });
    if (error) {
      input.checked = !input.checked;
      msg.textContent = error.message;
      msg.hidden = false;
    }
  });
}

// ── First-run guide ────────────────────────────────────────────────────────
const JOINED_KEY = "characterly:joined-server";
const joinedServer = () => { try { return localStorage.getItem(JOINED_KEY) === "1"; } catch { return false; } };
$("#join-server").addEventListener("click", () => {
  try { localStorage.setItem(JOINED_KEY, "1"); } catch { /* fine */ }
  setTimeout(renderGuide, 300);
});
let hasCharacter = false;
function setStep(id: string, done: boolean) {
  const li = $(id);
  li.toggleAttribute("data-done", done);
  for (const p of li.querySelectorAll<HTMLElement>("[data-pending]")) p.hidden = done;
  for (const p of li.querySelectorAll<HTMLElement>("[data-done]")) p.hidden = !done;
}
// ── Creator page ───────────────────────────────────────────────────────────
// The opt-in public profile at /creators/<slug>. Saves go through POST
// /creator-profile (the only write path — the columns reject direct updates)
// so public text always passes the listing screen. The address field
// auto-fills from the public name until the user overrides it, normalizes
// while typing, and a debounced creator_slug_available rpc flags
// taken/reserved before save ever happens.
const slugInput = () => $<HTMLInputElement>("#creator-slug");
const CREATOR_FIELDS: Record<string, string> = { slug: "#creator-slug", name: "#creator-name", bio: "#creator-bio" };
let slugTouched = false;
let slugCheckTimer: ReturnType<typeof setTimeout> | undefined;
function renderCreator() {
  const on = linked() && !profileUnknown();
  $("#creator-body").hidden = !on;
  $("#creator-locked").hidden = on;
  if (!on) return;
  $<HTMLInputElement>("#creator-public").checked = profile?.creator_public === true;
  slugInput().value = profile?.creator_slug ?? "";
  $<HTMLInputElement>("#creator-name").value = profile?.creator_name ?? "";
  $<HTMLInputElement>("#creator-bio").value = profile?.creator_bio ?? "";
  slugTouched = !!profile?.creator_slug;
  const live = profile?.creator_public === true && !!profile?.creator_slug;
  const badge = $("#creator-state");
  badge.textContent = live ? "Live" : (profile?.creator_slug || profile?.creator_name ? "Draft" : "Off");
  badge.className = live ? "badge badge-go" : "badge";
  const view = $<HTMLAnchorElement>("#creator-view");
  view.hidden = !live;
  $<HTMLButtonElement>("#creator-copy").hidden = !live;
  if (live) view.href = `/creators/${profile!.creator_slug}`;
  updateSlugPreview();
}
function updateSlugPreview() {
  const raw = slugInput().value.trim().toLowerCase();
  const pv = $("#creator-url-preview");
  pv.hidden = !raw;
  const av = $("#creator-avail");
  av.textContent = "";
  av.className = "";
  clearTimeout(slugCheckTimer);
  $("#creator-url-text").textContent = raw ? `${location.host}/creators/${raw}` : "";
  if (!raw || profile?.creator_slug === raw) return; // your own saved address — no availability tag needed
  slugCheckTimer = setTimeout(async () => {
    try {
      const { data } = await creatorSlugAvailable(raw);
      if (slugInput().value.trim().toLowerCase() !== raw) return; // stale keystroke
      if (!data) return;
      if (data.available) { av.textContent = " — available"; av.className = "ok"; }
      else if (data.reason === "taken") { av.textContent = " — taken, try another"; av.className = "bad"; }
      else if (data.reason === "reserved") { av.textContent = " — not available"; av.className = "bad"; }
      else { av.textContent = " — letters, numbers, hyphens (3–32)"; av.className = "bad"; }
    } catch { /* availability is a nicety — the save check still guards */ }
  }, 300);
}
// Typing a public name offers an address until the user overrides the field.
$<HTMLInputElement>("#creator-name").addEventListener("input", () => {
  if (!slugTouched) {
    slugInput().value = creatorSlugify($<HTMLInputElement>("#creator-name").value);
    updateSlugPreview();
  }
});
slugInput().addEventListener("input", () => {
  // Live-normalize so the field can never hold a shape the server rejects.
  const v = slugInput().value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 32);
  if (v !== slugInput().value) slugInput().value = v;
  slugTouched = v !== "";
  updateSlugPreview();
});
for (const sel of Object.values(CREATOR_FIELDS)) {
  $(sel).addEventListener("input", () => $(sel).removeAttribute("aria-invalid"));
}
$<HTMLButtonElement>("#creator-copy").addEventListener("click", async () => {
  const btn = $<HTMLButtonElement>("#creator-copy");
  try {
    await navigator.clipboard.writeText($<HTMLAnchorElement>("#creator-view").href);
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = "Copy link"; }, 1600);
  } catch { /* clipboard denied — the link is right above to copy */ }
});
$("#form-creator").addEventListener("submit", async e => {
  e.preventDefault();
  const msg = $("#creator-msg");
  msg.hidden = true;
  msg.classList.remove("ok");
  const slug = creatorSlugify(slugInput().value);
  slugInput().value = slug;
  if (slug && !CREATOR_SLUG_RE.test(slug)) {
    msg.textContent = "Addresses use 3–32 lowercase letters, numbers or hyphens.";
    msg.hidden = false;
    slugInput().setAttribute("aria-invalid", "true");
    slugInput().focus();
    return;
  }
  const btn = e.submitter as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch("/creator-profile", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session?.access_token ?? ""}` },
      body: JSON.stringify({
        slug,
        name: $<HTMLInputElement>("#creator-name").value.trim(),
        bio: $<HTMLInputElement>("#creator-bio").value.trim(),
        public: $<HTMLInputElement>("#creator-public").checked,
      }),
    });
    const data = await res.json().catch(() => ({})) as { error?: string; field?: string; slug?: string };
    if (!res.ok) {
      msg.textContent = data.error || "Save didn't go through. Try again.";
      msg.hidden = false;
      // The endpoint names the offending field — light it up and land focus.
      const bad = data.field ? $(CREATOR_FIELDS[data.field] ?? "#creator-slug") as HTMLInputElement | null : null;
      if (bad) { bad.setAttribute("aria-invalid", "true"); bad.focus(); }
      return;
    }
    msg.textContent = "Saved.";
    msg.classList.add("ok");
    msg.hidden = false;
    await refreshAll();
  } catch {
    msg.textContent = "Save didn't go through. Check your connection and try again.";
    msg.hidden = false;
  } finally {
    if (btn) btn.disabled = false;
  }
});

function renderGuide() {
  const steps = { link: linked(), join: joinedServer() || hasCharacter, char: hasCharacter };
  setStep("#step-link", steps.link);
  setStep("#step-join", steps.join);
  setStep("#step-char", steps.char);
  const allDone = steps.link && steps.join && steps.char;
  $("#guide").hidden = allDone && !urlParams.has("welcome");
}

async function refreshAll() {
  try { profile = await getProfile(userId); profileFailed = false; } catch { profileFailed = true; }
  $("#dash-load-error").hidden = !profileFailed;
  await guard(renderDiscordCard());
  renderBilling();
  await guard(renderTokens());
  await guard(renderBotSettings());
  renderCreator();
  renderGuide();
}

await refreshAll();
hideLoader();
// On a failed profile read the sections still attempt their own RPCs, which
// either succeed (transient profile error) or surface their own honest error.
const linkedOrRetry = linked() || profileUnknown();
initImportCard({ linked: linkedOrRetry, uid: userId });
initImportHistory({ linked: linkedOrRetry, uid: userId });
initMemories({ linked: linkedOrRetry });
if (linked()) {
  myCompanions().then(({ data }: any) => { hasCharacter = Array.isArray(data) && data.length > 0; renderGuide(); }, () => {});
}
$("[data-dash]").setAttribute("aria-busy", "false");

// ── Password ───────────────────────────────────────────────────────────────
$("#form-password").addEventListener("submit", async e => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const msg = $("#security-msg");
  const fd = new FormData(form);
  const pw = String(fd.get("password") ?? ""), again = String(fd.get("confirm") ?? "");
  msg.hidden = true;
  msg.classList.remove("ok");
  if (pw.length < 8) { msg.textContent = "Your password needs at least 8 characters."; msg.hidden = false; return; }
  if (pw !== again) { msg.textContent = "Those two passwords don't match."; msg.hidden = false; return; }
  const { error } = await updatePassword(pw);
  msg.textContent = error ? error.message : "Password updated.";
  msg.classList.toggle("ok", !error);
  msg.hidden = false;
  if (!error) form.reset();
});
