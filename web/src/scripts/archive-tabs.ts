// Upgrades every [data-archive] into an accessible tablist (WAI-ARIA tabs:
// arrow keys move, Home/End jump, activation follows focus). The ink bar
// slides to the selected tab; the panel settles in from the side. Under
// reduced motion the CSS drops both transitions.
for (const root of document.querySelectorAll<HTMLElement>("[data-archive]")) {
  const list = root.querySelector<HTMLElement>("[data-tablist]");
  if (!list) continue;
  const tabs = [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const panels = tabs.map(t => document.getElementById(t.getAttribute("aria-controls")!)!);
  const ink = list.querySelector<HTMLElement>(".tab-ink")!;

  list.hidden = false;
  for (const h of root.querySelectorAll<HTMLElement>("[data-fallback-title]")) h.hidden = true;

  const place = (tab: HTMLElement) => {
    ink.style.setProperty("--x", `${tab.offsetLeft}px`);
    ink.style.setProperty("--w", `${tab.offsetWidth}px`);
  };

  const select = (i: number, focus: boolean) => {
    tabs.forEach((t, j) => {
      const on = i === j;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      panels[j].hidden = !on;
    });
    panels[i].removeAttribute("data-entering");
    void panels[i].offsetWidth; // restart the settle animation
    panels[i].setAttribute("data-entering", "");
    place(tabs[i]);
    if (focus) tabs[i].focus();
  };

  const start = Math.max(0, panels.findIndex(p => p.hasAttribute("data-initial")));
  tabs.forEach((_t, j) => { panels[j].hidden = j !== start; });
  // Wait for the webfont before measuring the ink bar.
  document.fonts?.ready.then(() => place(tabs[tabs.findIndex(t => t.tabIndex === 0)] ?? tabs[0]));
  place(tabs[start]);
  addEventListener("resize", () => place(tabs.find(t => t.getAttribute("aria-selected") === "true") ?? tabs[0]));

  tabs.forEach((t, i) => {
    t.addEventListener("click", () => select(i, false));
    t.addEventListener("keydown", e => {
      const k = e.key;
      const n = k === "ArrowRight" ? (i + 1) % tabs.length
        : k === "ArrowLeft" ? (i - 1 + tabs.length) % tabs.length
        : k === "Home" ? 0 : k === "End" ? tabs.length - 1 : -1;
      if (n >= 0) { e.preventDefault(); select(n, true); }
    });
  });
}
