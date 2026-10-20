import { sql as defaultSql, type Sql } from "./db.js";
import { escapeLike } from "./database.js";
import type { EventCandidate, EventParticipant, EventTier, ParticipantRole, StoredEvent } from "./types.js";

// ── Row types returned by Postgres ────────────────────────────────────────────

type EventRow = {
  id: number; guild_id: string; channel_id: string;
  title: string; summary: string; significance: number; tier: string;
  occurred_at: Date | string; closed_at: Date | string | null; reference_count: number;
  classifications: number;
  created_at: Date | string; updated_at: Date | string;
};

type ParticipantRow = { user_id: string; user_name: string; role: string };
type MessageRow    = { message_id: string };
type MemoryRow     = { memory_id: number };

// ── Helpers ───────────────────────────────────────────────────────────────────

function ts(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : d;
}

function rowToStored(row: EventRow, participants: EventParticipant[], messageIds: string[], memoryIds: number[]): StoredEvent {
  return {
    id: Number(row.id), guildId: row.guild_id, channelId: row.channel_id,
    title: row.title, summary: row.summary,
    significance: Number(row.significance), tier: row.tier as EventTier,
    occurredAt: new Date(ts(row.occurred_at)),
    closedAt: row.closed_at ? new Date(ts(row.closed_at)) : null,
    referenceCount: Number(row.reference_count),
    classifications: Number(row.classifications ?? 0),
    participants, messageIds, memoryIds,
    createdAt: ts(row.created_at), updatedAt: ts(row.updated_at),
  };
}

// ── EventStore ────────────────────────────────────────────────────────────────

export class EventStore {
  private sql: Sql;

  constructor(sql: Sql = defaultSql) {
    this.sql = sql;
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  private async hydrate(row: EventRow): Promise<StoredEvent> {
    return (await this.hydrateBatch([row]))[0];
  }

  /** One participants + one messages + one memories query for any number of
   *  events — hydrate() used to cost 3 round trips PER row. Order of the
   *  input rows is preserved in the output. */
  private async hydrateBatch(rows: EventRow[]): Promise<StoredEvent[]> {
    if (!rows.length) return [];
    const ids = rows.map(r => r.id);
    const [participants, messageIds, memoryIds] = await Promise.all([
      this.sql<Array<ParticipantRow & { event_id: number }>>`
        SELECT event_id, user_id, user_name, role FROM event_participants WHERE event_id = ANY(${ids})
      `,
      this.sql<Array<MessageRow & { event_id: number }>>`
        SELECT event_id, message_id FROM event_messages WHERE event_id = ANY(${ids})
      `,
      this.sql<Array<MemoryRow & { event_id: number }>>`
        SELECT event_id, memory_id FROM event_memories WHERE event_id = ANY(${ids})
      `,
    ]);
    const partBy = new Map<number, EventParticipant[]>();
    for (const p of participants) {
      const v = { userId: p.user_id, userName: p.user_name, role: p.role as ParticipantRole };
      const l = partBy.get(Number(p.event_id)); if (l) l.push(v); else partBy.set(Number(p.event_id), [v]);
    }
    const msgBy = new Map<number, string[]>();
    for (const m of messageIds) {
      const k = Number(m.event_id);
      const l = msgBy.get(k); if (l) l.push(m.message_id); else msgBy.set(k, [m.message_id]);
    }
    const memBy = new Map<number, number[]>();
    for (const m of memoryIds) {
      const k = Number(m.event_id);
      const l = memBy.get(k); if (l) l.push(Number(m.memory_id)); else memBy.set(k, [Number(m.memory_id)]);
    }
    return rows.map(r => rowToStored(r, partBy.get(Number(r.id)) ?? [], msgBy.get(Number(r.id)) ?? [], memBy.get(Number(r.id)) ?? []));
  }

  async getEvent(guildId: string, eventId: number): Promise<StoredEvent | undefined> {
    const rows = await this.sql<EventRow[]>`
      SELECT id, guild_id, channel_id, title, summary, significance, tier, occurred_at, closed_at, reference_count, classifications, created_at, updated_at
      FROM events WHERE guild_id = ${guildId} AND id = ${eventId}
    `;
    return rows[0] ? this.hydrate(rows[0]) : undefined;
  }

  /** All open (unclosed) events for a guild/channel, ordered newest first. */
  async openEvents(guildId: string, channelId: string): Promise<StoredEvent[]> {
    const rows = await this.sql<EventRow[]>`
      SELECT id, guild_id, channel_id, title, summary, significance, tier, occurred_at, closed_at, reference_count, classifications, created_at, updated_at
      FROM events WHERE guild_id = ${guildId} AND channel_id = ${channelId} AND closed_at IS NULL
      ORDER BY occurred_at DESC
    `;
    return this.hydrateBatch(rows);
  }

  /** All events that a given memory is linked to. */
  async eventsForMemory(guildId: string, memoryId: number): Promise<StoredEvent[]> {
    const rows = await this.sql<EventRow[]>`
      SELECT e.id, e.guild_id, e.channel_id, e.title, e.summary, e.significance, e.tier,
             e.occurred_at, e.closed_at, e.reference_count, e.classifications, e.created_at, e.updated_at
      FROM events e JOIN event_memories em ON em.event_id = e.id WHERE em.memory_id = ${memoryId} AND e.guild_id = ${guildId}
    `;
    return this.hydrateBatch(rows);
  }

  async listEvents(guildId: string, options: { tier?: EventTier; subjectUserId?: string; page?: number; limit?: number } = {}): Promise<{ events: StoredEvent[]; total: number; page: number }> {
    const page = Math.max(1, options.page ?? 1);
    const pageSize = options.limit ?? 8;
    const offset = (page - 1) * pageSize;
    const tier = options.tier ?? "event";

    let countResult: [{ count: number }];
    let rows: EventRow[];

    if (options.subjectUserId) {
      countResult = await this.sql<[{ count: number }]>`
        SELECT COUNT(*)::int as count FROM events e WHERE e.guild_id = ${guildId} AND e.tier = ${tier}
        AND EXISTS (SELECT 1 FROM event_participants ep WHERE ep.event_id = e.id AND ep.user_id = ${options.subjectUserId})
      `;
      rows = await this.sql<EventRow[]>`
        SELECT e.id, e.guild_id, e.channel_id, e.title, e.summary, e.significance, e.tier,
               e.occurred_at, e.closed_at, e.reference_count, e.classifications, e.created_at, e.updated_at
        FROM events e WHERE e.guild_id = ${guildId} AND e.tier = ${tier}
        AND EXISTS (SELECT 1 FROM event_participants ep WHERE ep.event_id = e.id AND ep.user_id = ${options.subjectUserId})
        ORDER BY e.occurred_at DESC LIMIT ${pageSize} OFFSET ${offset}
      `;
    } else {
      countResult = await this.sql<[{ count: number }]>`SELECT COUNT(*)::int as count FROM events WHERE guild_id = ${guildId} AND tier = ${tier}`;
      rows = await this.sql<EventRow[]>`
        SELECT id, guild_id, channel_id, title, summary, significance, tier, occurred_at, closed_at, reference_count, classifications, created_at, updated_at
        FROM events WHERE guild_id = ${guildId} AND tier = ${tier}
        ORDER BY occurred_at DESC LIMIT ${pageSize} OFFSET ${offset}
      `;
    }

    return { events: await this.hydrateBatch(rows), total: Number(countResult[0].count), page };
  }

  /** Bulk subjectUserId-scoped listing — one query for the (member, event)
   *  join plus one batched hydrate for the union of matched events. Each
   *  subject gets its own top-`perSubject` by recency, matching listEvents'
   *  page-1 semantics exactly. Events shared by several in-set subjects are
   *  hydrated once and handed to each list. */
  async listEventsForSubjects(
    guildId: string, subjectIds: string[],
    options: { tier?: EventTier; perSubject?: number } = {},
  ): Promise<Map<string, StoredEvent[]>> {
    const out = new Map<string, StoredEvent[]>();
    if (!subjectIds.length) return out;
    const tier = options.tier ?? "event";
    const perSubject = options.perSubject ?? 8;
    const rows = await this.sql<Array<EventRow & { subject_user_id: string }>>`
      SELECT s.subject_user_id, e.id, e.guild_id, e.channel_id, e.title, e.summary, e.significance, e.tier,
             e.occurred_at, e.closed_at, e.reference_count, e.classifications, e.created_at, e.updated_at
      FROM (
        SELECT ep.user_id AS subject_user_id, ep.event_id,
               ROW_NUMBER() OVER (PARTITION BY ep.user_id ORDER BY e.occurred_at DESC) AS rn
        FROM event_participants ep JOIN events e ON e.id = ep.event_id
        WHERE e.guild_id = ${guildId} AND e.tier = ${tier} AND ep.user_id = ANY(${subjectIds})
      ) s JOIN events e ON e.id = s.event_id
      WHERE s.rn <= ${perSubject}
      ORDER BY s.subject_user_id, e.occurred_at DESC
    `;
    const distinct = [...new Map(rows.map(r => [Number(r.id), r])).values()];
    const hydrated = new Map((await this.hydrateBatch(distinct)).map(ev => [ev.id, ev]));
    for (const r of rows) {
      const ev = hydrated.get(Number(r.id))!;
      const list = out.get(r.subject_user_id);
      if (list) list.push(ev); else out.set(r.subject_user_id, [ev]);
    }
    return out;
  }

  /** Closed candidates still owed a classification pass — the maintainEvents
   * work list. Cursored by id (not page) because the loop mutates the filter:
   * a promotion leaves the tier, a discard bumps classifications — OFFSET
   * paging would skip rows as the result set shrinks mid-scan. Significance
   * > 0 means already scored; classifications >= 3 is the re-score cap. */
  async listUnscoredCandidates(guildId: string, afterId: number, limit = 50): Promise<StoredEvent[]> {
    const rows = await this.sql<EventRow[]>`
      SELECT id, guild_id, channel_id, title, summary, significance, tier, occurred_at, closed_at, reference_count, classifications, created_at, updated_at
      FROM events
      WHERE guild_id = ${guildId} AND tier = 'candidate' AND closed_at IS NOT NULL
        AND significance <= 0 AND classifications < 3 AND id > ${afterId}
      ORDER BY id LIMIT ${limit}
    `;
    return this.hydrateBatch(rows);
  }

  /** Promoted events both users participated in — the shared-history layer for
   * pairwise reply context. Roles are returned per side so the caller can
   * attribute them correctly. */
  async sharedEvents(guildId: string, aId: string, bId: string, limit = 3): Promise<Array<{
    title: string; occurredAt: string; roleA: string | null; roleB: string | null;
  }>> {
    const rows = await this.sql<Array<{
      title: string; occurred_at: Date | string; role_a: string | null; role_b: string | null;
    }>>`
      SELECT e.title, e.occurred_at, pa.role AS role_a, pb.role AS role_b
      FROM events e
      JOIN event_participants pa ON pa.event_id = e.id AND pa.user_id = ${aId}
      JOIN event_participants pb ON pb.event_id = e.id AND pb.user_id = ${bId}
      WHERE e.guild_id = ${guildId} AND e.tier = 'event' AND e.title != ''
      ORDER BY e.significance DESC, e.occurred_at DESC LIMIT ${limit}
    `;
    return rows.map(r => ({
      title: r.title, occurredAt: ts(r.occurred_at),
      roleA: r.role_a, roleB: r.role_b,
    }));
  }

  /** Title search over promoted events — the lookup_event tool path. */
  async searchEvents(guildId: string, query: string, limit = 3): Promise<StoredEvent[]> {
    const rows = await this.sql<EventRow[]>`
      SELECT id, guild_id, channel_id, title, summary, significance, tier, occurred_at, closed_at, reference_count, classifications, created_at, updated_at
      FROM events WHERE guild_id = ${guildId} AND tier = 'event' AND title ILIKE ${`%${escapeLike(query)}%`}
      ORDER BY significance DESC, occurred_at DESC LIMIT ${limit}
    `;
    return this.hydrateBatch(rows);
  }

  /** The event a message already belongs to, if any — the pipeline's
   * idempotency guard: a retried job must not mint a second candidate
   * window for a message it already clustered. Scoped to the guild like
   * every other read. */
  async eventForMessage(guildId: string, messageId: string): Promise<number | null> {
    const rows = await this.sql<Array<{ event_id: number | string }>>`
      SELECT em.event_id FROM event_messages em
      JOIN events e ON e.id = em.event_id AND e.guild_id = ${guildId}
      WHERE em.message_id = ${messageId}
      LIMIT 1
    `;
    return rows[0] ? Number(rows[0].event_id) : null;
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  async createEvent(candidate: Omit<EventCandidate, "messageIds" | "memoryIds">): Promise<StoredEvent> {
    return await this.sql.begin(async sql => {
      const inserted = await sql<EventRow[]>`
        INSERT INTO events (guild_id, channel_id, title, summary, significance, tier, occurred_at)
        VALUES (${candidate.guildId}, ${candidate.channelId}, ${candidate.title}, ${candidate.summary}, ${candidate.significance}, ${candidate.tier}, ${candidate.occurredAt.toISOString()})
        RETURNING id, guild_id, channel_id, title, summary, significance, tier, occurred_at, closed_at, reference_count, classifications, created_at, updated_at
      `;
      const row = inserted[0];
      const eventId = Number(row.id);
      for (const p of candidate.participants) {
        await sql`
          INSERT INTO event_participants (event_id, user_id, user_name, role)
          VALUES (${eventId}, ${p.userId}, ${p.userName}, ${p.role})
          ON CONFLICT (event_id, user_id) DO NOTHING
        `;
      }
      // Build the StoredEvent from the RETURNING row + participants (no separate SELECT needed)
      return rowToStored(row, candidate.participants, [], []);
    }) as StoredEvent;
  }

  // Event IDs are serial and flow in from LLM continuity decisions — every
  // write below requires guildId and fails closed for foreign or nonexistent
  // events so an untrusted ID can never mutate another tenant's rows.

  async attachMessage(guildId: string, eventId: number, messageId: string): Promise<void> {
    await this.sql`
      INSERT INTO event_messages (event_id, message_id)
      SELECT ${eventId}, ${messageId}
      WHERE EXISTS (SELECT 1 FROM events WHERE id = ${eventId} AND guild_id = ${guildId})
      ON CONFLICT (event_id, message_id) DO NOTHING
    `;
    await this.sql`UPDATE events SET updated_at = NOW() WHERE id = ${eventId} AND guild_id = ${guildId}`;
  }

  async attachMemory(guildId: string, eventId: number, memoryId: number, linkType: "generated" | "referenced" | "retroactive" = "generated"): Promise<void> {
    await this.sql`
      INSERT INTO event_memories (event_id, memory_id, link_type)
      SELECT ${eventId}, ${memoryId}, ${linkType}
      WHERE EXISTS (SELECT 1 FROM events WHERE id = ${eventId} AND guild_id = ${guildId})
      ON CONFLICT (event_id, memory_id) DO NOTHING
    `;
    await this.sql`UPDATE memories SET event_id = ${eventId} WHERE id = ${memoryId} AND guild_id = ${guildId} AND event_id IS NULL
      AND EXISTS (SELECT 1 FROM events WHERE id = ${eventId} AND guild_id = ${guildId})`;
    await this.sql`UPDATE events SET updated_at = NOW() WHERE id = ${eventId} AND guild_id = ${guildId}`;
  }

  async addParticipant(guildId: string, eventId: number, userId: string, userName: string, role: ParticipantRole = "participant"): Promise<void> {
    await this.sql`
      INSERT INTO event_participants (event_id, user_id, user_name, role)
      SELECT ${eventId}, ${userId}, ${userName}, ${role}
      WHERE EXISTS (SELECT 1 FROM events WHERE id = ${eventId} AND guild_id = ${guildId})
      ON CONFLICT (event_id, user_id) DO NOTHING
    `;
  }

  async closeEvent(guildId: string, eventId: number): Promise<void> {
    await this.sql`UPDATE events SET closed_at = NOW(), updated_at = NOW() WHERE id = ${eventId} AND guild_id = ${guildId} AND closed_at IS NULL`;
  }

  async updateSignificance(guildId: string, eventId: number, significance: number, tier: EventTier, title: string, summary: string): Promise<void> {
    await this.sql`UPDATE events SET significance = ${significance}, tier = ${tier}, title = ${title}, summary = ${summary}, updated_at = NOW() WHERE id = ${eventId} AND guild_id = ${guildId}`;
  }

  /** One LLM classification attempt was spent on this event — callers count
   *  failures too (not just successes), so a 'discard'-verdict candidate or a
   *  cluster that always throws can't be re-classified on every future
   *  reference/maintenance pass forever. */
  async noteClassification(guildId: string, eventId: number): Promise<void> {
    await this.sql`UPDATE events SET classifications = classifications + 1 WHERE id = ${eventId} AND guild_id = ${guildId}`;
  }

  async incrementReferenceCount(guildId: string, eventId: number): Promise<number> {
    await this.sql`UPDATE events SET reference_count = reference_count + 1, updated_at = NOW() WHERE id = ${eventId} AND guild_id = ${guildId}`;
    const rows = await this.sql<[{ reference_count: number }]>`SELECT reference_count FROM events WHERE id = ${eventId} AND guild_id = ${guildId}`;
    return rows[0]?.reference_count ?? 0;
  }

  /** Close all open events older than maxAgeMs. Returns the count closed. */
  async closeStaleEvents(guildId: string, maxAgeMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const result = await this.sql`UPDATE events SET closed_at = NOW(), updated_at = NOW() WHERE guild_id = ${guildId} AND closed_at IS NULL AND occurred_at < ${cutoff}`;
    return result.count;
  }
}
