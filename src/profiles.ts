import { createHash } from "node:crypto";
import { config } from "./config.js";
import { sql as defaultSql, type Sql } from "./db.js";
import type { Brain } from "./brain.js";
import type { MemoryStore } from "./database.js";
import type { EventStore } from "./events.js";
import type { Dossier, DossierSection, Profile, ProfileSynthesis, ProfileSynthesisInput } from "./types.js";
import { gatherDossierInputs, type DossierInput } from "./dossier.js";
import { buildAliasMap } from "./entity-resolution.js";
import { applyProposals, attributeHash, extractDeterministic, listAttributes, listAttributesForSubjects } from "./attributes.js";
import { logError } from "./secrets.js";
import { inc } from "./metrics.js";

// ── Row types returned by Postgres ────────────────────────────────────────────

type ProfileRow = {
  guild_id: string; subject_id: string; display_name: string;
  summary: string; facets_json: string; source_hash: string; attr_hash: string;
  built_at: Date | string | null; updated_at: Date | string;
};

function ts(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : d;
}

/** Memory IDs that were actually present in a section's input payload. */
function collectSourceIds(payload: Record<string, unknown>): Set<number> {
  const ids = new Set<number>();
  for (const list of ["items", "memories"]) {
    const arr = payload[list];
    if (Array.isArray(arr)) for (const x of arr) {
      if (x && typeof x === "object" && typeof (x as { id?: unknown }).id === "number") ids.add((x as { id: number }).id);
    }
  }
  return ids;
}

/** Drop LLM-invented citations: keep only source_ids that existed in the input. */
function filterSourceIds(data: Record<string, unknown>, validIds: Set<number>): Record<string, unknown> {
  if (!validIds.size) return data;
  const out = { ...data };
  for (const list of ["items", "traits"]) {
    const arr = out[list];
    if (Array.isArray(arr)) {
      out[list] = arr.map(item =>
        item && typeof item === "object" && Array.isArray((item as { source_ids?: unknown }).source_ids)
          ? { ...(item as Record<string, unknown>), source_ids: (item as { source_ids: number[] }).source_ids.filter(id => validIds.has(id)) }
          : item
      );
    }
  }
  return out;
}

/** Degenerate-output detector: models occasionally emit repeated punctuation/glyphs
 * instead of prose. Require real words and some alphanumeric content. */
function looksDegenerate(bio: string): boolean {
  const t = bio.trim();
  const words = t.split(/\s+/).filter(Boolean);
  const alnum = t.replace(/[^a-z0-9]/gi, "");
  return words.length < 5 || alnum.length < 20 || t.startsWith("{") || t.startsWith("[");
}

function rowToProfile(r: ProfileRow): Profile {
  let facets: Profile["facets"] = {};
  try { facets = JSON.parse(r.facets_json); } catch { /* malformed facet JSON → empty facets */ }
  return {
    guildId: r.guild_id, subjectId: r.subject_id, displayName: r.display_name,
    summary: r.summary, facets,
    builtAt: r.built_at ? ts(r.built_at) : null, updatedAt: ts(r.updated_at),
  };
}

// ── ProfileStore ──────────────────────────────────────────────────────────────
// Per-chatter profile cards. buildProfiles() gathers deterministic inputs per
// subject (memories, patterns, relationship edges, events, activity stats),
// hashes them, and only calls the LLM when the inputs have changed.

export class ProfileStore {
  constructor(private sql: Sql = defaultSql) {}

  async getProfile(guildId: string, subjectId: string): Promise<Profile | undefined> {
    // Consent-gated: a straggler profile for a non-opted-in member is invisible
    // everywhere, not just in /profile — defense in depth under the purge.
    const rows = await this.sql<ProfileRow[]>`
      SELECT * FROM profiles WHERE guild_id = ${guildId} AND subject_id = ${subjectId}
        AND subject_id IN (SELECT user_id FROM members WHERE guild_id = ${guildId} AND opted_in = 1 AND opted_out = 0)
    `;
    return rows[0] ? rowToProfile(rows[0]) : undefined;
  }

  async getProfiles(guildId: string, subjectIds: string[]): Promise<Profile[]> {
    if (subjectIds.length === 0) return [];
    const rows = await this.sql<ProfileRow[]>`
      SELECT * FROM profiles WHERE guild_id = ${guildId} AND subject_id = ANY(${subjectIds})
        AND subject_id IN (SELECT user_id FROM members WHERE guild_id = ${guildId} AND opted_in = 1 AND opted_out = 0)
    `;
    return rows.map(rowToProfile);
  }

  /** Public for /opt-out — removes card, dossier sections, and attribute rows.
   * Attributes are pure derived data: deleted, not forgotten. */
  async deleteProfile(guildId: string, subjectId: string): Promise<void> {
    await this.sql`DELETE FROM profiles WHERE guild_id = ${guildId} AND subject_id = ${subjectId}`;
    await this.sql`DELETE FROM profile_attributes WHERE guild_id = ${guildId} AND subject_id = ${subjectId}`;
  }

  /** Top channel and active-hour histograms for a set of members — the two
   *  archive scans the per-member version ran per call, grouped once. Ties
   *  break deterministically (channel/hour ASC) so render hashes don't flap
   *  between equivalent orderings. */
  private async activityStatsFor(guildId: string, userIds: string[]): Promise<Map<string, { topChannel: string | null; activeHours: string }>> {
    const out = new Map<string, { topChannel: string | null; activeHours: string }>();
    if (!userIds.length) return out;
    const channelRows = await this.sql<Array<{ author_id: string; channel_id: string }>>`
      SELECT DISTINCT ON (author_id) author_id, channel_id FROM (
        SELECT author_id, channel_id, COUNT(*) AS c FROM messages
        WHERE guild_id = ${guildId} AND author_id = ANY(${userIds})
        GROUP BY author_id, channel_id
      ) s ORDER BY author_id, c DESC, channel_id ASC
    `;
    const hourRows = await this.sql<Array<{ author_id: string; hour: number }>>`
      SELECT author_id, hour FROM (
        SELECT author_id, EXTRACT(HOUR FROM created_at)::int AS hour, COUNT(*) AS c,
               ROW_NUMBER() OVER (PARTITION BY author_id ORDER BY COUNT(*) DESC, EXTRACT(HOUR FROM created_at) ASC) AS rn
        FROM messages
        WHERE guild_id = ${guildId} AND author_id = ANY(${userIds})
        GROUP BY author_id, EXTRACT(HOUR FROM created_at)
      ) s WHERE rn <= 3
      ORDER BY author_id, c DESC, hour ASC
    `;
    const channelBy = new Map(channelRows.map(r => [r.author_id, r.channel_id]));
    const hoursBy = new Map<string, number[]>();
    for (const r of hourRows) {
      const list = hoursBy.get(r.author_id);
      if (list) list.push(r.hour); else hoursBy.set(r.author_id, [r.hour]);
    }
    for (const id of userIds) {
      const hours = hoursBy.get(id) ?? [];
      out.set(id, {
        topChannel: channelBy.get(id) ?? null,
        activeHours: hours.length ? hours.map(h => `${String(h).padStart(2, "0")}:00`).join(", ") : "unknown",
      });
    }
    return out;
  }

  /** The existing-row triple buildProfiles diffs against, for a whole set. */
  private async profileHashes(guildId: string, subjectIds: string[]): Promise<Map<string, { source_hash: string; attr_hash: string; facets_json: string }>> {
    const out = new Map<string, { source_hash: string; attr_hash: string; facets_json: string }>();
    if (!subjectIds.length) return out;
    const rows = await this.sql<Array<{ subject_id: string; source_hash: string; attr_hash: string; facets_json: string }>>`
      SELECT subject_id, source_hash, attr_hash, facets_json FROM profiles
      WHERE guild_id = ${guildId} AND subject_id = ANY(${subjectIds})
    `;
    for (const r of rows) out.set(r.subject_id, r);
    return out;
  }

  /** Batched consent purge — the sweep runs this for every non-opted member;
   *  two deletes for the whole set instead of two per member. */
  private async deleteProfiles(guildId: string, subjectIds: string[]): Promise<void> {
    if (!subjectIds.length) return;
    await this.sql`DELETE FROM profiles WHERE guild_id = ${guildId} AND subject_id = ANY(${subjectIds})`;
    await this.sql`DELETE FROM profile_attributes WHERE guild_id = ${guildId} AND subject_id = ANY(${subjectIds})`;
  }

  /**
   * Rebuild profile cards for every eligible member of a guild.
   * Eligible = opted in AND (≥1 active memory OR ≥5 recorded messages); members
   * without consent are skipped and any straggler profile is deleted on sight.
   * `opts.onlyUserId` scopes the pass to one member (used by /profile-build).
   */
  async buildProfiles(
    guildId: string,
    brain: Brain,
    memoryStore: MemoryStore,
    eventStore: EventStore,
    model?: string,
    opts?: { excludeIds?: string[]; onlyUserId?: string }
  ): Promise<{ built: number; unchanged: number; considered: number }> {
    let built = 0, unchanged = 0, considered = 0;

    // Interaction graph is guild-wide — compute once, slice per member.
    const aliasMap = await buildAliasMap(guildId, memoryStore);
    const allPairs = await memoryStore.interactionPairs(guildId, aliasMap, {
      excludeIds: opts?.excludeIds ?? [],
      excludeChannels: (await memoryStore.settings(guildId)).ignoredChannels,
    });

    const members = await memoryStore.listMembers(guildId);
    const scoped = opts?.onlyUserId ? members.filter(m => m.userId === opts.onlyUserId) : members;

    // Consent boundary first: straggler profiles/attributes for non-consenting
    // members are purged — batched to two deletes for the guild, not per member.
    const eligible = scoped.filter(m => m.optedIn && !m.optedOut);
    await this.deleteProfiles(guildId, scoped.filter(m => !(m.optedIn && !m.optedOut)).map(m => m.userId));

    // ── Guild-wide prefetch: every read the loop used to run per member,
    //  batched over ANY($ids) — ~15 round-trips per member becomes ~a dozen
    //  total. Order inside each bucket matches the per-member query it
    //  replaces, so fingerprints/hashes don't shift. ─────────────────────────
    const ids = eligible.map(m => m.userId);
    const [activeBy, candBy, patternsBy, edgesBy, statsBy, existingBy, attrsBy, eventsBy] = await Promise.all([
      memoryStore.allActiveMemoriesFor(guildId, ids),
      memoryStore.candidateMemoriesFor(guildId, ids),
      memoryStore.patternsFor(guildId, ids),
      memoryStore.mergedEdgesFor(guildId, ids),
      this.activityStatsFor(guildId, ids),
      this.profileHashes(guildId, ids),
      listAttributesForSubjects(this.sql, guildId, ids),
      eventStore.listEventsForSubjects(guildId, ids, { tier: "event" }),
    ]);

    // Dossier-tier members pull three heavier inputs — prefetched for just them.
    const dossierEligibleIds = eligible
      .filter(m => (activeBy.get(m.userId)?.length ?? 0) >= 3 || m.messageCount >= 50)
      .map(m => m.userId);
    const [samplesBy, obsBy, claimsBy] = await Promise.all([
      memoryStore.sampleMessagesFor(guildId, dossierEligibleIds),
      memoryStore.relationshipObservationsForSubjects(guildId, dossierEligibleIds),
      memoryStore.thirdPartyClaimsFor(guildId, dossierEligibleIds),
    ]);

    // One name resolution for every id a card or section can name — members,
    // edge counterparties, interaction partners, observed parties.
    const nameIds = new Set(ids);
    for (const list of edgesBy.values()) for (const e of list) nameIds.add(e.otherId);
    for (const p of allPairs) { nameIds.add(p.aId); nameIds.add(p.bId); }
    for (const obs of obsBy.values()) for (const o of obs) nameIds.add(o.otherId);
    const names = await memoryStore.displayNamesFor(guildId, [...nameIds]);

    for (const member of eligible) {
      const active = activeBy.get(member.userId) ?? [];
      if (member.messageCount < 5 && active.length === 0) continue;
      considered++;

      const candidatePool = candBy.get(member.userId) ?? [];
      const candidates = candidatePool.filter(m => m.confidence >= 0.5).slice(0, 5);
      const patterns = patternsBy.get(member.userId) ?? [];
      const edgesAll = edgesBy.get(member.userId) ?? [];
      const edges = edgesAll.filter(e => e.observationCount >= 2).slice(0, 8);
      const events = [...(eventsBy.get(member.userId) ?? [])]
        .sort((a, b) => b.significance - a.significance).slice(0, 5);
      const stats = statsBy.get(member.userId) ?? { topChannel: null, activeHours: "unknown" };
      const displayName = names.get(member.userId) ?? member.userId;

      // Attributes are prefetched too — but applyProposals can write between
      // the two reads the flow makes, so the cache refetches lazily whenever
      // an apply actually changed rows (counts > 0).
      let attrsCache = attrsBy.get(member.userId) ?? [];
      let attrsStale = false;
      const readAttrs = async () => {
        if (attrsStale) attrsCache = await listAttributes(this.sql, guildId, member.userId);
        attrsStale = false;
        return attrsCache;
      };
      const noteApplied = (r: { inserted: number; folded: number; revived: number; superseded: number }) => {
        if (r.inserted + r.folded + r.revived + r.superseded > 0) attrsStale = true;
      };

      // The extraction call is bounded by this fingerprint over semantic
      // inputs only — raw activity churn (messageCount, lastSeenAt) is
      // deliberately excluded so a member who just chats costs zero LLM.
      // Stats reach the bio through the render hash instead.
      const fingerprint = [
        member.userId,
        ...active.map(m => `m${m.id}:${m.updatedAt}`),
        ...candidates.map(m => `c${m.id}:${m.updatedAt}`),
        ...patterns.map(p => `p${p.id}:${p.updatedAt}`),
        ...edges.map(e => `r${e.otherId}:${e.observationCount}:${e.lastObservedAt}`),
        ...events.map(e => `e${e.id}`),
      ].join("|");
      const sourceHash = createHash("sha256").update(fingerprint).digest("hex");

      const existingRow = existingBy.get(member.userId);
      const existing = existingRow ? [existingRow] : [];
      let existingFacets: Profile["facets"] = {};
      try { existingFacets = JSON.parse(existing[0]?.facets_json ?? "{}"); } catch { /* malformed JSON → rebuild */ }
      const sections: Dossier["sections"] = { ...(existingFacets.dossier?.sections ?? {}) };

      // ── Dossier inputs (tier 2) — gathered before the card early-out so
      // section changes alone can trigger a rebuild.
      const dossierEligible = active.length >= 3 || member.messageCount >= 50;
      const memberInteractions = allPairs
        .filter(p => p.aId === member.userId || p.bId === member.userId)
        .map(p => ({ otherId: p.aId === member.userId ? p.bId : p.aId, count: p.count }));
      const dossierInputs = dossierEligible
        ? await gatherDossierInputs(guildId, member, memoryStore, eventStore, {
            interactions: memberInteractions,
            preActive: active, preCandidates: candidatePool, prePatterns: patterns,
            preEdges: edgesAll, preEvents: eventsBy.get(member.userId) ?? [],
            preNames: names,
            preSamples: samplesBy.get(member.userId) ?? [],
            preObservations: obsBy.get(member.userId) ?? [],
            preClaims: claimsBy.get(member.userId) ?? [],
          })
        : new Map<DossierSection, DossierInput>();

      // Sections whose inputs vanished are dropped; unchanged hashes are kept.
      for (const key of Object.keys(sections) as DossierSection[]) {
        if (!dossierInputs.has(key)) delete sections[key];
      }
      const toBuild = [...dossierInputs.values()].filter(i => sections[i.section]?.hash !== i.hash);

      const cardChanged = existing[0]?.source_hash !== sourceHash;

      // ── Tier 0: structured attributes — the source of truth ──────────────
      // Deterministic extraction runs every pass: pure code, free, idempotent
      // via the upsert-diff, and the catch-all for every activation path plus
      // the lazy backfill for memories that predate this feature.
      const detProposals = active.flatMap(m => extractDeterministic({ id: m.id, kind: m.kind, content: m.content }));
      // A DB error here must fail this member's pass, not the guild's build.
      if (detProposals.length) {
        try { noteApplied(await applyProposals(this.sql, guildId, member.userId, detProposals)); }
        catch (error) { logError(`Attribute upsert failed for ${member.userId}`, error); }
      }

      // LLM extraction is gated: memory-fingerprint change, or the member has
      // never been through extraction (attr_hash unset = first pass / lazy
      // backfill). Citations are validated ⊆ input; zero-citation and
      // candidate-only proposals are dropped — an uncitable facet is exactly
      // the failure this table exists to kill.
      const extractionInput = [
        ...active.slice(0, 15).map(m => ({ id: m.id, content: m.content, kind: m.kind, confirmed: true })),
        ...candidates.map(m => ({ id: m.id, content: m.content, kind: m.kind, confirmed: false })),
      ];
      const neverExtracted = (existing[0]?.attr_hash ?? "") === "";
      if ((cardChanged || neverExtracted) && extractionInput.length) {
        try {
          const attrsNow = await readAttrs();
          const raw = await brain.extractAttributes({
            displayName,
            memories: extractionInput,
            currentAttributes: attrsNow.filter(a => a.status === "active").map(a => ({ field: a.field, value: a.value })),
          }, model);
          const validIds = new Set(extractionInput.map(m => m.id));
          const activeIds = new Set(active.map(m => m.id));
          const proposals = raw
            .map(p => ({ ...p, memoryIds: p.memoryIds.filter(id => validIds.has(id)) }))
            .filter(p => p.memoryIds.length > 0)
            .filter(p => p.memoryIds.some(id => activeIds.has(id)));
          if (proposals.length) noteApplied(await applyProposals(this.sql, guildId, member.userId, proposals));
        } catch (error) {
          // Model flakiness — attributes just stay as they are. Counted so a
          // systematic failure is distinguishable from "nothing changed".
          inc("profiles.extract_error");
          logError(`attribute extraction failed for u:${member.userId}`, error);
        }
      }

      // ── Render gate: the bio re-renders when the attribute set or the
      // context feeding it changes — not on raw activity churn. ────────────
      const attrs = await readAttrs();
      // Only active attributes render — contested stays visible in admin
      // triage but never presents as fact in a profile.
      const liveAttrs = attrs.filter(a => a.status === "active");
      const renderHash = attributeHash(attrs, [
        ...patterns.map(p => `p${p.id}:${p.updatedAt}`),
        ...edges.map(e => `r${e.otherId}:${e.observationCount}:${e.lastObservedAt}`),
        ...events.map(e => `e${e.id}`),
        `ch:${stats.topChannel ?? ""}`, `hr:${stats.activeHours}`,
      ]);
      const renderChanged = existing[0]?.attr_hash !== renderHash;

      if (!cardChanged && !renderChanged && toBuild.length === 0) { unchanged++; continue; }

      // ── Tier 1: card — prose rendered from the structured set ────────────
      const edgeNames = new Map<string, string>();
      for (const e of edges) edgeNames.set(e.otherId, names.get(e.otherId) ?? e.otherId);

      let cardResult: ProfileSynthesis | undefined;
      if (renderChanged || !existing[0]) {
        const input: ProfileSynthesisInput = {
          displayName,
          stats: {
            messageCount: member.messageCount,
            firstSeenAt: member.firstSeenAt, lastSeenAt: member.lastSeenAt,
            topChannel: stats.topChannel, activeHours: stats.activeHours,
          },
          attributes: liveAttrs.map(a => ({ field: a.field, value: a.value, confidence: a.confidence })),
          patterns: patterns.map(p => p.description),
          relationships: edges.map(e => ({
            withName: edgeNames.get(e.otherId) ?? "unknown",
            summary: e.summary, valence: e.valence, observations: e.observationCount,
          })),
          events: events.map(e => ({
            title: e.title || `Event #${e.id}`,
            role: e.participants.find(p => p.userId === member.userId)?.role ?? "participant",
            significance: e.significance,
          })),
        };

        try {
          cardResult = await brain.synthesizeProfile(input, model);
          if (looksDegenerate(cardResult.bio)) cardResult = await brain.synthesizeProfile(input, model);
        } catch (error) {
          // Model flakiness (json_validate_failed, loops) — fall through to
          // the deterministic bio; still surface it.
          inc("profiles.synthesize_error");
          logError(`profile synthesis failed for u:${member.userId}`, error);
        }
        if (cardResult && looksDegenerate(cardResult.bio)) cardResult = undefined;
        if (!cardResult && !existing[0]) {
          cardResult = {
            bio: `${displayName} has posted ${input.stats.messageCount} messages between ${input.stats.firstSeenAt ?? "unknown"} and ${input.stats.lastSeenAt ?? "unknown"}.`,
            roleInServer: "",
          };
        }
      }

      // ── Tier 2: dossier sections ──────────────────────────────────────────
      for (const sectionInput of toBuild) {
        const builtAt = new Date().toISOString();
        if (sectionInput.section === "timeline") {
          sections.timeline = { hash: sectionInput.hash, builtAt, data: sectionInput.payload };
          continue;
        }
        const validIds = collectSourceIds(sectionInput.payload);
        const sectionModel = config.dossierModel ?? model;
        try {
          let data = await brain.synthesizeDossierSection(sectionInput.section, displayName, sectionInput.payload, sectionModel);
          if (typeof data.prose === "string" && looksDegenerate(data.prose)) {
            data = await brain.synthesizeDossierSection(sectionInput.section, displayName, sectionInput.payload, sectionModel);
          }
          if (typeof data.prose === "string" && looksDegenerate(data.prose)) continue; // keep old section
          if (sectionInput.section === "voice") data = { ...data, stats: sectionInput.payload.stats };
          sections[sectionInput.section] = { hash: sectionInput.hash, builtAt, data: filterSourceIds(data, validIds) };
        } catch (error) {
          // Keep previous section data on failure — but make the failure
          // visible (a bad dossierModel would otherwise skip sections forever).
          inc("profiles.dossier_error");
          logError(`dossier ${sectionInput.section} synthesis failed for u:${member.userId}`, error);
        }
        await new Promise(r => setTimeout(r, 800)); // pace section calls for Groq TPM
      }

      // Facets assemble deterministically: traits/interests from live
      // attributes, notable relationships from verified edges.
      const facets: Profile["facets"] = {
        traits: liveAttrs.filter(a => a.field === "trait").map(a => a.value),
        interests: liveAttrs.filter(a => a.field === "interest").map(a => a.value),
        notableRelationships: edges.slice(0, 5).map(e => `${edgeNames.get(e.otherId) ?? "unknown"} — ${e.summary || "observed dynamic"}`),
        roleInServer: cardResult?.roleInServer ?? existingFacets.roleInServer ?? "",
        dossier: { sections },
      };
      const summary = cardResult?.bio ?? (existing[0] ? undefined : "");
      if (cardResult || !existing[0]) {
        await this.sql`
          INSERT INTO profiles (guild_id, subject_id, display_name, summary, facets_json, source_hash, attr_hash, built_at, updated_at)
          VALUES (${guildId}, ${member.userId}, ${displayName}, ${summary ?? ""}, ${JSON.stringify(facets)}, ${sourceHash}, ${renderHash}, NOW(), NOW())
          ON CONFLICT (guild_id, subject_id) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            summary      = EXCLUDED.summary,
            facets_json  = EXCLUDED.facets_json,
            source_hash  = EXCLUDED.source_hash,
            attr_hash    = EXCLUDED.attr_hash,
            built_at     = EXCLUDED.built_at,
            updated_at   = NOW()
        `;
      } else {
        // Card unchanged — refresh facets/dossier + hashes, preserve summary + built_at.
        await this.sql`
          UPDATE profiles SET display_name = ${displayName}, facets_json = ${JSON.stringify(facets)}, source_hash = ${sourceHash}, attr_hash = ${renderHash}, updated_at = NOW()
          WHERE guild_id = ${guildId} AND subject_id = ${member.userId}
        `;
      }
      built++;
    }

    return { built, unchanged, considered };
  }
}
