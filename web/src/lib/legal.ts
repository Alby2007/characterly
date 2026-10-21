// House documents: the repo's TERMS/PRIVACY/SECURITY/SAFETY.md are the single
// source of truth. FIX: rendered at BUILD time (the old site rendered them in
// the browser, so the pages were empty without JavaScript).
import termsMd from "../../../TERMS.md?raw";
import privacyMd from "../../../PRIVACY.md?raw";
import securityMd from "../../../SECURITY.md?raw";
import safetyMd from "../../../SAFETY.md?raw";

export const DOCS = {
  terms: { md: termsMd, label: "Terms of Service", description: "The terms for using Characterly, its Discord bot and this website." },
  privacy: { md: privacyMd, label: "Privacy Policy", description: "What Characterly stores, why, how long it keeps it, and how to delete it." },
  security: { md: securityMd, label: "Security", description: "How Characterly protects accounts, keys and data, and how to report a vulnerability." },
  safety: { md: safetyMd, label: "Safety", description: "Characterly's content policy, screening, crisis support and how reports are handled." },
} as const;
export type DocSlug = keyof typeof DOCS;

const MD_ROUTE: Record<string, string> = {
  "TERMS.md": "/terms", "PRIVACY.md": "/privacy", "SECURITY.md": "/security", "SAFETY.md": "/safety",
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function inline(s: string): string {
  // Links first (their text may contain ** or `), then bold, code, and
  // italics last so `_Last updated_`-style pairs don't eat bold.
  let out = esc(s);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, url: string) => {
    const href = MD_ROUTE[url.split("/").pop() ?? ""] ?? url;
    const external = /^https?:\/\//.test(href);
    return `<a href="${href}"${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${text}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");
  out = out.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
  return out;
}

/** md → { title, updated, sections, html }. Covers exactly the constructs the
 *  legal docs use (h1, h2, last-updated stamp, `- ` lists, paragraphs). */
export function renderDoc(md: string) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let title = "", updated = "";
  type Block = { type: "h2" | "p"; text: string } | { type: "ul"; items: string[] };
  const blocks: Block[] = [];
  let para: string[] = [];
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

  const sections: { id: string; name: string }[] = [];
  const html: string[] = [];
  let n = 0;
  for (const b of blocks) {
    if (b.type === "h2") {
      const id = `s-${++n}`;
      sections.push({ id, name: inline(b.text) });
      html.push(`<h2 id="${id}">${inline(b.text)}</h2>`);
    } else if (b.type === "ul") {
      html.push(`<ul>${b.items.map(i => `<li>${inline(i)}</li>`).join("")}</ul>`);
    } else {
      html.push(`<p>${inline(b.text)}</p>`);
    }
  }
  return { title: inline(title), updated, sections, html: html.join("\n") };
}
