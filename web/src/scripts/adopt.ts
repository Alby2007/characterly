// "Chat on the web" on a character page. Signed out → sign in (Discord or
// email) and come straight back with ?adopt=1, which adopts on arrival.
// Signed in → web_adopt_listing → /chat/<conversation_id>. The Supabase client
// only loads when someone actually adopts, so shelf pages stay light.
import { showLoader, hideLoader } from "./loader";

const hasSession = () => {
  try { return Object.keys(localStorage).some(k => /^sb-.*-auth-token$/.test(k)); } catch { return false; }
};

const btn = document.querySelector<HTMLButtonElement>("[data-adopt]");
const msg = document.querySelector<HTMLElement>("[data-adopt-msg]");

function say(nodes: (string | Node)[]) {
  if (!msg) return;
  msg.replaceChildren(...nodes);
  msg.hidden = false;
}
const anchor = (text: string, href: string) => Object.assign(document.createElement("a"), { textContent: text, href });

async function adopt(listingId: number, name: string) {
  if (!btn) return;
  btn.disabled = true;
  if (msg) msg.hidden = true;
  showLoader(`Adopting ${name}…`);
  const { adoptListing, isFail } = await import("./webchat");
  const r = await adoptListing(listingId);
  if (!isFail(r) && r && r.ok) {
    showLoader(r.reused ? `Opening your chat with ${r.name}…` : `${r.name} is yours. Opening your chat…`);
    location.href = `/chat/${r.conversation_id}`;
    return;
  }
  hideLoader();
  btn.disabled = false;
  const reason = isFail(r) ? r.reason : "network";
  if (reason === "signed_out") return signIn(listingId);
  if (reason === "cooldown") {
    const until = isFail(r) && typeof r.cooldown_until === "string" ? new Date(r.cooldown_until) : null;
    const when = until && Number.isFinite(until.getTime())
      ? until.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })
      : "in a few hours";
    return say([`You gave ${name} back recently. You can adopt them again from ${when}, and they'll still remember you.`]);
  }
  if (reason === "own_listing") return say([`${name} is your own character, so there's nothing to adopt. `, anchor("Go to your characters", "/chat")]);
  if (reason === "delisted" || reason === "not_found") return say([`${name} isn't on the shelf any more. `, anchor("Browse the shelf", "/characters")]);
  say(["Adopting didn't go through. Try again in a moment."]);
}

function signIn(listingId: number) {
  const back = `/characters/${listingId}?adopt=1`;
  showLoader("Taking you to sign in…");
  location.href = `/account?next=${encodeURIComponent(back)}&for=adopt`;
}

if (btn) {
  const id = Number(btn.dataset.adopt);
  const name = btn.dataset.adoptName ?? "them";
  btn.addEventListener("click", () => (hasSession() ? adopt(id, name) : signIn(id)));
  // Back from sign-in: finish what they started, then drop the flag so a
  // refresh doesn't adopt twice (adopting again would only reopen the chat).
  const q = new URLSearchParams(location.search);
  if (q.get("adopt") === "1") {
    history.replaceState(null, "", location.pathname);
    if (hasSession()) adopt(id, name);
  }
}
