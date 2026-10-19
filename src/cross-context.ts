import { MemoryStore } from "./database.js";
import type { EventStore } from "./events.js";
import type { Companion } from "./types.js";
import { promptInline, promptName } from "./prompt-safety.js";

// ── Cross-Context Consciousness (DM ↔ Server Bridge) ─────────────────────────
// Two strictly asymmetric bridges connect a user's private 1:1 DM with their
// companion to the friend servers where the companion has been summoned:
//  1. DM → Server (`gatherOwnerSubtextForServer`): pulls high-confidence
//     memories and attributes from `dm:<ownerUserId>` so the companion brings
//     its private bond/subtext into server hangouts without leaking raw secrets.
//  2. Server → DM (`gatherServerDigestForDm`): pulls recent events, relationship
//     edges, and channel activity from shared servers so in 1:1 DMs the
//     companion can gossip, debrief, and reference what happened in the group.
//
// Everything crossing either bridge is member- or server-authored text riding
// into someone else's prompt — an injection surface. Every interpolated string
// is sanitized via prompt-safety.ts (no value can forge prompt structure), and
// member-attributed items obey the same share-facts consent rule the memory
// lane already enforced: memory opt-in was never consent to being gossiped
// into someone else's DM.

export async function gatherOwnerSubtextForServer(
  store: MemoryStore,
  ownerUserId: string,
  companionId: number,
  maxMemories = 6,
): Promise<string | undefined> {
  const dmScope = `dm:${ownerUserId}`;
  const compSubj = MemoryStore.companionSubjectId(companionId);
  // companionId rides along so this companion's in-fiction story facts keep
  // continuity in the server lane — the vault treats them as private subtext
  // exactly like DM memories, never verbatim.
  const [ownerMemories, compMemories, attrs, dmJournal] = await Promise.all([
    store.relevantMemories(dmScope, ownerUserId, maxMemories, companionId),
    store.relevantMemories(dmScope, compSubj, 3, companionId),
    store.attributesFor(dmScope, ownerUserId),
    // The companion's private-DM journal rides the same confidential-subtext
    // lane as owner memories — first-person beats from 1:1 time together.
    store.journalFor(companionId, dmScope, { limit: 3 }),
  ]);

  const activeAttrs = attrs.filter(a => a.status === "active");
  const activeOwnerMems = ownerMemories.filter(m => m.status === "active");
  const activeCompMems = compMemories.filter(m => m.status === "active");

  const lines: string[] = [];
  if (activeAttrs.length) {
    lines.push(
      `Owner facets from private DMs: ${activeAttrs.map(a => `${promptInline(a.field, 40)}: ${promptInline(a.value, 120)}`).join("; ")}`,
    );
  }
  for (const m of activeOwnerMems.slice(0, maxMemories)) {
    lines.push(`- [Private DM memory] ${promptInline(m.content)}`);
  }
  for (const m of activeCompMems.slice(0, 3)) {
    lines.push(`- [Shared DM moment] ${promptInline(m.content)}`);
  }
  for (const j of dmJournal.slice(0, 3)) {
    lines.push(`- [Your private DM memory] ${promptInline(j.content)}`);
  }

  return lines.length ? lines.join("\n") : undefined;
}

/** Does the member on the other side of an edge consent to their dynamic
 * being gossiped into a companion owner's DM? The recipient's own side and
 * non-member subjects (companions, server lore) are exempt — this gate exists
 * for third-party members, matching the digestFor memory rule. */
async function shareFactsConsented(store: MemoryStore, guildId: string, otherId: string, recipientId: string): Promise<boolean> {
  if (otherId === recipientId || otherId === "server" || otherId.startsWith("companion:")) return true;
  const m = await store.getMember(guildId, otherId).catch(() => undefined);
  return m?.shareFactsWithCompanionOwners === true;
}

export async function gatherServerDigestForDm(
  store: MemoryStore,
  eventStore: EventStore,
  ownerUserId: string,
  companion: Companion,
  resolveGuildName?: (guildId: string) => string | undefined,
): Promise<string | undefined> {
  const guildIds = await store.listCompanionGuilds(companion.id);
  if (!guildIds.length) return undefined;

  const compSubj = MemoryStore.companionSubjectId(companion.id);
  const sections: string[] = [];

  for (const guildId of guildIds.slice(0, 3)) {
    const guildLabel = promptInline(resolveGuildName?.(guildId) ?? `Server ${guildId}`, 80);
    const [eventList, compEdges, ownerEdges, recentMems] = await Promise.all([
      eventStore.listEvents(guildId, { limit: 3 }),
      store.relationshipsFor(guildId, compSubj),
      store.relationshipsFor(guildId, ownerUserId),
      // Active-only + no unknown subjects in SQL — filtering after LIMIT meant
      // a burst of fresh candidates starved the digest to nothing. digestFor
      // restricts subjects to server lore, the owner, companions, and members
      // who explicitly opted into fact-sharing.
      store.recentMemories(guildId, 5, { status: "active", excludeSubjects: ["unknown"], digestFor: ownerUserId }),
    ]);

    const items: string[] = [];
    for (const ev of eventList.events) {
      if (ev.title) {
        items.push(`Event: "${promptInline(ev.title, 120)}"${ev.summary ? ` — ${promptInline(ev.summary)}` : ""}`);
      }
    }

    for (const edge of compEdges.slice(0, 4)) {
      if (!edge.inferred && edge.summary && await shareFactsConsented(store, guildId, edge.otherId, ownerUserId)) {
        const otherName = promptName(await store.displayNameFor(guildId, edge.otherId));
        items.push(`Your dynamic with ${otherName}: "${promptInline(edge.summary)}"${edge.trend ? ` (${promptInline(edge.trend, 80)})` : ""}`);
      }
    }

    for (const edge of ownerEdges.slice(0, 4)) {
      if (edge.otherId === compSubj || edge.subjectId === compSubj) continue;
      const otherId = edge.subjectId === ownerUserId ? edge.otherId : edge.subjectId;
      if (!edge.inferred && edge.summary && await shareFactsConsented(store, guildId, otherId, ownerUserId)) {
        const otherName = promptName(await store.displayNameFor(guildId, otherId));
        items.push(`Owner's dynamic with ${otherName}: "${promptInline(edge.summary)}"`);
      }
    }

    // Unknown-subject claims are excluded in SQL — they're pre-resolution
    // data, inert until claimed, so the digest never surfaces one. The belt-
    // and-braces filter here keeps that true even if a caller drops the flag.
    for (const m of recentMems.filter(m => m.subjectId !== "unknown").slice(0, 3)) {
      items.push(`Server note (${promptName(m.subjectLabel)}): ${promptInline(m.content)}`);
    }

    if (items.length) {
      sections.push(`[${guildLabel}]\n${items.map(i => `  • ${i}`).join("\n")}`);
    }
  }

  return sections.length ? sections.join("\n\n") : undefined;
}
