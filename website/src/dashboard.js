import "./base.js";
import { supabase } from "./supabase.js";
import { DISCORD_OAUTH_ENABLED, TERMS_VERSION } from "./config.js";
import {
  requireAuth, getProfile, updateDisplayName,
  updatePassword, deleteAccount, signOut,
  linkDiscord, getIdentities, unlinkDiscord, unlinkDiscordLink, claimLinkCode, withTimeout,
  getBotSettings, saveBotSettings, getByokStatus, getCreditLedger, ensureConsent,
} from "./auth.js";
import { initImportCard } from "./import-card.js";
import { initImportHistory } from "./import-history.js";

const $ = sel => document.querySelector(sel);
const guard = (p, ms = 8000) => withTimeout(p, ms).catch(e => console.warn("dashboard section failed:", e));

const user = await requireAuth();
if (!user) throw new Error("redirecting");

// Clickwrap gate — OAuth + magic-link signups never see the email form's
// checkbox, so acceptance is captured here on the first authed visit. Holds
// rendering until consent is recorded (sign-out is the escape hatch).
$("#consent-signout").addEventListener("click", async () => {
  try { await signOut(); } finally { window.location.href = "/"; }
});
await ensureConsent(TERMS_VERSION);

// Wired FIRST: nothing below (network-bound renders) may be able to leave
// sign-out / delete inert by hanging or throwing.
// ── Sign out ───────────────────────────────────────────────────────────────
for (const btn of [$("#nav-signout"), $("#nav-signout-mobile")]) {
  btn.addEventListener("click", async () => {
    try { await signOut(); } finally { window.location.href = "/"; }
  });
}

// ── Delete account ─────────────────────────────────────────────────────────
const modal = $("#delete-modal");
const confirmInput = $("#delete-confirm");
const deleteBtn = $("#delete-do");

const deleteErr = $("#delete-error");

$("#btn-delete").addEventListener("click", () => {
  modal.hidden = false;
  confirmInput.value = "";
  deleteBtn.disabled = true;
  deleteErr.hidden = true;
  confirmInput.focus();
});
$("#delete-cancel").addEventListener("click", () => { modal.hidden = true; });
modal.addEventListener("click", e => { if (e.target === modal) modal.hidden = true; });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !modal.hidden) modal.hidden = true; });
confirmInput.addEventListener("input", () => {
  deleteBtn.disabled = confirmInput.value.trim().toUpperCase() !== "DELETE";
});
deleteBtn.addEventListener("click", async () => {
  deleteBtn.disabled = true;
  deleteErr.hidden = true;
  // Bound the rpc: a hung request (e.g. queued behind a wedged auth lock)
  // must surface, not sit silently. A retry is safe — deleting an
  // already-deleted user is a no-op that returns success.
  const { error } = await withTimeout(deleteAccount(), 10000, "Delete").catch(e => ({ error: e }));
  if (error) {
    deleteErr.textContent = error.message ?? "Delete failed — try again.";
    deleteErr.hidden = false;
    deleteBtn.disabled = false;
    return;
  }
  // Account is gone server-side. signOut clears local keys synchronously
  // and never waits on the network, so navigation is instant either way.
  await signOut();
  window.location.href = "/";
});


// ── Profile ────────────────────────────────────────────────────────────────
let profile = await withTimeout(getProfile(user.id), 8000).catch(() => null);
const displayName = profile?.display_name || user.user_metadata?.display_name || user.email.split("@")[0];

const hour = new Date().getHours();
$("#dash-greeting").textContent = hour < 5 ? "Up late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
$("#dash-name").textContent = displayName;
$("#profile-email").textContent = user.email;
$("#profile-avatar").textContent = displayName.charAt(0).toUpperCase();
$("#input-name").value = displayName;
$("#profile-since").textContent = `Member since ${new Date(user.created_at).toLocaleDateString(undefined, { month: "long", year: "numeric" })}`;

$("#form-name").addEventListener("submit", async e => {
  e.preventDefault();
  const err = $("#profile-error");
  err.hidden = true;
  const name = $("#input-name").value.trim();
  try {
    await updateDisplayName(user.id, name);
    $("#dash-name").textContent = name || user.email.split("@")[0];
    $("#profile-avatar").textContent = (name || "C").charAt(0).toUpperCase();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

// ── Discord identity ───────────────────────────────────────────────────────
// OAuth errors return on the redirect URL — either as query params or in the
// hash fragment (implicit flow), so check both and surface them.
const urlParams = new URLSearchParams(window.location.search);
const hashParams = new URLSearchParams(window.location.hash.slice(1));
const oauthError = urlParams.get("error_description") || hashParams.get("error_description")
  || urlParams.get("error") || hashParams.get("error");
if (oauthError) {
  const el = $("#discord-error");
  el.textContent = decodeURIComponent(oauthError).replace(/\+/g, " ");
  el.hidden = false;
  history.replaceState(null, "", window.location.pathname);
}

function showDiscordError(message) {
  const el = $("#discord-error");
  el.textContent = message;
  el.hidden = false;
}

async function renderDiscordCard() {
  const { data } = await getIdentities();
  const identities = data?.identities ?? [];
  const discordIdentity = identities.find(i => i.provider === "discord");
  // Two link paths: an OAuth identity, or a /link code that stamped
  // web_profiles.discord_user_id without creating an identity row.
  const codeLinkedId = profile?.discord_user_id;
  if (discordIdentity || codeLinkedId) {
    $("#discord-badge").textContent = "Linked";
    $("#discord-badge").className = "badge badge-ok";
    $("#discord-linked").hidden = false;
    $("#discord-unlinked").hidden = true;
    if (discordIdentity) {
      const d = discordIdentity.identity_data ?? {};
      $("#discord-name").textContent = d.full_name || d.name || d.custom_claims?.global_name || "Discord user";
      $("#discord-sub").textContent = "Linked via Discord";
      if (typeof d.avatar_url === "string" && d.avatar_url.startsWith("https://")) {
        $("#discord-avatar").innerHTML = "";
        const img = document.createElement("img");
        img.src = d.avatar_url;
        img.alt = "";
        $("#discord-avatar").append(img);
      } else {
        $("#discord-avatar").innerHTML = "";
        $("#discord-avatar").textContent = $("#discord-name").textContent.charAt(0).toUpperCase();
      }
    } else {
      // Code-linked lane: the bot snapshots username/avatar onto the code at
      // /link time and claim_link_code stamps them onto web_profiles. Rows
      // linked before v38 stay blank until the bot's boot backfill heals them.
      const name = typeof profile?.discord_username === "string" && profile.discord_username
        ? profile.discord_username : "Discord account";
      $("#discord-name").textContent = name;
      $("#discord-sub").textContent = `Linked via code — ID ${codeLinkedId}`;
      $("#discord-avatar").innerHTML = "";
      const av = profile?.discord_avatar_url;
      if (typeof av === "string" && av.startsWith("https://")) {
        const img = document.createElement("img");
        img.src = av;
        img.alt = "";
        $("#discord-avatar").append(img);
      } else {
        $("#discord-avatar").textContent = (name || "#").charAt(0).toUpperCase();
      }
    }
    const doUnlink = discordIdentity
      ? async () => {
          // Supabase refuses to unlink a user's last identity, but the UI
          // still explains the escape hatch instead of silently hiding it.
          if (identities.length < 2) return;
          if (!confirm("Unlink your Discord account? Subscription perks tied to it will stop applying.")) return;
          const { error } = await unlinkDiscord(discordIdentity);
          if (error) return showDiscordError(error.message);
        }
      : async () => {
          if (!confirm("Unlink your Discord account? Subscription perks tied to it will stop applying.")) return;
          const { error } = await unlinkDiscordLink();
          if (error) return showDiscordError(error.message);
        };
    const canUnlink = discordIdentity ? identities.length >= 2 : true;
    $("#btn-unlink-discord").hidden = !canUnlink;
    $("#discord-unlink-note").hidden = canUnlink;
    $("#btn-unlink-discord").onclick = async () => {
      await doUnlink();
      profile = await getProfile(user.id).catch(() => profile);
      await renderDiscordCard();
      await renderTokens();
      await renderBotSettings();
    };
  } else {
    $("#discord-badge").textContent = "Not linked";
    $("#discord-badge").className = "badge badge-soon";
    $("#discord-linked").hidden = true;
    $("#discord-unlinked").hidden = false;
    if (DISCORD_OAUTH_ENABLED) $("#btn-link-discord").hidden = false;
  }
}

$("#btn-link-discord").addEventListener("click", async () => {
  const { error } = await linkDiscord();
  if (error) {
    const el = $("#discord-error");
    el.textContent = error.message;
    el.hidden = false;
  }
});

$("#form-link-code").addEventListener("submit", async e => {
  e.preventDefault();
  const msg = $("#link-code-msg");
  msg.hidden = true; msg.classList.remove("ok");
  const code = $("#input-link-code").value.trim();
  if (!code) return;
  const { error } = await claimLinkCode(code);
  if (error) {
    // rpc raises "tag: message" — show just the message half.
    msg.textContent = error.message.includes(":") ? error.message.split(":").slice(1).join(":").trim() : error.message;
    msg.hidden = false;
    return;
  }
  $("#input-link-code").value = "";
  profile = await getProfile(user.id).catch(() => profile);
  await renderDiscordCard();
  await renderTokens();
  await renderBotSettings();
});

await guard(renderDiscordCard());
renderBilling();

// Back from Stripe checkout — the webhook does the crediting (seconds, not
// instant); surface a heads-up rather than pretending the balance moved.
if (new URLSearchParams(location.search).get("checkout")) {
  $("#billing-note").textContent = "Payment complete — your account updates in a few seconds. Refresh if it hasn't yet.";
  history.replaceState(null, "", location.pathname);
}
// ── Tokens + companion settings ──────────────────────────────────────────────
// Tokens are the user-facing name for hosted-lane credits. Balance/plan live
// on the profile row; settings + BYOK state come from rpcs that stamp the
// caller's own discord_user_id server-side.
const LEDGER_LABELS = { grant_daily: "Daily refill", grant_weekly: "Weekly refill", purchase: "Token pack", refund: "Refund", adjust: "Adjustment" };
const REASON_LABELS = { dm_turn: "DM chat", guild_turn: "Server chat", c2c: "Companion chat", dm_turn_refund: "Chat refund", guild_turn_refund: "Chat refund" };

// Checkout sessions are minted by the create-checkout edge function — it
// checks plan server-side and forces client_reference_id to the caller's own
// account. The old public payment links are deactivated: they couldn't gate
// packs behind Premium or stop a premium user buying a second subscription.
// Product↔token mapping lives in supabase/functions/stripe-webhook — keep in
// sync there.
async function openCheckout(product, btn) {
  const msg = $("#billing-msg");
  msg.hidden = true;
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "Opening checkout…";
  try {
    const { data, error } = await supabase.functions.invoke("create-checkout", { body: { product } });
    if (error || !data?.url) {
      // Non-2xx bodies carry the real reason — FunctionsHttpError parks the
      // raw Response on .context; parse it before falling back.
      let detail = error?.message ?? "checkout failed";
      try { detail = (await error?.context?.json())?.error ?? detail; } catch { /* keep generic */ }
      throw new Error(detail);
    }
    window.location.href = data.url;
  } catch (e) {
    msg.textContent = `Couldn't start checkout — ${e.message}. Try again in a moment.`;
    msg.hidden = false;
    btn.disabled = false;
    btn.textContent = label;
  }
}
for (const [sel, product] of [["#btn-subscribe", "premium"], ["#btn-subscribe-yearly", "premium_yearly"], ["#btn-pack-750", "pack_750"], ["#btn-pack-2500", "pack_2500"], ["#btn-pack-7500", "pack_7500"]]) {
  $(sel).addEventListener("click", () => { if (!$(sel).disabled) openCheckout(product, $(sel)); });
}

function renderBilling() {
  const premium = profile?.plan === "premium";
  $("#billing-plan").textContent = premium ? "Premium" : "Free";
  $("#billing-plan").className = premium ? "badge badge-ok" : "badge badge-soon";
  // A premium user must NOT get another subscription checkout — create-checkout
  // 409s on one anyway, but both buttons stay visibly off.
  const btn = $("#btn-subscribe");
  btn.classList.toggle("btn-ghost", premium);
  btn.disabled = premium;
  btn.textContent = premium ? "Premium — active" : "Go Premium — $7.99/mo";
  const yearly = $("#btn-subscribe-yearly");
  yearly.disabled = premium;
  yearly.hidden = premium;
  // Packs are a Premium perk — free accounts get dead buttons, and the
  // function 403s them even if they call it directly.
  for (const sel of ["#btn-pack-750", "#btn-pack-2500", "#btn-pack-7500"]) $(sel).disabled = !premium;
  $("#pack-note").hidden = premium;
}

// The daily grant tops the balance back up to the plan amount on the first
// chat after UTC midnight — the countdown to that boundary is the actionable
// "when", so render it live rather than restating "refills daily".
const nextRefillAt = () => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d; };
const fmtCountdown = ms => {
  const m = Math.max(0, Math.ceil(ms / 60000));
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
};
let grantTimer = null;
function renderGrantLine() {
  const premium = profile?.plan === "premium";
  const wait = fmtCountdown(nextRefillAt() - Date.now());
  $("#tokens-grant").textContent = premium
    ? `Premium refills to 150 tokens each UTC day — next refill in ${wait} (00:00 UTC).`
    : `Your free allowance refills to 30 tokens each UTC day — next refill in ${wait} (00:00 UTC).`;
}

async function renderTokens() {
  const linked = Boolean(profile?.discord_user_id);
  $("#tokens-body").hidden = !linked;
  $("#tokens-locked").hidden = linked;
  if (!linked) return;
  const premium = profile.plan === "premium";
  $("#tokens-plan").textContent = premium ? "Premium" : "Free";
  $("#tokens-plan").className = premium ? "badge badge-ok" : "badge badge-soon";
  $("#tokens-balance").textContent = Number(profile.credit_balance ?? 0).toLocaleString();
  renderGrantLine();
  if (!grantTimer) grantTimer = setInterval(renderGrantLine, 30_000);
  const ul = $("#tokens-ledger");
  ul.innerHTML = "";
  const { data: ledger } = await getCreditLedger(8).catch(() => ({ data: null }));
  for (const row of ledger ?? []) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = row.kind === "spend"
      ? (REASON_LABELS[row.reason] ?? "Chat")
      : (LEDGER_LABELS[row.kind] ?? row.kind);
    const delta = document.createElement("span");
    delta.textContent = `${row.delta > 0 ? "+" : ""}${row.delta}`;
    delta.className = row.delta > 0 ? "pos" : "neg";
    li.append(label, delta);
    ul.append(li);
  }
}

async function renderBotSettings() {
  const { data: s } = await getBotSettings().catch(() => ({ data: null }));
  const linked = Boolean(s?.linked ?? profile?.discord_user_id);
  $("#botset-controls").hidden = !linked;
  $("#botset-locked").hidden = linked;
  if (!linked) return;
  $("#set-c2c").checked = s?.c2c_enabled !== false;
  $("#set-alerts").checked = s?.low_credit_alerts !== false;
  const { data: byok } = await getByokStatus().catch(() => ({ data: null }));
  $("#byok-status").textContent = byok?.has_key
    ? `Personal AI key connected${byok.validated_at ? " · verified" : ""} — your chats don't spend tokens.`
    : "No personal key — your chats spend hosted tokens.";
}

for (const [sel, key] of [["#set-c2c", "c2c_enabled"], ["#set-alerts", "low_credit_alerts"]]) {
  $(sel).addEventListener("change", async e => {
    const msg = $("#botset-msg");
    msg.hidden = true;
    const { error } = await saveBotSettings({ [key]: e.target.checked });
    if (error) {
      e.target.checked = !e.target.checked;
      msg.textContent = error.message;
      msg.hidden = false;
    }
  });
}

await guard(renderTokens());
await guard(renderBotSettings());
initImportCard({ linked: Boolean(profile?.discord_user_id), uid: user.id });
initImportHistory({ linked: Boolean(profile?.discord_user_id), uid: user.id });

// ── Password change ────────────────────────────────────────────────────────
$("#form-password").addEventListener("submit", async e => {
  e.preventDefault();
  const msg = $("#security-msg");
  const fd = new FormData(e.target);
  const [pw, confirm] = [fd.get("password"), fd.get("confirm")];
  msg.hidden = true; msg.classList.remove("ok");
  if (pw.length < 8) { msg.textContent = "Password must be at least 8 characters."; msg.hidden = false; return; }
  if (pw !== confirm) { msg.textContent = "Passwords don't match."; msg.hidden = false; return; }
  const { error } = await updatePassword(pw);
  msg.textContent = error ? error.message : "Password updated.";
  msg.classList.toggle("ok", !error);
  msg.hidden = false;
  if (!error) e.target.reset();
});
