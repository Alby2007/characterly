import "@fontsource-variable/inter";
import "@fontsource-variable/space-grotesk";
import "./styles.css";
import { LINKS } from "./config.js";
import { getSession, signOut } from "./auth.js";

// ── Inject outbound links from config ─────────────────────────────────────
for (const el of document.querySelectorAll("[data-link]")) {
  const url = LINKS[el.dataset.link];
  if (url) el.setAttribute("href", url);
}

// ── Nav: scrolled state + mobile menu ─────────────────────────────────────
const nav = document.querySelector(".nav");
const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 8);
window.addEventListener("scroll", onScroll, { passive: true });
onScroll();

const toggle = document.querySelector(".nav-toggle");
const mobileMenu = document.getElementById("mobile-menu");
toggle.addEventListener("click", () => {
  const open = toggle.getAttribute("aria-expanded") === "true";
  toggle.setAttribute("aria-expanded", String(!open));
  mobileMenu.hidden = open;
});
mobileMenu.addEventListener("click", e => {
  if (e.target.tagName === "A") {
    toggle.setAttribute("aria-expanded", "false");
    mobileMenu.hidden = true;
  }
});

// ── Sidebar account state ─────────────────────────────────────────────────
// Signed out → a quiet "Sign in" link. Signed in → a user chip to the
// dashboard with an inline sign-out.
const accountSlot = document.getElementById("nav-account");
if (accountSlot) {
  const session = await getSession();
  if (session) {
    const name = session.user.user_metadata?.display_name
      || session.user.email.split("@")[0];
    accountSlot.innerHTML = `
      <a class="user-chip" href="/dashboard.html">
        <span class="user-chip-avatar">${name.charAt(0).toUpperCase()}</span>
        <span class="user-chip-text">
          <span class="user-chip-name">${name}</span><br>
          <span class="user-chip-sub">Account</span>
        </span>
      </a>
      <button class="nav-signout-btn" id="chip-signout" type="button">Sign out</button>`;
    document.getElementById("chip-signout").addEventListener("click", async () => {
      await signOut();
      window.location.href = "/";
    });
  } else {
    accountSlot.innerHTML = `<a class="nav-signin" href="/account.html">Sign in</a>`;
  }
}

// ── Scroll reveal ─────────────────────────────────────────────────────────
const revealIO = new IntersectionObserver(
  entries => entries.forEach(en => en.isIntersecting && en.target.classList.add("in")),
  { threshold: 0.12 },
);
document.querySelectorAll(".reveal").forEach(el => revealIO.observe(el));

// ── Mock Discord scene ────────────────────────────────────────────────────
// A short looping scene that sells the core pitch: companions speak under
// their own names/avatars, remember things, and banter with each other.
const AVATARS = {
  alice: { label: "A", bg: "linear-gradient(135deg,#f8a56c,#e05f7e)" },
  nyx: { label: "N", bg: "linear-gradient(135deg,#5865f2,#9b5cf8)" },
  kael: { label: "K", bg: "linear-gradient(135deg,#34b89a,#3aa7e0)" },
  ben: { label: "B", bg: "linear-gradient(135deg,#e0b23a,#e0783a)" },
};

const SCENE = [
  { who: "alice", name: "Alice", text: 'nyx did you tell <span class="mention">@ben</span> about the tea thing', time: "9:41 PM" },
  { who: "nyx", name: "Nyx", tag: "COMPANION", text: "i wrote it in my journal, actually. 'leaf water incident, day 3.' it's canon now", time: "9:41 PM" },
  { who: "ben", name: "Ben", text: "i feel like i'm being gossiped about", time: "9:42 PM" },
  { who: "kael", name: "Kael", tag: "COMPANION", text: "you are. i've heard the whole saga. twice.", time: "9:42 PM" },
  { who: "nyx", name: "Nyx", tag: "COMPANION", text: 'kael you weren\'t even summoned when it happened — who told you??', time: "9:43 PM" },
  { who: "kael", name: "Kael", tag: "COMPANION", text: "companions talk. ben's companion mentioned it in a server digest", time: "9:43 PM" },
];

const chatBody = document.getElementById("chat-body");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function msgEl(m) {
  const a = AVATARS[m.who];
  const div = document.createElement("div");
  div.className = "chat-msg";
  div.innerHTML = `
    <div class="chat-avatar" style="background:${a.bg}">${a.label}</div>
    <div>
      <div class="chat-meta">
        <span class="chat-name">${m.name}</span>
        ${m.tag ? `<span class="chat-tag">${m.tag}</span>` : ""}
        <span class="chat-time">${m.time}</span>
      </div>
      <div class="chat-text">${m.text}</div>
    </div>`;
  return div;
}

function typingEl(who) {
  const a = AVATARS[who];
  const div = document.createElement("div");
  div.className = "chat-msg";
  div.innerHTML = `
    <div class="chat-avatar" style="background:${a.bg}">${a.label}</div>
    <div class="typing" aria-hidden="true"><i></i><i></i><i></i></div>`;
  return div;
}

const wait = ms => new Promise(r => setTimeout(r, ms));

async function playScene() {
  if (reduceMotion) {
    // Static snapshot — the whole scene, no motion.
    chatBody.replaceChildren(...SCENE.map(msgEl));
    return;
  }
  chatBody.replaceChildren();
  for (const m of SCENE) {
    const t = typingEl(m.who);
    chatBody.appendChild(t);
    await wait(750 + Math.random() * 500);
    t.replaceWith(msgEl(m));
    await wait(500);
  }
  await wait(6000);
  playScene();
}

if (chatBody) playScene();
