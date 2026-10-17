import { randomInt } from "node:crypto";
import type { AttributeStatus, Companion, CompanionAdoption, CompanionListing, CompanionSpec, EvidenceEffect, EvidenceType, GuildCompanion, JournalCandidate, JournalEntry, Member, MemoryCandidate, MemoryStatus, MessageEvent, OnboardingState, ProfileAttribute, RelationshipEdge, VerificationVerdict, WebhookMessageRecord } from "./types.js";
import { sql as defaultSql, type Sql } from "./db.js";
import { runMigrations } from "./migrations.js";
import { findMentionedUsers } from "./entity-resolution.js";
import { calculateInitialConfidence, updateConfidence, calculateDefaultImportance, calculateDefaultExplicitness } from "./confidence.js";
import { contentPolarity, listAttributes, listAttributesForSubjects, listContestedAttributes, recomputeForMemories, transferProvenance } from "./attributes.js";

/** Cap on members.known_names — unbounded growth would inflate the alias map
 * and every per-message regex built from it. Oldest names are evicted. */
const MAX_KNOWN_NAMES = 32;

/** Escape ILIKE wildcards in user/model-controlled query fragments — a bare
 * "%" would enumerate every row (bounded by LIMIT, but still a loose read). */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, c => `\\${c}`);

export type Memory = Omit<MemoryCandidate, "confidence" | "importance" | "explicitness"> & {
  // DB columns are NOT NULL, so these are always present on a persisted Memory.
  confidence: number;
  importance: number;
  explicitness: number;
  id: number; guildId: string; status: MemoryStatus; mentions: number;
  createdAt: string; updatedAt: string; lastConfirmedAt: string; lastContradictedAt: string | null;
  confirmationCount: number; contradictionCount: number; supersededBy: number | null; supersedesMemoryId: number | null;
  // Phase 1C additions (nullable — populated once contested or pattern-linked).
  netScore: number | null; frozenConfidence: number | null; patternId: number | null;
  // The evidence type of the first piece of evidence that created this memory. Used by the bulk
  // promotion path in maintain() to enforce the same gate as the per-insert promotableTypes check.
  primaryEvidenceType: string;
  // v0.2 — nullable FK to the event this memory was generated from or linked to.
  eventId: number | null;
  // v0.2 — display name of the subject at the time the memory was created.
  subjectName: string;
};
export type BehavioralPattern = { id: number; guildId: string; subjectId: string; description: string; episodeCount: number; confidence: number; createdAt: string; updatedAt: string; status: string };
export type MemoryEvidence = { id: number; memoryId: number; messageId: string; authorId: string; quote: string; reason: string; explicitness: number; observedAt: string; evidenceType: string; effect: string; messageContentSnapshot: string; messageTimestamp: string; createdAt: string };
export type MemoryHistory = { id: number; memoryId: number; action: string; previousConfidence: number | null; newConfidence: number | null; previousStatus: MemoryStatus | null; newStatus: MemoryStatus | null; evidenceId: number | null; detailsJson: string; createdAt: string };

// ── Row types returned by Postgres ────────────────────────────────────────────

type MemoryRow = {
  id: number; guild_id: string; subject_id: string; subject_name: string;
  kind: string; content: string; confidence: number; importance: number;
  mentions: number; confirmation_count: number; contradiction_count: number;
  created_at: Date | string; updated_at: Date | string;
  last_confirmed_at: Date | string; last_contradicted_at: Date | string | null;
  status: string; superseded_by: number | null; supersedes_memory_id: number | null;
  explicitness: number; reason: string; net_score: number | null;
  frozen_confidence: number | null; pattern_id: number | null;
  primary_evidence_type: string; event_id: number | null;
};

type EvidenceRow = {
  id: number; memory_id: number; message_id: string; author_id: string;
  quote: string; reason: string; explicitness: number;
  observed_at: Date | string; evidence_type: string; effect: string;
  message_content_snapshot: string; message_timestamp: Date | string; created_at: Date | string;
};

type HistoryRow = {
  id: number; memory_id: number; action: string;
  previous_confidence: number | null; new_confidence: number | null;
  previous_status: string | null; new_status: string | null;
  evidence_id: number | null; details_json: string; created_at: Date | string;
};

type MessageRow = {
  id: string; guild_id: string; channel_id: string; author_id: string;
  author_name: string; content: string; created_at: Date | string;
};

type SettingsRow = { guild_id: string; memory_enabled: number; reply_enabled: number; proactive_enabled: number; raw_retention_days: number; announced_at: Date | string | null; ignored_channels: string[] | null; llm_daily_cap: number };

/** Public settings shape — server_settings projected to camelCase. */
export type Settings = { guildId: string; memoryEnabled: number; replyEnabled: number; proactiveEnabled: number; rawRetentionDays: number; announcedAt: string | null; ignoredChannels: string[]; llmDailyCap: number };

type MemberRow = {
  guild_id: string; user_id: string; known_names: string[];
  first_seen_at: Date | string; last_seen_at: Date | string;
  message_count: number; opted_out: number; opted_in: number;
};

type RelationshipRow = {
  id: number; guild_id: string; subject_id: string; other_id: string;
  summary: string; valence: number | null; observation_count: number;
  last_observed_at: Date | string | null; updated_at: Date | string;
  behavioral_count: number; party_count: number; trend: string | null; inferred: number;
};

function rowToEdge(r: RelationshipRow): RelationshipEdge {
  return {
    id: Number(r.id), guildId: r.guild_id, subjectId: r.subject_id, otherId: r.other_id,
    summary: r.summary, valence: r.valence != null ? Number(r.valence) : null,
    observationCount: Number(r.observation_count),
    lastObservedAt: r.last_observed_at ? ts(r.last_observed_at) : null,
    updatedAt: ts(r.updated_at),
    behavioralCount: Number(r.behavioral_count), partyCount: Number(r.party_count),
    trend: r.trend, inferred: !!r.inferred,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ts(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : d;
}

function rowToMember(r: MemberRow): Member {
  return {
    guildId: r.guild_id, userId: r.user_id, knownNames: r.known_names ?? [],
    firstSeenAt: ts(r.first_seen_at), lastSeenAt: ts(r.last_seen_at),
    messageCount: Number(r.message_count), optedOut: Number(r.opted_out) === 1,
    optedIn: Number(r.opted_in ?? 0) === 1,
  };
}

function rowToMemory(r: MemoryRow): Memory {
  return {
    id: Number(r.id), guildId: r.guild_id, subjectId: r.subject_id, subjectName: r.subject_name,
    kind: r.kind as Memory["kind"], content: r.content, confidence: Number(r.confidence),
    importance: Number(r.importance), explicitness: Number(r.explicitness),
    mentions: Number(r.mentions), confirmationCount: Number(r.confirmation_count),
    contradictionCount: Number(r.contradiction_count),
    createdAt: ts(r.created_at), updatedAt: ts(r.updated_at),
    lastConfirmedAt: ts(r.last_confirmed_at),
    lastContradictedAt: r.last_contradicted_at ? ts(r.last_contradicted_at) : null,
    status: r.status as MemoryStatus,
    supersededBy: r.superseded_by != null ? Number(r.superseded_by) : null,
    supersedesMemoryId: r.supersedes_memory_id != null ? Number(r.supersedes_memory_id) : null,
    netScore: r.net_score != null ? Number(r.net_score) : null,
    frozenConfidence: r.frozen_confidence != null ? Number(r.frozen_confidence) : null,
    patternId: r.pattern_id != null ? Number(r.pattern_id) : null,
    primaryEvidenceType: r.primary_evidence_type,
    eventId: r.event_id != null ? Number(r.event_id) : null,
    reason: r.reason,
  };
}

// ── MemoryStore ───────────────────────────────────────────────────────────────

// pg_trgm similarity thresholds for near-duplicate dedup in saveMemory().
// ≥ MATCH: evidence attaches to the existing row. ≥ NEAR_MISS (but < MATCH): the
// new row is still created and a dedup_near_miss history entry records the score
// for threshold tuning.
const TRIGRAM_MATCH_THRESHOLD = 0.6;
const TRIGRAM_NEAR_MISS_THRESHOLD = 0.4;

// Only high-quality evidence types may promote a candidate to active — or ride the
// fuzzy-dedup fast-path. Sarcasm, rumour, and uncertain inferences are excluded
// regardless of confidence.
const PROMOTABLE_EVIDENCE_TYPES: EvidenceType[] = ["explicit_fact", "clear_preference", "correction"];

export class MemoryStore {
  private constructor(private sql: Sql) {}

  static async create(sql: Sql = defaultSql): Promise<MemoryStore> {
    await runMigrations(sql);
    return new MemoryStore(sql);
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  private async ensureSettings(guildId: string, retentionDays = 30): Promise<void> {
    if (guildId.startsWith("dm:")) {
      await this.sql`
        INSERT INTO server_settings (guild_id, memory_enabled, reply_enabled, raw_retention_days)
        VALUES (${guildId}, 1, 1, ${retentionDays})
        ON CONFLICT (guild_id) DO NOTHING
      `;
      return;
    }
    await this.sql`
      INSERT INTO server_settings (guild_id, raw_retention_days) VALUES (${guildId}, ${retentionDays})
      ON CONFLICT (guild_id) DO NOTHING
    `;
  }

  // settings() runs on every message, so it's cached per guild; setPaused is the
  // only writer and invalidates. The TTL bounds staleness from out-of-band edits.
  private settingsCache = new Map<string, { value: Settings; at: number }>();

  async settings(guildId: string, defaultRetentionDays = 30): Promise<Settings> {
    const cached = this.settingsCache.get(guildId);
    if (cached && Date.now() - cached.at < 60_000) return cached.value;
    await this.ensureSettings(guildId, defaultRetentionDays);
    const rows = await this.sql<SettingsRow[]>`SELECT guild_id, memory_enabled, reply_enabled, proactive_enabled, raw_retention_days, announced_at, ignored_channels, llm_daily_cap FROM server_settings WHERE guild_id = ${guildId}`;
    const r = rows[0];
    const value = { guildId: r.guild_id, memoryEnabled: Number(r.memory_enabled), replyEnabled: Number(r.reply_enabled), proactiveEnabled: Number(r.proactive_enabled), rawRetentionDays: Number(r.raw_retention_days), announcedAt: r.announced_at ? ts(r.announced_at) : null, ignoredChannels: r.ignored_channels ?? [], llmDailyCap: Number(r.llm_daily_cap) };
    this.settingsCache.set(guildId, { value, at: Date.now() });
    return value;
  }

  /** Stamp the join disclosure as delivered. Returns false when the settings
   * row doesn't exist — the caller retries on the next GuildCreate. */
  async markAnnounced(guildId: string): Promise<boolean> {
    const rows = await this.sql`UPDATE server_settings SET announced_at = now() WHERE guild_id = ${guildId} RETURNING guild_id`;
    this.settingsCache.delete(guildId);
    return rows.length > 0;
  }

  async setPaused(guildId: string, paused: boolean, defaultRetentionDays = 30): Promise<void> {
    await this.ensureSettings(guildId, defaultRetentionDays);
    const v = paused ? 0 : 1;
    await this.sql`UPDATE server_settings SET memory_enabled = ${v}, reply_enabled = ${v} WHERE guild_id = ${guildId}`;
    this.settingsCache.delete(guildId);
  }

  /** Channels the bot treats as fully invisible — no archive, replies, or
   * member writes there, and server-build scans skip them. */
  async setIgnoredChannels(guildId: string, channelIds: string[], defaultRetentionDays = 30): Promise<void> {
    await this.ensureSettings(guildId, defaultRetentionDays);
    await this.sql`UPDATE server_settings SET ignored_channels = ${channelIds} WHERE guild_id = ${guildId}`;
    this.settingsCache.delete(guildId);
  }

  /** Per-guild daily LLM-call bound — enforced by the metered client in
   * brains.ts against guild_usage, for every key source (guild or env). */
  async setDailyCap(guildId: string, cap: number, defaultRetentionDays = 30): Promise<void> {
    await this.ensureSettings(guildId, defaultRetentionDays);
    await this.sql`UPDATE server_settings SET llm_daily_cap = ${cap} WHERE guild_id = ${guildId}`;
    this.settingsCache.delete(guildId);
  }

  /** Atomic per-guild daily LLM-call charge. The INSERT..ON CONFLICT takes the
   * (guild_id, day) row lock, so concurrent charges serialize — the counter can
   * never overshoot the cap. Days are UTC so the BudgetExceeded reschedule
   * (next UTC midnight) matches the counter reset. Returns ok=false without
   * incrementing when the guild is already at/over cap. */
  async chargeLlmCall(guildId: string, cap: number): Promise<{ ok: boolean; used: number; cap: number }> {
    if (cap <= 0) return { ok: false, used: 0, cap };
    const rows = await this.sql<Array<{ llm_calls: number }>>`
      INSERT INTO guild_usage (guild_id, day, llm_calls)
      VALUES (${guildId}, (now() AT TIME ZONE 'UTC')::date, 1)
      ON CONFLICT (guild_id, day) DO UPDATE SET llm_calls = guild_usage.llm_calls + 1
      WHERE guild_usage.llm_calls < ${cap}
      RETURNING llm_calls
    `;
    return rows.length ? { ok: true, used: rows[0].llm_calls, cap } : { ok: false, used: cap, cap };
  }

  async usageToday(guildId: string): Promise<number> {
    const rows = await this.sql<Array<{ llm_calls: number }>>`
      SELECT llm_calls FROM guild_usage WHERE guild_id = ${guildId} AND day = (now() AT TIME ZONE 'UTC')::date
    `;
    return rows[0]?.llm_calls ?? 0;
  }

  /** Queue visibility for /status + the ops console — pending work,
   * dead-lettered rows (attempts >= 5: excluded from claiming but kept
   * inspectable), and the oldest pending job's age so a draining-but-stale
   * queue is visible. `null` guildId = fleet-wide (the host's view). */
  async queueStats(guildId: string | null): Promise<{ pending: number; dead: number; oldestPendingAt: Date | null }> {
    const rows = await this.sql<Array<{ pending: number; dead: number; oldest: Date | string | null }>>`
      SELECT count(*) FILTER (WHERE attempts < 5)::int AS pending,
             count(*) FILTER (WHERE attempts >= 5)::int AS dead,
             min(created_at) FILTER (WHERE attempts < 5) AS oldest
      FROM jobs WHERE (${guildId}::text IS NULL OR guild_id = ${guildId})
    `;
    const r = rows[0];
    return { pending: r?.pending ?? 0, dead: r?.dead ?? 0, oldestPendingAt: r?.oldest ? new Date(r.oldest) : null };
  }

  /** Reconcile triage marks against job reality. 'queued'/'durable'/'regex'
   * only mean "extraction was requested" — the mark is the source of truth the
   * sweep reads, the job row is the source of truth for whether work exists.
   * Three corrections:
   *   1. any extraction-marked message with a live job → 'queued' (canonical;
   *      also dedupes the enqueue-succeeded-but-mark-write-failed window)
   *   2. 'queued' whose only jobs are dead-lettered → 'dead': terminal for the
   *      sweep, still reachable by /profile-build's <> 'extracted' scan, and
   *      overwritten by 'extracted' if the job is later re-driven
   *   3. 'queued' with no job at all (dormant-drop, crash windows) → 'durable'
   *      so the sweep re-enqueues it — listUninspectedMessages reads
   *      durable/regex marks at any age, so no window can strand them */
  async repairQueuedMarks(guildId: string): Promise<{ rejoined: number; dead: number; requeued: number }> {
    return this.sql.begin(async sql => {
      const joined = await sql<Array<{ n: number }>>`
        WITH upd AS (
          UPDATE messages m SET triage_result = 'queued'
          WHERE m.guild_id = ${guildId} AND m.triage_result IN ('durable', 'regex')
            AND EXISTS (
              SELECT 1 FROM jobs j
              WHERE j.guild_id = m.guild_id AND j.attempts < 5
                AND j.payload->'event'->>'messageId' = m.id
            )
          RETURNING 1
        ) SELECT count(*)::int AS n FROM upd
      `;
      const deadRows = await sql<Array<{ n: number }>>`
        WITH upd AS (
          UPDATE messages m SET triage_result = 'dead'
          WHERE m.guild_id = ${guildId} AND m.triage_result = 'queued'
            AND NOT EXISTS (
              SELECT 1 FROM jobs j
              WHERE j.guild_id = m.guild_id AND j.attempts < 5
                AND j.payload->'event'->>'messageId' = m.id
            )
            AND EXISTS (
              SELECT 1 FROM jobs j
              WHERE j.guild_id = m.guild_id AND j.attempts >= 5
                AND j.payload->'event'->>'messageId' = m.id
            )
          RETURNING 1
        ) SELECT count(*)::int AS n FROM upd
      `;
      const requeueRows = await sql<Array<{ n: number }>>`
        WITH upd AS (
          UPDATE messages m SET triage_result = 'durable'
          WHERE m.guild_id = ${guildId} AND m.triage_result = 'queued'
            AND NOT EXISTS (
              SELECT 1 FROM jobs j
              WHERE j.guild_id = m.guild_id
                AND j.payload->'event'->>'messageId' = m.id
            )
          RETURNING 1
        ) SELECT count(*)::int AS n FROM upd
      `;
      return { rejoined: joined[0]?.n ?? 0, dead: deadRows[0]?.n ?? 0, requeued: requeueRows[0]?.n ?? 0 };
    });
  }

  // ── Guild LLM keys (BYOK) ────────────────────────────────────────────────────
  // key_enc is AES-256-GCM ciphertext (secrets.ts) — never log or return it to
  // Discord. key_hint (last-4) is the only plaintext remnant, for masked display.

  async getGuildKey(guildId: string): Promise<{ keyEnc: Buffer; keyHint: string; baseUrl: string | null; model: string | null; validatedAt: string | null } | null> {
    const rows = await this.sql<Array<{ key_enc: Buffer; key_hint: string; base_url: string | null; model: string | null; validated_at: Date | string | null }>>`
      SELECT key_enc, key_hint, base_url, model, validated_at FROM guild_keys WHERE guild_id = ${guildId}
    `;
    const r = rows[0];
    return r ? { keyEnc: r.key_enc, keyHint: r.key_hint, baseUrl: r.base_url, model: r.model, validatedAt: r.validated_at ? ts(r.validated_at) : null } : null;
  }

  async upsertGuildKey(guildId: string, key: { keyEnc: Buffer; keyHint: string; baseUrl: string | null; model?: string | null; validatedAt: string | null }): Promise<void> {
    await this.sql`
      INSERT INTO guild_keys (guild_id, key_enc, key_hint, base_url, model, validated_at)
      VALUES (${guildId}, ${key.keyEnc}, ${key.keyHint}, ${key.baseUrl}, ${key.model ?? null}, ${key.validatedAt})
      ON CONFLICT (guild_id) DO UPDATE
      SET key_enc = ${key.keyEnc}, key_hint = ${key.keyHint}, base_url = ${key.baseUrl},
          model = ${key.model ?? null}, validated_at = ${key.validatedAt}, updated_at = now()
    `;
  }

  /** Mark a stored key live-verified — set after the first successful use. */
  async markGuildKeyValidated(guildId: string): Promise<void> {
    await this.sql`UPDATE guild_keys SET validated_at = now() WHERE guild_id = ${guildId} AND validated_at IS NULL`;
  }

  async deleteGuildKey(guildId: string): Promise<void> {
    await this.sql`DELETE FROM guild_keys WHERE guild_id = ${guildId}`;
  }

  /** Kick-purge: delete EVERY row belonging to a guild, in FK-dependency
   * order, in one transaction. Called on GuildDelete (bot kicked/removed) —
   * "kick the bot, your data goes with it." memory_history, the event junction
   * tables, and memory_evidence carry no guild_id — they delete through their
   * parent keys. Junction/history deletes match on EITHER parent's guild so
   * legacy cross-guild links can't strand an FK. memories.event_id,
   * memory_evidence.message_id, memories.superseded_by and
   * profile_attributes.memory_ids are unfenced — no ordering hazard. */
  async purgeGuild(guildId: string): Promise<void> {
    await this.sql.begin(async tx => {
      // Children of memories/events first (no guild_id on these tables).
      await tx`DELETE FROM memory_history WHERE memory_id IN (SELECT id FROM memories WHERE guild_id = ${guildId})
        OR evidence_id IN (SELECT id FROM memory_evidence WHERE memory_id IN (SELECT id FROM memories WHERE guild_id = ${guildId}))`;
      await tx`DELETE FROM event_memories WHERE event_id IN (SELECT id FROM events WHERE guild_id = ${guildId})
        OR memory_id IN (SELECT id FROM memories WHERE guild_id = ${guildId})`;
      await tx`DELETE FROM event_participants WHERE event_id IN (SELECT id FROM events WHERE guild_id = ${guildId})`;
      await tx`DELETE FROM event_messages WHERE event_id IN (SELECT id FROM events WHERE guild_id = ${guildId})`;
      await tx`DELETE FROM memory_evidence WHERE memory_id IN (SELECT id FROM memories WHERE guild_id = ${guildId})`;
      // Parents, then every guild-scoped table.
      await tx`DELETE FROM memories WHERE guild_id = ${guildId}`;
      await tx`DELETE FROM events WHERE guild_id = ${guildId}`;
      await tx`DELETE FROM profile_attributes WHERE guild_id = ${guildId}`;
      await tx`DELETE FROM profiles WHERE guild_id = ${guildId}`;
      await tx`DELETE FROM relationship_observations WHERE guild_id = ${guildId}`;
      await tx`DELETE FROM relationships WHERE guild_id = ${guildId}`;
      await tx`DELETE FROM behavioral_patterns WHERE guild_id = ${guildId}`;
      await tx`DELETE FROM alias_candidates WHERE guild_id = ${guildId}`;
      await tx`DELETE FROM unresolved_names WHERE guild_id = ${guildId}`;
      await tx`DELETE FROM members WHERE guild_id = ${guildId}`;
      await tx`DELETE FROM companion_journal WHERE origin_scope = ${guildId}`;
      await tx`DELETE FROM messages WHERE guild_id = ${guildId}`;
      await tx`DELETE FROM webhook_messages WHERE guild_id = ${guildId}`;
      await tx`DELETE FROM guild_companions WHERE guild_id = ${guildId}`;
      await tx`DELETE FROM guild_keys WHERE guild_id = ${guildId}`;
      // Queued jobs and usage counters are guild-scoped too — a kicked guild
      // leaves nothing behind, including pending work.
      await tx`DELETE FROM jobs WHERE guild_id = ${guildId}`;
      await tx`DELETE FROM guild_usage WHERE guild_id = ${guildId}`;
      await tx`DELETE FROM server_settings WHERE guild_id = ${guildId}`;
    });
    this.settingsCache.delete(guildId);
  }

  /** Guild ids present in guild-scoped tables but absent from the given set —
   * zombies left when an in-flight write races a kick-purge and re-inserts a
   * row after it commits: a maintenance tick's ensureSettings/setMemberOptIn,
   * or an extract job claimed before the purge that lands memories, events,
   * relationship observations, or attributes afterward. Caller is
   * responsible for passing a populated cache — an empty set is treated as
   * "cache not ready" and returns nothing. Excludes `dm:` scopes since 1:1 DMs
   * are not Discord guilds in `client.guilds.cache`. */
  async guildsNotIn(guildIds: string[]): Promise<string[]> {
    if (!guildIds.length) return [];
    const rows = await this.sql<{ guild_id: string }[]>`
      SELECT guild_id FROM server_settings WHERE NOT (guild_id = ANY(${guildIds})) AND guild_id NOT LIKE 'dm:%'
      UNION SELECT guild_id FROM members WHERE NOT (guild_id = ANY(${guildIds})) AND guild_id NOT LIKE 'dm:%'
      UNION SELECT guild_id FROM memories WHERE NOT (guild_id = ANY(${guildIds})) AND guild_id NOT LIKE 'dm:%'
      UNION SELECT guild_id FROM events WHERE NOT (guild_id = ANY(${guildIds})) AND guild_id NOT LIKE 'dm:%'
      UNION SELECT guild_id FROM relationship_observations WHERE NOT (guild_id = ANY(${guildIds})) AND guild_id NOT LIKE 'dm:%'
      UNION SELECT guild_id FROM profile_attributes WHERE NOT (guild_id = ANY(${guildIds})) AND guild_id NOT LIKE 'dm:%'
      UNION SELECT guild_id FROM jobs WHERE NOT (guild_id = ANY(${guildIds})) AND guild_id NOT LIKE 'dm:%'
      UNION SELECT origin_scope FROM companion_journal WHERE NOT (origin_scope = ANY(${guildIds})) AND origin_scope NOT LIKE 'dm:%'`;
    return rows.map(r => r.guild_id);
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  async recordMessage(event: MessageEvent, replyToId?: string, trackMember = true, authorIsBot = false): Promise<void> {
    // Insert-only dedup: a conflict means the message was already archived
    // (re-ingest), so member stats must not double-count. Name/seen-at merges
    // still run — they're idempotent by construction.
    const inserted = await this.sql`
      INSERT INTO messages (id, guild_id, channel_id, author_id, author_name, content, created_at, reply_to_id, author_is_bot)
      VALUES (${event.messageId}, ${event.guildId}, ${event.channelId}, ${event.authorId}, ${event.authorName}, ${event.content}, ${event.createdAt.toISOString()}, ${replyToId ?? null}, ${authorIsBot})
      ON CONFLICT (id) DO NOTHING
    `;
    if (inserted.count === 0 && replyToId) {
      // Pre-existing rows can still gain a reply edge on re-ingest.
      await this.sql`UPDATE messages SET reply_to_id = ${replyToId} WHERE id = ${event.messageId} AND reply_to_id IS NULL`;
    }
    // Bot-authored rows are archive-only context — no member registry entry,
    // so bots never accrue message_count or become profile-eligible.
    if (trackMember) await this.upsertMember(event.guildId, event.authorId, event.authorName, event.createdAt, inserted.count > 0);
  }

  /** Edited message — update the archive row only. Evidence snapshots keep the
   * extraction-time text on purpose: rewriting them would falsify the record
   * of what the memory was actually derived from. */
  async updateMessageContent(guildId: string, messageId: string, content: string): Promise<void> {
    await this.sql`UPDATE messages SET content = ${content} WHERE guild_id = ${guildId} AND id = ${messageId}`;
  }

  /** Deleted message — remove the raw row so sweeps and context never see it
   * again, and scrub the verbatim text columns on any evidence it produced.
   * Evidence metadata (type, effect, reason) stays: the audit trail keeps the
   * "why" without keeping the deleted words. */
  async deleteMessage(guildId: string, messageId: string): Promise<void> {
    await this.sql.begin(async sql => {
      await sql`DELETE FROM messages WHERE guild_id = ${guildId} AND id = ${messageId}`;
      await sql`UPDATE memory_evidence SET quote = '', message_content_snapshot = '' WHERE message_id = ${messageId}`;
    });
  }

  // ── Members ────────────────────────────────────────────────────────────────
  // The members table is the member registry: one row per (guild, user) tracking every
  // display name observed, message counts, and first/last activity. It backs the
  // entity-resolution alias map and per-chatter profiles.

  async upsertMember(guildId: string, userId: string, displayName: string, at: Date, countMessage = true): Promise<void> {
    const inc = countMessage ? 1 : 0;
    await this.sql`
      INSERT INTO members (guild_id, user_id, known_names, first_seen_at, last_seen_at, message_count)
      VALUES (${guildId}, ${userId}, ${[displayName]}, ${at.toISOString()}, ${at.toISOString()}, ${inc})
      ON CONFLICT (guild_id, user_id) DO UPDATE SET
        known_names   = CASE
          WHEN ${displayName} = ANY(members.known_names) THEN members.known_names
          WHEN cardinality(members.known_names) >= ${MAX_KNOWN_NAMES}
            THEN array_append(members.known_names[2:cardinality(members.known_names)], ${displayName})
          ELSE array_append(members.known_names, ${displayName})
        END,
        first_seen_at = LEAST(members.first_seen_at, EXCLUDED.first_seen_at),
        last_seen_at  = GREATEST(members.last_seen_at, EXCLUDED.last_seen_at),
        message_count = members.message_count + ${inc}
    `;
  }

  async getMember(guildId: string, userId: string): Promise<Member | undefined> {
    const rows = await this.sql<MemberRow[]>`SELECT * FROM members WHERE guild_id = ${guildId} AND user_id = ${userId}`;
    return rows[0] ? rowToMember(rows[0]) : undefined;
  }

  async listMembers(guildId: string): Promise<Member[]> {
    const rows = await this.sql<MemberRow[]>`SELECT * FROM members WHERE guild_id = ${guildId} ORDER BY message_count DESC`;
    return rows.map(rowToMember);
  }

  /** Fallback for rows archived before the members table existed (pre-v7). */
  async listAuthorNames(guildId: string): Promise<Array<{ authorId: string; authorName: string }>> {
    const rows = await this.sql<Array<{ author_id: string; author_name: string }>>`
      SELECT DISTINCT author_id, author_name FROM messages WHERE guild_id = ${guildId}
    `;
    return rows.map(r => ({ authorId: r.author_id, authorName: r.author_name }));
  }

  async setMemberOptOut(guildId: string, userId: string, optedOut: boolean): Promise<void> {
    // Upsert: a member who has never posted has no row yet, and opt-out must
    // still stick for when they do. Opting out also revokes opt-in — the
    // opt-out flag always wins.
    await this.sql`
      INSERT INTO members (guild_id, user_id, known_names, first_seen_at, last_seen_at, message_count, opted_out, opted_in)
      VALUES (${guildId}, ${userId}, '{}', NOW(), NOW(), 0, ${optedOut ? 1 : 0}, 0)
      ON CONFLICT (guild_id, user_id) DO UPDATE
      SET opted_out = ${optedOut ? 1 : 0}, opted_in = CASE WHEN ${optedOut} THEN 0 ELSE members.opted_in END
    `;
  }

  async setMemberOptIn(guildId: string, userId: string, optedIn: boolean): Promise<void> {
    // Upsert like setMemberOptOut — a member can opt in before ever posting.
    // Opting in never clears opted_out; derived data requires opted_in=1 AND
    // opted_out=0, so an opted-out member stays protected even if both flags
    // end up set.
    await this.sql`
      INSERT INTO members (guild_id, user_id, known_names, first_seen_at, last_seen_at, message_count, opted_in)
      VALUES (${guildId}, ${userId}, '{}', NOW(), NOW(), 0, ${optedIn ? 1 : 0})
      ON CONFLICT (guild_id, user_id) DO UPDATE SET opted_in = ${optedIn ? 1 : 0}
    `;
  }

  /** Learn a new name for a member from evidence (self-naming, manual /alias).
   * Records provenance in alias_candidates and applies it to known_names so the
   * alias map resolves it from then on. Idempotent per evidence message. */
  async learnAlias(guildId: string, userId: string, name: string, source: string, messageId: string): Promise<boolean> {
    const clean = name.trim();
    if (!clean) return false;
    return await this.sql.begin(async sql => {
      const inserted = await sql`
        INSERT INTO alias_candidates (guild_id, user_id, name, source, evidence_message_id)
        VALUES (${guildId}, ${userId}, ${clean}, ${source}, ${messageId})
        ON CONFLICT (guild_id, user_id, name, evidence_message_id) DO NOTHING
        RETURNING id
      `;
      if (inserted.length === 0) return false;
      await sql`
        UPDATE members SET known_names = CASE
          WHEN cardinality(known_names) >= ${MAX_KNOWN_NAMES}
            THEN array_append(known_names[2:cardinality(known_names)], ${clean})
          ELSE array_append(known_names, ${clean})
        END
        WHERE guild_id = ${guildId} AND user_id = ${userId}
          AND NOT (LOWER(${clean}) = ANY(SELECT LOWER(x) FROM unnest(known_names) x))
      `;
      return true;
    });
  }

  /** Log a name that failed entity resolution — the discovery surface for
   * aliases self-naming can't catch and recurring non-member entities. */
  async logUnresolvedName(guildId: string, name: string, messageId: string): Promise<void> {
    const clean = name.trim();
    if (!clean) return;
    await this.sql`
      INSERT INTO unresolved_names (guild_id, name, message_id)
      VALUES (${guildId}, ${clean}, ${messageId})
      ON CONFLICT (guild_id, name, message_id) DO NOTHING
    `;
  }

  /** Unresolved names by frequency — candidates for alias learning or
   * external-entity modeling. */
  async unresolvedNames(guildId: string, limit = 30): Promise<Array<{ name: string; count: number }>> {
    const rows = await this.sql<Array<{ name: string; c: number }>>`
      SELECT name, COUNT(*)::int AS c FROM unresolved_names
      WHERE guild_id = ${guildId}
      GROUP BY name ORDER BY c DESC, name LIMIT ${limit}
    `;
    return rows.map(r => ({ name: r.name, count: r.c }));
  }

  /** Best current display name for a user: latest known name, else most recent message author_name. */
  async displayNameFor(guildId: string, userId: string): Promise<string> {
    const member = await this.getMember(guildId, userId);
    if (member && member.knownNames.length > 0) return member.knownNames[member.knownNames.length - 1];
    const rows = await this.sql<Array<{ author_name: string }>>`
      SELECT author_name FROM messages WHERE guild_id = ${guildId} AND author_id = ${userId} ORDER BY created_at DESC, id DESC LIMIT 1
    `;
    return rows[0]?.author_name ?? userId;
  }

  /** Bulk displayNameFor — at most two queries for any batch size: one member
   * lookup plus a DISTINCT ON fallback scan for ids with no known names. */
  async displayNamesFor(guildId: string, userIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!userIds.length) return out;
    const members = await this.sql<Array<{ user_id: string; known_names: string[] }>>`
      SELECT user_id, known_names FROM members WHERE guild_id = ${guildId} AND user_id = ANY(${userIds})
    `;
    const missing: string[] = [];
    for (const id of userIds) {
      const m = members.find(r => r.user_id === id);
      if (m && m.known_names.length) out.set(id, m.known_names[m.known_names.length - 1]);
      else missing.push(id);
    }
    if (missing.length) {
      const rows = await this.sql<Array<{ author_id: string; author_name: string }>>`
        SELECT DISTINCT ON (author_id) author_id, author_name FROM messages
        WHERE guild_id = ${guildId} AND author_id = ANY(${missing})
        ORDER BY author_id, created_at DESC
      `;
      for (const r of rows) out.set(r.author_id, r.author_name);
    }
    for (const id of userIds) if (!out.has(id)) out.set(id, id);
    return out;
  }

  // ── Relationships ──────────────────────────────────────────────────────────
  // Relationship assertions are stored as idempotent observations keyed by
  // (subject_id, other_id, message_id). Observations carry a sincerity verdict;
  // the `relationships` edge table is fully derived — rebuilt by
  // recomputeEdges() from 'literal'-verdicted observations only, so an
  // unverified assertion never surfaces in profiles or dossiers. Edges
  // materialize at the next maintenance pass, not at record time.

  // authorId is the assertor — the member whose message the claim came from.
  // Stored because the subject/other pair alone can't tell self-report from
  // third-party assertion, and opt-out must erase a member's authored claims
  // even when the message itself is gone.
  async recordRelationship(guildId: string, subjectId: string, otherId: string, messageId: string, authorId: string, nature: string, valence: number | null, reason = ""): Promise<boolean> {
    if (subjectId === otherId || subjectId === "unknown" || otherId === "unknown" || subjectId === "server" || otherId === "server") return false;
    const inserted = await this.sql`
      INSERT INTO relationship_observations (guild_id, subject_id, other_id, message_id, author_id, nature, valence, reason)
      VALUES (${guildId}, ${subjectId}, ${otherId}, ${messageId}, ${authorId}, ${nature}, ${valence}, ${reason})
      ON CONFLICT (subject_id, other_id, message_id) DO NOTHING
      RETURNING id
    `;
    return inserted.length > 0;
  }

  /** All edges where the subject is either side of the relationship — claimed
   * edges first by depth, then behavior-only (inferred) edges by contact
   * frequency. */
  async relationshipsFor(guildId: string, subjectId: string): Promise<RelationshipEdge[]> {
    const rows = await this.sql<RelationshipRow[]>`
      SELECT id, guild_id, subject_id, other_id, summary, valence, observation_count,
             last_observed_at, updated_at, behavioral_count, party_count, trend, inferred
      FROM relationships
      WHERE guild_id = ${guildId} AND (subject_id = ${subjectId} OR other_id = ${subjectId})
      ORDER BY inferred ASC, observation_count DESC, behavioral_count DESC
    `;
    return rows.map(rowToEdge);
  }

  // ── Sincerity verification ─────────────────────────────────────────────────
  // Extraction can mislabel edgy humor as explicit_fact/clear_preference. A
  // second-pass LLM judgment against the stored source message gates promotion:
  // jokes are re-classified sarcasm_or_joke, verified literal self-reports go
  // active, and third-party literals stay candidate pending corroboration.

  /** Per-row "preceding context" in one round trip: for each (channel, ts)
   * anchor the LATERAL grabs the 5 messages before it, keyed back to the row
   * index. Replaces a per-row query in the verification list functions. */
  private async _contextBefore(guildId: string, anchors: Array<{ ix: number; channelId: string; createdAt: Date | string }>): Promise<Map<number, Array<{ authorName: string; content: string }>>> {
    const out = new Map<number, Array<{ authorName: string; content: string }>>();
    if (!anchors.length) return out;
    const rows = await this.sql<Array<{ ix: number; author_name: string; content: string; created_at: Date | string }>>`
      SELECT t.ix, m.author_name, m.content, m.created_at
      FROM unnest(${anchors.map(a => a.ix)}::int[], ${anchors.map(a => a.channelId)}::text[], ${anchors.map(a => new Date(a.createdAt).toISOString())}::timestamptz[]) AS t(ix, channel_id, ts)
      JOIN LATERAL (
        SELECT author_name, content, created_at, id FROM messages
        WHERE guild_id = ${guildId} AND channel_id = t.channel_id AND created_at < t.ts
        ORDER BY created_at DESC, id DESC LIMIT 5
      ) m ON true
      ORDER BY t.ix, m.created_at DESC, m.id DESC
    `;
    for (const r of rows) {
      const list = out.get(r.ix) ?? [];
      list.unshift({ authorName: r.author_name, content: r.content });
      out.set(r.ix, list);
    }
    return out;
  }

  /** Candidate memories with promotable evidence types, joined to their first source message.
   * Carries the author's known names and the messages preceding the source so the
   * verifier can spot pasted/quoted text and jokes that only read literal in isolation. */
  async listVerifiableCandidates(guildId: string, limit = 200, subjectId?: string): Promise<Array<{
    memoryId: number; subjectId: string; kind: Memory["kind"]; content: string;
    evidenceType: string; selfReport: boolean; authorName: string; authorNames: string[];
    sourceMessage: string; contextBefore: Array<{ authorName: string; content: string }>;
  }>> {
    const rows = await this.sql<Array<{
      memory_id: number; subject_id: string; kind: string; content: string;
      primary_evidence_type: string; self_report: boolean;
      author_name: string | null; author_names: string[] | null; source_message: string;
      channel_id: string | null; msg_created_at: Date | string | null;
    }>>`
      SELECT m.id AS memory_id, m.subject_id, m.kind, m.content, m.primary_evidence_type,
             (m.subject_id = e.author_id) AS self_report,
             msg.author_name, mem.known_names AS author_names,
             e.message_content_snapshot AS source_message,
             msg.channel_id, msg.created_at AS msg_created_at
      FROM memories m
      JOIN LATERAL (
        SELECT ev.author_id, ev.message_id, ev.message_content_snapshot
        FROM memory_evidence ev WHERE ev.memory_id = m.id ORDER BY ev.id LIMIT 1
      ) e ON true
      LEFT JOIN messages msg ON msg.id = e.message_id
      LEFT JOIN members mem ON mem.guild_id = m.guild_id AND mem.user_id = e.author_id
      WHERE m.guild_id = ${guildId} AND m.status = 'candidate'
        AND m.primary_evidence_type IN ('explicit_fact', 'clear_preference', 'correction')
        ${subjectId ? this.sql`AND m.subject_id = ${subjectId}` : this.sql``}
      ORDER BY m.id
      LIMIT ${limit}
    `;
    const ctxMap = await this._contextBefore(guildId, rows.flatMap((r, i) =>
      r.channel_id && r.msg_created_at ? [{ ix: i, channelId: r.channel_id, createdAt: r.msg_created_at }] : []));
    return rows.map((r, i) => ({
      memoryId: Number(r.memory_id), subjectId: r.subject_id, kind: r.kind as Memory["kind"],
      content: r.content, evidenceType: r.primary_evidence_type, selfReport: r.self_report,
      authorName: r.author_name ?? r.subject_id, authorNames: r.author_names ?? [],
      sourceMessage: r.source_message, contextBefore: ctxMap.get(i) ?? [],
    }));
  }

  /**
   * Apply one verification verdict to a candidate memory.
   * - joke → evidence re-classified sarcasm_or_joke, confidence reset to 0.10
   * - misattributed → forgotten (the source text was quoting/describing someone else)
   * - literal + self-report + promotable type → promoted to active
   * - literal + third-party, or unclear → unchanged
   * Returns "promoted" | "flagged" | "rejected" | "unchanged".
   */
  async applyVerification(memoryId: number, verdict: VerificationVerdict, reason: string): Promise<"promoted" | "flagged" | "rejected" | "unchanged"> {
    return await this.sql.begin(async sql => {
      const rows = await sql<MemoryRow[]>`SELECT * FROM memories WHERE id = ${memoryId}`;
      const mem = rows[0] ? rowToMemory(rows[0]) : undefined;
      if (!mem || mem.status !== "candidate") return "unchanged";

      if (verdict === "misattributed") {
        await sql`UPDATE memories SET status = 'forgotten', updated_at = NOW() WHERE id = ${memoryId}`;
        await recomputeForMemories(sql, mem.guildId, [memoryId]);
        await this._logHistory(sql, memoryId, "misattributed", mem.confidence, mem.confidence, "candidate", "forgotten", null, { reason });
        return "rejected";
      }

      if (verdict === "joke") {
        const jokeConfidence = calculateInitialConfidence("sarcasm_or_joke");
        await sql`UPDATE memories SET primary_evidence_type = 'sarcasm_or_joke', confidence = ${jokeConfidence}, updated_at = NOW() WHERE id = ${memoryId}`;
        await sql`UPDATE memory_evidence SET evidence_type = 'sarcasm_or_joke' WHERE memory_id = ${memoryId}`;
        await recomputeForMemories(sql, mem.guildId, [memoryId]);
        await this._logHistory(sql, memoryId, "flagged_joke", mem.confidence, jokeConfidence, "candidate", "candidate", null, { reason });
        return "flagged";
      }

      if (verdict === "literal") {
        const promotableTypes: EvidenceType[] = ["explicit_fact", "clear_preference", "correction"];
        const ev = await sql<[{ author_id: string }]>`
          SELECT author_id FROM memory_evidence WHERE memory_id = ${memoryId} ORDER BY id LIMIT 1
        `;
        const selfReport = ev[0]?.author_id === mem.subjectId;
        if (selfReport && promotableTypes.includes(mem.primaryEvidenceType as EvidenceType)) {
          await sql`UPDATE memories SET status = 'active', last_confirmed_at = NOW(), updated_at = NOW() WHERE id = ${memoryId}`;
          await recomputeForMemories(sql, mem.guildId, [memoryId]);
          await this._logHistory(sql, memoryId, "verified_active", mem.confidence, mem.confidence, "candidate", "active", null, { reason });
          return "promoted";
        }
        await this._logHistory(sql, memoryId, "verified_literal", mem.confidence, mem.confidence, "candidate", "candidate", null, { reason });
      }
      return "unchanged";
    });
  }

  // ── Dossier inputs ─────────────────────────────────────────────────────────

  /** Up to 60 raw messages for voice analysis — most recent, deterministic so
   * the section hash only changes when the member actually posts again. */
  async sampleMessages(guildId: string, authorId: string): Promise<Array<{ content: string; createdAt: string }>> {
    const rows = await this.sql<Array<{ content: string; created_at: Date | string }>>`
      SELECT content, created_at FROM messages
      WHERE guild_id = ${guildId} AND author_id = ${authorId} AND length(content) > 0
      ORDER BY created_at DESC, id DESC LIMIT 60
    `;
    return rows.map(r => ({ content: r.content, createdAt: ts(r.created_at) }));
  }

  /** Literal-verdicted relationship observations (with reasons) involving a
   * member — either as the asserting side ("member_subject") or the observed
   * side ("member_other"). otherId is always the counterparty. Dossier
   * relationship_map input; unverified assertions stay invisible here too. */
  async relationshipObservationsFor(guildId: string, subjectId: string): Promise<Array<{
    otherId: string; nature: string; valence: number | null; reason: string;
    direction: "member_subject" | "member_other"; source: string; createdAt: string;
  }>> {
    const rows = await this.sql<Array<{
      subject_id: string; other_id: string; nature: string; valence: number | null; reason: string; source: string; created_at: Date | string;
    }>>`
      SELECT subject_id, other_id, nature, valence, reason, source, created_at FROM relationship_observations
      WHERE guild_id = ${guildId} AND (subject_id = ${subjectId} OR other_id = ${subjectId})
        AND verdict = 'literal'
      ORDER BY created_at DESC, id DESC
    `;
    return rows.map(r => ({
      otherId: r.subject_id === subjectId ? r.other_id : r.subject_id,
      nature: r.nature,
      valence: r.valence != null ? Number(r.valence) : null,
      reason: r.reason,
      direction: r.subject_id === subjectId ? "member_subject" as const : "member_other" as const,
      source: r.source,
      createdAt: ts(r.created_at),
    }));
  }

  /** Everything the graph knows about one ordered pair: directed edges both
   * ways, recent literal observations (subject_id is the asserting side), and
   * the active memories each has authored about the other. Reply-path input —
   * pairwise theory of mind distinct from either member's standalone profile. */
  async pairwiseContext(guildId: string, aId: string, bId: string): Promise<{
    ab?: RelationshipEdge;
    ba?: RelationshipEdge;
    observations: Array<{ fromId: string; toId: string; nature: string; valence: number | null; reason: string; source: string; createdAt: string }>;
    claimsAboutA: string[];   // active memories about aId authored by bId
    claimsAboutB: string[];   // active memories about bId authored by aId
    /** Undirected 90d interaction count — from whichever edge rows carry the
     *  stamp (claimed or inferred). Zero when the pair never registered. */
    behavioralCount: number;
  }> {
    // Subject-consent: pair context only renders when at least one side opted
    // in — an edge between two non-consenting members can't be formed now, and
    // a straggler from before consent enforcement stays hidden.
    const consentRows = await this.sql<Array<{ user_id: string }>>`
      SELECT user_id FROM members
      WHERE guild_id = ${guildId} AND opted_in = 1 AND opted_out = 0
        AND user_id IN (${aId}, ${bId})
    `;
    if (!consentRows.length) return { observations: [], claimsAboutA: [], claimsAboutB: [], behavioralCount: 0 };
    const edgeRows = await this.sql<RelationshipRow[]>`
      SELECT id, guild_id, subject_id, other_id, summary, valence, observation_count,
             last_observed_at, updated_at, behavioral_count, party_count, trend, inferred
      FROM relationships
      WHERE guild_id = ${guildId}
        AND ((subject_id = ${aId} AND other_id = ${bId}) OR (subject_id = ${bId} AND other_id = ${aId}))
    `;

    const obsRows = await this.sql<Array<{
      subject_id: string; other_id: string; nature: string; valence: number | null; reason: string; source: string; created_at: Date | string;
    }>>`
      SELECT subject_id, other_id, nature, valence, reason, source, created_at FROM relationship_observations
      WHERE guild_id = ${guildId} AND verdict = 'literal'
        AND ((subject_id = ${aId} AND other_id = ${bId}) OR (subject_id = ${bId} AND other_id = ${aId}))
      ORDER BY created_at DESC, id DESC LIMIT 5
    `;

    const claimRows = await this.sql<Array<{ subject_id: string; content: string; confidence: number }>>`
      SELECT DISTINCT m.subject_id, m.content, m.confidence
      FROM memories m
      JOIN memory_evidence e ON e.memory_id = m.id
      WHERE m.guild_id = ${guildId} AND m.status = 'active'
        AND ((m.subject_id = ${aId} AND e.author_id = ${bId}) OR (m.subject_id = ${bId} AND e.author_id = ${aId}))
      ORDER BY m.subject_id, m.confidence DESC LIMIT 8
    `;

    const ab = edgeRows.find(r => r.subject_id === aId);
    const ba = edgeRows.find(r => r.subject_id === bId);
    return {
      ab: ab ? rowToEdge(ab) : undefined,
      ba: ba ? rowToEdge(ba) : undefined,
      behavioralCount: edgeRows.reduce((m, r) => Math.max(m, Number(r.behavioral_count)), 0),
      observations: obsRows.map(r => ({
        fromId: r.subject_id, toId: r.other_id, nature: r.nature,
        valence: r.valence != null ? Number(r.valence) : null,
        reason: r.reason, source: r.source, createdAt: ts(r.created_at),
      })),
      claimsAboutA: claimRows.filter(r => r.subject_id === aId).slice(0, 3).map(r => r.content),
      claimsAboutB: claimRows.filter(r => r.subject_id === bId).slice(0, 3).map(r => r.content),
    };
  }

  /** Memories about a subject asserted by someone else — the community-attributed
   * claims that feed the dossier reputation section. */
  async thirdPartyClaims(guildId: string, subjectId: string): Promise<Array<{
    memoryId: number; content: string; kind: Memory["kind"]; confidence: number; status: MemoryStatus; evidenceType: string;
  }>> {
    const rows = await this.sql<Array<{
      id: number; content: string; kind: string; confidence: number; status: string; primary_evidence_type: string;
    }>>`
      SELECT DISTINCT m.id, m.content, m.kind, m.confidence, m.status, m.primary_evidence_type
      FROM memories m
      JOIN memory_evidence e ON e.memory_id = m.id
      WHERE m.guild_id = ${guildId} AND m.subject_id = ${subjectId}
        AND e.author_id <> m.subject_id
        AND m.status IN ('active', 'candidate')
      ORDER BY m.confidence DESC
    `;
    return rows.map(r => ({
      memoryId: Number(r.id), content: r.content, kind: r.kind as Memory["kind"],
      confidence: Number(r.confidence), status: r.status as MemoryStatus,
      evidenceType: r.primary_evidence_type,
    }));
  }

  // ── Interaction graph ──────────────────────────────────────────────────────
  // Deterministic "who addresses whom" topology from the raw archive — <@ID>
  // mentions, written name-references, and reply targets. Distinct from
  // LLM-asserted edges: this measures frequency of contact, not claimed
  // dynamics.

  /** Undirected pairs keyed (min,max) — mention, name-ref, and reply each count
   * once per message per pair. excludeChannels honors the ignored-channel boundary
   * (ignored = invisible, including rows archived before the flag — same rule
   * as the sweep). Bot-authored rows are archive context, not partners: a
   * bot's mentions must not mint member↔bot edges, so ids observed posting as
   * bots are excluded on BOTH sides — allowBotIds re-admits companions, whose
   * member dynamics are real signal. */
  async interactionPairs(
    guildId: string,
    aliasMap: Map<string, string>,
    opts: { excludeIds?: string[]; excludeChannels?: string[]; allowBotIds?: string[] } = {}
  ): Promise<Array<{ aId: string; bId: string; count: number; firstAt: string; lastAt: string }>> {
    // Bounded to 90 days — the interaction graph is a recency signal anyway,
    // and this is the one query that reads the entire archive otherwise.
    const channels = opts.excludeChannels ?? [];
    const rows = await this.sql<Array<{ author_id: string; author_is_bot: boolean; content: string; created_at: Date | string; reply_author_id: string | null }>>`
      SELECT m.author_id, m.author_is_bot, m.content, m.created_at, ref.author_id AS reply_author_id
      FROM messages m
      LEFT JOIN messages ref ON ref.id = m.reply_to_id AND ref.guild_id = m.guild_id
      WHERE m.guild_id = ${guildId} AND length(m.content) > 0
        AND m.created_at > NOW() - interval '90 days'
        AND (${channels.length} = 0 OR m.channel_id <> ALL(${channels}::text[]))
      ORDER BY m.created_at, m.id
    `;
    const skip = new Set(opts.excludeIds ?? []);
    const allow = new Set(opts.allowBotIds ?? []);
    const botIds = new Set(rows.filter(r => r.author_is_bot && !allow.has(r.author_id)).map(r => r.author_id));
    const pairs = new Map<string, { aId: string; bId: string; count: number; firstAt: string; lastAt: string }>();
    for (const r of rows) {
      if (skip.has(r.author_id) || botIds.has(r.author_id)) continue;
      const targets = new Set<string>();
      for (const m of r.content.matchAll(/<@!?(\d{5,25})>/g)) targets.add(m[1]);
      for (const id of findMentionedUsers(r.content, aliasMap)) targets.add(id);
      // Replying to someone is addressing them — a close pair that replies
      // rather than name-drops still counts.
      if (r.reply_author_id) targets.add(r.reply_author_id);
      targets.delete(r.author_id);
      for (const t of targets) {
        if (skip.has(t) || botIds.has(t)) continue;
        const [a, b] = r.author_id < t ? [r.author_id, t] : [t, r.author_id];
        const key = `${a}|${b}`;
        const at = ts(r.created_at);
        const cur = pairs.get(key);
        if (cur) { cur.count++; cur.lastAt = at; }
        else pairs.set(key, { aId: a, bId: b, count: 1, firstAt: at, lastAt: at });
      }
    }
    return [...pairs.values()].sort((x, y) => y.count - x.count);
  }

  // ── Edge merging + observation verification ────────────────────────────────
  // Edges are stored directed (subject_id → other_id), so the same pair observed
  // from both sides fragments the observation count. mergedEdges groups by
  // counterparty for surfacing; the directed rows stay authoritative.

  /** Edges involving subjectId, merged by counterparty: counts summed, valence
   * observation-weighted, natures unioned (latest first). behavioralCount is
   * the undirected interaction stamp (max across directions — same number);
   * trend comes from the most recently observed edge. */
  async mergedEdges(guildId: string, subjectId: string): Promise<Array<{
    otherId: string; summary: string; natures: string[];
    valence: number | null; observationCount: number; lastObservedAt: string | null;
    behavioralCount: number; trend: string | null; inferred: boolean;
  }>> {
    const edges = await this.relationshipsFor(guildId, subjectId);
    const byOther = new Map<string, RelationshipEdge[]>();
    for (const e of edges) {
      const other = e.subjectId === subjectId ? e.otherId : e.subjectId;
      const list = byOther.get(other);
      if (list) list.push(e); else byOther.set(other, [e]);
    }
    return [...byOther.entries()].map(([otherId, list]) => {
      const total = list.reduce((s, e) => s + e.observationCount, 0);
      const scored = list.filter(e => e.valence != null && e.observationCount > 0);
      const valence = scored.length
        ? scored.reduce((s, e) => s + e.valence! * e.observationCount, 0) / scored.reduce((s, e) => s + e.observationCount, 0)
        : null;
      const byRecency = [...list].sort((a, b) => (b.lastObservedAt ?? "").localeCompare(a.lastObservedAt ?? ""));
      return {
        otherId,
        summary: byRecency[0].summary,
        natures: [...new Set(byRecency.map(e => e.summary).filter(Boolean))],
        valence, observationCount: total, lastObservedAt: byRecency[0].lastObservedAt,
        behavioralCount: list.reduce((m, e) => Math.max(m, e.behavioralCount), 0),
        trend: byRecency[0].trend,
        inferred: list.every(e => e.inferred),
      };
    }).sort((a, b) => b.observationCount - a.observationCount || b.behavioralCount - a.behavioralCount);
  }

  /** Unverified observations joined to their source message + author names +
   * preceding context — input for verifyRelationshipsBatch. */
  async listUnverifiedObservations(guildId: string, limit = 50): Promise<Array<{
    observationId: number; subjectId: string; otherId: string; nature: string;
    authorName: string; authorNames: string[]; sourceMessage: string;
    contextBefore: Array<{ authorName: string; content: string }>;
  }>> {
    const rows = await this.sql<Array<{
      id: number; subject_id: string; other_id: string; nature: string;
      author_name: string | null; author_names: string[] | null; source_message: string;
      channel_id: string | null; msg_created_at: Date | string | null;
    }>>`
      SELECT o.id, o.subject_id, o.other_id, o.nature,
             msg.author_name, mem.known_names AS author_names,
             msg.content AS source_message, msg.channel_id, msg.created_at AS msg_created_at
      FROM relationship_observations o
      JOIN messages msg ON msg.id = o.message_id
      LEFT JOIN members mem ON mem.guild_id = o.guild_id AND mem.user_id = COALESCE(o.author_id, msg.author_id)
      WHERE o.guild_id = ${guildId} AND o.verdict IS NULL
      ORDER BY o.id LIMIT ${limit}
    `;
    const ctxMap = await this._contextBefore(guildId, rows.flatMap((r, i) =>
      r.channel_id && r.msg_created_at ? [{ ix: i, channelId: r.channel_id, createdAt: r.msg_created_at }] : []));
    return rows.map((r, i) => ({
      observationId: Number(r.id), subjectId: r.subject_id, otherId: r.other_id,
      nature: r.nature, authorName: r.author_name ?? r.subject_id,
      authorNames: r.author_names ?? [], sourceMessage: r.source_message, contextBefore: ctxMap.get(i) ?? [],
    }));
  }

  async setObservationVerdict(observationId: number, verdict: string): Promise<void> {
    await this.sql`UPDATE relationship_observations SET verdict = ${verdict} WHERE id = ${observationId}`;
  }

  /** Rebuild the durable edges from literal-verdicted observations only —
   * unverified, unclear, misattributed, and joke rows never form or feed an
   * edge (pair_window rows arrive pre-verdicted, so they flow through here
   * like any literal). Aggregation: valence is the *weighted* average of the
   * five most recent observations — a claim authored by an edge party or a
   * verified pair_window read weighs double a third party's, so a pair's own
   * words and the holistic analysis outweigh gossip. summary is the modal
   * nature over the same window (latest-nature flip-flops under
   * contradiction); trend compares the recent-5 window against the PRIOR
   * window — an all-time baseline includes the recent rows themselves, which
   * damps the delta and makes n<=5 mathematically incapable of trending.
   *
   * `interactions` is the deterministic 90d interaction graph (from
   * interactionPairs): stamped onto claimed edges as behavioral_count, and
   * pairs with frequent contact but no claims materialize as inferred edges —
   * rows that render as contact frequency, never as a relationship claim.
   * This is the sole writer to `relationships`. Delete + re-aggregate in one
   * transaction; returns the edge count. */
  async recomputeEdges(
    guildId: string,
    interactions: Array<{ aId: string; bId: string; count: number }> = []
  ): Promise<number> {
    return await this.sql.begin(async sql => {
      await sql`DELETE FROM relationships WHERE guild_id = ${guildId}`;
      const inserted = await sql`
        INSERT INTO relationships (guild_id, subject_id, other_id, summary, valence, observation_count, party_count, trend, behavioral_count, inferred, last_observed_at, updated_at)
        SELECT guild_id, subject_id, other_id,
               COALESCE(summary, ''), recent_val, n, party_n,
               CASE WHEN prior_n >= 1 AND recent_val - prior_val >= 0.2 THEN 'warming'
                    WHEN prior_n >= 1 AND recent_val - prior_val <= -0.2 THEN 'cooling' END,
               0, 0, last_at, NOW()
        FROM (
          SELECT guild_id, subject_id, other_id,
                 MODE() WITHIN GROUP (ORDER BY nature) FILTER (WHERE rn <= 5) AS summary,
                 SUM(valence * w) FILTER (WHERE rn <= 5 AND valence IS NOT NULL)
                   / NULLIF(SUM(w) FILTER (WHERE rn <= 5 AND valence IS NOT NULL), 0) AS recent_val,
                 SUM(valence * w) FILTER (WHERE rn > 5 AND valence IS NOT NULL)
                   / NULLIF(SUM(w) FILTER (WHERE rn > 5 AND valence IS NOT NULL), 0) AS prior_val,
                 COUNT(*) FILTER (WHERE rn > 5 AND valence IS NOT NULL)::int AS prior_n,
                 COUNT(*)::int AS n,
                 COUNT(*) FILTER (WHERE author_id IN (subject_id, other_id))::int AS party_n,
                 MAX(created_at) AS last_at
          FROM (
            SELECT *, CASE WHEN author_id IN (subject_id, other_id) OR source = 'pair_window' THEN 2 ELSE 1 END AS w,
                   ROW_NUMBER() OVER (PARTITION BY guild_id, subject_id, other_id ORDER BY created_at DESC, id DESC) rn
            FROM relationship_observations
            WHERE guild_id = ${guildId} AND verdict = 'literal'
          ) lit
          GROUP BY guild_id, subject_id, other_id
        ) agg
        RETURNING id
      `;
      let total = inserted.length;
      if (interactions.length) {
        const aIds = interactions.map(p => p.aId);
        const bIds = interactions.map(p => p.bId);
        const cnts = interactions.map(p => p.count);
        // The interaction stamp is undirected — write it on both directions
        // of any claimed edge so readers see it from either side.
        await sql`
          UPDATE relationships r SET behavioral_count = v.cnt
          FROM (SELECT * FROM unnest(${aIds}::text[], ${bIds}::text[], ${cnts}::int[])) AS v(a_id, b_id, cnt)
          WHERE r.guild_id = ${guildId}
            AND ((r.subject_id = v.a_id AND r.other_id = v.b_id)
              OR (r.subject_id = v.b_id AND r.other_id = v.a_id))
        `;
        // Inferred edges: frequent contact, zero claims. Both directions so
        // directional reads see the pair symmetrically. Subject-consent at
        // write — at least one party opted in, same rule as observations.
        const inferred = await sql`
          INSERT INTO relationships (guild_id, subject_id, other_id, summary, valence, observation_count, party_count, behavioral_count, inferred, last_observed_at, updated_at)
          SELECT ${guildId}, v.a_id, v.b_id, '', NULL::double precision, 0, 0, v.cnt, 1, NULL::timestamptz, NOW()
          FROM (SELECT * FROM unnest(${aIds}::text[], ${bIds}::text[], ${cnts}::int[])) AS v(a_id, b_id, cnt)
          WHERE v.cnt >= 5
            AND NOT EXISTS (
              SELECT 1 FROM relationships r WHERE r.guild_id = ${guildId}
                AND ((r.subject_id = v.a_id AND r.other_id = v.b_id)
                  OR (r.subject_id = v.b_id AND r.other_id = v.a_id)))
            AND EXISTS (
              SELECT 1 FROM members m WHERE m.guild_id = ${guildId}
                AND m.user_id IN (v.a_id, v.b_id) AND m.opted_in = 1 AND m.opted_out = 0)
          UNION ALL
          SELECT ${guildId}, v.b_id, v.a_id, '', NULL::double precision, 0, 0, v.cnt, 1, NULL::timestamptz, NOW()
          FROM (SELECT * FROM unnest(${aIds}::text[], ${bIds}::text[], ${cnts}::int[])) AS v(a_id, b_id, cnt)
          WHERE v.cnt >= 5
            AND NOT EXISTS (
              SELECT 1 FROM relationships r WHERE r.guild_id = ${guildId}
                AND ((r.subject_id = v.a_id AND r.other_id = v.b_id)
                  OR (r.subject_id = v.b_id AND r.other_id = v.a_id)))
            AND EXISTS (
              SELECT 1 FROM members m WHERE m.guild_id = ${guildId}
                AND m.user_id IN (v.a_id, v.b_id) AND m.opted_in = 1 AND m.opted_out = 0)
          RETURNING id
        `;
        total += inferred.length;
      }
      return total;
    });
  }

  /** Exchange-window fetch for the pair-analysis job: messages authored by
   * either party that address the other — <@id> mention or written name-ref
   * (the same signal interactionPairs counts). 90d-bounded, capped, returned
   * oldest-first for prompt readability. */
  async pairExchanges(
    guildId: string, aId: string, bId: string,
    aliasMap: Map<string, string>, limit = 40, excludeChannels: string[] = []
  ): Promise<Array<{ id: string; authorId: string; authorName: string; content: string; createdAt: string }>> {
    const rows = await this.sql<Array<{ id: string; author_id: string; author_name: string; content: string; created_at: Date | string }>>`
      SELECT id, author_id, author_name, content, created_at FROM messages
      WHERE guild_id = ${guildId} AND author_id IN (${aId}, ${bId})
        AND length(content) > 0 AND created_at > NOW() - interval '90 days'
        AND (${excludeChannels.length} = 0 OR channel_id <> ALL(${excludeChannels}::text[]))
      ORDER BY created_at DESC, id DESC LIMIT 500
    `;
    const exchanges: Array<{ id: string; authorId: string; authorName: string; content: string; createdAt: string }> = [];
    for (const r of rows) {
      const other = r.author_id === aId ? bId : aId;
      const mentioned = r.content.includes(`<@${other}>`) || r.content.includes(`<@!${other}>`)
        || findMentionedUsers(r.content, aliasMap).includes(other);
      if (mentioned) exchanges.push({ id: r.id, authorId: r.author_id, authorName: r.author_name, content: r.content, createdAt: ts(r.created_at) });
      if (exchanges.length >= limit) break;
    }
    return exchanges.reverse();
  }

  /** Last pair-window analysis for a pair — any verdict counts (unconfident
   * runs write 'unclear' markers so the timestamp still throttles retries). */
  async lastPairWindowAt(guildId: string, aId: string, bId: string): Promise<string | null> {
    const rows = await this.sql<Array<{ last_at: Date | string | null }>>`
      SELECT MAX(created_at) AS last_at FROM relationship_observations
      WHERE guild_id = ${guildId} AND source = 'pair_window'
        AND ((subject_id = ${aId} AND other_id = ${bId}) OR (subject_id = ${bId} AND other_id = ${aId}))
    `;
    return rows[0]?.last_at ? ts(rows[0].last_at) : null;
  }

  /** Persist a pair-window analysis as a directed observation pair. The
   * analysis IS the verification — confident reads land verdict='literal'
   * (edges feed immediately), unconfident runs land 'unclear' markers (no
   * edge feed, auto-pruned at 90d, and the row's timestamp throttles
   * re-analysis via lastPairWindowAt). author_id stays NULL: the system is
   * the assertor — opt-out deletion matches on edge parties regardless.
   * Natures are directional — "A mentors B" must not materialize "B mentors
   * A" — so each direction carries its own label. The "pw:" provenance
   * prefix keeps the audit trail while sidestepping the
   * (subject, other, message) dedup key: an extracted observation citing the
   * same exchange message must not swallow the window row (both directions
   * swallowed = no marker, and the pair re-analyzes every pass). */
  async recordWindowObservation(
    guildId: string, aId: string, bId: string, messageId: string,
    aToBNature: string, bToANature: string,
    valence: number | null, reason: string, confident: boolean
  ): Promise<void> {
    const verdict = confident ? "literal" : "unclear";
    const prov = `pw:${messageId}`;
    await this.sql`
      INSERT INTO relationship_observations (guild_id, subject_id, other_id, message_id, author_id, nature, valence, reason, verdict, source)
      VALUES (${guildId}, ${aId}, ${bId}, ${prov}, NULL, ${aToBNature}, ${valence}, ${reason}, ${verdict}, 'pair_window'),
             (${guildId}, ${bId}, ${aId}, ${prov}, NULL, ${bToANature}, ${valence}, ${reason}, ${verdict}, 'pair_window')
      ON CONFLICT (subject_id, other_id, message_id) DO NOTHING
    `;
  }

  /** True when a pair-analysis job for this pair is already queued or
   * in-flight — the 7d throttle only sees written observations, so an un-run
   * job would otherwise enqueue a duplicate on the next pass. */
  async hasPendingPairAnalysis(guildId: string, aId: string, bId: string): Promise<boolean> {
    const rows = await this.sql<Array<{ exists: boolean }>>`
      SELECT EXISTS(
        SELECT 1 FROM jobs WHERE guild_id = ${guildId} AND type = 'pair-analysis'
          AND ((payload->>'aId' = ${aId} AND payload->>'bId' = ${bId})
            OR (payload->>'aId' = ${bId} AND payload->>'bId' = ${aId}))
      ) AS exists
    `;
    return rows[0]?.exists === true;
  }

  /** Established nature labels for the extraction prompt — reuse keeps the
   * vocabulary coherent ("close friends" once, not a synonym zoo). */
  async relationshipNatureVocab(guildId: string, limit = 20): Promise<string[]> {
    const rows = await this.sql<Array<{ nature: string }>>`
      SELECT nature, COUNT(*) AS c FROM relationship_observations
      WHERE guild_id = ${guildId} AND verdict = 'literal'
      GROUP BY nature ORDER BY c DESC LIMIT ${limit}
    `;
    return rows.map(r => r.nature);
  }

  async getMessage(guildId: string, messageId: string): Promise<{ id: string; guildId: string; channelId: string; authorId: string; authorName: string; content: string; createdAt: string; authorIsBot: boolean; triageResult: string | null; imageContext: string | null } | undefined> {
    const rows = await this.sql<Array<MessageRow & { author_is_bot: boolean; triage_result: string | null; image_context: string | null }>>`SELECT id, guild_id, channel_id, author_id, author_name, content, created_at, author_is_bot, triage_result, image_context FROM messages WHERE guild_id = ${guildId} AND id = ${messageId}`;
    if (!rows[0]) return undefined;
    const r = rows[0];
    return { id: r.id, guildId: r.guild_id, channelId: r.channel_id, authorId: r.author_id, authorName: r.author_name, content: r.content, createdAt: ts(r.created_at), authorIsBot: r.author_is_bot, triageResult: r.triage_result, imageContext: r.image_context };
  }

  /** Cache the formatted vision description for a message's attachments —
   * first writer wins; the extract job and every later reply share one
   * describe pass instead of re-billing vision per read. */
  async setImageContext(guildId: string, messageId: string, context: string): Promise<void> {
    await this.sql`UPDATE messages SET image_context = ${context} WHERE guild_id = ${guildId} AND id = ${messageId} AND image_context IS NULL`;
  }

  /** Memory ids whose evidence cites this message — lets a retried extract
   * job recover what was persisted without re-running the extraction LLM. */
  async memoryIdsForMessage(messageId: string): Promise<number[]> {
    const rows = await this.sql<Array<{ memory_id: number | string }>>`
      SELECT DISTINCT memory_id FROM memory_evidence WHERE message_id = ${messageId}
    `;
    return rows.map(r => Number(r.memory_id));
  }

  async hasEvidence(messageId: string): Promise<boolean> {
    const rows = await this.sql<[{ c: number }]>`SELECT COUNT(*)::int as c FROM memory_evidence WHERE message_id = ${messageId}`;
    return rows[0].c > 0;
  }

  /** The targeted corpus for one member's /profile-build scan: messages they
   * authored, messages referencing them (mention markup or any known name),
   * and messages replying to theirs — bounded to the retention window and
   * capped, newest-first by the cap then chronological for extraction. */
  async messagesAboutSubject(
    guildId: string, userId: string, names: string[], since: Date, limit = 1000
  ): Promise<Array<{ id: string; channelId: string; authorId: string; authorName: string; content: string; createdAt: string; replyToContent?: string }>> {
    const patterns = [
      ...names.map(n => `%${escapeLike(n)}%`),
      `%<@${userId}>%`, `%<@!${userId}>%`,
    ];
    const rows = await this.sql<Array<{
      id: string; channel_id: string; author_id: string; author_name: string; content: string;
      created_at: Date | string; ref_author_name: string | null; ref_content: string | null;
    }>>`
      SELECT m.id, m.channel_id, m.author_id, m.author_name, m.content, m.created_at,
             ref.author_name AS ref_author_name, ref.content AS ref_content
      FROM messages m
      LEFT JOIN messages ref ON ref.id = m.reply_to_id AND ref.guild_id = m.guild_id
      WHERE m.guild_id = ${guildId} AND m.created_at > ${since.toISOString()}
        AND m.content <> ''
        -- 'extracted' rows that yielded evidence already contributed their
        -- consented candidates; 'extracted' rows with NO evidence are exactly
        -- the consent-dropped (or empty-extraction) set a later opt-in must
        -- be able to rescan. Evidence insert is idempotent, so reprocessing
        -- is safe.
        AND (m.triage_result IS NULL OR m.triage_result <> 'extracted'
             OR NOT EXISTS (SELECT 1 FROM memory_evidence e WHERE e.message_id = m.id))
        AND (
          m.author_id = ${userId}
          OR m.content ILIKE ANY(${patterns})
          OR m.reply_to_id IN (SELECT id FROM messages WHERE guild_id = ${guildId} AND author_id = ${userId})
        )
      ORDER BY m.created_at DESC LIMIT ${limit}
    `;
    // DESC+LIMIT keeps the newest window; flip back to chronological so the
    // extraction pass (alias learning, reply context) reads them in order.
    return rows.reverse().map(r => ({
      id: r.id, channelId: r.channel_id, authorId: r.author_id, authorName: r.author_name,
      content: r.content, createdAt: ts(r.created_at),
      replyToContent: r.ref_author_name ? `${r.ref_author_name}: ${r.ref_content}` : undefined,
    }));
  }

  /** Returns triage_result for each given message id. Missing rows and NULLs are absent from the map. */
  async getTriageResults(messageIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (messageIds.length === 0) return out;
    const rows = await this.sql<Array<{ id: string; triage_result: string | null }>>`
      SELECT id, triage_result FROM messages WHERE id = ANY(${messageIds}) AND triage_result IS NOT NULL
    `;
    for (const r of rows) if (r.triage_result) out.set(r.id, r.triage_result);
    return out;
  }

  async setTriageResults(results: Array<{ id: string; result: string }>): Promise<void> {
    if (results.length === 0) return;
    await this.sql.begin(async sql => {
      for (const r of results) {
        await sql`UPDATE messages SET triage_result = ${r.result} WHERE id = ${r.id}`;
      }
    });
  }

  /** Recent messages the pipeline never classified, plus orphaned extraction
   * marks at ANY age: 'durable'/'regex' only ever mean "requested but not yet
   * extracted", and a live job would have flipped the mark to 'queued' (the
   * sweep's repairQueuedMarks pass does that reconciliation first) — so one
   * of these with no evidence row is definitively stranded work, and the 2h
   * sweep window must not hide it. Note: `messages` has no bot flag, so other
   * bots' messages are included — bounded noise. */
  async listUninspectedMessages(guildId: string, since: Date, excludeAuthorId: string, limit = 500): Promise<Array<{ id: string; channelId: string; authorId: string; authorName: string; content: string; createdAt: Date | string; replyToId: string | null; triageResult: string | null }>> {
    const rows = await this.sql<Array<{ id: string; channel_id: string; author_id: string; author_name: string; content: string; created_at: Date | string; reply_to_id: string | null; triage_result: string | null }>>`
      SELECT m.id, m.channel_id, m.author_id, m.author_name, m.content, m.created_at, m.reply_to_id, m.triage_result
      FROM messages m
      WHERE m.guild_id = ${guildId}
        AND (
          m.triage_result IN ('durable', 'regex')
          OR (m.triage_result IS NULL AND m.created_at > ${since.toISOString()})
        )
        AND m.author_id <> ${excludeAuthorId}
        AND NOT m.author_is_bot
        AND m.content <> ''
        AND NOT EXISTS (SELECT 1 FROM memory_evidence e WHERE e.message_id = m.id)
      ORDER BY m.created_at ASC LIMIT ${limit}
    `;
    return rows.map(r => ({ id: r.id, channelId: r.channel_id, authorId: r.author_id, authorName: r.author_name, content: r.content, createdAt: r.created_at, replyToId: r.reply_to_id, triageResult: r.triage_result }));
  }

  // ── Core memory persistence ────────────────────────────────────────────────
  // Phase 1 authoritative update: the LLM supplies language interpretation only. Confidence,
  // lifecycle, counters, and history are all determined here after an idempotent evidence insert.

  async saveMemory(event: MessageEvent, memory: MemoryCandidate, candidateThreshold = 0.7): Promise<Memory> {
    const evidenceType = memory.evidenceType ?? "uncertain_inference";
    const effect = memory.effect ?? "context";

    return await this.sql.begin(async sql => {
      // Upsert the memory row (idempotent on the unique content key).
      const existing = await sql<MemoryRow[]>`
        SELECT id FROM memories WHERE guild_id = ${event.guildId} AND subject_id = ${memory.subjectId} AND kind = ${memory.kind} AND content = ${memory.content}
      `;

      // Near-duplicate fast-path: when the exact key misses, fall back to a pg_trgm
      // similarity lookup in the same (guild, subject, kind) scope so rephrased
      // extractions reinforce one row instead of splitting confirmations.
      // Excluded:
      //  - effect 'correct': a replacement must create its own row for supersede() to link.
      //  - kind 'episode': recurring events must accumulate as separate rows for
      //    pattern consolidation.
      //  - subject 'unknown': similarity across different unresolved people would
      //    merge distinct memories.
      //  - non-promotable evidence types: the fast-path is gated the same way
      //    promotion is, so a joke/rumour extraction can't nudge a look-alike row.
      //  - contested/superseded/forgotten targets: a forgotten memory must not be
      //    resurrected by a near-duplicate.
      let trigramMatch: { id: number; score: number; content: string } | null = null;
      let nearMiss: { id: number; score: number; content: string } | null = null;
      if (!existing[0] && effect !== "correct" && memory.kind !== "episode" && memory.subjectId !== "unknown" && PROMOTABLE_EVIDENCE_TYPES.includes(evidenceType)) {
        const simRows = await sql<Array<{ id: number; sim: number; content: string }>>`
          SELECT id, similarity(content, ${memory.content}) AS sim, content
          FROM memories
          WHERE guild_id = ${event.guildId}
            AND subject_id = ${memory.subjectId}
            AND kind = ${memory.kind}
            AND status IN ('candidate', 'active', 'quarantined')
            AND content % ${memory.content}
          ORDER BY sim DESC, id ASC
          LIMIT 1
        `;
        const top = simRows[0] ? { id: Number(simRows[0].id), score: Number(simRows[0].sim), content: simRows[0].content } : null;
        if (top && top.score >= TRIGRAM_MATCH_THRESHOLD) trigramMatch = top;
        else if (top && top.score >= TRIGRAM_NEAR_MISS_THRESHOLD) nearMiss = top;
      }

      // Fuzzy matches don't get to trust the LLM's effect blindly: opposite
      // polarity between the two contents means this is a contradiction of the
      // matched row. Exact matches skip this — same string can't flip polarity.
      let effectiveEffect = effect;
      if (trigramMatch && contentPolarity(trigramMatch.content) !== contentPolarity(memory.content)) {
        effectiveEffect = "contradict";
      }

      const matchedId = existing[0] ? Number(existing[0].id) : trigramMatch?.id ?? null;
      if (!matchedId) {
        const initialConfidence = calculateInitialConfidence(evidenceType);
        // The extractor's salience judgment is authoritative when present —
        // clamped into [0.05, 1] so a degenerate value can't zero out or
        // max out the ranking; the kind-map is the fallback when it's absent.
        const importance = memory.importance != null && Number.isFinite(Number(memory.importance))
          ? Math.max(0.05, Math.min(1, Number(memory.importance)))
          : calculateDefaultImportance(memory.kind);
        const explicitness = memory.explicitness ?? calculateDefaultExplicitness(evidenceType);
        // Persist the extracted name even when the subject couldn't be resolved to an ID —
        // it enables later re-attribution of `unknown` memories.
        const subjectName = memory.subjectName || (memory.subjectId === event.authorId ? event.authorName : "");
        await sql`
          INSERT INTO memories (guild_id, subject_id, subject_name, kind, content, confidence, importance, mentions, confirmation_count, created_at, updated_at, last_confirmed_at, status, explicitness, reason, primary_evidence_type)
          VALUES (${event.guildId}, ${memory.subjectId}, ${subjectName}, ${memory.kind}, ${memory.content}, ${initialConfidence}, ${importance}, 0, 0, NOW(), NOW(), NOW(), 'candidate', ${explicitness}, ${memory.reason}, ${evidenceType})
          ON CONFLICT (guild_id, subject_id, kind, content) DO NOTHING
        `;
      }

      const savedRows = matchedId
        ? await sql<MemoryRow[]>`SELECT * FROM memories WHERE id = ${matchedId}`
        : await sql<MemoryRow[]>`
            SELECT * FROM memories WHERE guild_id = ${event.guildId} AND subject_id = ${memory.subjectId} AND kind = ${memory.kind} AND content = ${memory.content}
          `;
      const saved = rowToMemory(savedRows[0]);
      const applied = await this._applyEvidence(sql, saved, event, evidenceType, effectiveEffect, memory.reason, memory.explicitness, candidateThreshold);

      // Audit trail for the fuzzy path — real scores are what lets the threshold
      // be tuned with data instead of guesswork.
      if (trigramMatch && applied) {
        await this._logHistory(sql, saved.id, "dedup_matched", saved.confidence, applied.confidence, saved.status, applied.status, null, { similarity: trigramMatch.score, incomingContent: memory.content, effect, appliedEffect: effectiveEffect });
      }
      if (nearMiss) {
        await this._logHistory(sql, saved.id, "dedup_near_miss", null, null, null, null, null, { similarity: nearMiss.score, existingMemoryId: nearMiss.id, incomingContent: memory.content, existingContent: nearMiss.content });
      }
      return applied ?? saved;
    }) as Memory;
  }

  /**
   * Attach a new evidence event to an existing memory — used when a message
   * contests or confirms an already-stored claim (e.g. the subject telling the
   * bot "I never said that"). Idempotent on (memory_id, message_id); returns
   * undefined when the message was already evidence for this memory.
   */
  async attachEvidence(memoryId: number, event: MessageEvent, evidenceType: EvidenceType, effect: EvidenceEffect, reason: string, candidateThreshold = 0.7): Promise<Memory | undefined> {
    return await this.sql.begin(async sql => {
      const rows = await sql<MemoryRow[]>`SELECT * FROM memories WHERE id = ${memoryId}`;
      const saved = rows[0] ? rowToMemory(rows[0]) : undefined;
      if (!saved) return undefined;
      return await this._applyEvidence(sql, saved, event, evidenceType, effect, reason, undefined, candidateThreshold);
    }) as Memory | undefined;
  }

  /**
   * Insert an evidence row for `saved` and apply the deterministic lifecycle
   * transitions (support bumps confidence, contradict contests, correct logs).
   * Returns the updated memory, or undefined when the evidence was a duplicate.
   */
  private async _applyEvidence(
    sql: Sql, saved: Memory, event: MessageEvent,
    evidenceType: EvidenceType, effect: EvidenceEffect, reason: string,
    explicitness: number | undefined, candidateThreshold: number
  ): Promise<Memory | undefined> {
    const evidenceExplicitness = explicitness ?? calculateDefaultExplicitness(evidenceType);
    // Idempotent evidence insert — same (memory_id, message_id) is ignored.
    const insertedEvidence = await sql`
      INSERT INTO memory_evidence (memory_id, message_id, author_id, quote, reason, explicitness, observed_at, evidence_type, effect, message_content_snapshot, message_timestamp, created_at)
      VALUES (${saved.id}, ${event.messageId}, ${event.authorId}, ${event.content.slice(0, 1000)}, ${reason}, ${evidenceExplicitness}, ${event.createdAt.toISOString()}, ${evidenceType}, ${effect}, ${event.content.slice(0, 1000)}, ${event.createdAt.toISOString()}, NOW())
      ON CONFLICT (memory_id, message_id) DO NOTHING
      RETURNING id
    `;
    if (insertedEvidence.length === 0) return undefined;

    const evidenceId = Number(insertedEvidence[0].id);
    const previousConfidence = saved.confidence;
    const previousStatus = saved.status;
    // Confidence is frozen the moment a memory enters contested state and remains frozen while contested.
    // net_score is the sole arbiter of conflict resolution; confidence must not be changed by either
    // supporting or contradicting evidence during this period so the two signals stay independent.
    const isContested = saved.status === "contested";
    let confidence = saved.confidence;
    let status = saved.status;
    let confirmations = saved.confirmationCount;
    let contradictions = saved.contradictionCount;
    let action = "context";

    if (effect === "support") {
      if (!isContested) confidence = updateConfidence(confidence, "support");
      confirmations++;
      action = "support";
    }
    if (effect === "contradict") {
      contradictions++;
      status = "contested";
      action = "contradict";
      // Write frozen_confidence the first time a memory enters contested state.
      if (saved.status !== "contested") {
        await sql`UPDATE memories SET frozen_confidence = ${saved.confidence} WHERE id = ${saved.id}`;
      }
    }
    if (effect === "correct") { action = "correction_evidence"; }

    // Only high-quality evidence types may promote a candidate to active. Sarcasm, rumour, and
    // uncertain inferences are explicitly excluded regardless of how high confidence grows.
    // confirmations >= 2 means promotion always represents corroboration — a single sighting
    // can never activate a memory (a 'correction'-typed extraction starts at 0.80 and would
    // otherwise promote on first sight, skipping nightly verification entirely).
    // 'unknown' subjects are inert until claimed: they can never promote.
    if (status === "candidate" && effect === "support" && confidence >= candidateThreshold
        && confirmations >= 2 && saved.subjectId !== "unknown"
        && PROMOTABLE_EVIDENCE_TYPES.includes(evidenceType)) {
      status = "active";
      action = "promote";
    }

    await sql`
      UPDATE memories SET
        confidence = ${confidence},
        confirmation_count = ${confirmations},
        mentions = ${confirmations},
        contradiction_count = ${contradictions},
        status = ${status},
        updated_at = NOW(),
        last_confirmed_at = CASE WHEN ${effect} = 'support' THEN NOW() ELSE last_confirmed_at END,
        last_contradicted_at = CASE WHEN ${effect} = 'contradict' THEN NOW() ELSE last_contradicted_at END
      WHERE id = ${saved.id}
    `;

    // Recompute when EITHER status or confidence moved — support on an
    // already-active memory changes no status, but the attribute's derived
    // confidence must still track the underlying memory's.
    if (status !== previousStatus || confidence !== previousConfidence) await recomputeForMemories(sql, event.guildId, [saved.id]);
    await this._logHistory(sql, saved.id, action, previousConfidence, confidence, previousStatus, status, evidenceId, { evidenceType, effect, sourceMessageId: event.messageId });

    const finalRows = await sql<MemoryRow[]>`SELECT * FROM memories WHERE guild_id = ${event.guildId} AND id = ${saved.id}`;
    return rowToMemory(finalRows[0]);
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  async getMemory(guildId: string, id: number): Promise<Memory | undefined> {
    const rows = await this.sql<MemoryRow[]>`SELECT * FROM memories WHERE guild_id = ${guildId} AND id = ${id}`;
    return rows[0] ? rowToMemory(rows[0]) : undefined;
  }

  async listMemories(guildId: string, subjectId: string, options: { search?: string; page?: number; status?: MemoryStatus } = {}): Promise<{ memories: Memory[]; total: number; page: number }> {
    const page = Math.max(1, options.page ?? 1);
    const status = options.status ?? "active";
    const offset = (page - 1) * 8;

    let countResult: [{ count: number }];
    let rows: MemoryRow[];

    if (options.search) {
      const search = `%${escapeLike(options.search)}%`;
      countResult = await this.sql<[{ count: number }]>`SELECT COUNT(*)::int as count FROM memories WHERE guild_id = ${guildId} AND subject_id = ${subjectId} AND status = ${status} AND content ILIKE ${search}`;
      rows = await this.sql<MemoryRow[]>`SELECT * FROM memories WHERE guild_id = ${guildId} AND subject_id = ${subjectId} AND status = ${status} AND content ILIKE ${search} ORDER BY importance * confidence DESC, last_confirmed_at DESC LIMIT 8 OFFSET ${offset}`;
    } else {
      countResult = await this.sql<[{ count: number }]>`SELECT COUNT(*)::int as count FROM memories WHERE guild_id = ${guildId} AND subject_id = ${subjectId} AND status = ${status}`;
      rows = await this.sql<MemoryRow[]>`SELECT * FROM memories WHERE guild_id = ${guildId} AND subject_id = ${subjectId} AND status = ${status} ORDER BY importance * confidence DESC, last_confirmed_at DESC LIMIT 8 OFFSET ${offset}`;
    }

    return { memories: rows.map(rowToMemory), total: Number(countResult[0].count), page };
  }

  async relevantMemories(guildId: string, subjectId: string, limit = 8): Promise<Memory[]> {
    // Candidates with promotable primary evidence are included so fresh direct
    // self-reports ("call me Riley") reach replies before nightly verification
    // promotes them; sarcasm/joke/uncertain candidates stay gated out. The reply
    // prompt annotates each memory's confidence so the model can weigh them.
    const rows = await this.sql<MemoryRow[]>`
      SELECT * FROM memories WHERE guild_id = ${guildId}
        AND (status = 'active' OR (status = 'candidate' AND primary_evidence_type IN ('explicit_fact', 'clear_preference', 'correction')))
        AND (subject_id = 'server' OR (subject_id = ${subjectId}
          AND subject_id IN (SELECT user_id FROM members WHERE guild_id = ${guildId} AND opted_in = 1 AND opted_out = 0)))
      ORDER BY importance * confidence DESC, last_confirmed_at DESC LIMIT ${limit}
    `;
    return rows.map(rowToMemory);
  }

  /** Turn-aware recall: memories whose content matches any of the turn's
   * salient terms (recallTerms — proper nouns first). This is the contextual
   * half of prompt recall alongside relevantMemories' static spine — a fact
   * ranked below the spine cap still surfaces when the conversation is about
   * it. Same consent + candidate gates as relevantMemories. */
  async contextualMemories(guildId: string, subjectId: string, terms: string[], limit = 6): Promise<Memory[]> {
    if (!terms.length) return [];
    const patterns = terms.slice(0, 10).map(t => `%${escapeLike(t)}%`);
    const rows = await this.sql<MemoryRow[]>`
      SELECT * FROM memories WHERE guild_id = ${guildId}
        AND (status = 'active' OR (status = 'candidate' AND primary_evidence_type IN ('explicit_fact', 'clear_preference', 'correction')))
        AND (subject_id = 'server' OR (subject_id = ${subjectId}
          AND subject_id IN (SELECT user_id FROM members WHERE guild_id = ${guildId} AND opted_in = 1 AND opted_out = 0)))
        AND content ILIKE ANY(${patterns})
      ORDER BY importance * confidence DESC, last_confirmed_at DESC LIMIT ${limit}
    `;
    return rows.map(rowToMemory);
  }

  /** Semantic recall: cosine-distance scan over embedded memories matching
   * the turn's query vector — the leg that catches paraphrases ILIKE can't
   * ("her dad" vs "father"). Same consent + candidate gates as the lexical
   * legs; maxDistance bounds how loose a match can be. */
  async semanticMemories(guildId: string, subjectId: string, vector: string, opts: { limit?: number; maxDistance?: number } = {}): Promise<Memory[]> {
    const rows = await this.sql<MemoryRow[]>`
      SELECT *, (embedding <=> ${vector}::vector) AS distance FROM memories
      WHERE guild_id = ${guildId}
        AND (status = 'active' OR (status = 'candidate' AND primary_evidence_type IN ('explicit_fact', 'clear_preference', 'correction')))
        AND (subject_id = 'server' OR (subject_id = ${subjectId}
          AND subject_id IN (SELECT user_id FROM members WHERE guild_id = ${guildId} AND opted_in = 1 AND opted_out = 0)))
        AND embedding IS NOT NULL
        AND embedding <=> ${vector}::vector < ${opts.maxDistance ?? 0.55}
      ORDER BY distance ASC LIMIT ${opts.limit ?? 6}
    `;
    return rows.map(rowToMemory);
  }

  /** Store an embedding for a memory — NULL-guard keeps it idempotent and
   * preserves the first write on near-dup merges into an already-embedded row. */
  async setMemoryEmbedding(id: number, vector: string): Promise<void> {
    await this.sql`UPDATE memories SET embedding = ${vector}::vector WHERE id = ${id} AND embedding IS NULL`;
  }

  /** Rows missing embeddings — the backfill sweep's work list. Candidates are
   * included so promotable-but-unverified rows can surface semantically. */
  async unembeddedMemories(limit: number): Promise<Array<{ id: number; content: string }>> {
    const rows = await this.sql<Array<{ id: number; content: string }>>`
      SELECT id, content FROM memories
      WHERE embedding IS NULL AND status IN ('active', 'candidate')
      ORDER BY created_at ASC LIMIT ${limit}
    `;
    return rows.map(r => ({ id: Number(r.id), content: r.content }));
  }

  async allActiveMemories(guildId: string, subjectId: string): Promise<Memory[]> {
    const rows = await this.sql<MemoryRow[]>`
      SELECT * FROM memories WHERE guild_id = ${guildId} AND subject_id = ${subjectId} AND status = 'active'
      ORDER BY importance * confidence DESC, last_confirmed_at DESC
    `;
    return rows.map(rowToMemory);
  }

  /** Memories about a subject that a denial/correction message could target —
   * active + contested first, then candidates the subject might have seen surfaced. */
  async contestableMemories(guildId: string, subjectId: string, limit = 15): Promise<Memory[]> {
    const rows = await this.sql<MemoryRow[]>`
      SELECT * FROM memories WHERE guild_id = ${guildId} AND subject_id = ${subjectId}
        AND status IN ('active', 'contested', 'candidate')
      ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'contested' THEN 1 ELSE 2 END,
               importance * confidence DESC, last_confirmed_at DESC
      LIMIT ${limit}
    `;
    return rows.map(rowToMemory);
  }

  async evidence(guildId: string, memoryId: number): Promise<MemoryEvidence[]> {
    const rows = await this.sql<EvidenceRow[]>`
      SELECT e.id, e.memory_id, e.message_id, e.author_id, e.quote, e.reason, e.explicitness,
             e.observed_at, e.evidence_type, e.effect, e.message_content_snapshot, e.message_timestamp, e.created_at
      FROM memory_evidence e JOIN memories m ON m.id = e.memory_id
      WHERE m.guild_id = ${guildId} AND m.id = ${memoryId}
      ORDER BY e.observed_at DESC
    `;
    return rows.map(r => ({
      id: Number(r.id), memoryId: Number(r.memory_id), messageId: r.message_id, authorId: r.author_id,
      quote: r.quote, reason: r.reason, explicitness: Number(r.explicitness),
      observedAt: ts(r.observed_at), evidenceType: r.evidence_type, effect: r.effect,
      messageContentSnapshot: r.message_content_snapshot, messageTimestamp: ts(r.message_timestamp), createdAt: ts(r.created_at),
    }));
  }

  async history(guildId: string, memoryId: number): Promise<MemoryHistory[]> {
    const rows = await this.sql<HistoryRow[]>`
      SELECT h.id, h.memory_id, h.action, h.previous_confidence, h.new_confidence,
             h.previous_status, h.new_status, h.evidence_id, h.details_json, h.created_at
      FROM memory_history h JOIN memories m ON m.id = h.memory_id
      WHERE m.guild_id = ${guildId} AND m.id = ${memoryId}
      ORDER BY h.created_at DESC
    `;
    return rows.map(r => ({
      id: Number(r.id), memoryId: Number(r.memory_id), action: r.action,
      previousConfidence: r.previous_confidence != null ? Number(r.previous_confidence) : null,
      newConfidence: r.new_confidence != null ? Number(r.new_confidence) : null,
      previousStatus: r.previous_status as MemoryStatus | null,
      newStatus: r.new_status as MemoryStatus | null,
      evidenceId: r.evidence_id != null ? Number(r.evidence_id) : null,
      detailsJson: r.details_json, createdAt: ts(r.created_at),
    }));
  }

  async logHistory(memoryId: number, action: string, previousConfidence: number | null, newConfidence: number | null, previousStatus: MemoryStatus | null, newStatus: MemoryStatus | null, evidenceId: number | null, details: Record<string, unknown> = {}): Promise<void> {
    await this._logHistory(this.sql, memoryId, action, previousConfidence, newConfidence, previousStatus, newStatus, evidenceId, details);
  }

  private async _logHistory(sql: Sql, memoryId: number, action: string, previousConfidence: number | null, newConfidence: number | null, previousStatus: MemoryStatus | null, newStatus: MemoryStatus | null, evidenceId: number | null, details: Record<string, unknown> = {}): Promise<void> {
    await sql`
      INSERT INTO memory_history (memory_id, action, previous_confidence, new_confidence, previous_status, new_status, evidence_id, details_json)
      VALUES (${memoryId}, ${action}, ${previousConfidence}, ${newConfidence}, ${previousStatus}, ${newStatus}, ${evidenceId}, ${JSON.stringify(details)})
    `;
  }

  // ── Mutations ──────────────────────────────────────────────────────────────

  async forget(guildId: string, id: number): Promise<number> {
    return await this.sql.begin(async sql => {
      const result = await sql`UPDATE memories SET status = 'forgotten' WHERE guild_id = ${guildId} AND id = ${id} AND status != 'forgotten'`;
      if (result.count) await recomputeForMemories(sql, guildId, [id]);
      return result.count;
    });
  }

  /** Opt-out bulk forget: every live memory about a subject → forgotten. */
  async forgetAllFor(guildId: string, subjectId: string): Promise<number> {
    return await this.sql.begin(async sql => {
      const rows = await sql<Array<{ id: number }>>`
        UPDATE memories SET status = 'forgotten', updated_at = NOW()
        WHERE guild_id = ${guildId} AND subject_id = ${subjectId} AND status != 'forgotten'
        RETURNING id
      `;
      await recomputeForMemories(sql, guildId, rows.map(r => r.id));
      return rows.length;
    });
  }

  /** Hard-delete every relationship observation and edge involving a subject —
   * as either edge party or as the assertor. Unlike memories (soft-forgotten
   * for inspectability), these tables have no status column or inspection
   * surface, so opt-out deletes. Edges are removed eagerly rather than waiting
   * on recomputeEdges — a guild-wide rebuild for one opt-out would be wasteful
   * and would leave a stale edge visible until the next maintenance run.
   * Returns the observation count (edges aggregate many observations). */
  async forgetRelationshipsFor(guildId: string, subjectId: string): Promise<number> {
    return await this.sql.begin(async sql => {
      const gone = await sql<Array<{ subject_id: string; other_id: string }>>`
        DELETE FROM relationship_observations
        WHERE guild_id = ${guildId} AND (subject_id = ${subjectId} OR other_id = ${subjectId} OR author_id = ${subjectId})
        RETURNING subject_id, other_id
      `;
      await sql`
        DELETE FROM relationships
        WHERE guild_id = ${guildId} AND (subject_id = ${subjectId} OR other_id = ${subjectId})
      `;
      // An edge fed by a now-deleted observation keeps its stale aggregate
      // (count, valence, summary) until the next recompute — drop every edge
      // that consumed a deleted row instead. Surviving literal observations
      // rebuild it on the next maintenance pass.
      if (gone.length) {
        const pairs = [...new Set(gone.map(g => `${g.subject_id}|${g.other_id}`))];
        await sql`
          DELETE FROM relationships r
          WHERE r.guild_id = ${guildId}
            AND (r.subject_id || '|' || r.other_id) = ANY(${pairs})
        `;
      }
      return gone.length;
    });
  }

  async confirm(guildId: string, id: number): Promise<number> {
    return await this.sql.begin(async sql => {
      const result = await sql`
        UPDATE memories SET status = 'active', confidence = GREATEST(confidence, 0.9), last_confirmed_at = NOW()
        WHERE guild_id = ${guildId} AND id = ${id} AND status = 'candidate'
      `;
      if (result.count) await recomputeForMemories(sql, guildId, [id]);
      return result.count;
    });
  }

  async supersede(guildId: string, oldId: number, replacementId: number): Promise<void> {
    const old = await this.getMemory(guildId, oldId);
    const replacement = await this.getMemory(guildId, replacementId);
    if (!old || !replacement) return;
    await this.sql.begin(async sql => {
      await sql`UPDATE memories SET status = 'superseded', superseded_by = ${replacementId}, updated_at = NOW() WHERE guild_id = ${guildId} AND id = ${oldId}`;
      await sql`UPDATE memories SET supersedes_memory_id = ${oldId}, status = 'active', updated_at = NOW() WHERE guild_id = ${guildId} AND id = ${replacementId}`;
      // Provenance transfers, not strips: attributes citing the superseded
      // memory now cite the canonical replacement.
      await transferProvenance(sql, guildId, oldId, replacementId);
      await recomputeForMemories(sql, guildId, [replacementId]);
      await this._logHistory(sql, oldId, "superseded", old.confidence, old.confidence, old.status, "superseded", null, { replacementId });
      await this._logHistory(sql, replacementId, "correction_activated", replacement.confidence, replacement.confidence, replacement.status, "active", null, { supersedesMemoryId: oldId });
    });
  }

  // ── Semantic dedup ─────────────────────────────────────────────────────────
  // The trigram fast-path in saveMemory() catches lexically-similar rephrasings;
  // the maintenance pass below catches semantic duplicates with no trigram
  // overlap ("allergic to peanuts" / "can't eat nuts") by handing each member's
  // memory list to the LLM. The LLM proposes groups; applyDedupGroups() enforces
  // the guards and merges. Same-subject merges only — unresolved names could be
  // different people, and 'episode' rows accumulate by design.

  /** Per-member memory lists for the dedup LLM pass: live rows on resolved
   * subjects only, grouped by subject. Bounded per member and per run. */
  async listDedupCandidates(guildId: string, maxMembers = 50, maxPerMember = 30): Promise<Array<{
    subjectId: string; label: string; memories: Array<{ memoryId: number; kind: string; status: string; content: string }>;
  }>> {
    const rows = await this.sql<Array<{ id: number | string; subject_id: string; kind: string; status: string; content: string }>>`
      SELECT id, subject_id, kind, status, content FROM memories
      WHERE guild_id = ${guildId}
        AND status IN ('candidate', 'active')
        AND kind != 'episode'
        AND subject_id != 'unknown'
      ORDER BY subject_id, id
    `;
    const bySubject = new Map<string, Array<{ id: number | string; subject_id: string; kind: string; status: string; content: string }>>();
    for (const r of rows) {
      const list = bySubject.get(r.subject_id) ?? [];
      list.push(r);
      bySubject.set(r.subject_id, list);
    }
    const members = [...bySubject.entries()]
      .filter(([, list]) => list.length >= 2)          // nothing to dedup solo
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, maxMembers);
    return await Promise.all(members.map(async ([subjectId, list]) => ({
      subjectId,
      label: await this.displayNameFor(guildId, subjectId),
      memories: list.slice(0, maxPerMember).map(r => ({ memoryId: Number(r.id), kind: r.kind, status: r.status, content: r.content })),
    })));
  }

  /** Merge a duplicate memory into its canonical row: the dup's evidence moves
   * over, except rows colliding on message_id, which stay on the superseded
   * dup — memory_history.evidence_id references them (FK, no cascade) and the
   * dup's audit trail stays complete. Counters are recounted from evidence,
   * and the dup becomes 'superseded' with a link back. Canonical
   * status/confidence are untouched — a merge must not launder promotion.
   * Idempotent: a dup no longer candidate/active is a no-op. */
  async mergeDuplicate(guildId: string, canonicalId: number, dupId: number, reason = ""): Promise<boolean> {
    if (canonicalId === dupId) return false;
    return await this.sql.begin(async sql => {
      const rows = await sql<Array<{ id: number | string; status: string }>>`
        SELECT id, status FROM memories WHERE guild_id = ${guildId} AND id IN (${canonicalId}, ${dupId})
      `;
      const canon = rows.find(r => Number(r.id) === canonicalId);
      const dup = rows.find(r => Number(r.id) === dupId);
      if (!canon || !dup) return false;
      if (canon.status !== "candidate" && canon.status !== "active") return false;
      if (dup.status !== "candidate" && dup.status !== "active") return false;

      await sql`
        UPDATE memory_evidence ev SET memory_id = ${canonicalId}
        WHERE ev.memory_id = ${dupId}
          AND NOT EXISTS (SELECT 1 FROM memory_evidence e WHERE e.memory_id = ${canonicalId} AND e.message_id = ev.message_id)
      `;
      await sql`
        UPDATE memories SET
          confirmation_count = (SELECT COUNT(*)::int FROM memory_evidence WHERE memory_id = ${canonicalId} AND effect = 'support'),
          mentions           = (SELECT COUNT(*)::int FROM memory_evidence WHERE memory_id = ${canonicalId} AND effect = 'support'),
          contradiction_count = (SELECT COUNT(*)::int FROM memory_evidence WHERE memory_id = ${canonicalId} AND effect = 'contradict'),
          updated_at = NOW()
        WHERE id = ${canonicalId}
      `;
      await sql`UPDATE memories SET status = 'superseded', superseded_by = ${canonicalId}, updated_at = NOW() WHERE id = ${dupId}`;
      // A merge is a supersede for provenance purposes: attributes citing the
      // dup transfer their citation to the canonical row.
      await transferProvenance(sql, guildId, dupId, canonicalId);
      await this._logHistory(sql, canonicalId, "dedup_merged", null, null, null, null, null, { mergedMemoryId: dupId, reason });
      await this._logHistory(sql, dupId, "dedup_merged", null, null, dup.status, "superseded", null, { mergedInto: canonicalId, reason });
      return true;
    });
  }

  /** Apply LLM-proposed duplicate groups with guards: every id must share the
   * same (subject_id, kind) and be candidate/active; singletons and
   * cross-member/kind groups are dropped. Canonical = active over candidate,
   * then higher confidence, then lowest id. Returns merge/skip counts. */
  async applyDedupGroups(guildId: string, groups: Array<{ ids: number[]; reason: string }>, maxMerges = 30): Promise<{ merged: number; skipped: number }> {
    let merged = 0, skipped = 0;
    for (const g of groups) {
      if (merged >= maxMerges) break;
      const ids = [...new Set(g.ids)];
      if (ids.length < 2) { skipped++; continue; }
      const rows = await this.sql<Array<{ id: number | string; subject_id: string; kind: string; status: string; confidence: number }>>`
        SELECT id, subject_id, kind, status, confidence FROM memories
        WHERE guild_id = ${guildId} AND id IN ${this.sql(ids)}
      `;
      const live = rows.filter(r => (r.status === "candidate" || r.status === "active") && r.kind !== "episode" && r.subject_id !== "unknown");
      if (live.length !== ids.length || new Set(live.map(r => r.subject_id)).size !== 1 || new Set(live.map(r => r.kind)).size !== 1) {
        skipped++;
        continue;
      }
      live.sort((a, b) =>
        (b.status === "active" ? 1 : 0) - (a.status === "active" ? 1 : 0)
        || b.confidence - a.confidence
        || Number(a.id) - Number(b.id)
      );
      const canonicalId = Number(live[0].id);
      for (const dup of live.slice(1)) {
        if (merged >= maxMerges) break;
        if (await this.mergeDuplicate(guildId, canonicalId, Number(dup.id), g.reason)) merged++;
        else skipped++;
      }
    }
    return { merged, skipped };
  }

  async resolveContested(guildId: string, memoryId: number, now = new Date()): Promise<{ resolved: boolean; netScore: number }> {
    const memory = await this.getMemory(guildId, memoryId);
    if (!memory || memory.status !== "contested") return { resolved: false, netScore: 0 };
    const evRows = await this.evidence(guildId, memoryId);
    const ev = evRows.filter(item => item.effect === "support" || item.effect === "contradict");
    const weight = (timestamp: string) => Math.pow(0.5, Math.max(0, now.getTime() - new Date(timestamp).getTime()) / 86_400_000 / 90);
    const supportScore = ev.filter(item => item.effect === "support").reduce((sum, item) => sum + weight(item.messageTimestamp), 0);
    const contradictionScore = ev.filter(item => item.effect === "contradict").reduce((sum, item) => sum + weight(item.messageTimestamp), 0);
    const netScore = supportScore - contradictionScore;
    const newest = [...ev].sort((a, b) => b.messageTimestamp.localeCompare(a.messageTimestamp))[0];
    // Always persist the current net_score so the DB reflects the latest resolution signal
    // (and so the unresolved path can diff against it to suppress repeat logging).
    const previousNetScore = memory.netScore;
    await this.sql`UPDATE memories SET net_score = ${netScore} WHERE guild_id = ${guildId} AND id = ${memoryId}`;
    if (memory.confidence >= 0.70 && netScore >= 0.50 && newest?.effect !== "contradict") {
      // Resolution: support won, but the promotion gate still applies — a
      // memory whose primary evidence could never promote (rumour, sarcasm,
      // uncertain inference) resolves to candidate, not active. Otherwise a
      // weak-evidence candidate could launder itself into an active fact via
      // contradict → contested → resolve. Candidates reap via stale-quarantine.
      // 'unknown' subjects are inert until claimed — never resolve to active.
      const promotable = PROMOTABLE_EVIDENCE_TYPES.includes(memory.primaryEvidenceType as EvidenceType) && memory.subjectId !== "unknown";
      const target: MemoryStatus = promotable ? "active" : "candidate";
      await this.sql`UPDATE memories SET status = ${target}, frozen_confidence = NULL, net_score = NULL, updated_at = NOW() WHERE guild_id = ${guildId} AND id = ${memoryId}`;
      await recomputeForMemories(this.sql, guildId, [memoryId]);
      await this.logHistory(memoryId, "conflict_resolved", memory.confidence, memory.confidence, "contested", target, null, { supportScore, contradictionScore, netScore, promotable });
      return { resolved: true, netScore };
    }
    // Contested is a dispute state, not a terminal one — confidence is frozen
    // at entry, so a sub-threshold contested row could never meet the resolve
    // gate and would be re-litigated by every nightly pass forever. A live
    // dispute stays contested (new evidence or the subject's own word can
    // still settle it), but a standoff with no new signal in 30 days settles
    // by the standing sign: support-leaning returns to candidate (the ordinary
    // ladder / stale-quarantine decides from there), contradiction-leaning
    // quarantines.
    const lastSignalAt = newest ? new Date(newest.messageTimestamp).getTime() : 0;
    const staleContest = now.getTime() - lastSignalAt > 30 * 86_400_000;
    const demote: MemoryStatus | null = staleContest ? (netScore >= 0 ? "candidate" : "quarantined") : null;
    if (demote) {
      await this.sql`UPDATE memories SET status = ${demote}, frozen_confidence = NULL, net_score = NULL, updated_at = NOW() WHERE guild_id = ${guildId} AND id = ${memoryId}`;
      await recomputeForMemories(this.sql, guildId, [memoryId]);
      await this.logHistory(memoryId, "conflict_demoted", memory.confidence, memory.confidence, "contested", demote, null, { supportScore, contradictionScore, netScore, staleContest });
      return { resolved: true, netScore };
    }
    // A live dispute stays contested — but log only when the score actually
    // moved, so nightly rescans of an unchanged standoff don't spam
    // memory_history. Time-decayed weights drift in the last decimals between
    // calls, so the comparison needs an epsilon; a real new vote moves the
    // score by ~1.
    if (previousNetScore == null || Math.abs(previousNetScore - netScore) >= 0.01) {
      await this.logHistory(memoryId, "conflict_unresolved", memory.confidence, memory.confidence, "contested", "contested", null, { supportScore, contradictionScore, netScore });
    }
    return { resolved: false, netScore };
  }

  /** The subject of a contested memory affirms it themselves — decisive on the
   * dispute regardless of net_score, since the person described is the authority
   * on their own facts. But the evidence-type floor still applies: a row whose
   * primary evidence could never promote resolves to candidate, where nightly
   * verification and stale-quarantine judge it — a joke the subject confirms
   * does not become a fact. */
  async subjectConfirm(guildId: string, memoryId: number): Promise<void> {
    const memory = await this.getMemory(guildId, memoryId);
    if (!memory || memory.status !== "contested") return;
    const promotable = PROMOTABLE_EVIDENCE_TYPES.includes(memory.primaryEvidenceType as EvidenceType) && memory.subjectId !== "unknown";
    const target: MemoryStatus = promotable ? "active" : "candidate";
    await this.sql`UPDATE memories SET status = ${target}, frozen_confidence = NULL, net_score = NULL, updated_at = NOW() WHERE guild_id = ${guildId} AND id = ${memoryId}`;
    await recomputeForMemories(this.sql, guildId, [memoryId]);
    await this.logHistory(memoryId, "subject_confirmed", memory.confidence, memory.confidence, "contested", target, null, { promotable });
  }

  // ── Context helpers ────────────────────────────────────────────────────────

  /** Recent channel transcript with reply edges resolved — "call her a bitch"
   * only makes sense if the model can see it was a reply to a specific line.
   * Bot-authored rows carry authorId so the reply path can render them as
   * "you:" and member→bot reply edges resolve instead of dangling. */
  async recentContext(guildId: string, channelId: string, limit = 25): Promise<Array<{ authorName: string; authorId: string; content: string; createdAt: string; replyToAuthorId?: string; replyToAuthor?: string; replyToSnippet?: string }>> {
    const rows = await this.sql<Array<{ author_name: string; author_id: string; content: string; created_at: string; reply_to_author_id: string | null; reply_to_author: string | null; reply_to_snippet: string | null }>>`
      SELECT m.author_name, m.author_id, m.content, m.created_at,
             ref.author_id AS reply_to_author_id, ref.author_name AS reply_to_author,
             LEFT(ref.content, 80) AS reply_to_snippet
      FROM messages m
      LEFT JOIN messages ref ON ref.id = m.reply_to_id
      WHERE m.guild_id = ${guildId} AND m.channel_id = ${channelId}
      ORDER BY m.created_at DESC LIMIT ${limit}
    `;
    return rows.reverse().map(r => ({
      authorName: r.author_name, authorId: r.author_id, content: r.content, createdAt: ts(r.created_at),
      ...(r.reply_to_author ? { replyToAuthorId: r.reply_to_author_id ?? undefined, replyToAuthor: r.reply_to_author, replyToSnippet: r.reply_to_snippet ?? "" } : {}),
    }));
  }

  async messagesByIds(guildId: string, messageIds: string[]): Promise<Array<{ authorName: string; content: string; createdAt: string }>> {
    if (messageIds.length === 0) return [];
    const rows = await this.sql<MessageRow[]>`
      SELECT author_name, content, created_at FROM messages WHERE guild_id = ${guildId} AND id = ANY(${messageIds}) ORDER BY created_at ASC, id ASC
    `;
    return rows.map(r => ({ authorName: r.author_name, content: r.content, createdAt: ts(r.created_at) }));
  }

  async deleteRawMessagesOlderThan(guildId: string, days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const result = await this.sql`DELETE FROM messages WHERE guild_id = ${guildId} AND created_at < ${cutoff}`;
    return result.count;
  }

  // Derived-data retention. Only `messages` aged out via raw retention, leaving
  // the append-only tables unbounded; this caps them at 90 days:
  // - memory_history: audit trail — old entries lose tuning value anyway.
  // - unresolved_names / alias_candidates: discovery surfaces — a name that still
  //   matters recurs and writes a fresh row, so aged rows carry no unique signal.
  // - candidate-tier events that have closed (discarded or timed out): never
  //   surfaced anywhere. Promoted 'event' rows are the feature and are kept.
  // Child tables have no cascade, so they're deleted first. memory_evidence
  // ROWS are deliberately kept — the audit trail (type, effect, reason) is
  // retained for inspectability even on forgotten memories — but their
  // verbatim text columns expire with the raw-message retention window,
  // otherwise a deleted message's words would persist inside evidence.
  async pruneDerivedData(guildId: string, olderThanDays = 90, verbatimDays?: number): Promise<{ history: number; names: number; aliases: number; events: number; usage: number; evidence: number; observations: number }> {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const staleEvents = this.sql`SELECT id FROM events WHERE guild_id = ${guildId} AND tier = 'candidate' AND closed_at IS NOT NULL AND occurred_at < ${cutoff}`;
    const history = await this.sql`
      DELETE FROM memory_history WHERE created_at < ${cutoff}
      AND memory_id IN (SELECT id FROM memories WHERE guild_id = ${guildId})
    `;
    const names = await this.sql`DELETE FROM unresolved_names WHERE guild_id = ${guildId} AND created_at < ${cutoff}`;
    const aliases = await this.sql`DELETE FROM alias_candidates WHERE guild_id = ${guildId} AND created_at < ${cutoff}`;
    await this.sql`DELETE FROM webhook_messages WHERE guild_id = ${guildId} AND created_at < ${cutoff}`;
    await this.sql`DELETE FROM event_participants WHERE event_id IN (${staleEvents})`;
    await this.sql`DELETE FROM event_messages WHERE event_id IN (${staleEvents})`;
    await this.sql`DELETE FROM event_memories WHERE event_id IN (${staleEvents})`;
    const events = await this.sql`DELETE FROM events WHERE id IN (${staleEvents})`;
    // guild_usage is operational state, not derived data — 30 days of history
    // is enough for /status-style review; without this it grows ~365
    // rows/guild/year forever. The 'hosted:global' fleet-breaker row isn't a
    // real guild so it rides this same prune via whichever guild runs first.
    const usage = await this.sql`DELETE FROM guild_usage WHERE guild_id IN (${guildId}, 'hosted:global') AND day < (now() AT TIME ZONE 'UTC')::date - 30`;
    // Two classes of dead observation: a NULL-verdict row whose source message
    // is gone can never be verified (listUnverifiedObservations JOINs
    // messages), and a non-literal verdict never feeds an edge. Both are
    // permanent dead weight — prune them. Literal rows survive a dead source:
    // the rendered verdict is the derived truth, same stance as evidence
    // metadata outliving its scrubbed quote.
    const deadSource = await this.sql`
      DELETE FROM relationship_observations
      WHERE guild_id = ${guildId} AND verdict IS NULL
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = message_id AND m.guild_id = ${guildId})
    `;
    const deadVerdict = await this.sql`
      DELETE FROM relationship_observations
      WHERE guild_id = ${guildId} AND verdict IN ('joke', 'unclear', 'misattributed') AND created_at < ${cutoff}
    `;
    let evidence = { count: 0 };
    if (verbatimDays !== undefined) {
      const vcutoff = new Date(Date.now() - verbatimDays * 86_400_000).toISOString();
      evidence = await this.sql`
        UPDATE memory_evidence SET quote = '', message_content_snapshot = ''
        WHERE created_at < ${vcutoff} AND (quote <> '' OR message_content_snapshot <> '')
        AND memory_id IN (SELECT id FROM memories WHERE guild_id = ${guildId})
      `;
    }
    return { history: history.count, names: names.count, aliases: aliases.count, events: events.count, usage: usage.count, evidence: evidence.count, observations: deadSource.count + deadVerdict.count };
  }

  /** Opt-out scrub: blank the verbatim text columns on every evidence row
   * citing this subject's memories — immediately, not at retention expiry.
   * Metadata (type, effect, reason, observed_at) stays for the audit trail.
   * Also covers evidence this subject AUTHORED: their verbatim words must
   * come off other members' memories too, not just their own. */
  async scrubEvidenceFor(guildId: string, subjectId: string): Promise<number> {
    const result = await this.sql`
      UPDATE memory_evidence SET quote = '', message_content_snapshot = ''
      WHERE (quote <> '' OR message_content_snapshot <> '')
      AND memory_id IN (SELECT id FROM memories WHERE guild_id = ${guildId})
      AND (
        author_id = ${subjectId}
        OR memory_id IN (SELECT id FROM memories WHERE guild_id = ${guildId} AND subject_id = ${subjectId})
      )
    `;
    return result.count;
  }

  /** Hard-delete a subject's attribute rows — derived data about an opted-out
   * member shouldn't linger even in a non-active status. */
  async deleteAttributesFor(guildId: string, subjectId: string): Promise<number> {
    const result = await this.sql`DELETE FROM profile_attributes WHERE guild_id = ${guildId} AND subject_id = ${subjectId}`;
    return result.count;
  }

  /** Hard-delete a subject's consolidated behavioral patterns — derived person
   * data like attributes, so opt-out removes them outright. Without this a
   * pattern built from now-forgotten episodes would resurface on re-opt-in. */
  async deletePatternsFor(guildId: string, subjectId: string): Promise<number> {
    const result = await this.sql`DELETE FROM behavioral_patterns WHERE guild_id = ${guildId} AND subject_id = ${subjectId}`;
    return result.count;
  }

  // Admin triage view: the last N memories written for the guild across all
  // subjects, with the best display label we have (member name > extracted
  // subject name > raw id).
  async recentMemories(guildId: string, limit = 15): Promise<Array<Memory & { subjectLabel: string }>> {
    const rows = await this.sql<Array<MemoryRow & { subject_label: string }>>`
      SELECT m.*, COALESCE(NULLIF(mb.known_names[1], ''), NULLIF(m.subject_name, ''), m.subject_id) AS subject_label
      FROM memories m
      LEFT JOIN members mb ON mb.guild_id = m.guild_id AND mb.user_id = m.subject_id
      WHERE m.guild_id = ${guildId}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ${limit}
    `;
    return rows.map(r => ({ ...rowToMemory(r), subjectLabel: r.subject_label }));
  }

  /** Guild-wide active-memory text search — the search_memories lookup tool.
   * Importance-weighted, bounded; only 'active' rows ever surface.
   * `kinds` restricts at query level — proactive grounding passes
   * ['server_lore'] so person facts/preferences can never slip through a
   * post-fetch filter bug into an unprompted public answer. */
  async searchMemories(guildId: string, query: string, limit = 5, kinds?: string[]): Promise<Array<{ subjectId: string; content: string; confidence: number }>> {
    // Person-scoped rows surface only for opted-in subjects — server lore and
    // episodes attached to 'server' are consent-exempt shared context.
    const rows = await this.sql<Array<{ subject_id: string; content: string; confidence: number }>>`
      SELECT subject_id, content, confidence FROM memories
      WHERE guild_id = ${guildId} AND status = 'active' AND content ILIKE ${`%${escapeLike(query)}%`}
      AND (subject_id = 'server' OR subject_id IN (SELECT user_id FROM members WHERE guild_id = ${guildId} AND opted_in = 1 AND opted_out = 0))
      ${kinds?.length ? this.sql`AND kind = ANY(${kinds})` : this.sql``}
      ORDER BY importance * confidence DESC LIMIT ${limit}
    `;
    return rows.map(r => ({ subjectId: r.subject_id, content: r.content, confidence: Number(r.confidence) }));
  }

  // ── Episode consolidation ──────────────────────────────────────────────────
  // Consolidate active episodes for a subject into behavioral_patterns rows.
  // Only active-status episodes count toward pattern formation — candidates and quarantined
  // episodes must not influence whether a pattern is recognised.
  //
  // If the subject already has an active pattern, unlinked episodes are appended to it (the
  // episode_count and confidence are refreshed) rather than creating a second pattern row.
  // This prevents unbounded pattern accumulation across maintenance runs.

  async consolidateEpisodes(guildId: string, subjectId: string, minEpisodes = 3): Promise<number> {
    const unlinked = await this.sql<Array<{ id: number; content: string; confidence: number }>>`
      SELECT id, content, confidence FROM memories
      WHERE guild_id = ${guildId} AND subject_id = ${subjectId} AND kind = 'episode' AND status = 'active' AND pattern_id IS NULL
      ORDER BY confidence DESC
    `;
    if (unlinked.length < minEpisodes) return 0;
    const ids = unlinked.map(e => Number(e.id));
    const avgConfidence = unlinked.reduce((sum, e) => sum + Number(e.confidence), 0) / unlinked.length;

    const existingPattern = await this.sql<Array<{ id: number; episode_count: number }>>`
      SELECT id, episode_count FROM behavioral_patterns WHERE guild_id = ${guildId} AND subject_id = ${subjectId} AND status = 'active' ORDER BY id LIMIT 1
    `;

    let patternId: number;
    if (existingPattern[0]) {
      const newCount = Number(existingPattern[0].episode_count) + unlinked.length;
      await this.sql`UPDATE behavioral_patterns SET episode_count = ${newCount}, confidence = ${avgConfidence}, updated_at = NOW() WHERE id = ${existingPattern[0].id}`;
      patternId = Number(existingPattern[0].id);
    } else {
      // TODO(Phase 1D): synthesise a human-readable description via LLM rather than copying the episode content verbatim.
      const description = unlinked[0].content;
      const inserted = await this.sql`
        INSERT INTO behavioral_patterns (guild_id, subject_id, description, episode_count, confidence)
        VALUES (${guildId}, ${subjectId}, ${description}, ${unlinked.length}, ${avgConfidence})
        RETURNING id
      `;
      patternId = Number(inserted[0].id);
    }
    await this.sql`UPDATE memories SET pattern_id = ${patternId} WHERE id = ANY(${ids})`;
    return 1;
  }

  async patterns(guildId: string, subjectId: string): Promise<BehavioralPattern[]> {
    const rows = await this.sql<Array<{ id: number; guild_id: string; subject_id: string; description: string; episode_count: number; confidence: number; created_at: Date | string; updated_at: Date | string; status: string }>>`
      SELECT id, guild_id, subject_id, description, episode_count, confidence, created_at, updated_at, status
      FROM behavioral_patterns WHERE guild_id = ${guildId} AND subject_id = ${subjectId} AND status = 'active'
      ORDER BY confidence DESC
    `;
    return rows.map(r => ({
      id: Number(r.id), guildId: r.guild_id, subjectId: r.subject_id, description: r.description,
      episodeCount: Number(r.episode_count), confidence: Number(r.confidence),
      createdAt: ts(r.created_at), updatedAt: ts(r.updated_at), status: r.status,
    }));
  }

  async maintain(guildId: string, candidateThreshold = 0.7): Promise<{ promoted: number; quarantinedCandidates: number; quarantinedActive: number; resolved: number; patternsFound: number }> {
    const candidateCutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const staleCutoff = new Date(Date.now() - 90 * 86_400_000).toISOString();

    // The primary_evidence_type gate mirrors the per-insert promotableTypes allowlist so that
    // sarcasm, rumour, and uncertain-inference memories cannot be promoted by bulk maintenance
    // even if their confidence and mention counts happen to satisfy the numeric thresholds.
    const promotedRows = await this.sql<Array<{ id: number }>>`
      UPDATE memories SET status = 'active' WHERE guild_id = ${guildId} AND status = 'candidate'
      AND mentions >= 2 AND confidence >= ${candidateThreshold}
      AND primary_evidence_type IN ('explicit_fact', 'clear_preference', 'correction')
      -- 'unknown' subjects are inert until claimed and non-consenting members
      -- must never promote (mirrors the relevantMemories read gate). Opt-out
      -- forgets a member's memories outright, so this mostly guards stale rows.
      AND (subject_id = 'server'
           OR subject_id IN (SELECT user_id FROM members WHERE guild_id = ${guildId} AND opted_in = 1 AND opted_out = 0))
      RETURNING id
    `;
    const quarantinedCandidatesRows = await this.sql<Array<{ id: number }>>`
      UPDATE memories SET status = 'quarantined' WHERE guild_id = ${guildId} AND status = 'candidate' AND last_confirmed_at < ${candidateCutoff}
      RETURNING id
    `;
    const quarantinedActiveRows = await this.sql<Array<{ id: number }>>`
      UPDATE memories SET status = 'quarantined' WHERE guild_id = ${guildId} AND status = 'active' AND confidence < 0.75 AND last_confirmed_at < ${staleCutoff}
      RETURNING id
    `;
    // Status changes cascade to citing attributes — quarantined provenance no
    // longer supports a live facet; promoted provenance can revive one.
    const changedIds = [...promotedRows, ...quarantinedCandidatesRows, ...quarantinedActiveRows].map(r => r.id);
    if (changedIds.length) await recomputeForMemories(this.sql, guildId, changedIds);

    // Attempt to resolve all contested memories in this guild via age-weighted net score.
    const contestedRows = await this.sql<Array<{ id: number }>>`SELECT id FROM memories WHERE guild_id = ${guildId} AND status = 'contested'`;
    let resolved = 0;
    for (const row of contestedRows) {
      const result = await this.resolveContested(guildId, Number(row.id));
      if (result.resolved) resolved++;
    }

    // Consolidate episodes into behavioral patterns per subject.
    const subjectRows = await this.sql<Array<{ subject_id: string }>>`
      SELECT DISTINCT subject_id FROM memories WHERE guild_id = ${guildId} AND kind = 'episode' AND status = 'active' AND pattern_id IS NULL
    `;
    let patternsFound = 0;
    for (const row of subjectRows) {
      patternsFound += await this.consolidateEpisodes(guildId, row.subject_id);
    }

    return {
      promoted: promotedRows.length,
      quarantinedCandidates: quarantinedCandidatesRows.length,
      quarantinedActive: quarantinedActiveRows.length,
      resolved,
      patternsFound,
    };
  }

  // ── Admin ──────────────────────────────────────────────────────────────────

  async stats(guildId: string): Promise<{ messages: number; memories: number; lore: number }> {
    const [messages, memories, lore] = await Promise.all([
      this.sql<[{ count: number }]>`SELECT COUNT(*)::int as count FROM messages WHERE guild_id = ${guildId}`,
      this.sql<[{ count: number }]>`SELECT COUNT(*)::int as count FROM memories WHERE guild_id = ${guildId} AND status = 'active'`,
      this.sql<[{ count: number }]>`SELECT COUNT(*)::int as count FROM memories WHERE guild_id = ${guildId} AND status = 'active' AND kind = 'server_lore'`,
    ]);
    return { messages: messages[0].count, memories: memories[0].count, lore: lore[0].count };
  }

  async exportSubject(guildId: string, subjectId: string): Promise<{ memories: Array<Memory & { evidence: MemoryEvidence[] }>; attributes: ProfileAttribute[]; journal: JournalEntry[] }> {
    const rows = await this.sql<MemoryRow[]>`SELECT * FROM memories WHERE guild_id = ${guildId} AND subject_id = ${subjectId} ORDER BY id`;
    const memories = await Promise.all(rows.map(async r => {
      const mem = rowToMemory(r);
      return { ...mem, evidence: await this.evidence(guildId, mem.id) };
    }));
    const attributes = await listAttributes(this.sql, guildId, subjectId);
    const journal = await this.journalAboutSubject(guildId, subjectId);
    return { memories, attributes, journal };
  }

  /** Structured profile attributes for a subject — the provenance-backed facet set. */
  async attributesFor(guildId: string, subjectId: string): Promise<ProfileAttribute[]> {
    return listAttributes(this.sql, guildId, subjectId);
  }

  /** Batch attribute read keyed by subject — the reply path fetches facets
   * for every in-prompt person in one round trip. */
  async attributesForSubjects(guildId: string, subjectIds: string[], opts: { status?: AttributeStatus } = {}): Promise<Map<string, ProfileAttribute[]>> {
    return listAttributesForSubjects(this.sql, guildId, subjectIds, opts);
  }

  /** Guild-wide contested attributes — the admin triage surface. */
  async contestedAttributes(guildId: string, limit = 10): Promise<ProfileAttribute[]> {
    return listContestedAttributes(this.sql, guildId, limit);
  }

  // ── Personal Companions & Webhook Attribution (v21) ────────────────────────

  static companionSubjectId(companionId: number): string {
    return `companion:${companionId}`;
  }

  private rowToCompanion(r: {
    id: number | string; owner_user_id: string; name: string; avatar_url: string | null;
    voice_persona: string; core_traits: string[] | null; owner_dynamic: string;
    backstory: string; onboarding_state: string; onboarding_turns: number;
    kind?: string; adopted_from_listing_id?: number | string | null; listing_version?: number;
    persona_source?: string; import_meta?: Record<string, unknown> | null;
    created_at: Date | string; updated_at: Date | string;
  }): Companion {
    return {
      id: Number(r.id),
      ownerUserId: r.owner_user_id,
      name: r.name,
      avatarUrl: r.avatar_url,
      voicePersona: r.voice_persona,
      coreTraits: r.core_traits ?? [],
      ownerDynamic: r.owner_dynamic,
      backstory: r.backstory,
      onboardingState: (r.onboarding_state === "active" ? "active" : "onboarding") as OnboardingState,
      onboardingTurns: Number(r.onboarding_turns),
      kind: (r.kind === "adopted" ? "adopted" : "awakened"),
      adoptedFromListingId: r.adopted_from_listing_id != null ? Number(r.adopted_from_listing_id) : null,
      listingVersion: Number(r.listing_version ?? 0),
      personaSource: r.persona_source ?? "authored",
      importMeta: r.import_meta ?? null,
      createdAt: ts(r.created_at),
      updatedAt: ts(r.updated_at),
    };
  }

  /** The user's awakened companion by default — pass kind='adopted' only where
   *  the adopted roster is explicitly wanted (marketplace internals). */
  async getCompanionByOwner(ownerUserId: string, kind: "awakened" | "adopted" = "awakened"): Promise<Companion | null> {
    const rows = await this.sql<Array<any>>`
      SELECT * FROM companions WHERE owner_user_id = ${ownerUserId} AND kind = ${kind}
    `;
    return rows[0] ? this.rowToCompanion(rows[0]) : null;
  }

  async getCompanionById(id: number): Promise<Companion | null> {
    const rows = await this.sql<Array<any>>`
      SELECT * FROM companions WHERE id = ${id}
    `;
    return rows[0] ? this.rowToCompanion(rows[0]) : null;
  }

  /** Advance or create an onboarding companion draft for a user in 1:1 DMs.
   *  Once a companion is 'active', its persona is permanently locked — this
   *  method is a no-op and returns the locked companion. */
  async upsertCompanionOnboarding(
    ownerUserId: string,
    spec: Partial<CompanionSpec>,
    incrementTurn = true,
  ): Promise<Companion> {
    const existing = await this.getCompanionByOwner(ownerUserId);
    if (existing?.onboardingState === "active") return existing;
    const incTurn = incrementTurn ? 1 : 0;
    const rows = await this.sql<Array<any>>`
      INSERT INTO companions (owner_user_id, name, avatar_url, voice_persona, core_traits, owner_dynamic, backstory, onboarding_state, onboarding_turns, created_at, updated_at)
      VALUES (
        ${ownerUserId},
        ${spec.name?.trim() ?? ""},
        ${spec.avatarUrl ?? null},
        ${spec.voicePersona?.trim() ?? ""},
        ${spec.coreTraits ?? []},
        ${spec.ownerDynamic?.trim() ?? ""},
        ${spec.backstory?.trim() ?? ""},
        'onboarding',
        ${incTurn},
        NOW(), NOW()
      )
      ON CONFLICT (owner_user_id) WHERE kind = 'awakened' DO UPDATE SET
        name             = CASE WHEN ${spec.name?.trim() ?? ""} <> '' THEN ${spec.name?.trim() ?? ""} ELSE companions.name END,
        avatar_url       = COALESCE(${spec.avatarUrl ?? null}, companions.avatar_url),
        voice_persona    = CASE WHEN ${spec.voicePersona?.trim() ?? ""} <> '' THEN ${spec.voicePersona?.trim() ?? ""} ELSE companions.voice_persona END,
        core_traits      = CASE WHEN cardinality(${spec.coreTraits ?? []}::text[]) > 0 THEN ${spec.coreTraits ?? []} ELSE companions.core_traits END,
        owner_dynamic    = CASE WHEN ${spec.ownerDynamic?.trim() ?? ""} <> '' THEN ${spec.ownerDynamic?.trim() ?? ""} ELSE companions.owner_dynamic END,
        backstory        = CASE WHEN ${spec.backstory?.trim() ?? ""} <> '' THEN ${spec.backstory?.trim() ?? ""} ELSE companions.backstory END,
        onboarding_turns = companions.onboarding_turns + ${incTurn},
        updated_at       = NOW()
      WHERE companions.onboarding_state <> 'active'
      RETURNING *
    `;
    return rows[0] ? this.rowToCompanion(rows[0]) : (await this.getCompanionByOwner(ownerUserId))!;
  }

  /** Graduate a user's companion from onboarding to active, seed the DM scope's
   * consented member rows (owner + companion:<id>), and record the initial
   * owner ↔ companion relationship edges.
   * Each account gets ONE permanent companion — if the user's companion is
   * already 'active', it is permanently locked and returned unchanged. */
  async activateCompanion(
    ownerUserId: string,
    ownerDisplayName: string,
    spec: CompanionSpec,
  ): Promise<Companion> {
    const existing = await this.getCompanionByOwner(ownerUserId);
    if (existing?.onboardingState === "active") return existing;
    const dmScope = `dm:${ownerUserId}`;
    await this.ensureSettings(dmScope);
    const rows = await this.sql<Array<any>>`
      INSERT INTO companions (owner_user_id, name, avatar_url, voice_persona, core_traits, owner_dynamic, backstory, onboarding_state, onboarding_turns, created_at, updated_at)
      VALUES (
        ${ownerUserId},
        ${spec.name.trim() || "Companion"},
        ${spec.avatarUrl ?? null},
        ${spec.voicePersona.trim()},
        ${spec.coreTraits},
        ${spec.ownerDynamic.trim()},
        ${spec.backstory.trim()},
        'active',
        1,
        NOW(), NOW()
      )
      ON CONFLICT (owner_user_id) WHERE kind = 'awakened' DO UPDATE SET
        name             = CASE WHEN ${spec.name.trim()} <> '' THEN ${spec.name.trim()} ELSE companions.name END,
        avatar_url       = COALESCE(${spec.avatarUrl ?? null}, companions.avatar_url),
        voice_persona    = CASE WHEN ${spec.voicePersona.trim()} <> '' THEN ${spec.voicePersona.trim()} ELSE companions.voice_persona END,
        core_traits      = CASE WHEN cardinality(${spec.coreTraits}::text[]) > 0 THEN ${spec.coreTraits} ELSE companions.core_traits END,
        owner_dynamic    = CASE WHEN ${spec.ownerDynamic.trim()} <> '' THEN ${spec.ownerDynamic.trim()} ELSE companions.owner_dynamic END,
        backstory        = CASE WHEN ${spec.backstory.trim()} <> '' THEN ${spec.backstory.trim()} ELSE companions.backstory END,
        onboarding_state = 'active',
        updated_at       = NOW()
      WHERE companions.onboarding_state <> 'active'
      RETURNING *
    `;
    const companion = rows[0] ? this.rowToCompanion(rows[0]) : (await this.getCompanionByOwner(ownerUserId))!;
    const compSubj = MemoryStore.companionSubjectId(companion.id);
    const now = new Date();
    await this.upsertMember(dmScope, ownerUserId, ownerDisplayName, now, false);
    await this.setMemberOptIn(dmScope, ownerUserId, true);
    await this.upsertMember(dmScope, compSubj, companion.name, now, false);
    await this.setMemberOptIn(dmScope, compSubj, true);

    if (companion.ownerDynamic) {
      await this.sql`
        INSERT INTO relationship_observations (guild_id, subject_id, other_id, message_id, author_id, nature, valence, reason, verdict, source)
        VALUES
          (${dmScope}, ${ownerUserId}, ${compSubj}, ${`onboard:${companion.id}`}, ${ownerUserId}, ${companion.ownerDynamic}, 0.8, 'Established during companion awakening', 'literal', 'message'),
          (${dmScope}, ${compSubj}, ${ownerUserId}, ${`onboard:${companion.id}`}, ${compSubj}, ${companion.ownerDynamic}, 0.8, 'Established during companion awakening', 'literal', 'message')
        ON CONFLICT (subject_id, other_id, message_id) DO NOTHING
      `;
      await this.recomputeEdges(dmScope);
    }
    return companion;
  }

  async updateCompanionAvatar(ownerUserId: string, avatarUrl: string | null): Promise<Companion | null> {
    const rows = await this.sql<Array<any>>`
      UPDATE companions SET avatar_url = ${avatarUrl}, updated_at = NOW()
      WHERE owner_user_id = ${ownerUserId} AND kind = 'awakened'
      RETURNING *
    `;
    return rows[0] ? this.rowToCompanion(rows[0]) : null;
  }

  /** Summon a companion into a guild: links guild_companions, registers
   * companion:<id> as a consented guild member so entity resolution & edges
   * work immediately, and opts in the owner in that guild. */
  async summonCompanion(
    guildId: string,
    companionId: number,
    ownerUserId: string,
    ownerDisplayName?: string,
  ): Promise<void> {
    const companion = await this.getCompanionById(companionId);
    if (!companion || companion.onboardingState !== "active") return;
    await this.sql`
      INSERT INTO guild_companions (guild_id, companion_id, summoned_by, active, summoned_at)
      VALUES (${guildId}, ${companionId}, ${ownerUserId}, 1, NOW())
      ON CONFLICT (guild_id, companion_id) DO UPDATE SET active = 1, summoned_at = NOW()
    `;
    const now = new Date();
    const compSubj = MemoryStore.companionSubjectId(companionId);
    await this.upsertMember(guildId, compSubj, companion.name, now, false);
    await this.setMemberOptIn(guildId, compSubj, true);
    if (ownerDisplayName) {
      await this.upsertMember(guildId, ownerUserId, ownerDisplayName, now, false);
    }
    const ownerMember = await this.getMember(guildId, ownerUserId);
    if (!ownerMember?.optedOut) {
      await this.setMemberOptIn(guildId, ownerUserId, true);
    }
    if (companion.ownerDynamic) {
      await this.sql`
        INSERT INTO relationship_observations (guild_id, subject_id, other_id, message_id, author_id, nature, valence, reason, verdict, source)
        VALUES
          (${guildId}, ${ownerUserId}, ${compSubj}, ${`summon:${guildId}:${companionId}`}, ${ownerUserId}, ${companion.ownerDynamic}, 0.8, ${`${companion.name} is ${ownerDisplayName ?? "their owner"}'s companion (${companion.ownerDynamic})`}, 'literal', 'message'),
          (${guildId}, ${compSubj}, ${ownerUserId}, ${`summon:${guildId}:${companionId}`}, ${compSubj}, ${companion.ownerDynamic}, 0.8, ${`${companion.name} is ${ownerDisplayName ?? "their owner"}'s companion (${companion.ownerDynamic})`}, 'literal', 'message')
        ON CONFLICT (subject_id, other_id, message_id) DO NOTHING
      `;
    }
  }

  async dismissCompanion(guildId: string, companionId: number): Promise<boolean> {
    const result = await this.sql`
      UPDATE guild_companions SET active = 0
      WHERE guild_id = ${guildId} AND companion_id = ${companionId} AND active = 1
    `;
    return result.count > 0;
  }

  async listGuildCompanions(guildId: string): Promise<GuildCompanion[]> {
    const rows = await this.sql<Array<any>>`
      SELECT c.*, gc.guild_id, gc.summoned_by, gc.active, gc.summoned_at
      FROM guild_companions gc
      JOIN companions c ON c.id = gc.companion_id
      WHERE gc.guild_id = ${guildId} AND gc.active = 1 AND c.onboarding_state = 'active'
        -- Clones of banned listings freeze everywhere — guilds included.
        AND (c.adopted_from_listing_id IS NULL OR EXISTS (
          SELECT 1 FROM companion_listings l
          WHERE l.id = c.adopted_from_listing_id AND l.status <> 'banned'
        ))
      ORDER BY gc.summoned_at ASC
    `;
    return rows.map(r => ({
      ...this.rowToCompanion(r),
      guildId: r.guild_id,
      summonedBy: r.summoned_by,
      active: Number(r.active) === 1,
      summonedAt: ts(r.summoned_at),
    }));
  }

  async listCompanionGuilds(companionId: number): Promise<string[]> {
    const rows = await this.sql<Array<{ guild_id: string }>>`
      SELECT guild_id FROM guild_companions WHERE companion_id = ${companionId} AND active = 1 ORDER BY summoned_at DESC
    `;
    return rows.map(r => r.guild_id);
  }

  async listActiveDmScopes(): Promise<string[]> {
    const rows = await this.sql<Array<{ owner_user_id: string }>>`
      SELECT DISTINCT owner_user_id FROM companions WHERE onboarding_state = 'active'
    `;
    return rows.map(r => `dm:${r.owner_user_id}`);
  }

  // ── Companion marketplace (v34) ────────────────────────────────────────────
  // Listings project a creator's awakened companion into the hub forum; each
  // adoption clones the listing into a companions row owned by the adopter
  // (kind='adopted'), so keys/tokens, memories, and journals all resolve
  // against the adopter exactly like an awakened companion.

  private rowToListing(r: any): CompanionListing {
    return {
      id: Number(r.id),
      creatorUserId: r.creator_user_id,
      sourceCompanionId: r.source_companion_id != null ? Number(r.source_companion_id) : null,
      name: r.name,
      tagline: r.tagline,
      voicePersona: r.voice_persona,
      coreTraits: r.core_traits ?? [],
      ownerDynamic: r.owner_dynamic,
      backstory: r.backstory,
      greeting: r.greeting,
      avatarUrl: r.avatar_url,
      forumThreadId: r.forum_thread_id,
      version: Number(r.version),
      status: r.status,
      personaSource: r.persona_source ?? "authored",
      importMeta: r.import_meta ?? null,
      reportCount: Number(r.report_count),
      addCount: Number(r.add_count),
      createdAt: ts(r.created_at),
      updatedAt: ts(r.updated_at),
    };
  }

  private rowToAdoption(r: any): CompanionAdoption {
    return {
      id: Number(r.id),
      userId: r.user_id,
      listingId: Number(r.listing_id),
      companionId: Number(r.companion_id),
      adoptedAt: ts(r.adopted_at),
      droppedAt: r.dropped_at ? ts(r.dropped_at) : null,
      cooldownUntil: r.cooldown_until ? ts(r.cooldown_until) : null,
      dmIntroducedAt: r.dm_introduced_at ? ts(r.dm_introduced_at) : null,
    };
  }

  async listingById(listingId: number): Promise<CompanionListing | null> {
    const rows = await this.sql<Array<any>>`SELECT * FROM companion_listings WHERE id = ${listingId}`;
    return rows[0] ? this.rowToListing(rows[0]) : null;
  }

  async listingForCompanion(sourceCompanionId: number): Promise<CompanionListing | null> {
    const rows = await this.sql<Array<any>>`SELECT * FROM companion_listings WHERE source_companion_id = ${sourceCompanionId}`;
    return rows[0] ? this.rowToListing(rows[0]) : null;
  }

  /** Create or version-bump a listing. Every write records a persona version
   *  and (on update) syncs the persona into every adopted clone — live
   *  reference for adopters, audit trail for us. When `maxListings` is given,
   *  adding a LIVE listing (new row or delisted→active revive) is checked
   *  atomically against it — republishing an already-live listing is free. */
  async upsertListing(
    creatorUserId: string,
    sourceCompanionId: number,
    spec: { name: string; tagline: string; voicePersona: string; coreTraits: string[]; ownerDynamic: string; backstory: string; greeting: string; avatarUrl: string | null },
    opts: { forumThreadId?: string | null; maxListings?: number; maxDailyPublish?: number } = {},
  ): Promise<{ ok: true; listing: CompanionListing } | { ok: false; reason: "cap" | "daily_cap" }> {
    const persona = {
      name: spec.name, tagline: spec.tagline, voicePersona: spec.voicePersona,
      coreTraits: spec.coreTraits, ownerDynamic: spec.ownerDynamic,
      backstory: spec.backstory, greeting: spec.greeting, avatarUrl: spec.avatarUrl,
    };
    const res = await this.sql.begin(async sql => {
      // Serialize per-creator listing writes — the cap count and the insert
      // must be atomic across parallel publishes/creates/relists.
      if (opts.maxListings != null || opts.maxDailyPublish != null) {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`listing:${creatorUserId}`}))`;
        const existingRows = await sql<Array<{ status: string }>>`
          SELECT status FROM companion_listings WHERE source_companion_id = ${sourceCompanionId}
        `;
        const existing = existingRows[0];
        // The upsert adds a live listing only when there's no row yet or the
        // row revives from 'delisted'; editing an active/flagged listing
        // changes nothing the cap counts.
        if (opts.maxListings != null && (!existing || existing.status === "delisted")) {
          const countRows = await sql<[{ n: number | string }]>`
            SELECT COUNT(*) AS n FROM companion_listings
            WHERE creator_user_id = ${creatorUserId} AND status <> 'delisted' AND status <> 'unlisted'
          `;
          if (Number(countRows[0].n) >= opts.maxListings) return { ok: false as const, reason: "cap" as const };
        }
        // The daily publish cap counts listings that went LIVE today — a
        // revive or a republish isn't a new listing, and private unlisted
        // imports (published_at NULL) never count. Under the same lock so
        // parallel publishes can't both slide under it.
        if (!existing && opts.maxDailyPublish != null) {
          const dailyRows = await sql<[{ n: number | string }]>`
            SELECT COUNT(*) AS n FROM companion_listings
            WHERE creator_user_id = ${creatorUserId} AND published_at > NOW() - INTERVAL '1 day'
          `;
          if (Number(dailyRows[0].n) >= opts.maxDailyPublish) return { ok: false as const, reason: "daily_cap" as const };
        }
      }
      const rows = await sql<Array<any>>`
        INSERT INTO companion_listings (creator_user_id, source_companion_id, name, tagline, voice_persona, core_traits, owner_dynamic, backstory, greeting, avatar_url, forum_thread_id, version, status, published_at, created_at, updated_at)
        VALUES (
          ${creatorUserId}, ${sourceCompanionId},
          ${spec.name}, ${spec.tagline}, ${spec.voicePersona}, ${spec.coreTraits},
          ${spec.ownerDynamic}, ${spec.backstory}, ${spec.greeting}, ${spec.avatarUrl},
          ${opts.forumThreadId ?? null}, 1, 'active', NOW(), NOW(), NOW()
        )
        ON CONFLICT (source_companion_id) DO UPDATE SET
          name           = EXCLUDED.name,
          tagline        = EXCLUDED.tagline,
          voice_persona  = EXCLUDED.voice_persona,
          core_traits    = EXCLUDED.core_traits,
          owner_dynamic  = EXCLUDED.owner_dynamic,
          backstory      = EXCLUDED.backstory,
          greeting       = EXCLUDED.greeting,
          avatar_url     = EXCLUDED.avatar_url,
          forum_thread_id = COALESCE(EXCLUDED.forum_thread_id, companion_listings.forum_thread_id),
          version        = companion_listings.version + 1,
          -- Republishing revives a creator-delisted listing but must NOT clear
          -- a moderation flag, and must NOT undo a mod takedown — a delisted
          -- row with an outstanding takedown event (one newer than the latest
          -- unflag) stays down until a mod clears it.
          status         = CASE
            WHEN companion_listings.status = 'delisted'
             AND NOT EXISTS (
               SELECT 1 FROM moderation_events me
               WHERE me.listing_id = companion_listings.id
                 AND me.action IN ('delist', 'ban', 'ban_creator')
                 AND me.created_at > COALESCE(
                   (SELECT MAX(me2.created_at) FROM moderation_events me2
                    WHERE me2.listing_id = companion_listings.id AND me2.action = 'unflag'),
                   '-infinity'::timestamptz)
             )
            THEN 'active'
            ELSE companion_listings.status
          END,
          updated_at     = NOW()
        RETURNING *
      `;
      const listing = this.rowToListing(rows[0]);
      await sql`
        INSERT INTO companion_persona_versions (listing_id, version, persona_json)
        VALUES (${listing.id}, ${listing.version}, ${JSON.stringify(persona)})
        ON CONFLICT (listing_id, version) DO NOTHING
      `;
      return { ok: true as const, listing };
    });
    if (res.ok && res.listing.version > 1) await this.propagateListingVersion(res.listing.id);
    return res;
  }

  /** A freehand listing (v35): the persona lives entirely on the listing —
   *  no awakened companion backs it. source_companion_id stays NULL. When
   *  `maxListings` is given the cap check runs atomically in the same tx. */
  async createListing(
    creatorUserId: string,
    spec: { name: string; tagline: string; voicePersona: string; coreTraits: string[]; ownerDynamic: string; backstory: string; greeting: string; avatarUrl: string | null },
    opts: { maxListings?: number; maxDailyPublish?: number; status?: "active" | "unlisted"; personaSource?: string; importMeta?: Record<string, unknown> | null } = {},
  ): Promise<{ ok: true; listing: CompanionListing } | { ok: false; reason: "cap" | "daily_cap" }> {
    const status = opts.status ?? "active";
    return this.sql.begin(async sql => {
      if (opts.maxListings != null || opts.maxDailyPublish != null) {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`listing:${creatorUserId}`}))`;
        if (opts.maxListings != null) {
          const countRows = await sql<[{ n: number | string }]>`
            SELECT COUNT(*) AS n FROM companion_listings
            WHERE creator_user_id = ${creatorUserId} AND status <> 'delisted' AND status <> 'unlisted'
          `;
          if (Number(countRows[0].n) >= opts.maxListings) return { ok: false as const, reason: "cap" as const };
        }
        if (opts.maxDailyPublish != null) {
          const dailyRows = await sql<[{ n: number | string }]>`
            SELECT COUNT(*) AS n FROM companion_listings
            WHERE creator_user_id = ${creatorUserId} AND published_at > NOW() - INTERVAL '1 day'
          `;
          if (Number(dailyRows[0].n) >= opts.maxDailyPublish) return { ok: false as const, reason: "daily_cap" as const };
        }
      }
      const rows = await sql<Array<any>>`
        INSERT INTO companion_listings (creator_user_id, source_companion_id, name, tagline, voice_persona, core_traits, owner_dynamic, backstory, greeting, avatar_url, version, status, persona_source, import_meta, published_at, created_at, updated_at)
        VALUES (
          ${creatorUserId}, NULL,
          ${spec.name}, ${spec.tagline}, ${spec.voicePersona}, ${spec.coreTraits},
          ${spec.ownerDynamic}, ${spec.backstory}, ${spec.greeting}, ${spec.avatarUrl},
          1, ${status}, ${opts.personaSource ?? "authored"}, ${opts.importMeta ? sql.json(opts.importMeta as never) : null},
          CASE WHEN ${status} = 'active' THEN NOW() ELSE NULL END, NOW(), NOW()
        )
        RETURNING *
      `;
      const listing = this.rowToListing(rows[0]);
      await sql`
        INSERT INTO companion_persona_versions (listing_id, version, persona_json)
        VALUES (${listing.id}, 1, ${JSON.stringify({
          name: spec.name, tagline: spec.tagline, voicePersona: spec.voicePersona,
          coreTraits: spec.coreTraits, ownerDynamic: spec.ownerDynamic,
          backstory: spec.backstory, greeting: spec.greeting, avatarUrl: spec.avatarUrl,
        })})
        ON CONFLICT (listing_id, version) DO NOTHING
      `;
      return { ok: true as const, listing };
    }) as Promise<any>;
  }

  /** Revive a delisted listing (creator-owned only). Refuses anything that
   *  isn't 'delisted' — flagged rows can't reach this path because delist
   *  holds them, so a relist can never launder a moderation flag. A delist
   *  caused by a *mod* action also refuses ('moderated') — creator relist
   *  can't undo a takedown; only a mod unflag can. "Mod-caused" means a
   *  takedown event newer than the latest unflag — a resolved takedown or a
   *  plain creator unpublish stays relistable. The live-listing cap is
   *  enforced atomically: a revive adds a live listing back. */
  async relistListing(
    listingId: number,
    creatorUserId: string,
    maxListings: number,
  ): Promise<
    | { ok: true; listing: CompanionListing }
    | { ok: false; reason: "not_found" | "not_delisted" | "cap" | "moderated" }
  > {
    return this.sql.begin(async sql => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`listing:${creatorUserId}`}))`;
      const rows = await sql<Array<any>>`
        SELECT * FROM companion_listings WHERE id = ${listingId} AND creator_user_id = ${creatorUserId}
        FOR UPDATE
      `;
      if (!rows[0]) return { ok: false as const, reason: "not_found" as const };
      if (rows[0].status !== "delisted") return { ok: false as const, reason: "not_delisted" as const };
      const modRows = await sql<Array<{ x: number }>>`
        SELECT 1 AS x FROM moderation_events me
        WHERE me.listing_id = ${listingId}
          AND me.action IN ('delist', 'ban', 'ban_creator')
          AND me.created_at > COALESCE(
            (SELECT MAX(me2.created_at) FROM moderation_events me2
             WHERE me2.listing_id = ${listingId} AND me2.action = 'unflag'),
            '-infinity'::timestamptz)
        LIMIT 1
      `;
      if (modRows.length) return { ok: false as const, reason: "moderated" as const };
      const countRows = await sql<[{ n: number | string }]>`
        SELECT COUNT(*) AS n FROM companion_listings
        WHERE creator_user_id = ${creatorUserId} AND status <> 'delisted' AND status <> 'unlisted'
      `;
      if (Number(countRows[0].n) >= maxListings) return { ok: false as const, reason: "cap" as const };
      const updated = await sql<Array<any>>`
        UPDATE companion_listings SET status = 'active', updated_at = NOW()
        WHERE id = ${listingId} RETURNING *
      `;
      return { ok: true as const, listing: this.rowToListing(updated[0]) };
    }) as Promise<any>;
  }

  /** A creator's unpublished listings — the relist pool. Mod-takedowns are
   *  excluded: the creator can't bring them back, so they don't belong in
   *  the picker. */
  async listDelistedListings(creatorUserId: string): Promise<CompanionListing[]> {
    const rows = await this.sql<Array<any>>`
      SELECT * FROM companion_listings
      WHERE creator_user_id = ${creatorUserId} AND status = 'delisted'
        AND NOT EXISTS (
          SELECT 1 FROM moderation_events me
          WHERE me.listing_id = companion_listings.id
            AND me.action IN ('delist', 'ban', 'ban_creator')
            AND me.created_at > COALESCE(
              (SELECT MAX(me2.created_at) FROM moderation_events me2
               WHERE me2.listing_id = companion_listings.id AND me2.action = 'unflag'),
              '-infinity'::timestamptz)
        )
      ORDER BY updated_at DESC
    `;
    return rows.map(r => this.rowToListing(r));
  }

  /** Update any listing (awakened-backed or freehand) by id: bumps the
   *  version, snapshots the persona, and propagates to adopted clones. */
  async updateListing(
    listingId: number,
    creatorUserId: string,
    spec: { name: string; tagline: string; voicePersona: string; coreTraits: string[]; ownerDynamic: string; backstory: string; greeting: string; avatarUrl: string | null },
  ): Promise<CompanionListing | null> {
    const rows = await this.sql<Array<any>>`
      UPDATE companion_listings SET
        name = ${spec.name}, tagline = ${spec.tagline}, voice_persona = ${spec.voicePersona},
        core_traits = ${spec.coreTraits}, owner_dynamic = ${spec.ownerDynamic},
        backstory = ${spec.backstory}, greeting = ${spec.greeting}, avatar_url = ${spec.avatarUrl},
        version = version + 1, updated_at = NOW()
      WHERE id = ${listingId} AND creator_user_id = ${creatorUserId}
      RETURNING *
    `;
    if (!rows[0]) return null;
    const listing = this.rowToListing(rows[0]);
    await this.sql`
      INSERT INTO companion_persona_versions (listing_id, version, persona_json)
      VALUES (${listing.id}, ${listing.version}, ${JSON.stringify({
        name: spec.name, tagline: spec.tagline, voicePersona: spec.voicePersona,
        coreTraits: spec.coreTraits, ownerDynamic: spec.ownerDynamic,
        backstory: spec.backstory, greeting: spec.greeting, avatarUrl: spec.avatarUrl,
      })})
      ON CONFLICT (listing_id, version) DO NOTHING
    `;
    await this.propagateListingVersion(listing.id);
    return listing;
  }

  /** Live listings a creator is holding — counts toward the plan's
   *  publish cap. Delisted rows free the slot. */
  async activeListingCount(creatorUserId: string): Promise<number> {
    const rows = await this.sql<[{ n: number | string }]>`
      SELECT COUNT(*) AS n FROM companion_listings
      WHERE creator_user_id = ${creatorUserId} AND status <> 'delisted' AND status <> 'unlisted'
    `;
    return Number(rows[0].n);
  }

  async listMyListings(creatorUserId: string): Promise<CompanionListing[]> {
    const rows = await this.sql<Array<any>>`
      SELECT * FROM companion_listings
      WHERE creator_user_id = ${creatorUserId} AND status <> 'delisted' AND status <> 'banned'
      ORDER BY created_at ASC
    `;
    return rows.map(r => this.rowToListing(r));
  }

  /** Push a listing's current persona into every adopted clone. Only persona
   *  fields move — adopter-owned state (memories, journal, guilds) is theirs. */
  async propagateListingVersion(listingId: number): Promise<number> {
    const listing = await this.listingById(listingId);
    if (!listing) return 0;
    const result = await this.sql`
      UPDATE companions SET
        name             = ${listing.name},
        voice_persona    = ${listing.voicePersona},
        core_traits      = ${listing.coreTraits},
        owner_dynamic    = ${listing.ownerDynamic},
        backstory        = ${listing.backstory},
        avatar_url       = ${listing.avatarUrl},
        listing_version  = ${listing.version},
        updated_at       = NOW()
      WHERE adopted_from_listing_id = ${listingId} AND kind = 'adopted'
    `;
    return result.count;
  }

  async setListingThread(listingId: number, threadId: string): Promise<void> {
    await this.sql`
      UPDATE companion_listings SET forum_thread_id = ${threadId}, updated_at = NOW()
      WHERE id = ${listingId}
    `;
  }

  /** active → delisted only. Flagged rows are a moderation hold: letting a
   *  creator delist them would launder the flag, since republish/relist
   *  revive 'delisted' → 'active'. A flag clears only on human review. */
  async delistListing(listingId: number): Promise<boolean> {
    const result = await this.sql`
      UPDATE companion_listings SET status = 'delisted', updated_at = NOW()
      WHERE id = ${listingId} AND status = 'active'
    `;
    return result.count > 0;
  }

  /** The creator's private imports — unlisted rows only ever become public
   *  through publishListing. */
  async listUnlistedListings(creatorUserId: string): Promise<CompanionListing[]> {
    const rows = await this.sql<Array<any>>`
      SELECT * FROM companion_listings
      WHERE creator_user_id = ${creatorUserId} AND status = 'unlisted'
      ORDER BY created_at ASC
    `;
    return rows.map(r => this.rowToListing(r));
  }

  /** Same source file → same row. Idempotent import retries and dedupe. */
  async findUnlistedByHash(creatorUserId: string, sha256: string): Promise<CompanionListing | null> {
    const rows = await this.sql<Array<any>>`
      SELECT * FROM companion_listings
      WHERE creator_user_id = ${creatorUserId} AND status = 'unlisted'
        AND import_meta->>'sha256' = ${sha256}
      LIMIT 1
    `;
    return rows[0] ? this.rowToListing(rows[0]) : null;
  }

  /** Remove a private import row that never adopted (failed/cancelled
   *  import cleanup). Refuses anything that isn't still unlisted — a
   *  published row can never reach this path. Persona versions cascade. */
  async deleteUnlistedListing(listingId: number, creatorUserId: string): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM companion_listings
      WHERE id = ${listingId} AND creator_user_id = ${creatorUserId} AND status = 'unlisted'
        AND NOT EXISTS (
          SELECT 1 FROM companion_adoptions a
          WHERE a.listing_id = ${listingId} AND a.dropped_at IS NULL
        )
    `;
    return result.count > 0;
  }

  /** Publish a private import: unlisted → active, persona fields updated to
   *  the (possibly edited) spec, version bump, persona_version row, clone
   *  propagation — everything a normal listing write does, plus the
   *  live-listing cap since the row becomes public. Provenance columns are
   *  immutable — they ride into the marketplace unchanged. */
  async publishListing(
    listingId: number,
    creatorUserId: string,
    spec: { name: string; tagline: string; voicePersona: string; coreTraits: string[]; ownerDynamic: string; backstory: string; greeting: string; avatarUrl: string | null },
    maxListings: number,
    maxDailyPublish?: number,
  ): Promise<{ ok: true; listing: CompanionListing } | { ok: false; reason: "not_found" | "not_unlisted" | "cap" | "moderated" | "daily_cap" }> {
    const res = (await this.sql.begin(async sql => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`listing:${creatorUserId}`}))`;
      const rows = await sql<Array<any>>`
        SELECT * FROM companion_listings WHERE id = ${listingId} AND creator_user_id = ${creatorUserId}
        FOR UPDATE
      `;
      const listing = rows[0];
      if (!listing) return { ok: false as const, reason: "not_found" as const };
      if (listing.status !== "unlisted") return { ok: false as const, reason: "not_unlisted" as const };
      // Same guard as relist: a mod-caused takedown isn't reversible by the
      // creator — though 'unlisted' rows shouldn't be reachable by mods, the
      // check is cheap insurance against status bugs.
      const modRows = await sql<Array<{ x: number }>>`
        SELECT 1 AS x FROM moderation_events me
        WHERE me.listing_id = ${listingId}
          AND me.action IN ('delist', 'ban', 'ban_creator')
          AND me.created_at > COALESCE(
            (SELECT MAX(me2.created_at) FROM moderation_events me2
             WHERE me2.listing_id = ${listingId} AND me2.action = 'unflag'),
            '-infinity'::timestamptz)
        LIMIT 1
      `;
      if (modRows.length) return { ok: false as const, reason: "moderated" as const };
      const countRows = await sql<[{ n: number | string }]>`
        SELECT COUNT(*) AS n FROM companion_listings
        WHERE creator_user_id = ${creatorUserId} AND status <> 'delisted' AND status <> 'unlisted'
      `;
      if (Number(countRows[0].n) >= maxListings) return { ok: false as const, reason: "cap" as const };
      // Going public counts against the daily publish budget — unlisted
      // rows have published_at NULL, so this counts only today's flips.
      if (maxDailyPublish != null) {
        const dailyRows = await sql<[{ n: number | string }]>`
          SELECT COUNT(*) AS n FROM companion_listings
          WHERE creator_user_id = ${creatorUserId} AND published_at > NOW() - INTERVAL '1 day'
        `;
        if (Number(dailyRows[0].n) >= maxDailyPublish) return { ok: false as const, reason: "daily_cap" as const };
      }
      const newVersion = Number(listing.version) + 1;
      const updated = await sql<Array<any>>`
        UPDATE companion_listings SET
          name = ${spec.name}, tagline = ${spec.tagline},
          voice_persona = ${spec.voicePersona}, core_traits = ${spec.coreTraits},
          owner_dynamic = ${spec.ownerDynamic}, backstory = ${spec.backstory},
          greeting = ${spec.greeting}, avatar_url = ${spec.avatarUrl},
          version = ${newVersion}, status = 'active', published_at = NOW(), updated_at = NOW()
        WHERE id = ${listingId}
        RETURNING *
      `;
      await sql`
        INSERT INTO companion_persona_versions (listing_id, version, persona_json)
        VALUES (${listingId}, ${newVersion}, ${JSON.stringify({
          name: spec.name, tagline: spec.tagline, voicePersona: spec.voicePersona,
          coreTraits: spec.coreTraits, ownerDynamic: spec.ownerDynamic,
          backstory: spec.backstory, greeting: spec.greeting, avatarUrl: spec.avatarUrl,
        })})
        ON CONFLICT (listing_id, version) DO NOTHING
      `;
      return { ok: true as const, listing: this.rowToListing(updated[0]) };
    })) as { ok: true; listing: CompanionListing } | { ok: false; reason: "not_found" | "not_unlisted" | "cap" | "moderated" | "daily_cap" };
    if (res.ok) await this.propagateListingVersion(res.listing.id);
    return res;
  }

  /** File a categorized report. The anti-bombing daily cap (`maxDaily`)
   *  is enforced inside the transaction under a per-reporter advisory lock —
   *  parallel report clicks can't both slide under the ceiling. */
  async reportListing(
    listingId: number,
    reporterUserId: string,
    category = "other",
    reason = "",
    maxDaily?: number,
  ): Promise<{ ok: true; count: number } | { ok: false; reason: "dup" | "daily_cap" }> {
    return this.sql.begin(async sql => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`report:${reporterUserId}`}))`;
      if (maxDaily != null) {
        const dailyRows = await sql<[{ n: number | string }]>`
          SELECT COUNT(*) AS n FROM listing_reports
          WHERE reporter_user_id = ${reporterUserId} AND created_at > NOW() - INTERVAL '1 day'
        `;
        if (Number(dailyRows[0].n) >= maxDaily) return { ok: false as const, reason: "daily_cap" as const };
      }
      const inserted = await sql`
        INSERT INTO listing_reports (listing_id, reporter_user_id, category, reason)
        VALUES (${listingId}, ${reporterUserId}, ${category}, ${reason})
        ON CONFLICT (listing_id, reporter_user_id) DO NOTHING
        RETURNING id
      `;
      if (!inserted.length) return { ok: false as const, reason: "dup" as const };
      const rows = await sql<Array<{ report_count: number }>>`
        UPDATE companion_listings SET report_count = report_count + 1, updated_at = NOW()
        WHERE id = ${listingId}
        RETURNING report_count
      `;
      return { ok: true as const, count: Number(rows[0]?.report_count ?? 0) };
    }) as Promise<any>;
  }

  // ── Ratings + comment reports (v37) ────────────────────────────────────────
  // Listing threads are the comment surface: ratings are one row per
  // (listing, rater) so a re-rate is an upsert; comment reports dedupe per
  // (message, reporter) and share the reporter's daily cap budget with
  // listing reports — one anti-bombing ceiling across both lanes.

  async rateListing(listingId: number, raterUserId: string, stars: number): Promise<void> {
    await this.sql`
      INSERT INTO listing_ratings (listing_id, rater_user_id, stars)
      VALUES (${listingId}, ${raterUserId}, ${stars})
      ON CONFLICT (listing_id, rater_user_id)
      DO UPDATE SET stars = EXCLUDED.stars, updated_at = NOW()
    `;
  }

  async listingRatingStats(listingId: number): Promise<{ avg: number; count: number }> {
    const rows = await this.sql<Array<{ avg: number | string | null; n: number | string }>>`
      SELECT AVG(stars) AS avg, COUNT(*) AS n FROM listing_ratings WHERE listing_id = ${listingId}
    `;
    return { avg: rows[0].avg == null ? 0 : Number(rows[0].avg), count: Number(rows[0].n) };
  }

  async listingByThreadId(threadId: string): Promise<CompanionListing | null> {
    const rows = await this.sql<Array<any>>`SELECT * FROM companion_listings WHERE forum_thread_id = ${threadId}`;
    return rows[0] ? this.rowToListing(rows[0]) : null;
  }

  /** File a report on a comment inside a listing thread. Shares the
   *  reporter's daily budget with listing reports — the cap exists to blunt
   *  report-bombing, and the lane doesn't matter for that. Dedupe is per
   *  (message, reporter): the same user can report different comments. */
  async reportComment(
    r: { listingId: number | null; threadId: string; messageId: string; authorUserId: string; reporterUserId: string; category?: string },
    maxDaily?: number,
  ): Promise<{ ok: true } | { ok: false; reason: "dup" | "daily_cap" }> {
    return this.sql.begin(async sql => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`report:${r.reporterUserId}`}))`;
      if (maxDaily != null) {
        const dailyRows = await sql<[{ n: number | string }]>`
          SELECT (SELECT COUNT(*) FROM listing_reports WHERE reporter_user_id = ${r.reporterUserId} AND created_at > NOW() - INTERVAL '1 day')
               + (SELECT COUNT(*) FROM comment_reports WHERE reporter_user_id = ${r.reporterUserId} AND created_at > NOW() - INTERVAL '1 day') AS n
        `;
        if (Number(dailyRows[0].n) >= maxDaily) return { ok: false as const, reason: "daily_cap" as const };
      }
      const inserted = await sql`
        INSERT INTO comment_reports (listing_id, thread_id, message_id, author_user_id, reporter_user_id, category)
        VALUES (${r.listingId}, ${r.threadId}, ${r.messageId}, ${r.authorUserId}, ${r.reporterUserId}, ${r.category ?? "other"})
        ON CONFLICT (message_id, reporter_user_id) DO NOTHING
        RETURNING id
      `;
      return inserted.length ? { ok: true as const } : { ok: false as const, reason: "dup" as const };
    }) as Promise<any>;
  }

  /** Lookup the stored report row for a message — the mod timeout action
   *  resolves the author id from here rather than trusting the button. */
  async commentReportFor(messageId: string): Promise<{ authorUserId: string } | null> {
    const rows = await this.sql<Array<{ author_user_id: string }>>`
      SELECT author_user_id FROM comment_reports WHERE message_id = ${messageId} LIMIT 1
    `;
    return rows[0] ? { authorUserId: rows[0].author_user_id } : null;
  }

  /** Active listings that have a live forum thread — the tag sweep's universe:
   *  badges only mean anything on threads that exist and aren't taken down. */
  async listActiveListingsWithThreads(): Promise<CompanionListing[]> {
    const rows = await this.sql<Array<any>>`
      SELECT * FROM companion_listings
      WHERE status = 'active' AND forum_thread_id IS NOT NULL
      ORDER BY id ASC
    `;
    return rows.map(r => this.rowToListing(r));
  }

  /** Bulk rating stats keyed by listing id — the tag sweep reads this once
   *  rather than one query per thread. */
  async ratingStatsByListing(): Promise<Map<number, { avg: number; count: number }>> {
    const rows = await this.sql<Array<{ listing_id: number; avg: number | string | null; n: number | string }>>`
      SELECT listing_id, AVG(stars) AS avg, COUNT(*) AS n
      FROM listing_ratings GROUP BY listing_id
    `;
    return new Map(rows.map(r => [Number(r.listing_id), { avg: r.avg == null ? 0 : Number(r.avg), count: Number(r.n) }]));
  }

  /** Adoptions per listing within the window — the "Trending" velocity feed.
   *  adopted_at is the timestamped column; drops/re-adopts don't inflate it
   *  (a re-adopt rewrites adopted_at, which is legitimately fresh activity). */
  async recentAdoptionCounts(windowMs: number): Promise<Map<number, number>> {
    const seconds = Math.max(1, Math.floor(windowMs / 1000));
    const rows = await this.sql<Array<{ listing_id: number; n: number | string }>>`
      SELECT listing_id, COUNT(*) AS n FROM companion_adoptions
      WHERE adopted_at > NOW() - make_interval(secs => ${seconds})
      GROUP BY listing_id
    `;
    return new Map(rows.map(r => [Number(r.listing_id), Number(r.n)]));
  }

  async flagListing(listingId: number): Promise<boolean> {
    const result = await this.sql`UPDATE companion_listings SET status = 'flagged', updated_at = NOW() WHERE id = ${listingId} AND status = 'active'`;
    return result.count > 0;
  }

  /** A human moderation action on a listing. 'delist' takes it down (keeps
   *  clones); 'ban' is the kill switch (freezes clones via the roster/DM/
   *  guild joins); 'unflag' is the restore path: flagged → active,
   *  mod-delisted → active (a delist the *creator* caused stays down — only
   *  mod takedowns are mod-reversible), banned → flagged (back into the
   *  review queue rather than straight back live). Bypasses the creator
   *  paths' status restrictions. Every call writes a moderation_events row. */
  async modAction(
    listingId: number,
    actorUserId: string,
    action: "unflag" | "delist" | "ban",
    note = "",
  ): Promise<CompanionListing | null> {
    return this.sql.begin(async sql => {
      const rows = action === "unflag"
        ? await sql<Array<any>>`
            UPDATE companion_listings SET
              status = CASE WHEN status = 'banned' THEN 'flagged' ELSE 'active' END,
              updated_at = NOW()
            WHERE id = ${listingId} AND (
              status IN ('flagged', 'banned')
              -- A delisted row only unflags when its takedown is outstanding —
              -- creator unpublishes aren't mod-restorable.
              OR (status = 'delisted' AND EXISTS (
                SELECT 1 FROM moderation_events me
                WHERE me.listing_id = companion_listings.id
                  AND me.action IN ('delist', 'ban', 'ban_creator')
                  AND me.created_at > COALESCE(
                    (SELECT MAX(me2.created_at) FROM moderation_events me2
                     WHERE me2.listing_id = companion_listings.id AND me2.action = 'unflag'),
                    '-infinity'::timestamptz)
              ))
            )
            RETURNING *
          `
        : await sql<Array<any>>`
            UPDATE companion_listings SET status = ${action === "delist" ? "delisted" : "banned"}, updated_at = NOW()
            WHERE id = ${listingId} AND status = ANY(${action === "delist" ? ["active", "flagged"] : ["active", "flagged", "delisted"]})
            RETURNING *
          `;
      if (!rows[0]) return null;
      await sql`
        INSERT INTO moderation_events (listing_id, actor_user_id, action, note)
        VALUES (${listingId}, ${actorUserId}, ${action}, ${note})
      `;
      return this.rowToListing(rows[0]);
    }) as Promise<CompanionListing | null>;
  }

  /** Publish-ban a creator: record the ban and ban every live listing they
   *  own (active + flagged — delisted is already down). Returns the affected
   *  listings so callers can archive their forum threads. */
  async banCreator(discordUserId: string, actorUserId: string, reason = ""): Promise<CompanionListing[]> {
    return this.sql.begin(async sql => {
      await sql`
        INSERT INTO marketplace_bans (discord_user_id, reason, banned_by)
        VALUES (${discordUserId}, ${reason}, ${actorUserId})
        ON CONFLICT (discord_user_id) DO UPDATE SET reason = EXCLUDED.reason, banned_by = EXCLUDED.banned_by
      `;
      const listings = await sql<Array<any>>`
        UPDATE companion_listings SET status = 'banned', updated_at = NOW()
        WHERE creator_user_id = ${discordUserId} AND status IN ('active', 'flagged')
        RETURNING *
      `;
      for (const l of listings) {
        await sql`
          INSERT INTO moderation_events (listing_id, actor_user_id, action, note)
          VALUES (${l.id}, ${actorUserId}, 'ban_creator', ${reason})
        `;
      }
      return listings.map(l => this.rowToListing(l));
    }) as Promise<CompanionListing[]>;
  }

  async creatorBan(discordUserId: string): Promise<{ reason: string; createdAt: Date } | null> {
    const rows = await this.sql<Array<{ reason: string; created_at: string }>>`
      SELECT reason, created_at FROM marketplace_bans WHERE discord_user_id = ${discordUserId}
    `;
    return rows[0] ? { reason: rows[0].reason, createdAt: new Date(rows[0].created_at) } : null;
  }

  // Per-UTC-day action counts — the marketplace rate limits derive from
  // existing rows rather than a dedicated rate table. Publish counts
  // published_at (first time live), not created_at — private unlisted
  // imports stay out of the publish quota until they're actually published.
  async dailyPublishCount(creatorUserId: string): Promise<number> {
    const rows = await this.sql<[{ n: number | string }]>`
      SELECT COUNT(*) AS n FROM companion_listings
      WHERE creator_user_id = ${creatorUserId} AND published_at > NOW() - INTERVAL '1 day'
    `;
    return Number(rows[0].n);
  }
  async dailyReportCount(reporterUserId: string): Promise<number> {
    const rows = await this.sql<[{ n: number | string }]>`
      SELECT COUNT(*) AS n FROM listing_reports
      WHERE reporter_user_id = ${reporterUserId} AND created_at > NOW() - INTERVAL '1 day'
    `;
    return Number(rows[0].n);
  }
  async dailyAdoptCount(userId: string): Promise<number> {
    const rows = await this.sql<[{ n: number | string }]>`
      SELECT COUNT(*) AS n FROM companion_adoptions
      WHERE user_id = ${userId} AND adopted_at > NOW() - INTERVAL '1 day'
    `;
    return Number(rows[0].n);
  }

  /** The user's full roster: awakened companion first, then active adoptions. */
  async listCompanionsForUser(userId: string): Promise<Companion[]> {
    const rows = await this.sql<Array<any>>`
      SELECT c.* FROM companions c
      WHERE c.owner_user_id = ${userId} AND c.onboarding_state = 'active'
        AND (c.kind = 'awakened' OR EXISTS (
          SELECT 1 FROM companion_adoptions a
          WHERE a.companion_id = c.id AND a.dropped_at IS NULL
        ))
        -- Clones of banned listings freeze everywhere — roster included.
        AND (c.adopted_from_listing_id IS NULL OR EXISTS (
          SELECT 1 FROM companion_listings l
          WHERE l.id = c.adopted_from_listing_id AND l.status <> 'banned'
        ))
      ORDER BY (c.kind = 'awakened') DESC, c.created_at ASC
    `;
    return rows.map(r => this.rowToCompanion(r));
  }

  /** Which companion answers in this user's DM: their explicit pick while it
   *  stays usable, otherwise the awakened companion. */
  async resolveDmCompanion(userId: string): Promise<Companion | null> {
    const picked = await this.sql<Array<any>>`
      SELECT c.* FROM user_bot_settings s
      JOIN companions c ON c.id = s.active_dm_companion_id
      WHERE s.discord_user_id = ${userId} AND c.owner_user_id = ${userId}
        AND c.onboarding_state = 'active'
        AND (c.kind = 'awakened' OR EXISTS (
          SELECT 1 FROM companion_adoptions a
          WHERE a.companion_id = c.id AND a.dropped_at IS NULL
        ))
        -- Clones of banned listings freeze everywhere — DM answers included.
        AND (c.adopted_from_listing_id IS NULL OR EXISTS (
          SELECT 1 FROM companion_listings l
          WHERE l.id = c.adopted_from_listing_id AND l.status <> 'banned'
        ))
    `;
    if (picked[0]) return this.rowToCompanion(picked[0]);
    return this.getCompanionByOwner(userId);
  }

  async setActiveDmCompanion(userId: string, companionId: number): Promise<void> {
    await this.sql`
      INSERT INTO user_bot_settings (discord_user_id, active_dm_companion_id, updated_at)
      VALUES (${userId}, ${companionId}, NOW())
      ON CONFLICT (discord_user_id) DO UPDATE SET active_dm_companion_id = ${companionId}, updated_at = NOW()
    `;
  }

  /** First import claims the DM slot; later imports leave the user's pick
   *  alone. Mirrors the WHERE clause in import_companion_card (v42). */
  async claimDmCompanionIfUnset(userId: string, companionId: number): Promise<void> {
    await this.sql`
      INSERT INTO user_bot_settings (discord_user_id, active_dm_companion_id, updated_at)
      VALUES (${userId}, ${companionId}, NOW())
      ON CONFLICT (discord_user_id) DO UPDATE
        SET active_dm_companion_id = EXCLUDED.active_dm_companion_id, updated_at = NOW()
        WHERE user_bot_settings.active_dm_companion_id IS NULL
    `;
  }

  /** Active adoptions that actually occupy a slot — clones of banned
   *  listings are frozen and hidden (the user can't drop what they can't
   *  see), so they don't consume the slot while the ban stands. */
  async activeAdoptionCount(userId: string): Promise<number> {
    const rows = await this.sql<[{ n: number | string }]>`
      SELECT COUNT(*) AS n FROM companion_adoptions a
      LEFT JOIN companion_listings l ON l.id = a.listing_id
      WHERE a.user_id = ${userId} AND a.dropped_at IS NULL
        AND (l.id IS NULL OR l.status <> 'banned')
    `;
    return Number(rows[0].n);
  }

  async adoptionFor(userId: string, listingId: number): Promise<CompanionAdoption | null> {
    const rows = await this.sql<Array<any>>`
      SELECT * FROM companion_adoptions WHERE user_id = ${userId} AND listing_id = ${listingId}
    `;
    return rows[0] ? this.rowToAdoption(rows[0]) : null;
  }

  async adoptionForCompanion(companionId: number): Promise<CompanionAdoption | null> {
    const rows = await this.sql<Array<any>>`
      SELECT * FROM companion_adoptions WHERE companion_id = ${companionId}
    `;
    return rows[0] ? this.rowToAdoption(rows[0]) : null;
  }

  /** Adopt a listing for a user inside one transaction. maxSlots applies to
   *  anything that leaves the user holding an active adoption — fresh adds
   *  and post-cooldown re-adoptions alike; only an already-active re-click
   *  is free. Returns a discriminated result so the caller can phrase the
   *  refusal. */
  async adoptListing(
    userId: string,
    listingId: number,
    opts: { maxSlots: number; maxDaily?: number },
  ): Promise<
    | { ok: true; companion: Companion; adoption: CompanionAdoption; reused: boolean; revived: boolean }
    | { ok: false; reason: "not_found" | "delisted" | "own_listing" | "cap" | "cooldown" | "daily_cap"; cooldownUntil?: string }
  > {
    return this.sql.begin(async sql => {
      // Serialize per-user adoption txs — without this, parallel Add clicks on
      // different listings both pass the slot count check under READ COMMITTED.
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`adopt:${userId}`}))`;
      const listings = await sql<Array<any>>`
        SELECT * FROM companion_listings WHERE id = ${listingId} FOR UPDATE
      `;
      const listing = listings[0];
      if (!listing) return { ok: false as const, reason: "not_found" as const };
      // Unlisted = a private import: adoptable only by its own creator — the
      // own_listing rule exists for public listings; importing your own card
      // is the entire point of that status.
      const selfImport = listing.status === "unlisted" && listing.creator_user_id === userId;
      if (listing.status !== "active" && !selfImport) return { ok: false as const, reason: "delisted" as const };
      if (listing.creator_user_id === userId && !selfImport) return { ok: false as const, reason: "own_listing" as const };

      const existingRows = await sql<Array<any>>`
        SELECT * FROM companion_adoptions WHERE user_id = ${userId} AND listing_id = ${listingId}
      `;
      const existing = existingRows[0];
      if (existing && !existing.dropped_at) {
        return {
          ok: true as const, reused: true, revived: false,
          companion: this.rowToCompanion((await sql<Array<any>>`SELECT * FROM companions WHERE id = ${existing.companion_id}`)[0]),
          adoption: this.rowToAdoption(existing),
        };
      }
      if (existing?.cooldown_until && new Date(existing.cooldown_until).getTime() > Date.now()) {
        return { ok: false as const, reason: "cooldown" as const, cooldownUntil: ts(existing.cooldown_until) };
      }

      // Both paths below end in an ACTIVE adoption — a re-adopt consumes a
      // slot exactly like a fresh one (the early return above already
      // filtered the free no-op click). Adoptions of banned listings are
      // frozen ghosts — they don't count (same exclusion as
      // activeAdoptionCount).
      if (!existing || existing.dropped_at) {
        const countRows = await sql<[{ n: number | string }]>`
          SELECT COUNT(*) AS n FROM companion_adoptions a
          LEFT JOIN companion_listings l ON l.id = a.listing_id
          WHERE a.user_id = ${userId} AND a.dropped_at IS NULL
            AND (l.id IS NULL OR l.status <> 'banned')
        `;
        if (Number(countRows[0].n) >= opts.maxSlots) return { ok: false as const, reason: "cap" as const };
        // Anti-farming daily cap — checked under the same advisory lock so
        // parallel Add clicks can't both squeeze under the ceiling.
        if (opts.maxDaily != null) {
          const dailyRows = await sql<[{ n: number | string }]>`
            SELECT COUNT(*) AS n FROM companion_adoptions
            WHERE user_id = ${userId} AND adopted_at > NOW() - INTERVAL '1 day'
          `;
          if (Number(dailyRows[0].n) >= opts.maxDaily) return { ok: false as const, reason: "daily_cap" as const };
        }
      }

      let companionId: number;
      if (existing) {
        companionId = Number(existing.companion_id);
        await sql`
          UPDATE companions SET
            name = ${listing.name}, voice_persona = ${listing.voice_persona},
            core_traits = ${listing.core_traits}, owner_dynamic = ${listing.owner_dynamic},
            backstory = ${listing.backstory}, avatar_url = ${listing.avatar_url},
            listing_version = ${listing.version}, updated_at = NOW()
          WHERE id = ${companionId}
        `;
        await sql`
          UPDATE companion_adoptions SET dropped_at = NULL, cooldown_until = NULL, adopted_at = NOW()
          WHERE id = ${existing.id}
        `;
      } else {
        const compRows = await sql<Array<any>>`
          INSERT INTO companions (owner_user_id, name, avatar_url, voice_persona, core_traits, owner_dynamic, backstory, onboarding_state, onboarding_turns, kind, adopted_from_listing_id, listing_version, persona_source, import_meta, created_at, updated_at)
          VALUES (
            ${userId}, ${listing.name}, ${listing.avatar_url}, ${listing.voice_persona},
            ${listing.core_traits}, ${listing.owner_dynamic}, ${listing.backstory},
            'active', 0, 'adopted', ${listingId}, ${listing.version},
            ${listing.persona_source ?? "authored"}, ${listing.import_meta ?? null}, NOW(), NOW()
          )
          RETURNING *
        `;
        companionId = Number(compRows[0].id);
        await sql`
          INSERT INTO companion_adoptions (user_id, listing_id, companion_id, adopted_at)
          VALUES (${userId}, ${listingId}, ${companionId}, NOW())
        `;
        // Only a fresh adoption counts — re-adopts resume an existing
        // relationship and must not inflate the listing's "adopted by" stat.
        // Private unlisted rows never move the public counter.
        await sql`UPDATE companion_listings SET add_count = add_count + 1 WHERE id = ${listingId} AND status = 'active'`;
      }
      const adoption = this.rowToAdoption(
        (await sql<Array<any>>`SELECT * FROM companion_adoptions WHERE user_id = ${userId} AND listing_id = ${listingId}`)[0],
      );
      const companion = this.rowToCompanion(
        (await sql<Array<any>>`SELECT * FROM companions WHERE id = ${companionId}`)[0],
      );
      // revived = the adoption row existed but was dropped — "back on your
      // roster" rather than "still on your roster" (reused) or a fresh add.
      return { ok: true as const, companion, adoption, reused: Boolean(existing), revived: Boolean(existing?.dropped_at) };
    }) as Promise<any>;
  }

  /** Drop an adoption: frees the slot, starts the per-listing re-adopt
   *  cooldown, dismisses the clone everywhere, and hands the DM back to the
   *  awakened companion if it was the active pick. */
  async dropAdoption(userId: string, companionId: number, cooldownMs: number): Promise<CompanionAdoption | null> {
    return this.sql.begin(async sql => {
      const rows = await sql<Array<any>>`
        SELECT * FROM companion_adoptions
        WHERE user_id = ${userId} AND companion_id = ${companionId} AND dropped_at IS NULL
        FOR UPDATE
      `;
      if (!rows[0]) return null;
      const until = new Date(Date.now() + cooldownMs).toISOString();
      await sql`
        UPDATE companion_adoptions SET dropped_at = NOW(), cooldown_until = ${until}
        WHERE id = ${rows[0].id}
      `;
      await sql`UPDATE guild_companions SET active = 0 WHERE companion_id = ${companionId}`;
      await sql`
        UPDATE user_bot_settings SET active_dm_companion_id = NULL, updated_at = NOW()
        WHERE discord_user_id = ${userId} AND active_dm_companion_id = ${companionId}
      `;
      return this.rowToAdoption({ ...rows[0], dropped_at: new Date().toISOString(), cooldown_until: until });
    }) as Promise<CompanionAdoption | null>;
  }

  /** Stamp that the adoption greeting actually landed in the adopter's DMs —
   *  this is what unlocks server summoning for adopted companions. */
  async markDmIntroduced(adoptionId: number): Promise<void> {
    await this.sql`UPDATE companion_adoptions SET dm_introduced_at = NOW() WHERE id = ${adoptionId}`;
  }

  // ── Companion journal (v25) ──────────────────────────────────────────────
  // First-person entries about what a companion itself experienced. Origin
  // scope keys recall: entries are read only where they formed; owner-DM
  // entries additionally reach servers via the vault subtext path.

  /** Save first-person entries for a companion in a scope. Entries about
   * non-consenting humans are dropped at write time (same rule as memory
   * extraction); near-duplicates against existing entries are skipped. */
  async saveJournalEntries(
    companionId: number,
    scope: string,
    candidates: JournalCandidate[],
    sourceMessageId: string | null,
    isConsented: (subjectId: string) => Promise<boolean>,
  ): Promise<Array<{ id: number; content: string }>> {
    const saved: Array<{ id: number; content: string }> = [];
    for (const c of candidates) {
      const content = c.content?.trim();
      if (!content) continue;
      const kind = ["moment", "opinion", "inside_joke", "promise"].includes(c.kind) ? c.kind : "moment";
      const aboutIds = [...new Set(c.aboutSubjects ?? [])];
      let blocked = false;
      for (const s of aboutIds) {
        if (!(await isConsented(s))) { blocked = true; break; }
      }
      if (blocked) continue;
      // Near-duplicate suppression against this companion's live entries in the
      // same scope — a paraphrased repeat shouldn't stack journal rows.
      const dup = await this.sql<Array<{ id: number }>>`
        SELECT id FROM companion_journal
        WHERE companion_id = ${companionId} AND origin_scope = ${scope} AND status = 'active'
          AND similarity(content, ${content}) >= 0.75
        LIMIT 1
      `;
      if (dup.length) continue;
      const importance = Number.isFinite(Number(c.importance))
        ? Math.max(0, Math.min(1, Number(c.importance)))
        : 0.5;
      const rows = await this.sql<Array<{ id: number }>>`
        INSERT INTO companion_journal (companion_id, origin_scope, kind, content, about_subject_ids, importance, source_message_id)
        VALUES (${companionId}, ${scope}, ${kind}, ${content}, ${aboutIds}, ${importance}, ${sourceMessageId})
        ON CONFLICT (companion_id, origin_scope, source_message_id, kind, content) DO NOTHING
        RETURNING id
      `;
      if (rows.length) saved.push({ id: Number(rows[0].id), content });
    }
    return saved;
  }

  async setJournalEmbedding(id: number, vector: string): Promise<void> {
    await this.sql`UPDATE companion_journal SET embedding = ${vector}::vector WHERE id = ${id} AND embedding IS NULL`;
  }

  /** Semantic journal recall — cosine scan within the entry's origin scope,
   * then journalFor's exact opt-out filter and about-sort so read rules stay
   * identical across both legs. */
  async semanticJournal(
    companionId: number,
    scope: string,
    vector: string,
    opts: { aboutIds?: string[]; limit?: number; maxDistance?: number } = {},
  ): Promise<JournalEntry[]> {
    const limit = opts.limit ?? 6;
    const rows = await this.sql<Array<any>>`
      SELECT *, (embedding <=> ${vector}::vector) AS distance FROM companion_journal
      WHERE companion_id = ${companionId} AND origin_scope = ${scope} AND status = 'active'
        AND embedding IS NOT NULL
        AND embedding <=> ${vector}::vector < ${opts.maxDistance ?? 0.55}
      ORDER BY distance ASC LIMIT ${limit * 4}
    `;
    const entries = rows.map(r => this.rowToJournal(r));
    const optedOut = new Set<string>();
    for (const e of entries) {
      for (const s of e.aboutSubjectIds) {
        if (s.startsWith("companion:") || s === "server" || s === "unknown") continue;
        const m = await this.getMember(scope, s);
        if (m?.optedOut) optedOut.add(s);
      }
    }
    const kept = entries.filter(e => !e.aboutSubjectIds.some(s => optedOut.has(s)));
    const aboutSet = new Set(opts.aboutIds ?? []);
    if (aboutSet.size) {
      kept.sort((a, b) => Number(b.aboutSubjectIds.some(s => aboutSet.has(s))) - Number(a.aboutSubjectIds.some(s => aboutSet.has(s))));
    }
    return kept.slice(0, limit);
  }

  async unembeddedJournal(limit: number): Promise<Array<{ id: number; content: string }>> {
    const rows = await this.sql<Array<{ id: number; content: string }>>`
      SELECT id, content FROM companion_journal
      WHERE embedding IS NULL AND status = 'active'
      ORDER BY created_at ASC LIMIT ${limit}
    `;
    return rows.map(r => ({ id: Number(r.id), content: r.content }));
  }

  /** Recall this companion's active journal entries formed in this scope.
   * Ranked by importance then recency; subjects who opted out since writing
   * are filtered out at read time so a stale entry can't leak them. */
  async journalFor(
    companionId: number,
    scope: string,
    opts: { aboutIds?: string[]; limit?: number } = {},
  ): Promise<JournalEntry[]> {
    const limit = opts.limit ?? 6;
    const rows = await this.sql<Array<any>>`
      SELECT * FROM companion_journal
      WHERE companion_id = ${companionId} AND origin_scope = ${scope} AND status = 'active'
      ORDER BY importance DESC, created_at DESC
      LIMIT ${limit * 4}
    `;
    const entries = rows.map(r => this.rowToJournal(r));
    const optedOut = new Set<string>();
    for (const e of entries) {
      for (const s of e.aboutSubjectIds) {
        if (s.startsWith("companion:") || s === "server" || s === "unknown") continue;
        const m = await this.getMember(scope, s);
        if (m?.optedOut) optedOut.add(s);
      }
    }
    const kept = entries.filter(e => !e.aboutSubjectIds.some(s => optedOut.has(s)));
    const aboutSet = new Set(opts.aboutIds ?? []);
    const ranked = aboutSet.size
      ? kept.sort((a, b) => Number(b.aboutSubjectIds.some(s => aboutSet.has(s))) - Number(a.aboutSubjectIds.some(s => aboutSet.has(s))))
      : kept;
    const out = ranked.slice(0, limit);
    if (out.length) {
      await this.sql`UPDATE companion_journal SET last_recalled_at = NOW() WHERE id = ANY(${out.map(e => e.id)})`;
    }
    return out;
  }

  /** Hard-delete journal entries in a scope that mention a subject — opt-out
   * removes derived person data entirely, and journal entries are derived. */
  async forgetJournalAbout(scope: string, subjectId: string): Promise<number> {
    const res = await this.sql`
      DELETE FROM companion_journal
      WHERE origin_scope = ${scope} AND ${subjectId} = ANY(about_subject_ids)
    `;
    return res.count;
  }

  /** Cap entries per (companion, scope): evict the least important stale rows
   * first, then oldest. Runs from the nightly maintenance loop. */
  async pruneJournal(cap = 200): Promise<number> {
    const res = await this.sql`
      DELETE FROM companion_journal WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY companion_id, origin_scope
            ORDER BY importance * EXP(-EXTRACT(EPOCH FROM (NOW() - COALESCE(last_recalled_at, created_at))) / 86400.0 / 30) DESC,
                     created_at DESC
          ) rn FROM companion_journal WHERE status = 'active'
        ) ranked WHERE rn > ${cap}
      )
    `;
    return res.count;
  }

  /** Journal entries a subject appears in — feeds /memory-export and opt-out
   * inspection so the journal isn't invisible to the person it describes. */
  async journalAboutSubject(scope: string, subjectId: string): Promise<JournalEntry[]> {
    const rows = await this.sql<Array<any>>`
      SELECT * FROM companion_journal
      WHERE origin_scope = ${scope} AND ${subjectId} = ANY(about_subject_ids)
      ORDER BY created_at DESC
    `;
    return rows.map(r => this.rowToJournal(r));
  }

  private rowToJournal(r: any): JournalEntry {
    return {
      id: Number(r.id),
      companionId: Number(r.companion_id),
      originScope: r.origin_scope,
      kind: r.kind,
      content: r.content,
      aboutSubjectIds: r.about_subject_ids ?? [],
      importance: Number(r.importance),
      status: r.status,
      sourceMessageId: r.source_message_id,
      createdAt: ts(r.created_at),
    };
  }

  async recordWebhookMessage(
    messageId: string,
    guildId: string,
    channelId: string,
    companionId: number,
    chainDepth = 0,
  ): Promise<void> {
    await this.sql`
      INSERT INTO webhook_messages (message_id, guild_id, channel_id, companion_id, chain_depth)
      VALUES (${messageId}, ${guildId}, ${channelId}, ${companionId}, ${chainDepth})
      ON CONFLICT (message_id) DO NOTHING
    `;
  }

  async getWebhookMessage(messageId: string): Promise<WebhookMessageRecord | null> {
    const rows = await this.sql<Array<{
      message_id: string; guild_id: string; channel_id: string; companion_id: number | string;
      chain_depth: number; created_at: Date | string;
    }>>`
      SELECT message_id, guild_id, channel_id, companion_id, chain_depth, created_at
      FROM webhook_messages WHERE message_id = ${messageId}
    `;
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      messageId: r.message_id,
      guildId: r.guild_id,
      channelId: r.channel_id,
      companionId: Number(r.companion_id),
      chainDepth: Number(r.chain_depth),
      createdAt: ts(r.created_at),
    };
  }

  // ── Account linking ──────────────────────────────────────────────────────

  /** Mint a one-time link code for /link — the web account claims it via
   * claim_link_code(), which stamps web_profiles.discord_user_id plus the
   * profile snapshot carried on the code row (username + avatar URL), so a
   * code-linked account renders the same as an OAuth one. One active code
   * per Discord user; issuing a new one sweeps stale/expired rows.
   * Alphabet avoids ambiguous glyphs (0/O, 1/I) since users retype it. */
  async createLinkCode(
    discordUserId: string,
    ttlMinutes = 10,
    profile?: { username?: string | null; avatarUrl?: string | null },
  ): Promise<string> {
    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 8; i++) code += alphabet[randomInt(alphabet.length)];
    code = `${code.slice(0, 4)}-${code.slice(4)}`;
    await this.sql`DELETE FROM link_codes WHERE discord_user_id = ${discordUserId} OR expires_at < NOW()`;
    await this.sql`
      INSERT INTO link_codes (code, discord_user_id, expires_at, discord_username, discord_avatar_url)
      VALUES (${code}, ${discordUserId}, NOW() + (${ttlMinutes} || ' minutes')::interval,
              ${profile?.username ?? null}, ${profile?.avatarUrl ?? null})
    `;
    return code;
  }

  // ── Credits & per-user bot settings ──────────────────────────────────────────
  // Credits live on web_profiles (auth-gated table — absent on plain Postgres,
  // where creditsSupported stays false and the whole feature no-ops). Spends
  // are single-tx: apply due lazy grants under FOR UPDATE, then debit — the
  // row lock makes concurrent turns serialize and the ledger a true running
  // balance. Grants are configured at init from env so tests control them.

  private creditsEnabled = false;
  private creditGrants = { freeDaily: 30, premiumDaily: 150 };

  /** Detect whether the web-accounts schema exists (v26+). Called once at
   * init; tests re-call after creating the fixture tables. */
  async initCreditsSupport(grants?: { freeDaily: number; premiumDaily: number }): Promise<boolean> {
    if (grants) this.creditGrants = grants;
    const rows = await this.sql<Array<{ r: string | null }>>`SELECT to_regclass('public.web_profiles') AS r`;
    this.creditsEnabled = Boolean(rows[0]?.r);
    return this.creditsEnabled;
  }
  get creditsSupported(): boolean { return this.creditsEnabled; }

  /** Cached discord→account resolution shared by the link gate, payer lookup,
   * and plan checks. Only positive hits are cached — a negative entry would
   * mask a fresh /link claim for up to a minute, and a miss is one indexed
   * lookup anyway. */
  private accountCache = new Map<string, { account: { id: string; plan: "free" | "premium"; creditBalance: number }; at: number }>();
  private static readonly ACCOUNT_CACHE_MS = 60_000;
  private static readonly RESOLUTION_CACHE_MAX = 10_000;

  async accountForDiscordUser(discordUserId: string): Promise<{ id: string; plan: "free" | "premium"; creditBalance: number } | null> {
    if (!this.creditsEnabled) return { id: "selfhosted", plan: "premium", creditBalance: Infinity };
    const hit = this.accountCache.get(discordUserId);
    if (hit && Date.now() - hit.at < MemoryStore.ACCOUNT_CACHE_MS) return hit.account;
    const rows = await this.sql<Array<{ id: string; plan: string; credit_balance: number }>>`
      SELECT id, plan, credit_balance FROM web_profiles WHERE discord_user_id = ${discordUserId}
    `;
    if (!rows[0]) return null;
    const account = { id: rows[0].id, plan: rows[0].plan as "free" | "premium", creditBalance: Number(rows[0].credit_balance) };
    if (this.accountCache.size >= MemoryStore.RESOLUTION_CACHE_MAX) this.accountCache.clear();
    this.accountCache.set(discordUserId, { account, at: Date.now() });
    return account;
  }

  /** Latest recorded Terms/Privacy acceptance for a Discord user — null when
   *  they've never accepted. Matches on discord_user_id OR the linked
   *  account_id when supplied, so a web-signup acceptance counts at the
   *  Discord gate. Append-only rows; the highest version wins.
   *  Uncached: a stale cache would let a just-bumped policy slip through. */
  async tosAcceptance(discordUserId: string, accountId?: string | null): Promise<{ version: number; acceptedAt: string } | null> {
    const rows = await this.sql<Array<{ version: number; accepted_at: string }>>`
      SELECT version, accepted_at FROM consent_events
      WHERE document = 'terms'
        AND (discord_user_id = ${discordUserId}
          OR (${accountId ?? null}::text IS NOT NULL AND account_id = ${accountId ?? null}))
      ORDER BY version DESC, accepted_at DESC LIMIT 1
    `;
    return rows[0] ? { version: Number(rows[0].version), acceptedAt: rows[0].accepted_at } : null;
  }

  /** Append a clickwrap acceptance. account_id is the web_profiles.id when the
   *  user has a linked account (or 'selfhosted'); document/version/source let
   *  one table serve every consent surface — 'terms'/'discord_verify' today,
   *  'web_signup' when the site adds a signup checkbox. */
  async recordTosAcceptance(discordUserId: string, accountId: string | null, version: number, source: string): Promise<void> {
    await this.sql`
      INSERT INTO consent_events (discord_user_id, account_id, document, version, source)
      VALUES (${discordUserId}, ${accountId}, 'terms', ${version}, ${source})
    `;
  }

  /** Linked accounts still missing the Discord display snapshot — code-links
   *  claimed before v38 only stamped discord_user_id. The boot backfill walks
   *  these and re-fetches each profile from Discord. */
  async linkedProfilesMissingDiscordIdentity(): Promise<string[]> {
    if (!this.creditsEnabled) return [];
    const rows = await this.sql<Array<{ discord_user_id: string }>>`
      SELECT discord_user_id FROM web_profiles
      WHERE discord_user_id IS NOT NULL AND (discord_username IS NULL OR discord_username = '')
    `;
    return rows.map(r => r.discord_user_id);
  }

  /** Stamp the Discord display fields on a linked web account. Bot-only —
   *  postgres bypasses the column-level grants that keep authenticated
   *  clients from writing these (same guarantee as discord_user_id). */
  async syncDiscordIdentity(discordUserId: string, username: string, avatarUrl: string): Promise<void> {
    if (!this.creditsEnabled) return;
    await this.sql`
      UPDATE web_profiles
      SET discord_username = ${username}, discord_avatar_url = ${avatarUrl}, updated_at = NOW()
      WHERE discord_user_id = ${discordUserId}
    `;
  }

  private async writeLedger(tx: Sql, accountId: string, delta: number, kind: string, reason: string | null): Promise<number> {
    const rows = await tx<Array<{ credit_balance: number }>>`
      UPDATE public.web_profiles SET credit_balance = credit_balance + ${delta}, updated_at = now()
      WHERE id = ${accountId} RETURNING credit_balance
    `;
    const balance = Number(rows[0].credit_balance);
    await tx`
      INSERT INTO public.credit_ledger (account_id, delta, kind, reason, balance_after)
      VALUES (${accountId}, ${delta}, ${kind}, ${reason}, ${balance})
    `;
    return balance;
  }

  /** Debit n credits from the account linked to discordUserId. Applies any due
   * lazy grants first (daily for all plans — premium's floor is just higher)
   * lock — no scheduler, downtime-safe. ok:false when unlinked or broke. */
  async spendCredits(
    discordUserId: string,
    n: number,
    reason: string,
  ): Promise<{ ok: boolean; balance: number }> {
    if (!this.creditsEnabled) return { ok: true, balance: 0 };
    return this.sql.begin(async tx => {
      const rows = await tx<Array<{
        id: string; plan: string; credit_balance: number;
        last_daily_grant_on: string | Date | null;
        today: string;
      }>>`
        SELECT id, plan, credit_balance, last_daily_grant_on,
               (now() AT TIME ZONE 'UTC')::date AS today
        FROM public.web_profiles WHERE discord_user_id = ${discordUserId}
        FOR UPDATE
      `;
      const acct = rows[0];
      // Live miss evicts any cached positive — a just-unlinked user must fail
      // the gate on their next turn, not ride the stale entry.
      if (!acct) { this.accountCache.delete(discordUserId); return { ok: false, balance: 0 }; }
      // postgres.js returns computed ::date columns as strings but stored date
      // columns as Date objects — normalize both to YYYY-MM-DD before comparing.
      const isoDay = (v: string | Date | null): string | null =>
        v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
      const day = isoDay(acct.today)!;
      const lastDaily = isoDay(acct.last_daily_grant_on);
      let balance = Number(acct.credit_balance);
      // Grants REFILL to the grant amount rather than accruing — the user-facing
      // copy ("refreshes daily") is the contract, and a floor bounds how much an
      // idle account can bank toward a burst. Delta is what it took to reach the
      // floor; nothing is written when the balance already exceeds it.
      if (lastDaily !== day) {
        const g = acct.plan === "premium" ? this.creditGrants.premiumDaily : this.creditGrants.freeDaily;
        const delta = Math.max(0, g - balance);
        if (delta > 0) balance = await this.writeLedger(tx, acct.id, delta, "grant_daily", null);
        await tx`UPDATE public.web_profiles SET last_daily_grant_on = ${day} WHERE id = ${acct.id}`;
      }
      if (balance < n) return { ok: false, balance };
      balance = await this.writeLedger(tx, acct.id, -n, "spend", reason);
      this.accountCache.delete(discordUserId);
      return { ok: true, balance };
    });
  }

  /** Credit n back — a companion message that never sent didn't happen. */
  async refundCredits(discordUserId: string, n: number, reason: string): Promise<{ ok: boolean; balance: number }> {
    if (!this.creditsEnabled) return { ok: true, balance: 0 };
    return this.sql.begin(async tx => {
      const rows = await tx<Array<{ id: string }>>`SELECT id FROM public.web_profiles WHERE discord_user_id = ${discordUserId} FOR UPDATE`;
      if (!rows[0]) return { ok: false, balance: 0 };
      const balance = await this.writeLedger(tx, rows[0].id, n, "refund", reason);
      this.accountCache.delete(discordUserId);
      return { ok: true, balance };
    });
  }

  /** Pack purchase — credits an account by UUID (Stripe webhook path, keyed by
   * web_profiles.id rather than a Discord snowflake). stripeRef makes retries
   * idempotent: the ledger's unique stripe_ref index absorbs replays. */
  async purchaseCredits(accountId: string, n: number, reason: string, stripeRef: string): Promise<{ ok: boolean; duplicate: boolean; balance: number }> {
    if (!this.creditsEnabled) return { ok: true, duplicate: false, balance: 0 };
    return this.sql.begin(async tx => {
      const rows = await tx<Array<{ credit_balance: number }>>`
        SELECT credit_balance FROM public.web_profiles WHERE id = ${accountId} FOR UPDATE
      `;
      if (!rows[0]) return { ok: false, duplicate: false, balance: 0 };
      const inserted = await tx`
        INSERT INTO public.credit_ledger (account_id, delta, kind, reason, stripe_ref, balance_after)
        VALUES (${accountId}, ${n}, 'purchase', ${reason}, ${stripeRef}, ${Number(rows[0].credit_balance) + n})
        ON CONFLICT (stripe_ref) WHERE stripe_ref IS NOT NULL DO NOTHING
        RETURNING id
      `;
      if (!inserted[0]) return { ok: true, duplicate: true, balance: Number(rows[0].credit_balance) };
      const updated = await tx<Array<{ credit_balance: number }>>`
        UPDATE public.web_profiles SET credit_balance = credit_balance + ${n}, updated_at = now()
        WHERE id = ${accountId} RETURNING credit_balance
      `;
      this.accountCache.clear(); // accountId is a uuid — evict broadly, cheap at pack volume
      return { ok: true, duplicate: false, balance: Number(updated[0].credit_balance) };
    });
  }

  /** Today's hosted:global LLM-call count — the fleet breaker's current spend.
   * Used to shed the free lane before the hard cap trips. */
  async hostedUsageToday(): Promise<number> {
    const rows = await this.sql<Array<{ llm_calls: number | string | null }>>`
      SELECT llm_calls FROM guild_usage
      WHERE guild_id = 'hosted:global' AND day = (now() AT TIME ZONE 'UTC')::date
    `;
    return Number(rows[0]?.llm_calls ?? 0);
  }

  /** Per-user bot toggles — the site writes via upsert_my_settings; defaults
   * cover users who never open the settings page. */
  private botSettingsCache = new Map<string, { value: { c2cEnabled: boolean; lowCreditAlerts: boolean }; at: number }>();

  async userBotSettings(discordUserId: string): Promise<{ c2cEnabled: boolean; lowCreditAlerts: boolean }> {
    if (!this.creditsEnabled) return { c2cEnabled: true, lowCreditAlerts: true };
    const hit = this.botSettingsCache.get(discordUserId);
    if (hit && Date.now() - hit.at < MemoryStore.ACCOUNT_CACHE_MS) return hit.value;
    const rows = await this.sql<Array<{ c2c_enabled: boolean; low_credit_alerts: boolean }>>`
      SELECT c2c_enabled, low_credit_alerts FROM user_bot_settings WHERE discord_user_id = ${discordUserId}
    `;
    const value = rows[0]
      ? { c2cEnabled: Boolean(rows[0].c2c_enabled), lowCreditAlerts: Boolean(rows[0].low_credit_alerts) }
      : { c2cEnabled: true, lowCreditAlerts: true };
    if (this.botSettingsCache.size >= MemoryStore.RESOLUTION_CACHE_MAX) this.botSettingsCache.clear();
    this.botSettingsCache.set(discordUserId, { value, at: Date.now() });
    return value;
  }
}
