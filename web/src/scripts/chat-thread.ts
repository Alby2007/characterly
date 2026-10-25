// /chat/<id>: one conversation. Contract: docs/web-chat-frontend.md.
//   history  → web_conversation_messages (paged forward, oldest first)
//   send     → web_send_message with a fresh client_msg_id per send (a retry
//              of the same send can't double-post), optimistic user row +
//              typing placeholder
//   live     → private broadcast `web-messages:<uid>`, applied by row id;
//              polling (every 2.5s while a reply is in flight) underneath it,
//              because Realtime is best-effort
// Every string from the server is rendered as text, never as HTML.
import { requireAuth, ensureConsent, signOut, getProfile } from "./auth";
import { TERMS_VERSION } from "../lib/config";
import { showLoader, hideLoader } from "./loader";
import {
  myConversations, myAdoptions, conversationMessages, sendMessage, archiveConversation,
  openConversation, dropAdoption, reportListing, subscribeMessages, isFail, formatMessage,
  newClientId, MAX_MESSAGE, type Message, type Conversation, type Adoption,
} from "./webchat";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const goHome = async () => { try { await signOut(); } finally { location.href = "/"; } };
setTimeout(hideLoader, 12_000);

const convId = Number(location.pathname.match(/^\/chat\/(\d+)\/?$/)?.[1] ?? NaN);
const user = await requireAuth();
if (!user) { showLoader("Taking you to sign in…"); throw new Error("redirecting"); }
$("#consent-signout").addEventListener("click", goHome);
for (const b of document.querySelectorAll("[data-signout]")) b.addEventListener("click", goHome);
await ensureConsent(TERMS_VERSION);

const scroller = $("#t-scroll");
const list = $<HTMLOListElement>("#t-msgs");
const form = $<HTMLFormElement>("#composer");
const input = $<HTMLTextAreaElement>("#t-input");
const sendBtn = $<HTMLButtonElement>("#t-send");
const errorEl = $("#t-error");
const costEl = $("#t-cost");
const countEl = $("#t-count");
const closedEl = $("#t-closed");

const showError = (text: string) => { errorEl.textContent = text; errorEl.hidden = !text; };
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
};

// ── Who this is with ───────────────────────────────────────────────────────
let conv: Conversation | undefined;
let adoption: Adoption | undefined;
{
  const [cs, as] = Number.isFinite(convId) ? await Promise.all([myConversations(), myAdoptions()]) : [null, null];
  if (Array.isArray(cs)) conv = cs.find(c => c.id === convId);
  if (Array.isArray(as) && conv) adoption = as.find(a => a.adoption_id === conv!.adoption_id);
  if (!conv) {
    hideLoader();
    $("#t-name").textContent = "Chat not found";
    showClosed(
      isFail(cs) || isFail(as) ? "Your chats didn't load. Refresh the page to try again." : "This chat isn't on your account. It may have been closed, or the link is wrong.",
      [link("Back to your characters", "/chat", true)],
    );
    throw new Error("no conversation");
  }
}
const name = conv.name;
document.title = `${name} · Characterly`;
$("#t-name").textContent = name;
input.placeholder = `Message ${name}…`;
$("#t-input-label").textContent = `Message ${name}`;
$("#drop-h").textContent = `Give ${name} back?`;
$("#drop-text").textContent = `Their chat closes and ${name} leaves your characters. You can adopt them again after 12 hours, and they'll still remember you.`;
{
  const av = $("#t-av");
  if (conv.avatar_url && /^https:\/\//.test(conv.avatar_url)) {
    const img = el("img");
    img.src = conv.avatar_url; img.alt = ""; img.width = 56; img.height = 56;
    av.append(img);
  } else av.textContent = (name.trim()[0] ?? "?").toUpperCase();
  const meta = $("#t-meta");
  const facts = [adoption ? (adoption.origin === "discord" ? "Adopted in Discord" : "Adopted · yours") : "Given back"];
  if (adoption?.adopted_at) facts.push(`Remembers you since ${new Date(adoption.adopted_at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`);
  meta.replaceChildren(...facts.map(f => el("span", "", f)));
  if (adoption?.listing_id) {
    const p = $<HTMLAnchorElement>("#t-profile");
    p.href = `/characters/${adoption.listing_id}`;
    p.hidden = false;
    const pm = $<HTMLAnchorElement>("#t-profile-m");
    pm.href = p.href;
    pm.hidden = false;
  }
}

// ── Messages ───────────────────────────────────────────────────────────────
// Keyed by server id; optimistic rows by client_msg_id until the server
// returns their ids.
const rows = new Map<number, Message>();
const nodes = new Map<number, HTMLElement>();
const optimistic = new Map<string, { node: HTMLElement; text: string }>();
let frozen: "archived" | "banned" | "gone" | null = null;

const FAIL_COPY: Record<string, string> = {
  archived: "This chat was closed, so the reply didn't come through.",
  no_companion: `${name} isn't on your roster any more, so they couldn't reply.`,
  banned: `${name} was taken off the shelf, so this chat is frozen.`,
  no_trigger: "Something went wrong on our side. Send your message again.",
  no_reply: "No reply came through. Send your message again.",
};

const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
const toBottom = () => { scroller.scrollTop = scroller.scrollHeight; };
// The footer grows after boot (composer, balance) and with the textarea;
// a reader at the bottom stays at the bottom when the scroller shrinks.
let pinned = true;
scroller.addEventListener("scroll", () => { pinned = nearBottom(); }, { passive: true });
new ResizeObserver(() => { if (pinned) toBottom(); }).observe(scroller);

function renderRow(m: Message, fresh: boolean): HTMLElement {
  const li = el("li");
  li.dataset.id = String(m.id);
  if (m.role === "system") {
    li.className = "m m-system";
    // Billing notices point at the dashboard; give that a real link.
    const text = m.content || "";
    if (/token/i.test(text) && !/https?:\/\//.test(text)) {
      li.append(document.createTextNode(text + " "));
      li.append(Object.assign(el("a", "", "Get tokens"), { href: "/dashboard#billing" }));
    } else li.textContent = text;
  } else if (m.role === "companion" && (m.status === "pending" || m.status === "generating")) {
    li.className = "typing";
    li.setAttribute("aria-label", `${name} is replying`);
    li.append(el("i"), el("i"), el("i"));
  } else if (m.role === "companion" && m.status === "failed") {
    li.className = "m-failed";
    li.append(el("span", "", FAIL_COPY[m.fail_reason ?? ""] ?? "That reply didn't come through. Send your message again."));
  } else {
    li.className = `m m-${m.role}`;
    li.append(formatMessage(m.content || ""));
  }
  if (fresh) li.classList.add("m-new");
  return li;
}

function apply(m: Message, fresh = true) {
  const prev = rows.get(m.id);
  rows.set(m.id, m);
  const stick = nearBottom();
  // An optimistic user row is replaced by its server twin.
  if (m.role === "user" && m.client_msg_id && optimistic.has(m.client_msg_id)) {
    const o = optimistic.get(m.client_msg_id)!;
    optimistic.delete(m.client_msg_id);
    const node = renderRow(m, false);
    o.node.replaceWith(node);
    nodes.set(m.id, node);
  } else if (prev && nodes.has(m.id)) {
    if (prev.status === m.status && prev.content === m.content) return;
    const node = renderRow(m, fresh && m.status === "done");
    nodes.get(m.id)!.replaceWith(node);
    nodes.set(m.id, node);
  } else {
    const node = renderRow(m, fresh);
    // Keep id order even if events arrive out of order.
    const after = [...nodes.keys()].filter(k => k > m.id).sort((a, b) => a - b)[0];
    if (after !== undefined) list.insertBefore(node, nodes.get(after)!);
    else list.append(node);
    nodes.set(m.id, node);
  }
  if (m.role === "companion" && m.status === "failed" && (m.fail_reason === "banned")) freeze("banned");
  if (m.role === "companion" && m.status === "failed" && (m.fail_reason === "no_companion")) freeze("gone");
  if (m.role === "companion" && m.status === "failed" && (m.fail_reason === "archived")) freeze("archived");
  if (stick || m.role === "user") toBottom();
  schedulePoll();
}

const maxId = () => Math.max(0, ...rows.keys());
const inFlight = () => [...rows.values()].filter(m => m.role === "companion" && (m.status === "pending" || m.status === "generating"));

async function loadHistory() {
  let after = 0;
  for (let page = 0; page < 20; page++) {
    const batch = await conversationMessages(convId, after, 200);
    if (isFail(batch) || !Array.isArray(batch)) return page > 0;
    for (const m of batch) apply(m, false);
    if (batch.length < 200) return true;
    after = batch[batch.length - 1].id;
  }
  return true;
}

// ── Polling fallback ───────────────────────────────────────────────────────
// Rows are updated in place (pending → generating → done), so the poll reads
// from just before the oldest in-flight row, not from the newest id.
let pollTimer: number | null = null;
let live = false;
function schedulePoll() {
  if (pollTimer !== null) return;
  const busy = inFlight().length > 0;
  if (!busy && live) return;
  pollTimer = window.setTimeout(async () => {
    pollTimer = null;
    if (document.visibilityState !== "visible") { schedulePoll(); return; }
    const pend = inFlight();
    const from = pend.length ? Math.min(...pend.map(m => m.id)) - 1 : maxId();
    const batch = await conversationMessages(convId, from, 200);
    if (Array.isArray(batch)) for (const m of batch) apply(m, true);
    schedulePoll();
  }, inFlight().length ? 2500 : 10000);
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") schedulePoll(); });

// ── Composer ───────────────────────────────────────────────────────────────
function autosize() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  const n = input.value.length;
  countEl.hidden = n < MAX_MESSAGE - 500;
  countEl.textContent = `${n.toLocaleString()} / ${MAX_MESSAGE.toLocaleString()}`;
  countEl.classList.toggle("over", n > MAX_MESSAGE);
}
input.addEventListener("input", autosize);
input.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
});

const SEND_COPY: Record<string, string> = {
  empty: "Write something first.",
  too_long: `That's over ${MAX_MESSAGE.toLocaleString()} characters. Trim it a little and send again.`,
  archived: "This chat is closed. Start a new one to keep talking.",
  companion_gone: `${name} isn't on your roster any more.`,
  banned: `${name} was taken off the shelf, so this chat is frozen.`,
  signed_out: "Your session ran out. Refresh the page and sign in again.",
  network: "That didn't send. Check your connection and try again.",
  unavailable: "Chat isn't available right now. Try again in a moment.",
};

form.addEventListener("submit", async e => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || frozen) return;
  if (text.length > MAX_MESSAGE) return showError(SEND_COPY.too_long);
  showError("");
  const clientId = newClientId();
  const node = el("li", "m m-user sending m-new");
  node.append(formatMessage(text));
  list.append(node);
  optimistic.set(clientId, { node, text });
  input.value = "";
  autosize();
  toBottom();
  sendBtn.disabled = true;
  let r = await sendMessage(convId, text, clientId);
  // One automatic retry on a dropped connection: same client id, so it can't double-post.
  if (isFail(r) && r.reason === "network") r = await sendMessage(convId, text, clientId);
  sendBtn.disabled = false;
  if (isFail(r) || !r) {
    const reason = isFail(r) ? r.reason : "network";
    optimistic.delete(clientId);
    node.remove();
    if (!input.value) { input.value = text; autosize(); }
    showError(SEND_COPY[reason] ?? SEND_COPY.network);
    if (reason === "archived") freeze("archived");
    if (reason === "banned") freeze("banned");
    if (reason === "companion_gone") freeze("gone");
    return;
  }
  node.classList.remove("sending");
  // Seat the placeholder now; realtime or the poll fills it in.
  if (!rows.has(r.user_message_id)) {
    rows.set(r.user_message_id, { id: r.user_message_id, role: "user", content: text, status: "done", client_msg_id: clientId, created_at: new Date().toISOString() });
    optimistic.delete(clientId);
    nodes.set(r.user_message_id, node);
  }
  if (!rows.has(r.companion_message_id)) apply({ id: r.companion_message_id, role: "companion", content: "", status: "pending", created_at: new Date().toISOString() });
  input.focus();
});

// ── Closed, frozen, given back ─────────────────────────────────────────────
function link(text: string, href: string, primary = false) {
  return Object.assign(el("a", primary ? "btn btn-go" : "link", text), { href });
}
function showClosed(text: string, actions: HTMLElement[]) {
  form.hidden = true;
  costEl.hidden = true;
  closedEl.hidden = false;
  $("#t-closed-text").textContent = text;
  $("#t-closed-actions").replaceChildren(...actions);
}
function freeze(kind: "archived" | "banned" | "gone") {
  if (frozen === kind) return;
  frozen = kind;
  $("#t-close").hidden = true;
  $("#t-close-m").hidden = true;
  if (kind === "archived") {
    const again = el("button", "btn btn-go", "Start a new chat") as HTMLButtonElement;
    again.type = "button";
    again.addEventListener("click", async () => {
      if (!adoption) return;
      again.disabled = true;
      const r = await openConversation(adoption.adoption_id);
      if (isFail(r) || !r) { again.disabled = false; return showError("A new chat didn't open. Try again in a moment."); }
      location.href = `/chat/${r.conversation_id}`;
    });
    showClosed(
      adoption ? `This chat is closed. ${name} still remembers you; a new chat picks up from there.` : `This chat is closed and ${name} was given back.`,
      adoption ? [again] : [link("Back to your characters", "/chat")],
    );
  } else if (kind === "banned") {
    showClosed(`${name} was taken off the shelf by the moderators, so this chat is frozen. You can still read it.`, [link("Back to your characters", "/chat")]);
  } else {
    const acts = [link("Back to your characters", "/chat")];
    if (conv?.adoption_id && adoption?.listing_id) acts.unshift(link(`See ${name} on the shelf`, `/characters/${adoption.listing_id}`));
    showClosed(`${name} isn't on your roster any more, so this chat is read-only.`, acts);
  }
}

// ── Header actions ─────────────────────────────────────────────────────────
const closeBtn = $<HTMLButtonElement>("#t-close");
const closeM = $<HTMLButtonElement>("#t-close-m");
closeM.addEventListener("click", () => { menu.hidePopover?.(); closeBtn.click(); });
closeBtn.addEventListener("click", async () => {
  closeBtn.disabled = true;
  const r = await archiveConversation(convId, true);
  closeBtn.disabled = false;
  if (isFail(r)) return showError("The chat didn't close. Try again in a moment.");
  freeze("archived");
});

const menu = $("#t-menu");
const moreBtn = $<HTMLButtonElement>("#t-more");
menu.addEventListener("beforetoggle", (e: Event) => {
  if ((e as ToggleEvent).newState !== "open") return;
  const r = moreBtn.getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.left = `${Math.max(8, r.right - 220)}px`;
});

const dropModal = $<HTMLDialogElement>("#drop-modal");
$("#t-drop").addEventListener("click", () => { menu.hidePopover?.(); $("#drop-error").hidden = true; dropModal.showModal(); });
$("#drop-cancel").addEventListener("click", () => dropModal.close());
$("#drop-do").addEventListener("click", async () => {
  if (!adoption) return;
  const btn = $<HTMLButtonElement>("#drop-do");
  btn.disabled = true;
  const r = await dropAdoption(adoption.adoption_id);
  btn.disabled = false;
  if (isFail(r)) {
    const err = $("#drop-error");
    err.textContent = r.reason === "no_adoption" ? `${name} was already given back.` : "That didn't go through. Try again in a moment.";
    err.hidden = false;
    return;
  }
  location.href = "/chat";
});

const reportModal = $<HTMLDialogElement>("#report-modal");
const reportForm = $<HTMLFormElement>("#report-form");
const reportMsg = $("#report-msg");
$("#t-report").addEventListener("click", () => { menu.hidePopover?.(); reportMsg.hidden = true; reportForm.reset(); $<HTMLButtonElement>("#report-send").hidden = false; reportModal.showModal(); });
$("#report-cancel").addEventListener("click", () => reportModal.close());
reportForm.addEventListener("submit", async e => {
  e.preventDefault();
  if (!adoption?.listing_id) return;
  const fd = new FormData(reportForm);
  const category = String(fd.get("category") ?? "");
  if (!category) { reportMsg.className = "msg"; reportMsg.textContent = "Pick what's wrong first."; reportMsg.hidden = false; return; }
  const btn = $<HTMLButtonElement>("#report-send");
  btn.disabled = true;
  const r = await reportListing(adoption.listing_id, category, String(fd.get("reason") ?? "").trim());
  btn.disabled = false;
  reportMsg.hidden = false;
  if (isFail(r)) {
    reportMsg.className = "msg";
    reportMsg.textContent = r.reason === "dup" ? "You've already reported this character. The moderators have it."
      : r.reason === "daily_cap" ? "You've sent a lot of reports today. Try again tomorrow."
      : "The report didn't send. Try again in a moment.";
    return;
  }
  reportMsg.className = "msg ok";
  reportMsg.textContent = r.flagged ? "Thanks. That's taken them off the shelf while the moderators look." : "Thanks. The moderators will take a look.";
  btn.hidden = true;
});

// ── Boot ───────────────────────────────────────────────────────────────────
const loaded = await loadHistory();
hideLoader();
if (!loaded) showError("The conversation didn't load. Refresh the page to try again.");
// Announce new rows only: history loads silently.
list.setAttribute("aria-live", "polite");
toBottom();

if (conv.archived) freeze("archived");
else if (!adoption) freeze("gone");
else if (adoption.listing_status === "banned") freeze("banned");
else {
  form.hidden = false;
  costEl.hidden = false;
  closeBtn.hidden = false;
  closeM.hidden = false;
  input.focus({ preventScroll: true });
}
moreBtn.hidden = !adoption;
if (!adoption?.listing_id) $("#t-report").hidden = true;
schedulePoll();

subscribeMessages(user.id, m => { if (m.conversation_id === convId) apply(m, true); }, state => {
  live = state;
  schedulePoll();
}).catch(() => {});

getProfile(user.id).then(p => {
  if (!p) return;
  const b = $("#t-balance");
  b.replaceChildren(document.createTextNode(`${Number(p.credit_balance ?? 0).toLocaleString()} left · `), Object.assign(el("a", "", "Get more"), { href: "/dashboard#billing" }));
}, () => {});
