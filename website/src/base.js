// Shared entry for every page: fonts, styles, outbound links, nav behaviour,
// and scroll reveals. Page scripts import this first.
import "@fontsource-variable/fraunces/opsz.css";
import "@fontsource-variable/fraunces/opsz-italic.css";
import "@fontsource-variable/instrument-sans";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles.css";
import { LINKS } from "./config.js";

for (const el of document.querySelectorAll("[data-link]")) {
  const url = LINKS[el.dataset.link];
  if (url) el.setAttribute("href", url);
}

// ── Nav: border once scrolled + mobile menu ────────────────────────────────
const nav = document.querySelector(".nav");
if (nav) {
  const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 8);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

const toggle = document.querySelector(".nav-toggle");
const mobileMenu = document.getElementById("mobile-menu");
if (toggle && mobileMenu) {
  const setOpen = open => {
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    mobileMenu.hidden = !open;
  };
  toggle.addEventListener("click", () => setOpen(toggle.getAttribute("aria-expanded") !== "true"));
  mobileMenu.addEventListener("click", e => { if (e.target.closest("a, button")) setOpen(false); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") setOpen(false); });
}

// ── Scroll reveal ──────────────────────────────────────────────────────────
const revealIO = new IntersectionObserver(entries => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    en.target.classList.add("in");
    revealIO.unobserve(en.target);
  }
}, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
document.querySelectorAll(".rv").forEach(el => revealIO.observe(el));
