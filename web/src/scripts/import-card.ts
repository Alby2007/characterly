// @ts-nocheck: ported from website/src/import-card.js as-is; behaviour unchanged.
// Character-card import — parses the file entirely in the browser (shared
// parser with the bot), shows a preview, uploads the card PNG as the avatar,
// and calls the security-definer RPC that creates the private companion.
import { parseCardFile, cardToPersona, cardImportMeta, cardFileHash } from "../../../src/charcard.ts";
import { importCompanionCard, uploadCardAvatar, cardAvatarUrl, withTimeout } from "./auth";
import { LINKS } from "../lib/config";

const $ = sel => document.querySelector(sel);
const MAX_BYTES = 8 * 1024 * 1024;

export function initImportCard({ linked, uid }) {
  const body = $("#import-body");
  const locked = $("#import-locked");
  if (!body) return;
  body.hidden = !linked;
  if (locked) locked.hidden = linked;
  if (!linked) return;

  const drop = $("#import-drop");
  const input = $("#import-file");
  const preview = $("#import-preview");
  const msg = $("#import-msg");
  const done = $("#import-done");
  let pending = null; // { persona, meta, pngBytes, thumbUrl }

  const fail = text => {
    msg.textContent = text;
    msg.hidden = false;
    preview.hidden = true;
    drop.hidden = false;
  };
  const reset = () => {
    if (pending?.thumbUrl) URL.revokeObjectURL(pending.thumbUrl);
    pending = null;
    preview.hidden = true;
    drop.hidden = false;
    input.value = "";
  };

  const errText = code =>
    code === "no_card_in_png"
      ? "That PNG doesn't have character data inside it. Export the card (not just the picture) and try again."
      : code === "bad_json"
        ? "The data inside that file is damaged. Export a fresh copy and try again."
        : code === "too_large"
          ? "That file is over 8 MB. Character cards are small, so export a fresh copy."
          : "That file isn't a character card we can read. Export a .png card or .json and try again.";

  async function handleFile(file) {
    msg.hidden = true;
    done.hidden = true;
    if (!file) return;
    if (file.size > MAX_BYTES) return fail(errText("too_large"));
    const bytes = new Uint8Array(await file.arrayBuffer());
    const parsed = parseCardFile(bytes, file.name);
    if (!parsed.ok) return fail(errText(parsed.error));
    const persona = cardToPersona(parsed.card);
    const sha256 = await cardFileHash(bytes);
    const meta = cardImportMeta(parsed.card, { filename: file.name, sha256, importedVia: "web" });
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
    if (pending?.thumbUrl) URL.revokeObjectURL(pending.thumbUrl);
    pending = { persona, meta, pngBytes: isPng ? bytes : null, thumbUrl: isPng ? URL.createObjectURL(file) : null };

    $("#import-name").textContent = persona.name;
    $("#import-voice").textContent = persona.voicePersona.slice(0, 220);
    const traits = $("#import-traits");
    traits.hidden = !persona.coreTraits.length;
    traits.textContent = persona.coreTraits.join(" · ");
    const openingsEl = $("#import-openings");
    openingsEl.hidden = !persona.openings.length;
    openingsEl.textContent = persona.openings.length
      ? `+${persona.openings.length} alternate opening${persona.openings.length === 1 ? "" : "s"} — you'll pick one when you first meet.`
      : "";
    const creator = $("#import-creator");
    creator.hidden = !parsed.card.creator;
    creator.textContent = parsed.card.creator ? `Card credits: ${parsed.card.creator}` : "";
    const thumb = $("#import-thumb");
    thumb.hidden = !pending.thumbUrl;
    if (pending.thumbUrl) thumb.src = pending.thumbUrl;
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

  $("#import-cancel").addEventListener("click", () => { msg.hidden = true; reset(); });
  $("#import-confirm").addEventListener("click", async () => {
    if (!pending) return;
    const btn = $("#import-confirm");
    btn.disabled = true;
    msg.hidden = true;
    try {
      let avatarUrl = null;
      if (pending.pngBytes) {
        const path = `${uid}/${pending.meta.sha256}.png`;
        const { error: upErr } = await withTimeout(uploadCardAvatar(uid, pending.meta.sha256, pending.pngBytes), 15000, "Avatar upload");
        if (upErr) throw upErr;
        avatarUrl = cardAvatarUrl(path);
      }
      const { data, error } = await withTimeout(
        importCompanionCard({
          name: pending.persona.name,
          tagline: pending.persona.tagline,
          voice_persona: pending.persona.voicePersona,
          core_traits: pending.persona.coreTraits,
          owner_dynamic: pending.persona.ownerDynamic,
          backstory: pending.persona.backstory,
          greeting: pending.persona.greeting,
          openings: pending.persona.openings,
          avatar_url: avatarUrl,
          import_meta: pending.meta,
        }),
        15000,
        "Import",
      );
      if (error) throw error;
      preview.hidden = true;
      drop.hidden = false;
      done.hidden = false;
      const name = data?.name ?? pending.persona.name;
      const discord = LINKS.discord;
      done.innerHTML = data?.reused
        ? `<strong>${escapeHtml(name)}</strong> was already imported, so they're on your roster. <a href="${discord}" target="_blank" rel="noopener noreferrer">Open Discord</a> and say hi.`
        : `<strong>${escapeHtml(name)}</strong> is home. <a href="${discord}" target="_blank" rel="noopener noreferrer">Open Discord</a> and say hi. They'll introduce themselves.<br><span class="small muted">Imported characters stay private. Publishing to the shelf is a separate step in Discord (/companion → publish).</span>`;
      pending = null;
      input.value = "";
    } catch (e) {
      const m = String(e?.message ?? "");
      msg.textContent =
        e?.code === "PGRST202" ? "Imports aren't switched on yet. Check back soon."
        : /not authenticated/i.test(m) ? "Your session ran out. Refresh the page and sign in again."
        : /discord not linked/i.test(m) ? "Link Discord first: your characters live in your DMs."
        : /adoption slot full/i.test(m) ? "Your roster is full. Drop a character in Discord (/companion → drop) or go Premium, then try again."
        : /cooldown/i.test(m) ? "That companion is on a short re-adopt cooldown. They'll be back soon."
        : /daily adoption/i.test(m) ? "That's a lot of new characters today. Try again tomorrow."
        : /import cap/i.test(m) ? "You've reached the import limit. Publish or remove some imports first."
        : /name required/i.test(m) ? "That card has no usable name. Check the file and try again."
        : "The import didn't finish. Try again in a moment.";
      msg.hidden = false;
      preview.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
