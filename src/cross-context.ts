import { MemoryStore } from "./database.js";
import type { EventStore } from "./events.js";
import type { Companion } from "./types.js";

// ── Cross-Context Consciousness (DM ↔ Server Bridge) ─────────────────────────
// Two strictly asymmetric bridges connect a user's private 1:1 DM with their
// companion to the friend servers where the companion has been summoned:
//  1. DM → Server (`gatherOwnerSubtextForServer`): pulls high-confidence
//     memories and attributes from `dm:<ownerUserId>` so the companion brings
//     its private bond/subtext into server hangouts without leaking raw secrets.
//  2. Server → DM (`gatherServerDigestForDm`): pulls recent events, relationship
//     edges, and channel activity from shared servers so in 1:1 DMs the
//     companion can gossip, debrief, and reference what happened in the group.

export async function gatherOwnerSubtextForServer(
  store: MemoryStore,
  ownerUserId: string,
  companionId: number,
  maxMemories = 6,
): Promise<string | undefined> {
  const dmScope = `dm:${ownerUserId}`;
  const compSubj = MemoryStore.companionSubjectId(companionId);
  const [ownerMemories, compMemories, attrs, dmJournal] = await Promise.all([
    store.relevantMemories(dmScope, ownerUserId, maxMemories),
    store.relevantMemories(dmScope, compSubj, 3),
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
      `Owner facets from private DMs: ${activeAttrs.map(a => `${a.field}: ${a.value}`).join("; ")}`,
    );
  }
  for (const m of activeOwnerMems.slice(0, maxMemories)) {
    lines.push(`- [Private DM memory] ${m.content}`);
  }
  for (const m of activeCompMems.slice(0, 3)) {
    lines.push(`- [Shared DM moment] ${m.content}`);
  }
  for (const j of dmJournal.slice(0, 3)) {
    lines.push(`- [Your private DM memory] ${j.content}`);
  }

  return lines.length ? lines.join("\n") : undefined;
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
    const guildLabel = resolveGuildName?.(guildId) ?? `Server ${guildId}`;
    const [eventList, compEdges, ownerEdges, recentMems] = await Promise.all([
      eventStore.listEvents(guildId, { limit: 3 }),
      store.relationshipsFor(guildId, compSubj),
      store.relationshipsFor(guildId, ownerUserId),
      store.recentMemories(guildId, 5),
    ]);

    const items: string[] = [];
    for (const ev of eventList.events) {
      if (ev.title) {
        items.push(`Event: "${ev.title}"${ev.summary ? ` — ${ev.summary}` : ""}`);
      }
    }

    for (const edge of compEdges.slice(0, 4)) {
      if (!edge.inferred && edge.summary) {
        const otherName = await store.displayNameFor(guildId, edge.otherId);
        items.push(`Your dynamic with ${otherName}: "${edge.summary}"${edge.trend ? ` (${edge.trend})` : ""}`);
      }
    }

    for (const edge of ownerEdges.slice(0, 4)) {
      if (edge.otherId === compSubj || edge.subjectId === compSubj) continue;
      if (!edge.inferred && edge.summary) {
        const otherId = edge.subjectId === ownerUserId ? edge.otherId : edge.subjectId;
        const otherName = await store.displayNameFor(guildId, otherId);
        items.push(`Owner's dynamic with ${otherName}: "${edge.summary}"`);
      }
    }

    // Unknown-subject claims are pre-resolution data — inert until claimed —
    // so the digest must not surface one even if it reached 'active'.
    for (const m of recentMems.filter(x => x.status === "active" && x.subjectId !== "unknown").slice(0, 3)) {
      items.push(`Server note (${m.subjectLabel}): ${m.content}`);
    }

    if (items.length) {
      sections.push(`[${guildLabel}]\n${items.map(i => `  • ${i}`).join("\n")}`);
    }
  }

  return sections.length ? sections.join("\n\n") : undefined;
}
