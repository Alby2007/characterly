// Toggle the shared loading screen (components/Loader.astro, rendered by
// Base.astro). Callers must hide it again on every failure path.
const el = () => document.querySelector<HTMLElement>("[data-loader]");

export function showLoader(text: string) {
  const l = el();
  if (!l) return;
  const t = l.querySelector<HTMLElement>("[data-loader-text]");
  if (t) t.textContent = text;
  l.hidden = false;
}

export function hideLoader() {
  const l = el();
  if (l) l.hidden = true;
}

// Coming back with the browser's Back button restores the page from cache with
// the loader still up; clear it.
addEventListener("pageshow", e => { if (e.persisted) hideLoader(); });
