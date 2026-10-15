import "./base.js";
import { DISCORD_OAUTH_ENABLED } from "./config.js";
import {
  requireAuth, getProfile, updateDisplayName,
  updatePassword, deleteAccount, signOut,
  linkDiscord, getIdentities, unlinkDiscord, unlinkDiscordLink, claimLinkCode,
  getBotSettings, saveBotSettings, getByokStatus, getCreditLedger,
} from "./auth.js";

const $ = sel => document.querySelector(sel);

const user = await requireAuth();
if (!user) throw new Error("redirecting");

// ── Profile ────────────────────────────────────────────────────────────────
let profile = await getProfile(user.id).catch(() => null);
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
      $("#discord-name").textContent = "Discord account";
      $("#discord-sub").textContent = `Linked via code — ID ${codeLinkedId}`;
      $("#discord-avatar").innerHTML = "";
      $("#discord-avatar").textContent = "#";
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

await renderDiscordCard();

// ── Tokens + companion settings ──────────────────────────────────────────────
// Tokens are the user-facing name for hosted-lane credits. Balance/plan live
// on the profile row; settings + BYOK state come from rpcs that stamp the
// caller's own discord_user_id server-side.
const LEDGER_LABELS = { grant_daily: "Daily refill", grant_weekly: "Weekly refill", refund: "Refund", adjust: "Adjustment" };
const REASON_LABELS = { dm_turn: "DM chat", guild_turn: "Server chat", c2c: "Companion chat", dm_turn_refund: "Chat refund", guild_turn_refund: "Chat refund" };

async function renderTokens() {
  const linked = Boolean(profile?.discord_user_id);
  $("#tokens-body").hidden = !linked;
  $("#tokens-locked").hidden = linked;
  if (!linked) return;
  const premium = profile.plan === "premium";
  $("#tokens-plan").textContent = premium ? "Premium" : "Free";
  $("#tokens-plan").className = premium ? "badge badge-ok" : "badge badge-soon";
  $("#tokens-balance").textContent = Number(profile.credit_balance ?? 0).toLocaleString();
  $("#tokens-grant").textContent = premium
    ? "Daily top-up plus a weekly refill — applied automatically as you chat."
    : "Your free allowance refills each UTC day — applied automatically as you chat.";
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

await renderTokens();
await renderBotSettings();

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

$("#btn-delete").addEventListener("click", () => {
  modal.hidden = false;
  confirmInput.value = "";
  deleteBtn.disabled = true;
  confirmInput.focus();
});
$("#delete-cancel").addEventListener("click", () => { modal.hidden = true; });
modal.addEventListener("click", e => { if (e.target === modal) modal.hidden = true; });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !modal.hidden) modal.hidden = true; });
confirmInput.addEventListener("input", () => { deleteBtn.disabled = confirmInput.value !== "DELETE"; });
deleteBtn.addEventListener("click", async () => {
  deleteBtn.disabled = true;
  const { error } = await deleteAccount();
  if (error) {
    alert(error.message);
    deleteBtn.disabled = false;
    return;
  }
  try { await signOut(); } finally { window.location.href = "/"; }
});
