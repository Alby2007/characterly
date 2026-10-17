// Chat-history import — parses the transcript entirely in the browser
// (shared parser with the bot), shows a preview with a companion picker,
// and hands normalized turns to the security-definer RPC which re-bounds
// them, dedupes on sha256, and enqueues the distill job. Status polls
// my_chat_imports while anything is queued/distilling.
import { parseChatFile, chatImportMeta, chatFileHash } from "../../src/chathist.ts";
import { myCompanions, myChatImports, importChatHistory, deleteChatImport, withTimeout } from "./auth.js";

const $ = sel => document.querySelector(sel);
const MAX_BYTES = 8 * 1024 * 1024;
const POLL_MS = 8000;

export function initImportHistory({ linked, uid }) {
  const body = $("#hist-body");
  const locked = $("#hist-locked");
  if (!body) return;
  body.hidden = !linked;
  if (locked) locked.hidden = linked;
  if (!linked) return;

  const drop = $("#hist-drop");
  const input = $("#hist-file");
  const preview = $("#hist-preview");
  const msg = $("#hist-msg");
  const done = $("#hist-done");
  const statusList = $("#hist-status-list");
  const companionSel = $("#hist-companion");
  let pending = null; // { bytes, filename, sha256, chat, meta }
  let roster = null;  // [{id, name, kind}] — lazy, first file or first poll
  let pollTimer = null;

  const fail = text => {
    msg.textContent = text;
    msg.hidden = false;
    preview.hidden = true;
    drop.hidden = false;
  };
  const reset = () => {
    pending = null;
    preview.hidden = true;
    drop.hidden = false;
    input.value = "";
  };

  const errText = code =>
    code === "too_large"
      ? "That file is over 8 MB — chat exports can be big; export a shorter slice."
      : code === "bad_json"
        ? "That file looks like a chat export but the data inside is damaged — export a fresh copy."
        : code === "no_turns"
          ? "I couldn't find any usable conversation in that file — it may be a different export type."
          : "That file isn't a chat export we can read — a .jsonl transcript or supported .json works.";

  async function loadRoster() {
    if (roster) return roster;
    const { data, error } = await withTimeout(myCompanions(), 10000, "Companion list");
    if (error) throw error;
    roster = Array.isArray(data) ? data : [];
    companionSel.innerHTML = roster
      .map(c => `<option value="${c.id}">${escapeHtml(c.name)} (${c.kind === "awakened" ? "awakened" : "adopted"})</option>`)
      .join("");
    return roster;
  }

  function fillPreview() {
    const chat = pending.chat;
    $("#hist-title").textContent = pending.filename;
    const span = chat.firstTs && chat.lastTs
      ? `${chat.firstTs.slice(0, 10)} → ${chat.lastTs.slice(0, 10)}`
      : "dates unknown";
    $("#hist-detail").textContent =
      `${chat.turns.length} usable turns${chat.turns.length < chat.totalTurns ? ` (of ${chat.totalTurns})` : ""} between ${chat.userName} and ${chat.charName} — ${span}.`;
    const others = $("#hist-others");
    others.hidden = !chat.droppedOthers;
    others.textContent = chat.droppedOthers
      ? `${chat.droppedOthers} lines from other speakers will be skipped.`
      : "";
  }

  async function handleFile(file) {
    msg.hidden = true;
    done.hidden = true;
    if (!file) return;
    if (file.size > MAX_BYTES) return fail(errText("too_large"));
    const bytes = new Uint8Array(await file.arrayBuffer());
    const chatRes = parseChatFile(bytes, file.name);
    if (!chatRes.ok) return fail(errText(chatRes.error));
    const sha256 = await chatFileHash(bytes);
    pending = {
      bytes, filename: file.name, sha256, chat: chatRes.chat,
      meta: chatImportMeta(chatRes.chat, { filename: file.name, sha256, importedVia: "web" }),
    };
    try {
      const list = await loadRoster();
      if (!list.length) {
        pending = null;
        return fail("You need a companion to give this history to — awaken or adopt one in Discord first.");
      }
    } catch {
      pending = null;
      return fail("Couldn't load your companions — try again in a moment.");
    }
    // The picked companion's name sharpens speaker resolution for flagless
    // exports — re-parse on every (re)selection.
    companionSel.onchange = () => {
      const picked = roster.find(c => String(c.id) === companionSel.value);
      if (!picked || !pending) return;
      const re = parseChatFile(pending.bytes, pending.filename, { charName: picked.name });
      if (re.ok) {
        pending.chat = re.chat;
        pending.meta = chatImportMeta(re.chat, { filename: pending.filename, sha256: pending.sha256, importedVia: "web" });
        fillPreview();
      }
    };
    companionSel.dispatchEvent(new Event("change"));
    preview.hidden = false;
    drop.hidden = true;
  }

  drop.addEventListener("click", () => input.click());
  drop.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
  input.addEventListener("change", () => handleFile(input.files[0]).catch(() => fail("Couldn't read that file.")));
  for (const ev of ["dragover", "dragenter"]) {
    drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); });
  }
  for (const ev of ["dragleave", "dragend"]) {
    drop.addEventListener(ev, () => drop.classList.remove("over"));
  }
  drop.addEventListener("drop", e => {
    e.preventDefault();
    drop.classList.remove("over");
    handleFile(e.dataTransfer.files[0]).catch(() => fail("Couldn't read that file."));
  });

  $("#hist-cancel").addEventListener("click", () => { msg.hidden = true; reset(); });
  $("#hist-confirm").addEventListener("click", async () => {
    if (!pending) return;
    const btn = $("#hist-confirm");
    btn.disabled = true;
    msg.hidden = true;
    try {
      const chat = pending.chat;
      const { data, error } = await withTimeout(
        importChatHistory({
          companion_id: Number(companionSel.value),
          filename: pending.filename,
          format: chat.format,
          turns: chat.turns.map(t => ({ speaker: t.speaker, text: t.text, ts: t.ts ?? "" })),
          speakers: { user: chat.userName, char: chat.charName, dropped: chat.droppedOthers },
          meta: { sha256: pending.sha256, firstTs: chat.firstTs, lastTs: chat.lastTs },
        }),
        15000,
        "Import",
      );
      if (error) throw error;
      preview.hidden = true;
      drop.hidden = false;
      done.hidden = false;
      done.innerHTML = data?.reused
        ? `<strong>${escapeHtml(pending.filename)}</strong> is already imported — it's ${escapeHtml(data?.status ?? "in progress")}.`
        : `<strong>${escapeHtml(pending.filename)}</strong> is queued — the companion will read through and keep what mattered. We'll note progress below and in Discord.`;
      pending = null;
      input.value = "";
      pollStatus();
    } catch (e) {
      const m = String(e?.message ?? "");
      msg.textContent =
        e?.code === "PGRST202" ? "Chat imports aren't enabled yet — check back soon."
        : /not authenticated/i.test(m) ? "Your session lapsed — refresh and sign in again."
        : /discord not linked/i.test(m) ? "Link Discord above first — companions live in your DMs."
        : /not your companion/i.test(m) ? "That companion isn't on your roster — refresh and try again."
        : /import busy/i.test(m) ? "You have imports queued or distilling already — wait for one to finish."
        : /no usable turns/i.test(m) ? "No usable conversation in that file — check the export and try again."
        : "Couldn't queue the import — try again in a moment.";
      msg.hidden = false;
      preview.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  function renderStatus(rows) {
    statusList.hidden = !rows.length;
    statusList.innerHTML = rows.slice(0, 5).map(i => {
      const pct = i.message_count > 0 ? Math.min(100, Math.round(100 * i.processed_turns / i.message_count)) : 0;
      const state =
        i.status === "queued" ? "queued"
        : i.status === "distilling" ? `distilling — ${pct}%`
        : i.status === "done" ? `done — ${i.kept_count} memories kept`
        : `failed${i.error ? ` — ${escapeHtml(i.error)}` : ""}`;
      const action = i.status === "queued" || i.status === "distilling" ? "Cancel" : "Undo";
      return `<div class="hist-status-row"><span class="hist-file">${escapeHtml(i.filename)}</span><span class="hist-state hist-${i.status}">${state}</span><button class="hist-undo" type="button" data-import-id="${i.id}">${action}</button></div>`;
    }).join("");
  }

  statusList.addEventListener("click", async e => {
    const btn = e.target.closest(".hist-undo");
    if (!btn) return;
    const id = Number(btn.dataset.importId);
    if (!id) return;
    const row = btn.closest(".hist-status-row");
    const name = row?.querySelector(".hist-file")?.textContent ?? "this import";
    if (!confirm(`Remove every memory ${name} distilled? The transcript's already gone — this retracts the memories, permanently.`)) return;
    btn.disabled = true;
    const { data, error } = await deleteChatImport(id).catch(() => ({ data: null, error: { message: "x" } }));
    if (error || !data) {
      btn.disabled = false;
      msg.textContent = "Couldn't remove the import — try again in a moment.";
      msg.hidden = false;
      return;
    }
    done.hidden = false;
    done.innerHTML = `Done — everything <strong>${escapeHtml(data.filename)}</strong> distilled is forgotten.`;
    pollStatus();
  });

  async function pollStatus() {
    const { data, error } = await myChatImports().catch(() => ({ data: null, error: { message: "x" } }));
    if (error || !Array.isArray(data)) return;
    renderStatus(data);
    const running = data.some(i => i.status === "queued" || i.status === "distilling");
    if (running && !pollTimer) {
      pollTimer = setInterval(async () => {
        const r = await myChatImports().catch(() => ({ data: null, error: { message: "x" } }));
        if (r.error || !Array.isArray(r.data)) return;
        renderStatus(r.data);
        if (!r.data.some(i => i.status === "queued" || i.status === "distilling")) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      }, POLL_MS);
    }
  }
  pollStatus();
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
