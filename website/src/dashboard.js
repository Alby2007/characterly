import "@fontsource-variable/inter";
import "@fontsource-variable/space-grotesk";
import "./styles.css";
import { LINKS, DISCORD_OAUTH_ENABLED } from "./config.js";
import { supabase } from "./supabase.js";
import {
  requireAuth, getProfile, updateDisplayName,
  updatePassword, deleteAccount, signOut, signInWithDiscord,
} from "./auth.js";

for (const el of document.querySelectorAll("[data-link]")) {
  const url = LINKS[el.dataset.link];
  if (url) el.setAttribute("href", url);
}

const $ = sel => document.querySelector(sel);

const session = await requireAuth();
if (!session) throw new Error("redirecting");
const user = session.user;

// ── Profile ────────────────────────────────────────────────────────────────
const profile = await getProfile(user.id).catch(() => null);
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
const discordIdentity = (user.identities ?? []).find(i => i.provider === "discord");
if (discordIdentity) {
  $("#discord-badge").textContent = "Linked";
  $("#discord-badge").className = "badge badge-ok";
  $("#discord-linked").hidden = false;
  $("#discord-note").hidden = true;
  const d = discordIdentity.identity_data ?? {};
  $("#discord-name").textContent = d.full_name || d.name || d.custom_claims?.global_name || "Discord user";
  $("#discord-avatar").textContent = ($("#discord-name").textContent).charAt(0).toUpperCase();
} else if (DISCORD_OAUTH_ENABLED) {
  $("#discord-note").hidden = true;
  $("#btn-link-discord").hidden = false;
  $("#btn-link-discord").addEventListener("click", () => signInWithDiscord());
}

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
  await signOut();
  window.location.href = "/";
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
  await signOut();
  window.location.href = "/";
});
