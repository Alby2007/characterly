// Memory editor — the per-companion "what they remember" panel. Lists the
// caller's DM-lane data through security-definer RPCs: real memories, the
// companion's story facts, its journal, and the editable "story so far"
// recap. Pin/edit/forget mirror the Discord commands (/remember, /memory pin,
// /forget, /companion story) so either surface reaches the same rows.
import {
  myCompanions, myMemoryOverview, pinMemory, updateMemory,
  forgetMemory, pinJournalEntry, forgetJournalEntry, saveStorySummary, withTimeout,
} from "./auth.js";

const $ = sel => document.querySelector(sel);

const KIND_LABELS = {
  person_fact: "fact", person_preference: "preference", server_lore: "lore",
  episode: "episode", story_fact: "story",
};
const JOURNAL_LABELS = {
  moment: "moment", opinion: "opinion", inside_joke: "inside joke",
  promise: "promise", callback: "callback", bond: "history",
};

export function initMemories({ linked }) {
  const body = $("#memory-body");
  const locked = $("#memory-locked");
  if (!body) return;
  body.hidden = !linked;
  if (locked) locked.hidden = linked;
  if (!linked) return;

  const sel = $("#mem-companion");
  const lists = $("#mem-lists");
  const msg = $("#memory-msg");
  const summariesEl = $("#mem-summaries");
  const memoriesEl = $("#mem-memories");
  const journalEl = $("#mem-journal");

  const fail = text => { msg.textContent = text; msg.hidden = false; };
  const ok = () => { msg.hidden = true; };

  function explain(e) {
    const m = String(e?.message ?? "");
    if (e?.code === "PGRST202") return "Memory editing isn't enabled yet — check back soon.";
    if (/not authenticated/i.test(m)) return "Your session lapsed — refresh and sign in again.";
    if (/discord not linked/i.test(m)) return "Link Discord above first — companions live in your DMs.";
    if (/not your (companion|memory|journal)/i.test(m)) return "That isn't on your roster anymore — refreshing fixes it.";
    return "Couldn't do that — try again in a moment.";
  }

  function memoryRow(m) {
    const li = document.createElement("li");
    li.className = "mem-row";
    const text = document.createElement("p");
    text.className = "mem-text";
    text.textContent = m.content;
    const meta = document.createElement("div");
    meta.className = "mem-meta";
    const tag = (label, cls = "") => {
      const s = document.createElement("span");
      s.className = `mem-tag ${cls}`;
      s.textContent = label;
      return s;
    };
    meta.append(tag(KIND_LABELS[m.kind] ?? m.kind));
    if (m.subject_id?.startsWith("companion:")) meta.append(tag("their own"));
    if (m.status !== "active") meta.append(tag(m.status, "warn"));
    if (m.pinned) meta.append(tag("pinned", "pin"));
    const actions = document.createElement("div");
    actions.className = "mem-actions";
    const mkBtn = (label, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mem-btn";
      b.textContent = label;
      b.addEventListener("click", () => fn(b));
      return b;
    };
    actions.append(
      mkBtn(m.pinned ? "Unpin" : "Pin", async b => {
        b.disabled = true;
        const { error } = await withTimeout(pinMemory(m.id, !m.pinned), 8000, "Pin").catch(e => ({ error: e }));
        if (error) { b.disabled = false; return fail(explain(error)); }
        ok(); load();
      }),
      mkBtn("Edit", () => {
        const ta = document.createElement("textarea");
        ta.className = "input mem-edit";
        ta.maxLength = 1000;
        ta.value = m.content;
        const save = mkBtn("Save", async b2 => {
          b2.disabled = true;
          const { error } = await withTimeout(updateMemory(m.id, ta.value.trim()), 8000, "Edit").catch(e => ({ error: e }));
          if (error) { b2.disabled = false; return fail(explain(error)); }
          ok(); load();
        });
        const cancel = mkBtn("Cancel", () => load());
        text.replaceWith(ta);
        actions.replaceChildren(save, cancel);
        ta.focus();
      }),
      mkBtn("Forget", async b => {
        if (!confirm(`Forget "${m.content.slice(0, 80)}"? It's gone from recall — permanently.`)) return;
        b.disabled = true;
        const { error } = await withTimeout(forgetMemory(m.id), 8000, "Forget").catch(e => ({ error: e }));
        if (error) { b.disabled = false; return fail(explain(error)); }
        ok(); load();
      }),
    );
    li.append(text, meta, actions);
    return li;
  }

  function journalRow(j) {
    const li = document.createElement("li");
    li.className = "mem-row";
    const text = document.createElement("p");
    text.className = "mem-text mem-journal";
    text.textContent = j.content;
    const meta = document.createElement("div");
    meta.className = "mem-meta";
    const tag = document.createElement("span");
    tag.className = "mem-tag";
    tag.textContent = JOURNAL_LABELS[j.kind] ?? j.kind;
    meta.append(tag);
    if (j.pinned) {
      const p = document.createElement("span");
      p.className = "mem-tag pin";
      p.textContent = "pinned";
      meta.append(p);
    }
    const actions = document.createElement("div");
    actions.className = "mem-actions";
    const pinBtn = document.createElement("button");
    pinBtn.type = "button";
    pinBtn.className = "mem-btn";
    pinBtn.textContent = j.pinned ? "Unpin" : "Pin";
    pinBtn.addEventListener("click", async () => {
      pinBtn.disabled = true;
      const { error } = await withTimeout(pinJournalEntry(j.id, !j.pinned), 8000, "Pin").catch(e => ({ error: e }));
      if (error) { pinBtn.disabled = false; return fail(explain(error)); }
      ok(); load();
    });
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mem-btn";
    btn.textContent = "Forget";
    btn.addEventListener("click", async () => {
      if (!confirm("Forget this journal entry? Their private note is gone for good.")) return;
      btn.disabled = true;
      const { error } = await withTimeout(forgetJournalEntry(j.id), 8000, "Forget").catch(e => ({ error: e }));
      if (error) { btn.disabled = false; return fail(explain(error)); }
      ok(); load();
    });
    actions.append(pinBtn, btn);
    li.append(text, meta, actions);
    return li;
  }

  function summaryBlock(s, companionId) {
    const wrap = document.createElement("div");
    wrap.className = "mem-summary";
    const ta = document.createElement("textarea");
    ta.className = "input mem-edit";
    ta.maxLength = 4000;
    ta.rows = 4;
    ta.value = s.summary ?? "";
    const foot = document.createElement("div");
    foot.className = "mem-actions";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "btn btn-ghost btn-sm";
    save.textContent = "Save recap";
    save.addEventListener("click", async () => {
      save.disabled = true;
      const { error } = await withTimeout(
        saveStorySummary(companionId, s.channel_id, ta.value.trim()), 8000, "Save",
      ).catch(e => ({ error: e }));
      save.disabled = false;
      if (error) return fail(explain(error));
      ok(); load();
    });
    const note = document.createElement("span");
    note.className = "mem-note";
    note.textContent = s.user_edited ? "edited by you — treated as canon" : "auto-updated as you chat";
    foot.append(save, note);
    wrap.append(ta, foot);
    return wrap;
  }

  async function load() {
    const companionId = Number(sel.value);
    if (!companionId) return;
    lists.hidden = true;
    const { data, error } = await withTimeout(myMemoryOverview(companionId), 10000, "Memory").catch(e => ({ data: null, error: e }));
    if (error) return fail(explain(error));
    ok();
    const memories = data?.memories ?? [];
    const journal = data?.journal ?? [];
    const summaries = data?.summaries ?? [];

    summariesEl.replaceChildren(
      ...summaries.map(s => summaryBlock(s, companionId)),
      ...(summaries.length ? [] : [Object.assign(document.createElement("p"), {
        className: "plate-note",
        textContent: "No recap yet — it builds itself as you two chat, then you can rewrite it here.",
      })]),
    );
    memoriesEl.replaceChildren(
      ...memories.map(memoryRow),
      ...(memories.length ? [] : [Object.assign(document.createElement("li"), {
        className: "mem-empty",
        textContent: "Nothing remembered yet — tell them something worth keeping, or /remember it in Discord.",
      })]),
    );
    journalEl.replaceChildren(
      ...journal.map(journalRow),
      ...(journal.length ? [] : [Object.assign(document.createElement("li"), {
        className: "mem-empty",
        textContent: "No journal entries yet — they write these privately after you chat.",
      })]),
    );
    lists.hidden = false;
  }

  (async () => {
    const { data, error } = await withTimeout(myCompanions(), 10000, "Companion list").catch(e => ({ data: null, error: e }));
    if (error || !Array.isArray(data) || !data.length) {
      if (!error) return fail("No companions yet — awaken or adopt one in Discord first.");
      return fail(explain(error));
    }
    sel.innerHTML = data
      .map(c => `<option value="${c.id}">${escapeHtml(c.name)}${c.kind === "adopted" ? " (adopted)" : ""}</option>`)
      .join("");
    sel.addEventListener("change", () => load());
    await load();
  })();
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
