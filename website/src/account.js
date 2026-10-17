import "./base.js";
import { DISCORD_OAUTH_ENABLED, TERMS_VERSION } from "./config.js";
import {
  getSession, onAuthChange, authRedirectTarget, signIn, signUp, magicLink,
  resendVerification, signInWithDiscord, resetPassword, updatePassword, recordConsent,
} from "./auth.js";

const $ = sel => document.querySelector(sel);
const forms = {
  signin: $("#form-signin"),
  signup: $("#form-signup"),
  magic: $("#form-magic"),
  forgot: $("#form-forgot"),
  recovery: $("#form-recovery"),
};
const tabBar = $("#tab-bar");
const errorBox = $("#form-error");
const notice = $("#auth-notice");
const noticeText = $("#notice-text");
const noticeResend = $("#notice-resend");
const title = $("#auth-title");
const sub = $("#auth-sub");

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = !msg;
}
// {type, email} so the "Resend" button can fire the right send again.
let lastEmail = null;
function showNotice(msg, resend) {
  for (const f of Object.values(forms)) f.hidden = true;
  tabBar.hidden = true;
  $("#oauth-divider").hidden = true;
  $("#btn-discord").hidden = true;
  showError("");
  lastEmail = resend ?? null;
  noticeResend.hidden = !lastEmail;
  noticeText.textContent = msg;
  notice.hidden = false;
}
function hideNotice() { notice.hidden = true; }

let mode = "signin";
function setMode(next) {
  mode = next;
  hideNotice();
  showError("");
  const isFormMode = ["signin", "signup", "magic"].includes(next);
  tabBar.hidden = !isFormMode;
  for (const [key, form] of Object.entries(forms)) form.hidden = key !== next;
  document.querySelectorAll(".tab").forEach(t => {
    const active = t.dataset.tab === next;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", String(active));
  });
  title.textContent = { signin: "Welcome back", signup: "Create an account", magic: "Sign in by email", forgot: "Reset your password", recovery: "Choose a new password" }[next];
  sub.textContent = {
    signin: "Sign in to manage your account and Discord link.",
    signup: "One account for your Discord link, and billing later on.",
    magic: "We'll email you a link that signs you straight in.",
    forgot: "Enter the email on your account and we'll send a reset link.",
    recovery: "Almost done. Pick a new password.",
  }[next];
}

tabBar.addEventListener("click", e => {
  const tab = e.target.closest(".tab");
  if (tab) setMode(tab.dataset.tab);
});
$("#forgot-link").addEventListener("click", () => setMode("forgot"));
$("#back-to-signin").addEventListener("click", () => setMode("signin"));
$("#notice-back").addEventListener("click", () => setMode("signin"));
noticeResend.addEventListener("click", async () => {
  if (!lastEmail) return;
  noticeResend.disabled = true;
  const send = { signup: resendVerification, magic: magicLink, forgot: resetPassword }[lastEmail.type];
  const { error } = await send(lastEmail.email);
  noticeResend.disabled = false;
  if (error) return showError(error.message);
  noticeResend.textContent = "Sent again";
});

// ── URL params: recovery mode + OAuth/provider errors ───────────────────────
const params = new URLSearchParams(window.location.search);
const hashParams = new URLSearchParams(window.location.hash.slice(1));
const urlError =
  params.get("error_description") || params.get("error") ||
  hashParams.get("error_description") || hashParams.get("error");
if (urlError) showError(urlError.replace(/\+/g, " "));

// ── Recovery link detection ────────────────────────────────────────────────
// Supabase lands here with tokens in the URL hash; the client exchanges them
// and fires a PASSWORD_RECOVERY event. No event/session within a few seconds
// means the link was expired or already used — say so instead of showing a
// form that can only fail.
const inRecovery = params.get("mode") === "recovery";
let recoveryReady = false;
if (inRecovery) setMode("recovery");

getSession().then(session => {
  if (inRecovery) {
    if (session) recoveryReady = true;
    return;
  }
  if (session) window.location.replace(authRedirectTarget());
});

onAuthChange((event, session) => {
  if (inRecovery && (event === "PASSWORD_RECOVERY" || session)) {
    recoveryReady = true;
    setMode("recovery");
  }
});
if (inRecovery) {
  setTimeout(() => {
    if (recoveryReady || mode !== "recovery") return;
    for (const f of Object.values(forms)) f.hidden = true;
    showError("That reset link is expired or already used. Request a new one below.");
    forms.forgot.hidden = false;
    tabBar.hidden = true;
  }, 3000);
}

// ── OAuth button visibility ────────────────────────────────────────────────
if (DISCORD_OAUTH_ENABLED) {
  $("#oauth-divider").hidden = false;
  $("#btn-discord").hidden = false;
}
$("#btn-discord").addEventListener("click", async () => {
  const { error } = await signInWithDiscord();
  if (error) showError(error.message);
});

// ── Form handlers ──────────────────────────────────────────────────────────
function busy(btn, on) {
  btn.disabled = on;
  btn.dataset.label ??= btn.textContent;
  btn.textContent = on ? "One moment…" : btn.dataset.label;
}

forms.signin.addEventListener("submit", async e => {
  e.preventDefault();
  const btn = e.target.querySelector("[type=submit]");
  const fd = new FormData(e.target);
  busy(btn, true); showError("");
  const { error } = await signIn(fd.get("email").trim(), fd.get("password"));
  busy(btn, false);
  if (error) return showError(error.message === "Invalid login credentials"
    ? "Wrong email or password."
    : error.message);
  window.location.href = authRedirectTarget();
});

forms.signup.addEventListener("submit", async e => {
  e.preventDefault();
  const btn = e.target.querySelector("[type=submit]");
  const fd = new FormData(e.target);
  const email = fd.get("email").trim();
  const password = fd.get("password");
  if (password.length < 8) { showError("Password must be at least 8 characters."); return; }
  if (!fd.get("tos")) { showError("Please agree to the Terms of Service and Privacy Policy first."); return; }
  busy(btn, true); showError("");
  const { data, error } = await signUp(email, password, fd.get("display_name").trim());
  busy(btn, false);
  if (error) return showError(error.message);
  if (data.session) {
    // Immediate-session setups (email confirm off) can record here; confirm-
    // required flows record at the dashboard consent gate on first sign-in.
    recordConsent(TERMS_VERSION).catch(() => {});
    window.location.href = authRedirectTarget(); return;
  }
  showNotice("We sent a verification link to your email. Click it to finish creating your account.",
    { type: "signup", email });
});

forms.magic.addEventListener("submit", async e => {
  e.preventDefault();
  const btn = e.target.querySelector("[type=submit]");
  const fd = new FormData(e.target);
  const email = fd.get("email").trim();
  busy(btn, true); showError("");
  const { error } = await magicLink(email);
  busy(btn, false);
  if (error) return showError(error.message);
  showNotice("We sent a sign-in link to your email. It opens your dashboard in one click.",
    { type: "magic", email });
});

forms.forgot.addEventListener("submit", async e => {
  e.preventDefault();
  const btn = e.target.querySelector("[type=submit]");
  const fd = new FormData(e.target);
  const email = fd.get("email").trim();
  busy(btn, true); showError("");
  const { error } = await resetPassword(email);
  busy(btn, false);
  if (error) return showError(error.message);
  showNotice("If that email is on file, a password reset link is on its way.",
    { type: "forgot", email });
});

forms.recovery.addEventListener("submit", async e => {
  e.preventDefault();
  const btn = e.target.querySelector("[type=submit]");
  const fd = new FormData(e.target);
  const password = fd.get("password");
  if (password.length < 8) { showError("Password must be at least 8 characters."); return; }
  busy(btn, true); showError("");
  const { error } = await updatePassword(password);
  busy(btn, false);
  if (error) return showError(error.message);
  window.location.href = authRedirectTarget();
});
