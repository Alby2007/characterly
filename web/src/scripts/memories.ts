// The memory archive: per-character facts, journal and story recap from the
// caller's DM lane, through security-definer RPCs. Pin / edit / forget mirror
// the Discord commands (/memory list pin:, /memory forget, /companion story),
// so either surface reaches the same rows. Ported from website/src/memories.js;
// every change now leaves a visible mark before the list refreshes.
import {
  myCompanions, myMemoryOverview, pinMemory, updateMemory,
  forgetMemory, pinJournalEntry, forgetJournalEntry, saveStorySummary, withTimeout,
} from "./auth";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

const KIND_LABELS: Record<string, string> = {
  person_fact: "Fact", person_preference: "Preference", server_lore: "Lore", episode: "Moment", story_fact: "Story",
};
const JOURNAL_LABELS: Record<string, string> = {
  moment: "Moment", opinion: "Opinion", inside_joke: "Inside joke", promise: "Promise", callback: "Callback", bond: "History",
};
const ICON: Record<string, string> = {
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4"/></svg>',
  forget: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};
const MARK_MS = 900; // how long a change's mark shows before the list refreshes

type Memory = { id: number; content: string; kind: string; subject_id?: string; status: string; pinned: boolean };
type Journal = { id: number; content: string; kind: string; pinned: boolean };
type Summary = { channel_id: string; summary: string | null; user_edited: boolean };

export function initMemories({ linked }: { linked: boolean }) {
  const loading = $("#memory-loading");
  const locked = $("#memory-locked");
  const msg = $("#memory-msg");
  const pick = $("#mem-pick");
  const sel = $<HTMLSelectElement>("#mem-companion");
  const tabsEl = $("#mem-tabs");
  const lists = $("#mem-lists");
  const memoriesEl = $("#mem-memories");
  const journalEl = $("#mem-journal");
  const summariesEl = $("#mem-summaries");
  const nameEl = $("#mem-name");

  if (!linked) { loading.hidden = true; locked.hidden = false; return; }

  const fail = (text: string) => { msg.textContent = text; msg.hidden = false; };
  const ok = () => { msg.hidden = true; };
  const explain = (e: any) => {
    const m = String(e?.message ?? "");
    if (e?.code === "PGRST202") return "Memory editing isn't switched on yet. Check back soon.";
    if (/not authenticated/i.test(m)) return "Your session ran out. Refresh the page and sign in again.";
    if (/discord not linked/i.test(m)) return "Link Discord first: your characters live in your DMs.";
    if (/not your (companion|memory|journal)/i.test(m)) return "That isn't on your roster any more. Refreshing the page fixes it.";
    return "That didn't go through. Try again in a moment.";
  };

  // ── tabs ──
  const tabs = [...tabsEl.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const panels = tabs.map(t => document.getElementById(t.getAttribute("aria-controls")!)!);
  const ink = tabsEl.querySelector<HTMLElement>(".tab-ink")!;
  const place = (t: HTMLElement) => { ink.style.setProperty("--x", `${t.offsetLeft}px`); ink.style.setProperty("--w", `${t.offsetWidth}px`); };
  const select = (i: number, focus = false) => {
    tabs.forEach((t, j) => { t.setAttribute("aria-selected", String(i === j)); t.tabIndex = i === j ? 0 : -1; panels[j].hidden = i !== j; });
    place(tabs[i]);
    if (focus) tabs[i].focus();
  };
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => select(i));
    t.addEventListener("keydown", e => {
      const n = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i - 1 + tabs.length) % tabs.length : -1;
      if (n >= 0) { e.preventDefault(); select(n, true); }
    });
  });
  addEventListener("resize", () => place(tabs.find(t => t.getAttribute("aria-selected") === "true") ?? tabs[0]));

  // ── rows ──
  const el = (tag: string, cls = "", text = "") => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  };
  const actBtn = (label: string, icon: string, fn: (b: HTMLButtonElement) => void, extra = "") => {
    const b = el("button", `act ${extra}`) as HTMLButtonElement;
    b.type = "button";
    b.innerHTML = ICON[icon];
    b.append(label);
    b.addEventListener("click", () => fn(b));
    return b;
  };
  const flag = (label: string, icon?: string, warn = false) => {
    const f = el("span", `flag${warn ? " flag-warn" : ""}`);
    if (icon) f.innerHTML = ICON[icon];
    f.append(label);
    return f;
  };
  /** Strike the row through, say what happened, then refresh. */
  const markForgotten = (li: HTMLElement) => {
    li.classList.add("is-forgotten");
    li.querySelector(".entry-actions")?.replaceChildren(flag("Forgotten", "forget"));
    setTimeout(load, MARK_MS);
  };

  function memoryRow(m: Memory) {
    const li = el("li", "entry");
    const text = el("p", "entry-text", m.content);
    const flags = el("div", "entry-flags");
    if (m.pinned) flags.append(flag("Pinned", "pin"));
    if (m.subject_id?.startsWith("companion:")) flags.append(flag("About themselves"));
    if (m.status !== "active") flags.append(flag(m.status, undefined, true));
    const actions = el("div", "entry-actions");
    const body = el("div", "entry-body");
    actions.append(
      actBtn(m.pinned ? "Unpin" : "Pin", "pin", async b => {
        b.disabled = true;
        const { error } = await withTimeout(pinMemory(m.id, !m.pinned), 8000, "Pin").catch(e => ({ error: e }));
        if (error) { b.disabled = false; return fail(explain(error)); }
        ok(); load();
      }),
      actBtn("Edit", "edit", () => {
        const ta = el("textarea", "input") as HTMLTextAreaElement;
        ta.maxLength = 1000;
        ta.value = m.content;
        ta.setAttribute("aria-label", "Edit memory");
        const save = actBtn("Save", "edit", async b => {
          const next = ta.value.trim();
          if (!next) return fail("A memory can't be empty. Use Forget to remove it.");
          b.disabled = true;
          const { error } = await withTimeout(updateMemory(m.id, next), 8000, "Edit").catch(e => ({ error: e }));
          if (error) { b.disabled = false; return fail(explain(error)); }
          ok();
          // Show the change: old wording struck through above the new.
          body.replaceChildren(el("p", "entry-old", m.content), el("p", "entry-text", next), flagsRow(flag("Edited by you", "edit")));
          setTimeout(load, MARK_MS + 300);
        });
        const cancel = actBtn("Cancel", "forget", () => load());
        text.replaceWith(ta);
        actions.replaceChildren(save, cancel);
        ta.focus();
      }),
      actBtn("Forget", "forget", async b => {
        if (!confirm(`Forget "${m.content.slice(0, 80)}"? It's removed from their memory permanently.`)) return;
        b.disabled = true;
        const { error } = await withTimeout(forgetMemory(m.id), 8000, "Forget").catch(e => ({ error: e }));
        if (error) { b.disabled = false; return fail(explain(error)); }
        ok(); markForgotten(li);
      }, "act-forget"),
    );
    body.append(text, ...(flags.childElementCount ? [flags] : []), actions);
    li.append(el("span", "scope scope-kind", KIND_LABELS[m.kind] ?? m.kind), body);
    return li;
  }
  const flagsRow = (...f: HTMLElement[]) => { const d = el("div", "entry-flags"); d.append(...f); return d; };

  function journalRow(j: Journal) {
    const li = el("li", "entry");
    const body = el("div", "entry-body");
    const actions = el("div", "entry-actions");
    actions.append(
      actBtn(j.pinned ? "Unpin" : "Pin", "pin", async b => {
        b.disabled = true;
        const { error } = await withTimeout(pinJournalEntry(j.id, !j.pinned), 8000, "Pin").catch(e => ({ error: e }));
        if (error) { b.disabled = false; return fail(explain(error)); }
        ok(); load();
      }),
      actBtn("Forget", "forget", async b => {
        if (!confirm("Forget this journal entry? Their private note is gone for good.")) return;
        b.disabled = true;
        const { error } = await withTimeout(forgetJournalEntry(j.id), 8000, "Forget").catch(e => ({ error: e }));
        if (error) { b.disabled = false; return fail(explain(error)); }
        ok(); markForgotten(li);
      }, "act-forget"),
    );
    body.append(el("p", "entry-text", j.content), ...(j.pinned ? [flagsRow(flag("Pinned", "pin"))] : []), actions);
    li.append(el("span", "scope scope-kind", JOURNAL_LABELS[j.kind] ?? j.kind), body);
    return li;
  }

  function storyBlock(s: Summary, companionId: number) {
    const wrap = el("div", "story");
    const ta = el("textarea", "input") as HTMLTextAreaElement;
    ta.maxLength = 4000;
    ta.rows = 5;
    ta.value = s.summary ?? "";
    ta.setAttribute("aria-label", "Story recap");
    const foot = el("div", "story-foot");
    const save = el("button", "btn btn-sm", "Save recap") as HTMLButtonElement;
    save.type = "button";
    save.addEventListener("click", async () => {
      save.disabled = true;
      const { error } = await withTimeout(saveStorySummary(companionId, s.channel_id, ta.value.trim()), 8000, "Save").catch(e => ({ error: e }));
      save.disabled = false;
      if (error) return fail(explain(error));
      ok(); load();
    });
    foot.append(save, el("span", "small muted", s.user_edited ? "Edited by you, and treated as canon." : "Updates itself as you chat."));
    wrap.append(ta, foot);
    return wrap;
  }

  const emptyLi = (text: string) => el("li", "empty-row", text);

  let roster: Array<{ id: number; name: string; kind: string }> = [];
  async function load() {
    const companionId = Number(sel.value);
    if (!companionId) return;
    nameEl.textContent = roster.find(c => c.id === companionId)?.name ?? "Your characters";
    const { data, error } = await withTimeout(myMemoryOverview(companionId), 10000, "Memory").catch(e => ({ data: null, error: e })) as any;
    loading.hidden = true;
    if (error) return fail(explain(error));
    ok();
    const memories: Memory[] = data?.memories ?? [];
    const journal: Journal[] = data?.journal ?? [];
    const summaries: Summary[] = data?.summaries ?? [];
    $("#mem-count").textContent = String(memories.length);
    $("#journal-count").textContent = String(journal.length);
    memoriesEl.replaceChildren(...(memories.length ? memories.map(memoryRow)
      : [emptyLi("Nothing remembered yet. Tell them something worth keeping, or use /memory remember in Discord.")]));
    journalEl.replaceChildren(...(journal.length ? journal.map(journalRow)
      : [emptyLi("No journal entries yet. They write these privately after you chat.")]));
    summariesEl.replaceChildren(...(summaries.length ? summaries.map(s => storyBlock(s, companionId))
      : [el("p", "empty-row", "No recap yet. It builds itself as you two chat, then you can rewrite it here.")]));
    tabsEl.hidden = false;
    lists.hidden = false;
    place(tabs.find(t => t.getAttribute("aria-selected") === "true") ?? tabs[0]);
  }

  (async () => {
    const { data, error } = await withTimeout(myCompanions(), 10000, "Character list").catch(e => ({ data: null, error: e })) as any;
    loading.hidden = true;
    if (error) return fail(explain(error));
    if (!Array.isArray(data) || !data.length) {
      fail("No characters yet. Adopt one from the shelf, or import a card below, and their memory shows up here.");
      msg.classList.add("ok");
      return;
    }
    roster = data;
    sel.replaceChildren(...data.map((c: any) => {
      const o = document.createElement("option");
      o.value = String(c.id);
      o.textContent = `${c.name}${c.kind === "adopted" ? " (adopted)" : ""}`; // textContent: names are user-authored
      return o;
    }));
    pick.hidden = data.length < 2;
    sel.addEventListener("change", () => load());
    await load();
  })();
}
