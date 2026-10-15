import "@fontsource-variable/inter";
import "@fontsource-variable/space-grotesk";
import "./styles.css";
import { LINKS, DISCORD_OAUTH_ENABLED } from "./config.js";
import { supabase } from "./supabase.js";
import {
  requireAuth, getProfile, updateDisplayName,
  updatePassword, deleteAccount, signOut,
  linkDiscord, getIdentities, unlinkDiscord, unlinkDiscordLink, claimLinkCode,
} from "./auth.js";

for (const el of document.querySelectorAll("[data-link]")) {
  const url = LINKS[el.dataset.link];
  if (url) el.setAttribute("href", url);
}

const $ = sel => document.querySelector(sel);

const user = await requireAuth();
if (!user) throw new Error("redirecting");

// ── Profile ────────────────────────────────────────────────────────────────
let profile = await getProfile(user.id).catch(() => null);
const displayName = profile?.display_name || user.user_metadata?.display_name || user.email.split("@")[0];

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
});

await renderDiscordCard();

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
$("#nav-signout").addEventListener("click", async () => {
  try { await signOut(); } finally { window.location.href = "/"; }
});

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
