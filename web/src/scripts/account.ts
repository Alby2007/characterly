// /account: Discord sign-in first, email modes second. Ported from
// website/src/account.js. New: ?start=discord begins the Discord sign-in on
// load, so every "Continue with Discord" button on the site is a plain link.
import {
  getSession, onAuthChange, authRedirectTarget, signIn, signUp, magicLink,
  resendVerification, signInWithDiscord, resetPassword, updatePassword, recordConsent, beacon,
} from "./auth";
import { TERMS_VERSION } from "../lib/config";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
type Mode = "signin" | "signup" | "magic" | "forgot" | "recovery";
const forms: Record<Mode, HTMLFormElement> = {
  signin: $("#form-signin"), signup: $("#form-signup"), magic: $("#form-magic"),
  forgot: $("#form-forgot"), recovery: $("#form-recovery"),
};
const tabBar = $("#tab-bar");
const errorBox = $("#form-error");
const notice = $("#auth-notice");
const noticeText = $("#notice-text");
const noticeResend = $<HTMLButtonElement>("#notice-resend");
const title = $("#auth-title");
const sub = $("#auth-sub");
const discordBlock = $("#discord-block");
const orDivider = $("#or-divider");
const discordBtn = $<HTMLButtonElement>("#btn-discord");

const showError = (msg: string) => { errorBox.textContent = msg; errorBox.hidden = !msg; };

let lastEmail: { type: "signup" | "magic" | "forgot"; email: string } | null = null;
function showNotice(msg: string, resend?: { type: "signup" | "magic" | "forgot"; email: string }) {
  for (const f of Object.values(forms)) f.hidden = true;
  tabBar.hidden = true;
  discordBlock.hidden = true;
  orDivider.hidden = true;
  noticeText.textContent = msg;
  lastEmail = resend ?? null;
  noticeResend.hidden = !resend;
  noticeResend.disabled = false;
  noticeResend.textContent = "Resend the email";
  notice.hidden = false;
}

const COPY: Record<Mode, [string, string]> = {
  signin: ["Sign in", "Use your Discord account. It's the fastest way in, and it links your companions to your account straight away."],
  signup: ["Create an account", "Prefer email? You can link Discord afterwards from your dashboard."],
  magic: ["Sign in by email", "We'll email you a link that signs you straight in."],
  forgot: ["Reset your password", "Enter the email on your account and we'll send a reset link."],
  recovery: ["Choose a new password", "Almost done. Pick a new password."],
};

let mode: Mode = "signin";
function setMode(next: Mode, focusTab = false) {
  mode = next;
  notice.hidden = true;
  showError("");
  const isTab = next === "signin" || next === "signup" || next === "magic";
  tabBar.hidden = !isTab;
  discordBlock.hidden = !isTab;
  orDivider.hidden = !isTab;
  for (const [key, form] of Object.entries(forms)) form.hidden = key !== next;
  for (const t of tabBar.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
    const on = t.dataset.tab === next;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    if (on && focusTab) t.focus();
  }
  [title.textContent, sub.textContent] = COPY[next];
}

const tabOrder: Mode[] = ["signin", "signup", "magic"];
tabBar.addEventListener("click", e => {
  const tab = (e.target as Element).closest<HTMLButtonElement>('[role="tab"]');
  if (tab) setMode(tab.dataset.tab as Mode);
});
tabBar.addEventListener("keydown", e => {
  const i = tabOrder.indexOf(mode);
  const n = e.key === "ArrowRight" ? (i + 1) % 3 : e.key === "ArrowLeft" ? (i + 2) % 3 : -1;
  if (n >= 0) { e.preventDefault(); setMode(tabOrder[n], true); }
});
$("#forgot-link").addEventListener("click", () => setMode("forgot"));
$("#back-to-signin").addEventListener("click", () => setMode("signin"));
$("#notice-back").addEventListener("click", () => setMode("signin"));
noticeResend.addEventListener("click", async () => {
  if (!lastEmail) return;
  noticeResend.disabled = true;
  const send = { signup: resendVerification, magic: magicLink, forgot: resetPassword }[lastEmail.type];
  const { error } = await send(lastEmail.email);
  if (error) { noticeResend.disabled = false; return showError(error.message); }
  noticeResend.textContent = "Sent again";
});

// ── Discord ────────────────────────────────────────────────────────────────
async function startDiscord() {
  discordBtn.disabled = true;
  discordBtn.querySelector("span")!.textContent = "Opening Discord…";
  const { error } = await signInWithDiscord(authRedirectTarget());
  if (error) {
    discordBtn.disabled = false;
    discordBtn.querySelector("span")!.textContent = "Continue with Discord";
    showError(`Couldn't reach Discord: ${error.message}`);
  }
}
discordBtn.addEventListener("click", () => { beacon("discord_signin_click"); startDiscord(); });

// ── URL params: recovery mode, provider errors, ?start=discord ─────────────
const params = new URLSearchParams(location.search);
const hashParams = new URLSearchParams(location.hash.slice(1));
const urlError = params.get("error_description") || params.get("error") || hashParams.get("error_description") || hashParams.get("error");
if (urlError) showError(urlError.replace(/\+/g, " "));

// Supabase lands recovery links here with tokens in the hash and fires
// PASSWORD_RECOVERY. No event or session within a few seconds means the link
// was expired or already used: say so instead of showing a form that fails.
const inRecovery = params.get("mode") === "recovery";
let recoveryReady = false;
if (inRecovery) setMode("recovery");

getSession().then(session => {
  if (inRecovery) { if (session) recoveryReady = true; return; }
  if (session) { location.replace(authRedirectTarget()); return; }
  if (params.get("start") === "discord" && !urlError) startDiscord();
});
onAuthChange((event, session) => {
  if (inRecovery && (event === "PASSWORD_RECOVERY" || session)) { recoveryReady = true; setMode("recovery"); }
});
if (inRecovery) {
  setTimeout(() => {
    if (recoveryReady || mode !== "recovery") return;
    setMode("forgot");
    showError("That reset link has expired or was already used. Request a new one below.");
  }, 3000);
}

// ── Email forms ────────────────────────────────────────────────────────────
function busy(btn: HTMLButtonElement, on: boolean) {
  btn.disabled = on;
  btn.dataset.label ??= btn.textContent ?? "";
  btn.textContent = on ? "One moment…" : btn.dataset.label;
}
const submitOf = (f: HTMLFormElement) => f.querySelector<HTMLButtonElement>("[type=submit]")!;
const val = (fd: FormData, k: string) => String(fd.get(k) ?? "");

forms.signin.addEventListener("submit", async e => {
  e.preventDefault();
  const fd = new FormData(forms.signin);
  const btn = submitOf(forms.signin);
  busy(btn, true); showError("");
  const { error } = await signIn(val(fd, "email").trim(), val(fd, "password"));
  busy(btn, false);
  if (error) return showError(error.message === "Invalid login credentials" ? "That email and password don't match. Check both, or reset your password." : error.message);
  location.href = authRedirectTarget();
});

forms.signup.addEventListener("submit", async e => {
  e.preventDefault();
  const fd = new FormData(forms.signup);
  const btn = submitOf(forms.signup);
  const email = val(fd, "email").trim();
  const password = val(fd, "password");
  if (password.length < 8) return showError("Your password needs at least 8 characters.");
  if (!fd.get("tos")) return showError("Tick the box to agree to the Terms of Service and Privacy Policy first.");
  busy(btn, true); showError("");
  beacon("signup_start");
  const { data, error } = await signUp(email, password, val(fd, "display_name").trim());
  busy(btn, false);
  if (error) return showError(error.message);
  beacon("signup_done");
  if (data.session) {
    // Email confirmation off: record consent now. Confirm-required flows
    // record it at the dashboard consent gate on first sign-in.
    recordConsent(TERMS_VERSION).then(() => {}, () => {});
    location.href = authRedirectTarget();
    return;
  }
  showNotice(`We sent a verification link to ${email}. Open it to finish creating your account.`, { type: "signup", email });
});

forms.magic.addEventListener("submit", async e => {
  e.preventDefault();
  const fd = new FormData(forms.magic);
  const btn = submitOf(forms.magic);
  const email = val(fd, "email").trim();
  busy(btn, true); showError("");
  const { error } = await magicLink(email);
  busy(btn, false);
  if (error) return showError(error.message);
  showNotice(`We sent a sign-in link to ${email}. It opens your dashboard in one click.`, { type: "magic", email });
});

forms.forgot.addEventListener("submit", async e => {
  e.preventDefault();
  const fd = new FormData(forms.forgot);
  const btn = submitOf(forms.forgot);
  const email = val(fd, "email").trim();
  busy(btn, true); showError("");
  const { error } = await resetPassword(email);
  busy(btn, false);
  if (error) return showError(error.message);
  showNotice("If that email is on file, a password reset link is on its way.", { type: "forgot", email });
});

forms.recovery.addEventListener("submit", async e => {
  e.preventDefault();
  const fd = new FormData(forms.recovery);
  const btn = submitOf(forms.recovery);
  const password = val(fd, "password");
  if (password.length < 8) return showError("Your password needs at least 8 characters.");
  busy(btn, true); showError("");
  const { error } = await updatePassword(password);
  busy(btn, false);
  if (error) return showError(error.message);
  location.href = authRedirectTarget();
});
