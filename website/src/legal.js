// Charter pages — renders the repo's legal markdown as designed documents.
// The .md files are the single source of truth: vite bundles them at build
// time via ?raw imports, so editing TERMS.md updates /terms on next deploy.
import "./base.js";
import termsMd from "../../TERMS.md?raw";
import privacyMd from "../../PRIVACY.md?raw";
import securityMd from "../../SECURITY.md?raw";
import safetyMd from "../../SAFETY.md?raw";

const DOCS = {
  terms: { md: termsMd, route: "/terms" },
  privacy: { md: privacyMd, route: "/privacy" },
  security: { md: securityMd, route: "/security" },
  safety: { md: safetyMd, route: "/safety" },
};

// Repo-relative doc links get remapped to their site routes; everything else
// stays a normal link (external opens in a new tab).
const MD_ROUTE = { "TERMS.md": "/terms", "PRIVACY.md": "/privacy", "SECURITY.md": "/security", "SAFETY.md": "/safety" };

const esc = s =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(s) {
  // Order matters: links first (their markup may contain **/` in the URL's
  // text), then bold, then code, then italic last so `_Last updated_`-style
  // underscore pairs don't eat asterisk bold already produced.
  let out = esc(s);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, url) => {
    const href = MD_ROUTE[url.split("/").pop()] ?? url;
    const external = /^https?:\/\//.test(href);
    return `<a href="${href}"${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${text}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");
  out = out.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
  return out;
}

/** md → { title, updated, sections: [{id, name}], html } — covers exactly the
 *  constructs the legal docs use; anything else falls through as a paragraph. */
export function renderDoc(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let title = "", updated = "";
  const blocks = []; // {type:'h2'|'p'|'ul', text?, items?}
  let para = [];
  const flush = () => { if (para.length) { blocks.push({ type: "p", text: para.join(" ") }); para = []; } };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const h1 = line.match(/^#\s+(.+)$/);
    if (h1) { flush(); title = h1[1]; continue; }
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) { flush(); blocks.push({ type: "h2", text: h2[1] }); continue; }
    const stamp = line.match(/^_[Ll]ast updated:?\s*(.+?)_$/);
    if (stamp) { updated = stamp[1]; continue; }
    if (line.startsWith("- ")) {
      const last = blocks[blocks.length - 1];
      if (!para.length && last?.type === "ul") last.items.push(line.slice(2));
      else { flush(); blocks.push({ type: "ul", items: [line.slice(2)] }); }
      continue;
    }
    para.push(line);
  }
  flush();

  const sections = [];
  const html = [];
  let n = 0;
  for (const b of blocks) {
    if (b.type === "h2") {
      const id = `s-${++n}`;
      sections.push({ id, name: b.text });
      html.push(`<h2 id="${id}"><span class="sec-n">${String(n).padStart(2, "0")}</span>${inline(b.text)}</h2>`);
    } else if (b.type === "ul") {
      html.push(`<ul>${b.items.map(i => `<li>${inline(i)}</li>`).join("")}</ul>`);
    } else {
      html.push(`<p>${inline(b.text)}</p>`);
    }
  }
  return { title, updated, sections, html: html.join("\n") };
}

// ── Page boot ────────────────────────────────────────────────────────────────
// (document.currentScript is null inside module scripts — key off the route.)
const which = location.pathname.replace(/\/+$/, "").split("/").pop().replace(/\.html$/, "");
const doc = DOCS[which];
if (doc) {
  const { title, updated, sections, html } = renderDoc(doc.md);
  const el = sel => document.querySelector(sel);
  el("#doc-title").innerHTML = inline(title);
  el("#doc-stamp").textContent = updated ? `Last updated ${updated}` : "";
  el("#doc-body").innerHTML = html;
  el("#doc-toc").innerHTML = sections
    .map((s, i) => `<a href="#${s.id}"><span class="toc-n">${String(i + 1).padStart(2, "0")}</span>${inline(s.name)}</a>`)
    .join("");
  for (const a of document.querySelectorAll(".doc-tabs a")) {
    a.classList.toggle("active", a.getAttribute("href") === doc.route);
    if (a.getAttribute("href") === doc.route) a.setAttribute("aria-current", "page");
  }
}
