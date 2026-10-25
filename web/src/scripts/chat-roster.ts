// /chat — your characters. Merges web_my_adoptions (every live adoption,
// Discord-origin ones too for linked accounts) with web_my_conversations
// (last line, pending flag, archived chats) into the portrait grid, and keeps
// the "Replying" tags live via the private channel plus a light poll.
import { requireAuth, ensureConsent, signOut, getProfile } from "./auth";
import { TERMS_VERSION } from "../lib/config";
import { showLoader, hideLoader } from "./loader";
import {
  myAdoptions, myConversations, openConversation, subscribeMessages, isFail,
  previewLine, relativeTime, type Adoption, type Conversation,
} from "./webchat";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const goHome = async () => { try { await signOut(); } finally { location.href = "/"; } };
setTimeout(hideLoader, 12_000);

const user = await requireAuth();
if (!user) { showLoader("Taking you to sign in…"); throw new Error("redirecting"); }
$("#consent-signout").addEventListener("click", goHome);
for (const b of document.querySelectorAll("[data-signout]")) b.addEventListener("click", goHome);
await ensureConsent(TERMS_VERSION);

const rosterEl = $("#roster");
const errorEl = $("#roster-error");
const fail = (text: string) => { errorEl.textContent = text; errorEl.hidden = false; };

let adoptions: Adoption[] = [];
let conversations: Conversation[] = [];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
}

function art(name: string, url: string | null, cls: string, imgSize: number) {
  const box = el("span", cls);
  if (url && /^https:\/\//.test(url)) {
    const img = el("img");
    img.src = url; img.alt = ""; img.loading = "lazy"; img.width = imgSize; img.height = imgSize;
    box.append(img);
  } else {
    box.append(el("span", "rc-ph", (name.trim()[0] ?? "?").toUpperCase()));
  }
  return box;
}

const lastLine = (c: Conversation | undefined) => {
  const m = c?.last_message;
  if (!m || !m.content) return null;
  const line = previewLine(m.content);
  return m.role === "user" ? `You: ${line}` : line;
};

async function openFor(a: Adoption, btn: HTMLButtonElement) {
  btn.disabled = true;
  showLoader(`Opening your chat with ${a.name}…`);
  const r = await openConversation(a.adoption_id);
  if (isFail(r) || !r) {
    hideLoader();
    btn.disabled = false;
    return fail(r && isFail(r) && r.reason === "no_adoption"
      ? `${a.name} isn't on your roster any more. Refresh the page to update it.`
      : "That chat didn't open. Try again in a moment.");
  }
  location.href = `/chat/${r.conversation_id}`;
}

function card(a: Adoption, conv: Conversation | undefined) {
  const li = el("li");
  const inner = conv ? el("a", "rc") : el("button", "rc");
  if (conv) (inner as HTMLAnchorElement).href = `/chat/${conv.id}`;
  else { (inner as HTMLButtonElement).type = "button"; inner.addEventListener("click", () => openFor(a, inner as HTMLButtonElement)); }
  const pic = art(a.name, a.avatar_url, "rc-art", 400);
  if (conv?.pending) {
    const live = el("span", "rc-live");
    live.append(el("i"), document.createTextNode("Replying"));
    pic.append(live);
  }
  inner.append(pic, el("span", "rc-name", a.name));
  const line = lastLine(conv) ?? (a.tagline || null);
  if (line) inner.append(el("span", "rc-line", line));
  const meta = conv
    ? relativeTime(conv.last_activity_at)
    : "Start a new chat";
  inner.append(el("span", "rc-meta", a.origin === "discord" ? `${meta} · Adopted in Discord` : meta));
  inner.setAttribute("aria-label", `${a.name}${conv?.pending ? ", replying" : ""}${line ? `. ${line}` : ""}`);
  li.append(inner);
  return li;
}

function render() {
  const open = new Map<number, Conversation>();
  for (const c of conversations) if (!c.archived && !open.has(c.adoption_id)) open.set(c.adoption_id, c);
  const rows = adoptions.map(a => ({ a, c: open.get(a.adoption_id) ?? undefined }));
  rows.sort((x, y) => Date.parse(y.c?.last_activity_at ?? y.a.adopted_at) - Date.parse(x.c?.last_activity_at ?? x.a.adopted_at));

  if (!rows.length) {
    rosterEl.hidden = true;
    $("#roster-empty").hidden = false;
  } else {
    $("#roster-empty").hidden = true;
    const add = el("li");
    const tile = el("a", "rc-add");
    tile.href = "/characters";
    tile.append(el("span", "", "Adopt another"), el("span", "muted small", "Browse the shelf"));
    add.append(tile);
    rosterEl.replaceChildren(...rows.map(r => card(r.a, r.c)), add);
    rosterEl.hidden = false;
  }

  const live = new Set(adoptions.map(a => a.adoption_id));
  const closed = conversations.filter(c => c.archived);
  $("#closed").hidden = !closed.length;
  $("#closed-list").replaceChildren(...closed.slice(0, 20).map(c => {
    const li = el("li");
    const a = el("a");
    a.href = `/chat/${c.id}`;
    const av = c.avatar_url && /^https:\/\//.test(c.avatar_url)
      ? Object.assign(el("img", "cl-av"), { src: c.avatar_url, alt: "", width: 40, height: 40, loading: "lazy" as const })
      : el("span", "cl-av", (c.name.trim()[0] ?? "?").toUpperCase());
    const mid = el("span");
    mid.append(el("span", "cl-name", c.name));
    const line = lastLine(c);
    if (line) mid.append(el("span", "cl-line", line));
    a.append(av, mid, el("span", "cl-when", live.has(c.adoption_id) ? relativeTime(c.last_activity_at) : "Given back"));
    li.append(a);
    return li;
  }));
}

async function load() {
  const [a, c] = await Promise.all([myAdoptions(), myConversations()]);
  if (isFail(a) || isFail(c) || !Array.isArray(a) || !Array.isArray(c)) {
    fail("Your characters didn't load. Refresh the page to try again.");
    return false;
  }
  errorEl.hidden = true;
  adoptions = a;
  conversations = c;
  render();
  return true;
}

await load();
hideLoader();

// Tokens and the bond note: the one seam the visitor should know about.
getProfile(user.id).then(p => {
  if (!p) return;
  const t = $("#roster-tokens");
  const bal = Number(p.credit_balance ?? 0);
  t.replaceChildren(document.createTextNode(`${bal.toLocaleString()} tokens left · `), Object.assign(el("a", "", "Get more"), { href: "/dashboard#billing" }));
  t.hidden = false;
  const note = $("#bond-note");
  if (p.discord_user_id) {
    note.textContent = "Characters you adopted in Discord appear here too, with the same memory of you.";
  } else {
    note.replaceChildren(
      document.createTextNode("You're chatting on the web. Characters here keep a memory of you that's separate from any Discord DMs, and linking Discord later won't merge the two. "),
      Object.assign(el("a", "", "Link Discord on your dashboard"), { href: "/dashboard" }),
      document.createTextNode(" before you start if you'd like one shared memory."),
    );
  }
  note.hidden = false;
}, () => {});

// Live "Replying" tags: realtime when it works, a slow poll while anything is
// in flight either way.
let refreshing: Promise<unknown> | null = null;
const refresh = () => (refreshing ??= load().finally(() => { refreshing = null; }));
subscribeMessages(user.id, m => { if (m.role !== "user") refresh(); }, () => {}).catch(() => {});
setInterval(() => { if (document.visibilityState === "visible" && conversations.some(c => c.pending)) refresh(); }, 5000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
