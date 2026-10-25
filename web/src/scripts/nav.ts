import { LINKS } from "../lib/config";
import { showLoader } from "./loader";

// Discord sign-in links: show the loading screen the moment they're clicked, so
// the hop to /account and on to Discord never sits on a blank page. Plain
// left-clicks only; a new-tab click leaves this page as it is.
document.addEventListener("click", e => {
  const a = (e.target as Element).closest<HTMLAnchorElement>('a[href^="/account?start=discord"]');
  if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  showLoader("Opening Discord…");
});

// Every page: nav border once scrolled, mobile menu, funnel beacons, and the
// session-aware account slot. The slot reads the stored Supabase session
// directly instead of loading supabase-js on marketing pages; anything it
// shows is a convenience, and the dashboard re-validates the session.

const nav = document.querySelector<HTMLElement>("[data-nav]");
if (nav) {
  const onScroll = () => nav.toggleAttribute("data-scrolled", window.scrollY > 4);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

const btn = document.querySelector<HTMLButtonElement>("[data-menu-btn]");
const menu = document.getElementById("menu");
if (btn && menu) {
  const setOpen = (open: boolean) => {
    btn.setAttribute("aria-expanded", String(open));
    btn.querySelector(".sr-only")!.textContent = open ? "Close menu" : "Open menu";
    menu.hidden = !open;
  };
  btn.addEventListener("click", () => setOpen(btn.getAttribute("aria-expanded") !== "true"));
  menu.addEventListener("click", e => { if ((e.target as Element).closest("a, button")) setOpen(false); });
  addEventListener("keydown", e => { if (e.key === "Escape") setOpen(false); });
}

for (const el of document.querySelectorAll<HTMLElement>("[data-beacon]")) {
  el.addEventListener("click", () => {
    if (!el.dataset.beacon) return;
    try { navigator.sendBeacon?.("/track", JSON.stringify({ e: el.dataset.beacon })); } catch { /* never block */ }
  });
}

type StoredSession = { expires_at?: number; user?: { email?: string; user_metadata?: { display_name?: string } } };
function storedSession(): StoredSession | null {
  try {
    for (const key of Object.keys(localStorage)) {
      if (!/^sb-.*-auth-token$/.test(key)) continue;
      const s = JSON.parse(localStorage.getItem(key) ?? "null") as StoredSession | null;
      return s?.user ? s : null;
    }
  } catch { /* storage blocked */ }
  return null;
}

const session = storedSession();
if (session?.user) {
  const name = session.user.user_metadata?.display_name || session.user.email?.split("@")[0] || "Account";
  for (const slot of document.querySelectorAll<HTMLElement>("[data-account-slot]")) {
    const chip = document.createElement("a");
    chip.className = "chip";
    chip.href = "/dashboard";
    const av = document.createElement("span");
    av.className = "chip-av";
    av.textContent = name.charAt(0).toUpperCase();
    const label = document.createElement("span");
    label.className = "chip-name";
    label.textContent = name; // textContent: display names are user-supplied
    chip.append(av, label);
    slot.replaceChildren(chip);
  }
  // Signed in: your characters are one click from anywhere.
  for (const links of document.querySelectorAll<HTMLElement>(".nav-links:not(.nav-links-app)")) {
    if (links.querySelector('a[href="/chat"]')) continue;
    const a = Object.assign(document.createElement("a"), { href: "/chat", textContent: "Your characters" });
    if (location.pathname.startsWith("/chat")) a.setAttribute("aria-current", "page");
    links.prepend(a);
  }
  const mobile = document.querySelector<HTMLAnchorElement>("[data-account-mobile]");
  if (mobile) {
    mobile.textContent = "Your dashboard"; mobile.href = "/dashboard";
    const chats = Object.assign(document.createElement("a"), { href: "/chat", textContent: "Your characters" });
    mobile.before(chats);
  }
  for (const cta of document.querySelectorAll<HTMLAnchorElement>("[data-primary-cta]")) {
    cta.href = "/chat";
    cta.lastChild!.textContent = "Your characters";
    cta.removeAttribute("data-beacon");
  }
  // Signed in already: "Meet X in Discord" goes straight to the server.
  for (const meet of document.querySelectorAll<HTMLAnchorElement>("[data-meet]")) {
    meet.href = LINKS.discord;
    meet.target = "_blank";
    meet.rel = "noopener noreferrer";
    meet.removeAttribute("data-beacon");
  }
}
