import "./base.js";
import { getSession, signOut } from "./auth.js";

const h = (tag, props = {}, ...children) => {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
};

// ── Nav account state ─────────────────────────────────────────────────────
// Signed out → a quiet "Sign in" link. Signed in → initial + name linking to
// the dashboard, with an inline sign-out. Built with DOM nodes, never
// innerHTML: display_name is user-supplied.
const session = await getSession();
const name = session && (session.user.user_metadata?.display_name || session.user.email.split("@")[0]);
const doSignOut = async () => { try { await signOut(); } finally { window.location.href = "/"; } };

for (const slot of document.querySelectorAll("[data-account-slot]")) {
  if (!session) {
    slot.replaceChildren(h("a", { className: "nav-signin", href: "/account", textContent: "Sign in" }));
    continue;
  }
  const chip = h("a", { className: "user-chip", href: "/dashboard" },
    h("span", { className: "user-chip-avatar", textContent: name.charAt(0).toUpperCase() }),
    h("span", { className: "user-chip-name", textContent: name }));
  const out = h("button", { className: "nav-signout-btn", type: "button", textContent: "Sign out" });
  out.addEventListener("click", doSignOut);
  slot.replaceChildren(chip, out);
}
const mobileAccount = document.querySelector("[data-account-mobile]");
if (mobileAccount && session) {
  mobileAccount.textContent = "Your account";
  mobileAccount.href = "/dashboard";
}

// ── The scene ─────────────────────────────────────────────────────────────
// A short loop that shows the pitch: a companion arriving, speaking under its
// own name, keeping a journal, and keeping DM confidences.
const PEOPLE = {
  alice: { name: "Alice", bg: "#6e4536" },
  ben: { name: "Ben", bg: "#3c4a57" },
  nyx: { name: "Nyx", companion: true },
  kael: { name: "Kael", companion: true },
};

const SCENE = [
  { sys: "Kael" },
  { who: "alice", time: "21:41", html: 'nyx did you tell <span class="mention">@Ben</span> about the tea thing' },
  { who: "nyx", time: "21:41", html: "i wrote it down. “leaf water incident, day three.” it’s canon now" },
  { who: "ben", time: "21:42", html: "i feel like i’m being talked about" },
  { who: "kael", time: "21:42", html: "you are. i heard the whole saga last night" },
  { who: "nyx", time: "21:43", html: "kael you weren’t even here for that" },
  { who: "kael", time: "21:43", html: "ben tells me everything. well. almost everything" },
];

const avatar = p => h("div", {
  className: `msg-av${p.companion ? " companion" : ""}`,
  textContent: p.name[0],
  style: p.companion ? "" : `background:${p.bg}`,
});

function lineEl(line) {
  if (line.sys) {
    const el = h("div", { className: "sys" });
    el.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M1 7h10M7.5 3.5 11 7l-3.5 3.5"/></svg>';
    el.append(h("span", {}, "System · ", h("b", { textContent: line.sys }), " joined the chat"));
    return el;
  }
  const p = PEOPLE[line.who];
  const meta = h("div", { className: "msg-meta" },
    h("span", { className: `msg-name${p.companion ? " companion" : ""}`, textContent: p.name }));
  if (p.companion) meta.append(h("span", { className: "msg-tag", textContent: "COMPANION" }));
  meta.append(h("span", { className: "msg-time", textContent: line.time }));
  const text = h("div", { className: "msg-text" });
  text.innerHTML = line.html; // static, authored above
  return h("div", { className: "msg" }, avatar(p), h("div", {}, meta, text));
}

const typingEl = who => h("div", { className: "msg" }, avatar(PEOPLE[who]),
  h("div", { className: "typing", ariaHidden: "true" }, h("i"), h("i"), h("i")));

const chatBody = document.getElementById("chat-body");
const wait = ms => new Promise(r => setTimeout(r, ms));
const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

async function play() {
  chatBody.replaceChildren();
  chatBody.classList.remove("fading");
  await wait(600);
  for (const line of SCENE) {
    if (line.who) {
      const t = typingEl(line.who);
      chatBody.append(t);
      await wait(900 + Math.random() * 700);
      t.replaceWith(lineEl(line));
    } else {
      chatBody.append(lineEl(line));
    }
    await wait(700);
  }
  await wait(7000);
  chatBody.classList.add("fading");
  await wait(700);
  play();
}

if (chatBody) {
  if (still) chatBody.replaceChildren(...SCENE.map(lineEl));
  else play();
}
