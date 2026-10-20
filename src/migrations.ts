import type { Sql } from "./db.js";

export interface Migration {
  version: number;
  name: string;
  up: (sql: Sql) => Promise<void>;
  down: (sql: Sql) => Promise<void>;
}

async function hasColumn(sql: Sql, table: string, column: string): Promise<boolean> {
  const rows = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = ${table} AND column_name = ${column}
  `;
  return rows.length > 0;
}

// sql.unsafe can't be reached with anything but a safe shape: table and column
// are bare identifiers, the definition is a word/number/quote/paren character
// class — no semicolons, dashes, slashes, or quotes that could smuggle a second
// statement. Anything else throws before touching the database.
const IDENT_RE = /^[a-z][a-z0-9_]*$/;
const COLUMN_DEF_RE = /^[a-z_][a-z0-9_]*(\s+[A-Za-z0-9_().']+)+$/;

async function addColumn(sql: Sql, table: string, definition: string): Promise<void> {
  if (!IDENT_RE.test(table)) throw new Error(`migration table name rejected: ${table}`);
  const column = definition.trim().split(/\s+/)[0];
  if (!COLUMN_DEF_RE.test(definition.trim()) || !IDENT_RE.test(column)) {
    throw new Error(`migration column definition rejected: ${definition}`);
  }
  if (!(await hasColumn(sql, table, column))) {
    await sql.unsafe(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: "phase_1a_add_evidence_tracking",
    up: async (sql) => {
      await addColumn(sql, "memories", "confirmation_count INTEGER NOT NULL DEFAULT 0");
      await addColumn(sql, "memories", "contradiction_count INTEGER NOT NULL DEFAULT 0");
      await addColumn(sql, "memories", "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
      await addColumn(sql, "memories", "last_contradicted_at TIMESTAMPTZ");
      await addColumn(sql, "memories", "supersedes_memory_id BIGINT");
      await addColumn(sql, "memory_evidence", "evidence_type TEXT NOT NULL DEFAULT 'uncertain_inference'");
      await addColumn(sql, "memory_evidence", "effect TEXT NOT NULL DEFAULT 'context'");
      await addColumn(sql, "memory_evidence", "message_content_snapshot TEXT NOT NULL DEFAULT ''");
      await addColumn(sql, "memory_evidence", "message_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()");
      await addColumn(sql, "memory_evidence", "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
      await sql`
        CREATE TABLE IF NOT EXISTS memory_history (
          id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          memory_id        BIGINT NOT NULL REFERENCES memories(id),
          action           TEXT NOT NULL,
          previous_confidence DOUBLE PRECISION,
          new_confidence   DOUBLE PRECISION,
          previous_status  TEXT,
          new_status       TEXT,
          evidence_id      BIGINT REFERENCES memory_evidence(id),
          details_json     TEXT NOT NULL DEFAULT '{}',
          created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS memory_history_lookup ON memory_history(memory_id, created_at DESC)`;
      await sql`UPDATE memories SET confirmation_count = mentions WHERE confirmation_count = 0 AND mentions > 0`;
      await sql`UPDATE memories SET status = 'quarantined' WHERE status = 'stale'`;
    },
    down: async (sql) => {
      await sql`DROP INDEX IF EXISTS memory_history_lookup`;
      await sql`DROP TABLE IF EXISTS memory_history`;
      await sql`UPDATE memory_evidence SET message_content_snapshot = '', effect = 'context', evidence_type = 'uncertain_inference'`;
      await sql`UPDATE memories SET supersedes_memory_id = NULL, last_contradicted_at = NULL, contradiction_count = 0, confirmation_count = 0`;
    },
  },
  {
    version: 2,
    name: "phase_1c_conflict_and_patterns",
    up: async (sql) => {
      await addColumn(sql, "memories", "net_score DOUBLE PRECISION");
      await addColumn(sql, "memories", "frozen_confidence DOUBLE PRECISION");
      await addColumn(sql, "memories", "pattern_id BIGINT");
      await sql`
        CREATE TABLE IF NOT EXISTS behavioral_patterns (
          id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          guild_id      TEXT NOT NULL,
          subject_id    TEXT NOT NULL,
          description   TEXT NOT NULL,
          episode_count INTEGER NOT NULL DEFAULT 0,
          confidence    DOUBLE PRECISION NOT NULL DEFAULT 0,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          status        TEXT NOT NULL DEFAULT 'active'
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS patterns_lookup ON behavioral_patterns(guild_id, subject_id, status)`;
    },
    down: async (sql) => {
      await sql`DROP INDEX IF EXISTS patterns_lookup`;
      await sql`DROP TABLE IF EXISTS behavioral_patterns`;
      await sql`UPDATE memories SET net_score = NULL, frozen_confidence = NULL, pattern_id = NULL`;
    },
  },
  {
    version: 3,
    name: "phase_1c_primary_evidence_type",
    up: async (sql) => {
      await addColumn(sql, "memories", "primary_evidence_type TEXT NOT NULL DEFAULT 'uncertain_inference'");
    },
    down: async (sql) => {
      await sql`UPDATE memories SET primary_evidence_type = 'uncertain_inference'`;
    },
  },
  {
    version: 4,
    name: "v02_events",
    up: async (sql) => {
      await addColumn(sql, "memories", "event_id BIGINT");
      await sql`
        CREATE TABLE IF NOT EXISTS events (
          id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          guild_id        TEXT NOT NULL,
          channel_id      TEXT NOT NULL,
          title           TEXT NOT NULL DEFAULT '',
          summary         TEXT NOT NULL DEFAULT '',
          significance    DOUBLE PRECISION NOT NULL DEFAULT 0,
          tier            TEXT NOT NULL DEFAULT 'candidate',
          occurred_at     TIMESTAMPTZ NOT NULL,
          closed_at       TIMESTAMPTZ,
          reference_count INTEGER NOT NULL DEFAULT 0,
          classifications INTEGER NOT NULL DEFAULT 0,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS events_guild_channel ON events(guild_id, channel_id, occurred_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS events_guild_open ON events(guild_id, tier, closed_at)`;
      await sql`
        CREATE TABLE IF NOT EXISTS event_participants (
          id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          event_id  BIGINT NOT NULL REFERENCES events(id),
          user_id   TEXT NOT NULL,
          user_name TEXT NOT NULL,
          role      TEXT NOT NULL DEFAULT 'participant',
          UNIQUE(event_id, user_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS event_participants_event ON event_participants(event_id)`;
      await sql`
        CREATE TABLE IF NOT EXISTS event_messages (
          id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          event_id   BIGINT NOT NULL REFERENCES events(id),
          message_id TEXT NOT NULL,
          UNIQUE(event_id, message_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS event_messages_event ON event_messages(event_id)`;
      await sql`
        CREATE TABLE IF NOT EXISTS event_memories (
          id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          event_id  BIGINT NOT NULL REFERENCES events(id),
          memory_id BIGINT NOT NULL REFERENCES memories(id),
          link_type TEXT NOT NULL DEFAULT 'generated',
          UNIQUE(event_id, memory_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS event_memories_memory ON event_memories(memory_id)`;
      await sql`CREATE INDEX IF NOT EXISTS event_memories_event ON event_memories(event_id)`;
    },
    down: async (sql) => {
      await sql`DROP INDEX IF EXISTS event_memories_event`;
      await sql`DROP INDEX IF EXISTS event_memories_memory`;
      await sql`DROP TABLE IF EXISTS event_memories`;
      await sql`DROP INDEX IF EXISTS event_messages_event`;
      await sql`DROP TABLE IF EXISTS event_messages`;
      await sql`DROP INDEX IF EXISTS event_participants_event`;
      await sql`DROP TABLE IF EXISTS event_participants`;
      await sql`DROP INDEX IF EXISTS events_guild_open`;
      await sql`DROP INDEX IF EXISTS events_guild_channel`;
      await sql`DROP TABLE IF EXISTS events`;
      await sql`UPDATE memories SET event_id = NULL`;
    },
  },
  {
    version: 5,
    name: "v02_memory_subject_name",
    up: async (sql) => {
      await addColumn(sql, "memories", "subject_name TEXT NOT NULL DEFAULT ''");
    },
    down: async (sql) => {
      await sql`UPDATE memories SET subject_name = ''`;
    },
  },
  {
    version: 6,
    name: "v02_message_triage_result",
    up: async (sql) => {
      await addColumn(sql, "messages", "triage_result TEXT");
    },
    down: async (sql) => {
      await sql`UPDATE messages SET triage_result = NULL`;
    },
  },
  {
    version: 7,
    name: "v03_profiles_and_relationships",
    up: async (sql) => {
      await addColumn(sql, "messages", "reply_to_id TEXT");
      await sql`
        CREATE TABLE IF NOT EXISTS members (
          guild_id      TEXT NOT NULL,
          user_id       TEXT NOT NULL,
          known_names   TEXT[] NOT NULL DEFAULT '{}',
          first_seen_at TIMESTAMPTZ NOT NULL,
          last_seen_at  TIMESTAMPTZ NOT NULL,
          message_count INTEGER NOT NULL DEFAULT 0,
          opted_out     SMALLINT NOT NULL DEFAULT 0,
          PRIMARY KEY (guild_id, user_id)
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS relationship_observations (
          id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          guild_id   TEXT NOT NULL,
          subject_id TEXT NOT NULL,
          other_id   TEXT NOT NULL,
          message_id TEXT NOT NULL,
          nature     TEXT NOT NULL,
          valence    DOUBLE PRECISION,
          reason     TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(subject_id, other_id, message_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS relationship_obs_lookup ON relationship_observations(guild_id, subject_id, other_id)`;
      await sql`
        CREATE TABLE IF NOT EXISTS relationships (
          id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          guild_id          TEXT NOT NULL,
          subject_id        TEXT NOT NULL,
          other_id          TEXT NOT NULL,
          summary           TEXT NOT NULL DEFAULT '',
          valence           DOUBLE PRECISION,
          observation_count INTEGER NOT NULL DEFAULT 0,
          last_observed_at  TIMESTAMPTZ,
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(guild_id, subject_id, other_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS relationships_lookup ON relationships(guild_id, subject_id)`;
      await sql`
        CREATE TABLE IF NOT EXISTS profiles (
          guild_id     TEXT NOT NULL,
          subject_id   TEXT NOT NULL,
          display_name TEXT NOT NULL DEFAULT '',
          summary      TEXT NOT NULL DEFAULT '',
          facets_json  TEXT NOT NULL DEFAULT '{}',
          source_hash  TEXT NOT NULL DEFAULT '',
          built_at     TIMESTAMPTZ,
          updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (guild_id, subject_id)
        )
      `;
    },
    down: async (sql) => {
      await sql`DROP INDEX IF EXISTS relationships_lookup`;
      await sql`DROP TABLE IF EXISTS relationships`;
      await sql`DROP INDEX IF EXISTS relationship_obs_lookup`;
      await sql`DROP TABLE IF EXISTS relationship_observations`;
      await sql`DROP TABLE IF EXISTS profiles`;
      await sql`DROP TABLE IF EXISTS members`;
      await sql`UPDATE messages SET reply_to_id = NULL`;
    },
  },
  {
    version: 8,
    name: "v04_relationship_verdicts",
    // Sincerity verdict per observation ('literal'|'joke'|'unclear'; NULL = not
    // yet judged). Edge roll-up excludes 'joke' rows so edgy banter doesn't
    // create durable edges.
    up: async (sql) => {
      await addColumn(sql, "relationship_observations", "verdict TEXT");
    },
    down: async (sql) => {
      await sql`ALTER TABLE relationship_observations DROP COLUMN IF EXISTS verdict`;
    },
  },
  {
    version: 9,
    name: "v05_alias_learning",
    // Provenance for learned aliases: a self-naming hit ("I am Sage" posted by
    // nightowl) both records the candidate and applies it to known_names.
    up: async (sql) => {
      await sql`
        CREATE TABLE IF NOT EXISTS alias_candidates (
          id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          guild_id            TEXT NOT NULL,
          user_id             TEXT NOT NULL,
          name                TEXT NOT NULL,
          source              TEXT NOT NULL,
          evidence_message_id TEXT NOT NULL DEFAULT '',
          created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(guild_id, user_id, name, evidence_message_id)
        )
      `;
    },
    down: async (sql) => {
      await sql`DROP TABLE IF EXISTS alias_candidates`;
    },
  },
  {
    version: 10,
    name: "v06_unresolved_names",
    // Names that failed entity resolution, logged with their message — the
    // discovery surface for aliases the self-naming path can't catch and for
    // recurring non-member entities worth modeling.
    up: async (sql) => {
      await sql`
        CREATE TABLE IF NOT EXISTS unresolved_names (
          id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          guild_id   TEXT NOT NULL,
          name       TEXT NOT NULL,
          message_id TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(guild_id, name, message_id)
        )
      `;
    },
    down: async (sql) => {
      await sql`DROP TABLE IF EXISTS unresolved_names`;
    },
  },
  {
    version: 11,
    name: "v11_memory_trigram_dedup",
    // pg_trgm powers the near-duplicate fast-path in saveMemory(): when the exact
    // (guild, subject, kind, content) key misses, a similarity() lookup scoped to
    // the same subject+kind decides whether to reinforce an existing row instead.
    up: async (sql) => {
      await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`;
      await sql`CREATE INDEX IF NOT EXISTS memories_content_trgm ON memories USING gin (content gin_trgm_ops)`;
    },
    down: async (sql) => {
      await sql`DROP INDEX IF EXISTS memories_content_trgm`;
      // pg_trgm is left installed — other objects outside this schema may rely on it.
    },
  },
  {
    version: 12,
    name: "v12_profile_attributes",
    // Structured profile facets become the source of truth; profiles.summary /
    // facets_json become renderings gated on attr_hash. memory_ids carries
    // provenance so /forget / supersede / merge cascade immediately. Status is
    // derived from cited memories except 'superseded', which is asserted via
    // superseded_by (a row can be superseded while its evidence is still live).
    // No backfill: derivation runs lazily inside buildProfiles.
    up: async (sql) => {
      await sql`
        CREATE TABLE IF NOT EXISTS profile_attributes (
          id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          guild_id       TEXT NOT NULL,
          subject_id     TEXT NOT NULL,
          field          TEXT NOT NULL,
          value          TEXT NOT NULL,
          value_norm     TEXT NOT NULL,
          confidence     DOUBLE PRECISION NOT NULL,
          memory_ids     BIGINT[] NOT NULL DEFAULT '{}',
          status         TEXT NOT NULL,
          superseded_by  BIGINT,
          first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (guild_id, subject_id, field, value_norm)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS profile_attributes_lookup ON profile_attributes(guild_id, subject_id, status)`;
      await sql`CREATE INDEX IF NOT EXISTS profile_attributes_value_trgm ON profile_attributes USING gin (value_norm gin_trgm_ops)`;
      await addColumn(sql, "profiles", "attr_hash TEXT NOT NULL DEFAULT ''");
    },
    down: async (sql) => {
      await sql`DROP INDEX IF EXISTS profile_attributes_lookup`;
      await sql`DROP INDEX IF EXISTS profile_attributes_value_trgm`;
      await sql`DROP TABLE IF EXISTS profile_attributes`;
      await sql`ALTER TABLE profiles DROP COLUMN IF EXISTS attr_hash`;
    },
  },
  {
    version: 13,
    name: "v13_proactive_enabled",
    // Proactive speaking is a different consent shape than replying when
    // addressed — per-server opt-in, default off, unlike reply_enabled.
    up: async (sql) => {
      await addColumn(sql, "server_settings", "proactive_enabled SMALLINT NOT NULL DEFAULT 0");
    },
    down: async (sql) => {
      await sql`ALTER TABLE server_settings DROP COLUMN IF EXISTS proactive_enabled`;
    },
  },
  {
    version: 14,
    name: "v14_member_opted_in",
    // Derived-data consent is opt-in: person memories, relationship
    // observations, attributes, profiles, and dossiers only form for members
    // who opted_in AND are not opted_out.
    up: async (sql) => {
      await addColumn(sql, "members", "opted_in SMALLINT NOT NULL DEFAULT 0");
    },
    down: async (sql) => {
      await sql`ALTER TABLE members DROP COLUMN IF EXISTS opted_in`;
    },
  },
  {
    version: 15,
    name: "v15_guild_keys",
    // BYOK: one row per guild holding its OpenAI-compatible API key, encrypted
    // AES-256-GCM (secrets.ts). Never in server_settings — a dedicated table so
    // export/purge paths don't casually touch ciphertext. key_hint is the only
    // plaintext remnant (last-4 for masked display); validated_at NULL means
    // stored but never verified live.
    up: async (sql) => {
      await sql`
        CREATE TABLE IF NOT EXISTS guild_keys (
          guild_id     TEXT PRIMARY KEY,
          key_enc      BYTEA NOT NULL,
          key_hint     TEXT NOT NULL,
          base_url     TEXT,
          validated_at TIMESTAMPTZ,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
    },
    down: async (sql) => {
      await sql`DROP TABLE IF EXISTS guild_keys`;
    },
  },
  {
    version: 16,
    name: "v16_consent_posture",
    // Dormant-by-default: new guilds observe nothing until an admin runs
    // /memory-resume (the join announcement tells them to). Only new rows are
    // affected — guilds that already flipped these flags keep their values.
    // announced_at stamps the disclosure card so re-posts don't spam on
    // every connect (discord.js fires GuildCreate for cached guilds too).
    up: async (sql) => {
      await sql`ALTER TABLE server_settings ALTER COLUMN memory_enabled SET DEFAULT 0`;
      await sql`ALTER TABLE server_settings ALTER COLUMN reply_enabled SET DEFAULT 0`;
      await addColumn(sql, "server_settings", "announced_at TIMESTAMPTZ");
    },
    down: async (sql) => {
      await sql`ALTER TABLE server_settings ALTER COLUMN memory_enabled SET DEFAULT 1`;
      await sql`ALTER TABLE server_settings ALTER COLUMN reply_enabled SET DEFAULT 1`;
      await sql`ALTER TABLE server_settings DROP COLUMN IF EXISTS announced_at`;
    },
  },
  {
    version: 17,
    name: "v17_scale_rails",
    // Deferrable cognition moves off the live message path into a Postgres job
    // queue ('extract' is the only type for now). Claims are UPDATE..RETURNING
    // inside a tx (FOR UPDATE SKIP LOCKED), so a crashed worker can't hold
    // claims — no locked_at needed. attempts >= 5 dead-letters by exclusion
    // from the claim index (rows stay inspectable, nothing is deleted).
    // guild_usage meters LLM calls per guild per UTC day; llm_daily_cap is the
    // per-guild bound enforced by the metered client in brains.ts.
    // ignored_channels: channels the bot treats as fully invisible — no
    // archive, no replies, no member writes.
    up: async (sql) => {
      await sql`
        CREATE TABLE IF NOT EXISTS jobs (
          id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          guild_id   TEXT NOT NULL,
          type       TEXT NOT NULL,
          payload    JSONB NOT NULL,
          run_after  TIMESTAMPTZ NOT NULL DEFAULT now(),
          attempts   INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS jobs_claim ON jobs(run_after) WHERE attempts < 5`;
      await sql`
        CREATE TABLE IF NOT EXISTS guild_usage (
          guild_id  TEXT NOT NULL,
          day       DATE NOT NULL,
          llm_calls INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (guild_id, day)
        )
      `;
      await sql`ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS ignored_channels TEXT[] NOT NULL DEFAULT '{}'`;
      await sql`ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS llm_daily_cap INTEGER NOT NULL DEFAULT 1000`;
    },
    down: async (sql) => {
      await sql`DROP TABLE IF EXISTS jobs`;
      await sql`DROP TABLE IF EXISTS guild_usage`;
      await sql`ALTER TABLE server_settings DROP COLUMN IF EXISTS ignored_channels`;
      await sql`ALTER TABLE server_settings DROP COLUMN IF EXISTS llm_daily_cap`;
    },
  },
  {
    version: 18,
    name: "v18_bot_flag_and_event_classifications",
    // messages.author_is_bot: other bots' messages are archive-only context —
    // the sweep must never triage/extract them and a queued extract job drops
    // them at execution. events.classifications: counts re-classification
    // passes so a 'discard'-verdict candidate stops paying a full LLM call on
    // every future reference (bounded retries, not forever).
    up: async (sql) => {
      await sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS author_is_bot BOOLEAN NOT NULL DEFAULT FALSE`;
      await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS classifications INTEGER NOT NULL DEFAULT 0`;
    },
    down: async (sql) => {
      await sql`ALTER TABLE messages DROP COLUMN IF EXISTS author_is_bot`;
      await sql`ALTER TABLE events DROP COLUMN IF EXISTS classifications`;
    },
  },
  {
    version: 19,
    name: "v19_relationship_observation_author",
    // Assertor provenance: who said the thing matters for opt-out deletion
    // (your words' derivatives shouldn't survive you) and for judging whether
    // the assertion is self-report vs third-party claim. Backfilled from the
    // source message where it still exists; rows whose source already aged
    // out stay NULL — they're prunable exactly because provenance was lost.
    up: async (sql) => {
      await addColumn(sql, "relationship_observations", "author_id TEXT");
      await sql`
        UPDATE relationship_observations o SET author_id = m.author_id
        FROM messages m WHERE m.id = o.message_id AND m.guild_id = o.guild_id AND o.author_id IS NULL
      `;
    },
    down: async (sql) => {
      await sql`ALTER TABLE relationship_observations DROP COLUMN IF EXISTS author_id`;
    },
  },
  {
    version: 20,
    name: "v20_relationship_intelligence",
    // Observations gain a source channel: 'message' = single-message
    // assertion (verdict-gated), 'pair_window' = the pair-analysis job's
    // holistic read of an exchange window (verdict set at write — the
    // analysis IS the verification). Edges gain derived columns, all
    // rebuilt by recomputeEdges: behavioral_count stamps the deterministic
    // interaction graph onto claimed edges; party_count tracks self-report
    // depth; trend marks warming/cooling from recent-vs-alltime valence;
    // inferred marks behavior-only edges that carry no claim at all.
    up: async (sql) => {
      await addColumn(sql, "relationship_observations", "source TEXT NOT NULL DEFAULT 'message'");
      await addColumn(sql, "relationships", "behavioral_count INTEGER NOT NULL DEFAULT 0");
      await addColumn(sql, "relationships", "party_count INTEGER NOT NULL DEFAULT 0");
      await addColumn(sql, "relationships", "trend TEXT");
      await addColumn(sql, "relationships", "inferred SMALLINT NOT NULL DEFAULT 0");
    },
    down: async (sql) => {
      await sql`ALTER TABLE relationship_observations DROP COLUMN IF EXISTS source`;
      await sql`ALTER TABLE relationships DROP COLUMN IF EXISTS behavioral_count`;
      await sql`ALTER TABLE relationships DROP COLUMN IF EXISTS party_count`;
      await sql`ALTER TABLE relationships DROP COLUMN IF EXISTS trend`;
      await sql`ALTER TABLE relationships DROP COLUMN IF EXISTS inferred`;
    },
  },
  // ── v21: personal companions, server summons & webhook message attribution ──
  // Users create and bond with a personal companion in 1:1 DMs (`companions`),
  // summon it into friend servers (`guild_companions`), and server replies post
  // via channel webhooks attributed back to the speaking companion
  // (`webhook_messages`) with bounded bot-to-bot `chain_depth`.
  {
    version: 21,
    name: "v21_companions_and_webhooks",
    up: async (sql) => {
      await sql`
        CREATE TABLE IF NOT EXISTS companions (
          id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          owner_user_id    TEXT NOT NULL UNIQUE,
          name             TEXT NOT NULL DEFAULT '',
          avatar_url       TEXT,
          voice_persona    TEXT NOT NULL DEFAULT '',
          core_traits      TEXT[] NOT NULL DEFAULT '{}',
          owner_dynamic    TEXT NOT NULL DEFAULT '',
          backstory        TEXT NOT NULL DEFAULT '',
          onboarding_state TEXT NOT NULL DEFAULT 'onboarding',
          onboarding_turns INTEGER NOT NULL DEFAULT 0,
          created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS guild_companions (
          guild_id     TEXT NOT NULL,
          companion_id BIGINT NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
          summoned_by  TEXT NOT NULL,
          active       SMALLINT NOT NULL DEFAULT 1,
          summoned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (guild_id, companion_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS guild_companions_lookup ON guild_companions(guild_id, active)`;
      await sql`
        CREATE TABLE IF NOT EXISTS webhook_messages (
          message_id   TEXT PRIMARY KEY,
          guild_id     TEXT NOT NULL,
          channel_id   TEXT NOT NULL,
          companion_id BIGINT NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
          chain_depth  INTEGER NOT NULL DEFAULT 0,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS webhook_messages_guild ON webhook_messages(guild_id, created_at DESC)`;
    },
    down: async (sql) => {
      await sql`DROP INDEX IF EXISTS webhook_messages_guild`;
      await sql`DROP TABLE IF EXISTS webhook_messages`;
      await sql`DROP INDEX IF EXISTS guild_companions_lookup`;
      await sql`DROP TABLE IF EXISTS guild_companions`;
      await sql`DROP TABLE IF EXISTS companions`;
    },
  },
  // ── v22: per-key model override ─────────────────────────────────────────────
  // A stored BYOK key can pin its own model — required for custom base URLs
  // (a self-hosted server won't serve the operator's default model) and useful
  // for OpenRouter users who want a different model than the detected default.
  {
    version: 22,
    name: "v22_guild_keys_model",
    up: async (sql) => {
      await addColumn(sql, "guild_keys", "model TEXT");
    },
    down: async (sql) => {
      await sql`ALTER TABLE guild_keys DROP COLUMN IF EXISTS model`;
    },
  },
  // ── v23: Supabase security lockdown ─────────────────────────────────────────
  // Supabase exposes `public` through the Data API and auto-grants
  // anon/authenticated CRUD on new tables. Enabling RLS with zero policies is
  // deny-all for those roles while the backend's postgres role bypasses RLS.
  // Everything here is conditional so plain-Postgres test/local DBs (no anon/
  // authenticated roles, no extensions schema) run it unchanged.
  {
    version: 23,
    name: "v23_rls_lockdown",
    up: async (sql) => {
      await sql`
        DO $rls$
        DECLARE t text;
        BEGIN
          FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
          LOOP
            EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
          END LOOP;
        END $rls$
      `;
      await sql`
        DO $grants$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
            EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon';
          END IF;
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
            EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated';
          END IF;
        END $grants$
      `;
      await sql`
        DO $ext$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'extensions')
             AND EXISTS (
               SELECT 1 FROM pg_extension e
               JOIN pg_namespace n ON n.oid = e.extnamespace
               WHERE e.extname = 'pg_trgm' AND n.nspname = 'public'
             ) THEN
            EXECUTE 'ALTER EXTENSION pg_trgm SET SCHEMA extensions';
          END IF;
        END $ext$
      `;
    },
    // No-op: rolling back would reopen public API access to every table.
    down: async () => {},
  },
  // ── v24: covering indexes for foreign keys ──────────────────────────────────
  {
    version: 24,
    name: "v24_fk_indexes",
    up: async (sql) => {
      await sql`CREATE INDEX IF NOT EXISTS guild_companions_companion ON guild_companions(companion_id)`;
      await sql`CREATE INDEX IF NOT EXISTS memory_history_evidence ON memory_history(evidence_id)`;
      await sql`CREATE INDEX IF NOT EXISTS webhook_messages_companion ON webhook_messages(companion_id)`;
    },
    down: async (sql) => {
      await sql`DROP INDEX IF EXISTS guild_companions_companion`;
      await sql`DROP INDEX IF EXISTS memory_history_evidence`;
      await sql`DROP INDEX IF EXISTS webhook_messages_companion`;
    },
  },
  // ── v25: companion first-person journal ─────────────────────────────────────
  // A companion's own episodic memory — first-person, origin-tagged entries
  // about what it personally experienced ("Alice and I roasted her tea take").
  // origin_scope keys recall: entries surface only where they formed, and the
  // owner's dm:<id> entries additionally ride the vault subtext into servers.
  {
    version: 25,
    name: "v25_companion_journal",
    up: async (sql) => {
      await sql`
        CREATE TABLE IF NOT EXISTS companion_journal (
          id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          companion_id      BIGINT NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
          origin_scope      TEXT NOT NULL,
          kind              TEXT NOT NULL,
          content           TEXT NOT NULL,
          about_subject_ids TEXT[] NOT NULL DEFAULT '{}',
          importance        DOUBLE PRECISION NOT NULL DEFAULT 0.5,
          status            TEXT NOT NULL DEFAULT 'active',
          source_message_id TEXT,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_recalled_at  TIMESTAMPTZ,
          -- Retry idempotency: a crashed job resaves identical output without
          -- stacking rows. content is in the key so two same-kind entries from
          -- one reply both land; trgm dedup at write time covers paraphrases.
          UNIQUE(companion_id, origin_scope, source_message_id, kind, content)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS companion_journal_lookup ON companion_journal(companion_id, origin_scope, status, importance DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS companion_journal_about ON companion_journal USING gin(about_subject_ids)`;
      // Same lockdown as v23 — a new public table needs RLS or the Supabase
      // Data API could reach it. Conditional so plain Postgres test/local
      // databases run it unchanged.
      await sql`ALTER TABLE companion_journal ENABLE ROW LEVEL SECURITY`;
    },
    down: async (sql) => {
      await sql`DROP INDEX IF EXISTS companion_journal_about`;
      await sql`DROP INDEX IF EXISTS companion_journal_lookup`;
      await sql`DROP TABLE IF EXISTS companion_journal`;
    },
  },
  // ── v26: web accounts — the "real life user" half ───────────────────────────
  // Account profiles for Supabase Auth users (named web_profiles — `profiles`
  // is already the subject-profile table). Same project as the bot so the future
  // linking step is a row update, not a federation problem. Conditional on the
  // auth schema so plain Postgres (CI, local Docker) skips it — same pattern as
  // v23. Everything inside is idempotent so an MCP pre-apply + bot restart
  // can't double-fire.
  {
    version: 26,
    name: "v26_web_profiles",
    up: async (sql) => {
      await sql`
        DO $web$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
            EXECUTE 'CREATE SCHEMA IF NOT EXISTS internal';

            EXECUTE $ddl$
              CREATE TABLE IF NOT EXISTS public.web_profiles (
                id                 uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
                display_name       text NOT NULL DEFAULT '',
                discord_user_id    text UNIQUE,
                stripe_customer_id text UNIQUE,
                created_at         timestamptz NOT NULL DEFAULT now(),
                updated_at         timestamptz NOT NULL DEFAULT now()
              )
            $ddl$;

            EXECUTE 'ALTER TABLE public.web_profiles ENABLE ROW LEVEL SECURITY';

            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'GRANT SELECT, INSERT, UPDATE ON public.web_profiles TO authenticated';
            END IF;

            EXECUTE $fn$
              CREATE OR REPLACE FUNCTION internal.handle_new_user()
              RETURNS trigger
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              BEGIN
                INSERT INTO public.web_profiles (id, display_name)
                VALUES (new.id, coalesce(new.raw_user_meta_data->>'display_name', ''))
                ON CONFLICT (id) DO NOTHING;
                RETURN new;
              END
              $body$
            $fn$;
            EXECUTE 'REVOKE ALL ON FUNCTION internal.handle_new_user() FROM PUBLIC';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION internal.handle_new_user() FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION internal.handle_new_user() FROM authenticated';
            END IF;

            EXECUTE 'DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users';
            EXECUTE $trg$
              CREATE TRIGGER on_auth_user_created
              AFTER INSERT ON auth.users
              FOR EACH ROW EXECUTE FUNCTION internal.handle_new_user()
            $trg$;

            EXECUTE 'DROP POLICY IF EXISTS web_profiles_select_own ON public.web_profiles';
            EXECUTE 'DROP POLICY IF EXISTS web_profiles_insert_own ON public.web_profiles';
            EXECUTE 'DROP POLICY IF EXISTS web_profiles_update_own ON public.web_profiles';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE $p1$
                CREATE POLICY web_profiles_select_own ON public.web_profiles
                FOR SELECT TO authenticated
                USING ((select auth.uid()) = id)
              $p1$;
              EXECUTE $p2$
                CREATE POLICY web_profiles_insert_own ON public.web_profiles
                FOR INSERT TO authenticated
                WITH CHECK ((select auth.uid()) = id)
              $p2$;
              EXECUTE $p3$
                CREATE POLICY web_profiles_update_own ON public.web_profiles
                FOR UPDATE TO authenticated
                USING ((select auth.uid()) = id)
                WITH CHECK ((select auth.uid()) = id)
              $p3$;
            END IF;

            EXECUTE $dfn$
              CREATE OR REPLACE FUNCTION public.delete_own_account()
              RETURNS void
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE uid uuid := auth.uid();
              BEGIN
                IF uid IS NULL THEN
                  RAISE EXCEPTION 'not authenticated';
                END IF;
                DELETE FROM auth.users WHERE id = uid;
              END
              $body$
            $dfn$;
            EXECUTE 'REVOKE ALL ON FUNCTION public.delete_own_account() FROM PUBLIC';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION public.delete_own_account() FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.delete_own_account() TO authenticated';
            END IF;
          END IF;
        END $web$
      `;
    },
    down: async (sql) => {
      await sql`
        DO $unweb$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
            EXECUTE 'DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users';
          END IF;
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'internal') THEN
            EXECUTE 'DROP FUNCTION IF EXISTS internal.handle_new_user()';
          END IF;
        END $unweb$
      `;
      await sql`DROP FUNCTION IF EXISTS public.delete_own_account()`;
      await sql`DROP TABLE IF EXISTS public.web_profiles`;
    },
  },
  // ── v27: Discord ↔ web account linking ─────────────────────────────────────
  // web_profiles.discord_user_id becomes server-managed: column-level grants
  // stop users writing it (a forged snowflake would steal another user's
  // perks), and a trigger on auth.identities syncs it from what Discord itself
  // attested — covering OAuth sign-up, linkIdentity, auto-merged identities,
  // and unlink/account deletion. link_codes + claim_link_code implement the
  // Discord-originated /link flow: bot mints a one-time code, site claims it.
  {
    version: 27,
    name: "v27_discord_link",
    up: async (sql) => {
      // link_codes lives outside the auth-schema gate so the bot can mint codes
      // on any database; the claim rpc that consumes it needs auth.uid().
      await sql`
        CREATE TABLE IF NOT EXISTS link_codes (
          code            TEXT PRIMARY KEY,
          discord_user_id TEXT NOT NULL,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at      TIMESTAMPTZ NOT NULL,
          claimed_by      UUID
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS link_codes_user ON link_codes(discord_user_id, expires_at)`;
      // RLS with no policies = deny-all for Data API roles; only the bot
      // (postgres, bypasses RLS) reads/writes, and web claims go through the
      // security-definer rpc below.
      await sql`ALTER TABLE link_codes ENABLE ROW LEVEL SECURITY`;

      await sql`
        DO $link$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
            -- Tighten the writable surface: authenticated can update only
            -- display_name/updated_at on their own row. discord_user_id and
            -- stripe_customer_id are server-write-only from here on.
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'REVOKE UPDATE ON public.web_profiles FROM authenticated';
              EXECUTE 'GRANT UPDATE (display_name, updated_at) ON public.web_profiles TO authenticated';
            END IF;

            EXECUTE $fn$
              CREATE OR REPLACE FUNCTION internal.sync_discord_identity()
              RETURNS trigger
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              BEGIN
                IF TG_OP = 'INSERT' AND new.provider = 'discord' THEN
                  IF EXISTS (
                    SELECT 1 FROM public.web_profiles
                    WHERE discord_user_id = new.provider_id AND id <> new.user_id
                  ) THEN
                    RAISE EXCEPTION 'discord_already_linked: this Discord account is already linked to a different Characterly account';
                  END IF;
                  UPDATE public.web_profiles
                  SET discord_user_id = new.provider_id, updated_at = now()
                  WHERE id = new.user_id;
                  RETURN new;
                END IF;
                IF TG_OP = 'DELETE' AND old.provider = 'discord' THEN
                  -- Guard on the exact provider_id so a re-link to a different
                  -- Discord account isn't clobbered by the old row's delete.
                  UPDATE public.web_profiles
                  SET discord_user_id = NULL, updated_at = now()
                  WHERE id = old.user_id AND discord_user_id = old.provider_id;
                  RETURN old;
                END IF;
                RETURN coalesce(new, old);
              END
              $body$
            $fn$;
            EXECUTE 'REVOKE ALL ON FUNCTION internal.sync_discord_identity() FROM PUBLIC';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION internal.sync_discord_identity() FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION internal.sync_discord_identity() FROM authenticated';
            END IF;

            EXECUTE 'DROP TRIGGER IF EXISTS on_identity_sync ON auth.identities';
            EXECUTE $trg$
              CREATE TRIGGER on_identity_sync
              AFTER INSERT OR DELETE ON auth.identities
              FOR EACH ROW EXECUTE FUNCTION internal.sync_discord_identity()
            $trg$;

            -- Backfill users who already signed in via Discord before this
            -- trigger existed.
            EXECUTE $bf$
              UPDATE public.web_profiles wp
              SET discord_user_id = i.provider_id, updated_at = now()
              FROM auth.identities i
              WHERE i.user_id = wp.id AND i.provider = 'discord'
                AND wp.discord_user_id IS NULL
            $bf$;

            EXECUTE $rpc$
              CREATE OR REPLACE FUNCTION public.claim_link_code(p_code text)
              RETURNS void
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
                rec record;
              BEGIN
                IF uid IS NULL THEN
                  RAISE EXCEPTION 'not authenticated';
                END IF;
                SELECT * INTO rec FROM public.link_codes
                WHERE code = upper(trim(p_code));
                IF NOT FOUND THEN
                  RAISE EXCEPTION 'invalid_code: that code does not exist — check it and try again';
                END IF;
                IF rec.claimed_by IS NOT NULL THEN
                  RAISE EXCEPTION 'code_used: that code was already claimed — run /link again for a fresh one';
                END IF;
                IF rec.expires_at < now() THEN
                  RAISE EXCEPTION 'code_expired: that code expired — run /link again for a fresh one';
                END IF;
                IF EXISTS (
                  SELECT 1 FROM public.web_profiles
                  WHERE discord_user_id = rec.discord_user_id AND id <> uid
                ) THEN
                  RAISE EXCEPTION 'discord_already_linked: this Discord account is already linked to a different Characterly account';
                END IF;
                UPDATE public.web_profiles
                SET discord_user_id = rec.discord_user_id, updated_at = now()
                WHERE id = uid;
                UPDATE public.link_codes SET claimed_by = uid WHERE code = rec.code;
              END
              $body$
            $rpc$;
            EXECUTE 'REVOKE ALL ON FUNCTION public.claim_link_code(text) FROM PUBLIC';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION public.claim_link_code(text) FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.claim_link_code(text) TO authenticated';
            END IF;
          END IF;
        END $link$
      `;
    },
    down: async (sql) => {
      await sql`
        DO $unlink$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
            EXECUTE 'DROP TRIGGER IF EXISTS on_identity_sync ON auth.identities';
            EXECUTE 'DROP FUNCTION IF EXISTS public.claim_link_code(text)';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'REVOKE UPDATE (display_name, updated_at) ON public.web_profiles FROM authenticated';
              EXECUTE 'GRANT UPDATE ON public.web_profiles TO authenticated';
            END IF;
          END IF;
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'internal') THEN
            EXECUTE 'DROP FUNCTION IF EXISTS internal.sync_discord_identity()';
          END IF;
        END $unlink$
      `;
      await sql`DROP TABLE IF EXISTS link_codes`;
    },
  },
  // ── v28: account-linking hardening ─────────────────────────────────────────
  // Three audit fixes: handle_new_user falls back to OAuth metadata keys
  // (Discord supplies full_name/name, not display_name); claim_link_code
  // verifies the profile row actually updated before consuming the code; and
  // unlink_discord clears a code-claimed link — those users have no auth
  // identity row for unlinkIdentity to remove.
  {
    version: 28,
    name: "v28_link_hardening",
    up: async (sql) => {
      await sql`
        DO $hard$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
            EXECUTE $fn$
              CREATE OR REPLACE FUNCTION internal.handle_new_user()
              RETURNS trigger
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              BEGIN
                INSERT INTO public.web_profiles (id, display_name)
                VALUES (new.id, coalesce(
                  new.raw_user_meta_data->>'display_name',
                  new.raw_user_meta_data->>'full_name',
                  new.raw_user_meta_data->>'name',
                  ''
                ))
                ON CONFLICT (id) DO NOTHING;
                RETURN new;
              END
              $body$
            $fn$;
            EXECUTE 'REVOKE ALL ON FUNCTION internal.handle_new_user() FROM PUBLIC';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION internal.handle_new_user() FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION internal.handle_new_user() FROM authenticated';
            END IF;

            EXECUTE $rpc$
              CREATE OR REPLACE FUNCTION public.claim_link_code(p_code text)
              RETURNS void
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
                rec record;
                n integer;
              BEGIN
                IF uid IS NULL THEN
                  RAISE EXCEPTION 'not authenticated';
                END IF;
                SELECT * INTO rec FROM public.link_codes
                WHERE code = upper(trim(p_code));
                IF NOT FOUND THEN
                  RAISE EXCEPTION 'invalid_code: that code does not exist — check it and try again';
                END IF;
                IF rec.claimed_by IS NOT NULL THEN
                  RAISE EXCEPTION 'code_used: that code was already claimed — run /link again for a fresh one';
                END IF;
                IF rec.expires_at < now() THEN
                  RAISE EXCEPTION 'code_expired: that code expired — run /link again for a fresh one';
                END IF;
                IF EXISTS (
                  SELECT 1 FROM public.web_profiles
                  WHERE discord_user_id = rec.discord_user_id AND id <> uid
                ) THEN
                  RAISE EXCEPTION 'discord_already_linked: this Discord account is already linked to a different Characterly account';
                END IF;
                UPDATE public.web_profiles
                SET discord_user_id = rec.discord_user_id, updated_at = now()
                WHERE id = uid;
                GET DIAGNOSTICS n = ROW_COUNT;
                IF n = 0 THEN
                  RAISE EXCEPTION 'no_profile: account row missing — sign out and back in, then retry';
                END IF;
                UPDATE public.link_codes SET claimed_by = uid WHERE code = rec.code;
              END
              $body$
            $rpc$;
            EXECUTE 'REVOKE ALL ON FUNCTION public.claim_link_code(text) FROM PUBLIC';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION public.claim_link_code(text) FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.claim_link_code(text) TO authenticated';
            END IF;

            EXECUTE $rpc$
              CREATE OR REPLACE FUNCTION public.unlink_discord()
              RETURNS void
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
              BEGIN
                IF uid IS NULL THEN
                  RAISE EXCEPTION 'not authenticated';
                END IF;
                UPDATE public.web_profiles
                SET discord_user_id = NULL, updated_at = now()
                WHERE id = uid;
                IF NOT FOUND THEN
                  RAISE EXCEPTION 'no_profile: account row missing';
                END IF;
              END
              $body$
            $rpc$;
            EXECUTE 'REVOKE ALL ON FUNCTION public.unlink_discord() FROM PUBLIC';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION public.unlink_discord() FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.unlink_discord() TO authenticated';
            END IF;
          END IF;
        END $hard$
      `;
    },
    down: async (sql) => {
      await sql`
        DO $undo$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
            EXECUTE 'DROP FUNCTION IF EXISTS public.unlink_discord()';
            EXECUTE $fn$
              CREATE OR REPLACE FUNCTION internal.handle_new_user()
              RETURNS trigger
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              BEGIN
                INSERT INTO public.web_profiles (id, display_name)
                VALUES (new.id, coalesce(new.raw_user_meta_data->>'display_name', ''))
                ON CONFLICT (id) DO NOTHING;
                RETURN new;
              END
              $body$
            $fn$;
          END IF;
        END $undo$
      `;
    },
  },
  // ── v29: hosted-model credits + bot settings ────────────────────────────────
  // The operator env key becomes the "hosted lane": user-facing chat on it is
  // metered in credits (user-facing name: tokens) held on web_profiles and
  // audited by credit_ledger. Lazy accrual grants land inside the spend tx —
  // no scheduler. user_bot_settings is keyed by discord_user_id OUTSIDE the
  // auth gate so the bot reads it with zero joins on any Postgres; the global
  // hosted circuit breaker reuses guild_usage with scope 'hosted:global'.
  {
    version: 29,
    name: "v29_credits_and_bot_settings",
    up: async (sql) => {
      await sql`
        CREATE TABLE IF NOT EXISTS user_bot_settings (
          discord_user_id   TEXT PRIMARY KEY,
          c2c_enabled       BOOLEAN NOT NULL DEFAULT TRUE,
          low_credit_alerts BOOLEAN NOT NULL DEFAULT TRUE,
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      // Deny-all for Data API roles — the bot (postgres) reads/writes freely;
      // the site writes through upsert_my_settings which stamps the caller's
      // own linked discord_user_id.
      await sql`ALTER TABLE user_bot_settings ENABLE ROW LEVEL SECURITY`;

      await sql`
        DO $cred$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth')
             AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'web_profiles') THEN
            EXECUTE 'ALTER TABLE public.web_profiles
              ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT ''free''
                CHECK (plan IN (''free'',''premium'')),
              ADD COLUMN IF NOT EXISTS credit_balance INT NOT NULL DEFAULT 0,
              ADD COLUMN IF NOT EXISTS last_daily_grant_on DATE,
              ADD COLUMN IF NOT EXISTS last_weekly_grant_on DATE';

            EXECUTE $tbl$
              CREATE TABLE IF NOT EXISTS public.credit_ledger (
                id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                account_id    UUID NOT NULL REFERENCES public.web_profiles(id) ON DELETE CASCADE,
                delta         INT NOT NULL,
                kind          TEXT NOT NULL CHECK (kind IN ('grant_daily','grant_weekly','spend','refund','adjust')),
                reason        TEXT,
                balance_after INT NOT NULL,
                created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
              )
            $tbl$;
            EXECUTE 'CREATE INDEX IF NOT EXISTS credit_ledger_account ON public.credit_ledger(account_id, id DESC)';
            EXECUTE 'ALTER TABLE public.credit_ledger ENABLE ROW LEVEL SECURITY';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE $pol$
                CREATE POLICY credit_ledger_select_own ON public.credit_ledger
                FOR SELECT TO authenticated
                USING (account_id = auth.uid())
              $pol$;
            END IF;

            EXECUTE $fn$
              CREATE OR REPLACE FUNCTION public.my_bot_settings()
              RETURNS json
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                did text;
                rec record;
              BEGIN
                IF auth.uid() IS NULL THEN
                  RAISE EXCEPTION 'not authenticated';
                END IF;
                SELECT discord_user_id INTO did FROM public.web_profiles WHERE id = auth.uid();
                IF did IS NULL THEN
                  RETURN json_build_object('linked', false, 'c2c_enabled', true, 'low_credit_alerts', true);
                END IF;
                SELECT * INTO rec FROM public.user_bot_settings WHERE discord_user_id = did;
                RETURN json_build_object(
                  'linked', true,
                  'c2c_enabled', coalesce(rec.c2c_enabled, true),
                  'low_credit_alerts', coalesce(rec.low_credit_alerts, true)
                );
              END
              $body$
            $fn$;
            EXECUTE 'REVOKE ALL ON FUNCTION public.my_bot_settings() FROM PUBLIC';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION public.my_bot_settings() FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.my_bot_settings() TO authenticated';
            END IF;

            EXECUTE $fn$
              CREATE OR REPLACE FUNCTION public.upsert_my_settings(patch jsonb)
              RETURNS void
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                did text;
                v_c2c boolean;
                v_alerts boolean;
              BEGIN
                IF auth.uid() IS NULL THEN
                  RAISE EXCEPTION 'not authenticated';
                END IF;
                SELECT discord_user_id INTO did FROM public.web_profiles WHERE id = auth.uid();
                IF did IS NULL THEN
                  RAISE EXCEPTION 'not_linked: link your Discord account first';
                END IF;
                IF patch ? 'c2c_enabled' AND jsonb_typeof(patch->'c2c_enabled') <> 'boolean' THEN
                  RAISE EXCEPTION 'bad_patch: c2c_enabled must be boolean';
                END IF;
                IF patch ? 'low_credit_alerts' AND jsonb_typeof(patch->'low_credit_alerts') <> 'boolean' THEN
                  RAISE EXCEPTION 'bad_patch: low_credit_alerts must be boolean';
                END IF;
                v_c2c := coalesce((patch->>'c2c_enabled')::boolean, true);
                v_alerts := coalesce((patch->>'low_credit_alerts')::boolean, true);
                INSERT INTO public.user_bot_settings (discord_user_id, c2c_enabled, low_credit_alerts, updated_at)
                VALUES (did, v_c2c, v_alerts, now())
                ON CONFLICT (discord_user_id) DO UPDATE SET
                  c2c_enabled = COALESCE((patch->>'c2c_enabled')::boolean, user_bot_settings.c2c_enabled),
                  low_credit_alerts = COALESCE((patch->>'low_credit_alerts')::boolean, user_bot_settings.low_credit_alerts),
                  updated_at = now();
              END
              $body$
            $fn$;
            EXECUTE 'REVOKE ALL ON FUNCTION public.upsert_my_settings(jsonb) FROM PUBLIC';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION public.upsert_my_settings(jsonb) FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.upsert_my_settings(jsonb) TO authenticated';
            END IF;

            EXECUTE $fn$
              CREATE OR REPLACE FUNCTION public.my_byok_status()
              RETURNS json
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                did text;
                rec record;
              BEGIN
                IF auth.uid() IS NULL THEN
                  RAISE EXCEPTION 'not authenticated';
                END IF;
                SELECT discord_user_id INTO did FROM public.web_profiles WHERE id = auth.uid();
                IF did IS NULL THEN
                  RETURN json_build_object('linked', false, 'has_key', false);
                END IF;
                SELECT validated_at INTO rec FROM public.guild_keys
                WHERE guild_id = 'dm:' || did;
                RETURN json_build_object(
                  'linked', true,
                  'has_key', FOUND,
                  'validated_at', rec.validated_at
                );
              END
              $body$
            $fn$;
            EXECUTE 'REVOKE ALL ON FUNCTION public.my_byok_status() FROM PUBLIC';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION public.my_byok_status() FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.my_byok_status() TO authenticated';
            END IF;
          END IF;
        END $cred$
      `;
    },
    down: async (sql) => {
      await sql`
        DO $drop$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
            EXECUTE 'DROP FUNCTION IF EXISTS public.my_byok_status()';
            EXECUTE 'DROP FUNCTION IF EXISTS public.upsert_my_settings(jsonb)';
            EXECUTE 'DROP FUNCTION IF EXISTS public.my_bot_settings()';
            EXECUTE 'DROP TABLE IF EXISTS public.credit_ledger';
            EXECUTE 'ALTER TABLE public.web_profiles
              DROP COLUMN IF EXISTS plan,
              DROP COLUMN IF EXISTS credit_balance,
              DROP COLUMN IF EXISTS last_daily_grant_on,
              DROP COLUMN IF EXISTS last_weekly_grant_on';
          END IF;
        END $drop$
      `;
      await sql`DROP TABLE IF EXISTS user_bot_settings`;
    },
  },
  // ── v30: account + credits hardening ────────────────────────────────────────
  // Review fixes: v26 granted authenticated a table-level INSERT on
  // web_profiles that v27 never revoked — a user with no profile row could
  // forge plan/credits/discord_user_id. The handle_new_user trigger is the
  // only legitimate row creator, so INSERT is revoked entirely; the pre-v26
  // users who motivated the exploit get a backfill here (sign-in never
  // re-fires an INSERT trigger, so they'd otherwise stay row-less forever).
  // claim_link_code locks its code row (concurrent claims raced the
  // claimed_by check) and normalizes input (dash optional). credit_ledger's
  // policy uses (select auth.uid()) for per-statement evaluation like the
  // other v26-v29 policies.
  {
    version: 30,
    name: "v30_account_credits_hardening",
    up: async (sql) => {
      await sql`
        DO $fix$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth')
             AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'web_profiles') THEN
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'REVOKE INSERT ON public.web_profiles FROM authenticated';
            END IF;
            EXECUTE $back$
              INSERT INTO public.web_profiles (id, display_name)
              SELECT u.id, coalesce(
                nullif(u.raw_user_meta_data->>'display_name', ''),
                nullif(u.raw_user_meta_data->>'full_name', ''),
                nullif(u.raw_user_meta_data->>'name', ''),
                split_part(u.email, '@', 1)
              )
              FROM auth.users u
              WHERE NOT EXISTS (SELECT 1 FROM public.web_profiles w WHERE w.id = u.id)
              ON CONFLICT (id) DO NOTHING
            $back$;

            EXECUTE $rpc$
              CREATE OR REPLACE FUNCTION public.claim_link_code(p_code text)
              RETURNS void
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
                rec record;
                n integer;
                norm text := upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g'));
              BEGIN
                IF uid IS NULL THEN
                  RAISE EXCEPTION 'not authenticated';
                END IF;
                -- Codes are XXXX-XXXX but users drop the dash — normalize to
                -- the stored form before lookup.
                IF length(norm) <> 8 THEN
                  RAISE EXCEPTION 'invalid_code: that code does not exist — check it and try again';
                END IF;
                norm := substr(norm, 1, 4) || '-' || substr(norm, 5, 4);
                -- FOR UPDATE serializes concurrent claims of the same code —
                -- the second claimant sees the first's claimed_by, not a
                -- duplicate-key error.
                SELECT * INTO rec FROM public.link_codes
                WHERE code = norm
                FOR UPDATE;
                IF NOT FOUND THEN
                  RAISE EXCEPTION 'invalid_code: that code does not exist — check it and try again';
                END IF;
                IF rec.claimed_by IS NOT NULL THEN
                  RAISE EXCEPTION 'code_used: that code was already claimed — run /link again for a fresh one';
                END IF;
                IF rec.expires_at < now() THEN
                  RAISE EXCEPTION 'code_expired: that code expired — run /link again for a fresh one';
                END IF;
                IF EXISTS (
                  SELECT 1 FROM public.web_profiles
                  WHERE discord_user_id = rec.discord_user_id AND id <> uid
                ) THEN
                  RAISE EXCEPTION 'discord_already_linked: this Discord account is already linked to a different Characterly account';
                END IF;
                UPDATE public.web_profiles
                SET discord_user_id = rec.discord_user_id, updated_at = now()
                WHERE id = uid;
                GET DIAGNOSTICS n = ROW_COUNT;
                IF n = 0 THEN
                  RAISE EXCEPTION 'no_profile: account row missing — contact support';
                END IF;
                UPDATE public.link_codes SET claimed_by = uid WHERE code = rec.code;
              END
              $body$
            $rpc$;
            EXECUTE 'REVOKE ALL ON FUNCTION public.claim_link_code(text) FROM PUBLIC';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION public.claim_link_code(text) FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.claim_link_code(text) TO authenticated';
            END IF;

            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
               AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'credit_ledger') THEN
              EXECUTE 'DROP POLICY IF EXISTS credit_ledger_select_own ON public.credit_ledger';
              EXECUTE 'CREATE POLICY credit_ledger_select_own ON public.credit_ledger
                FOR SELECT TO authenticated
                USING (account_id = (select auth.uid()))';
            END IF;
          END IF;
        END $fix$
      `;
    },
    down: async (sql) => {
      await sql`
        DO $undo$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth')
             AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
            EXECUTE 'GRANT INSERT ON public.web_profiles TO authenticated';
            EXECUTE 'DROP POLICY IF EXISTS credit_ledger_select_own ON public.credit_ledger';
            EXECUTE 'CREATE POLICY credit_ledger_select_own ON public.credit_ledger
              FOR SELECT TO authenticated
              USING (account_id = auth.uid())';
          END IF;
        END $undo$
      `;
    },
  },
  // ── v31: Stripe plumbing for premium + token packs ─────────────────────────
  // web_profiles gains stripe_customer_id/stripe_subscription_id so webhook
  // events map customer → account. credit_ledger gains 'purchase' as a kind
  // and a stripe_ref column with a unique index — pack fulfillment is
  // idempotent because webhook redelivery lands on the constraint, not the
  // balance. Both halves stay inside the auth-schema gate like v29.
  {
    version: 31,
    name: "v31_stripe_packs",
    up: async (sql) => {
      await sql`
        DO $mig$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth')
             AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'web_profiles') THEN
            EXECUTE 'ALTER TABLE public.web_profiles
              ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
              ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT';
            EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS web_profiles_stripe_customer
              ON public.web_profiles (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL';
          END IF;
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth')
             AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'credit_ledger') THEN
            EXECUTE 'ALTER TABLE public.credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_kind_check';
            EXECUTE 'ALTER TABLE public.credit_ledger
              ADD CONSTRAINT credit_ledger_kind_check
              CHECK (kind IN (''grant_daily'',''grant_weekly'',''spend'',''refund'',''adjust'',''purchase''))';
            EXECUTE 'ALTER TABLE public.credit_ledger ADD COLUMN IF NOT EXISTS stripe_ref TEXT';
            EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_stripe_ref
              ON public.credit_ledger (stripe_ref) WHERE stripe_ref IS NOT NULL';

            -- Pack grant for the Stripe webhook edge function. service_role
            -- only — users can't self-grant. Idempotent: a redelivered webhook
            -- hits the stripe_ref unique index and returns duplicate=true
            -- without touching the balance. balance_after is written under the
            -- account row lock so the audit row is truthful.
            EXECUTE $rpc$
              CREATE OR REPLACE FUNCTION public.grant_pack(
                p_account uuid, p_tokens int, p_ref text
              ) RETURNS jsonb
              LANGUAGE plpgsql SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                bal integer;
                dup boolean := false;
              BEGIN
                PERFORM 1 FROM public.web_profiles WHERE id = p_account FOR UPDATE;
                IF NOT FOUND THEN
                  RETURN jsonb_build_object('ok', false, 'reason', 'no_account');
                END IF;
                INSERT INTO public.credit_ledger (account_id, delta, kind, reason, stripe_ref, balance_after)
                SELECT p_account, p_tokens, 'purchase', 'pack_' || p_tokens, p_ref,
                       w.credit_balance + p_tokens
                FROM public.web_profiles w WHERE w.id = p_account
                ON CONFLICT (stripe_ref) WHERE stripe_ref IS NOT NULL DO NOTHING;
                IF NOT FOUND THEN
                  dup := true;
                ELSE
                  UPDATE public.web_profiles
                  SET credit_balance = credit_balance + p_tokens, updated_at = now()
                  WHERE id = p_account
                  RETURNING credit_balance INTO bal;
                END IF;
                SELECT credit_balance INTO bal FROM public.web_profiles WHERE id = p_account;
                RETURN jsonb_build_object('ok', true, 'duplicate', dup, 'balance', bal);
              END
              $body$
            $rpc$;
            EXECUTE 'REVOKE ALL ON FUNCTION public.grant_pack(uuid, int, text) FROM PUBLIC';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION public.grant_pack(uuid, int, text) FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION public.grant_pack(uuid, int, text) FROM authenticated';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.grant_pack(uuid, int, text) TO service_role';
            END IF;
          END IF;
        END $mig$
      `;
    },
    down: async (sql) => {
      await sql`
        DO $undo$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
            EXECUTE 'DROP FUNCTION IF EXISTS public.grant_pack(uuid, int, text)';
            EXECUTE 'DROP INDEX IF EXISTS public.credit_ledger_stripe_ref';
            EXECUTE 'ALTER TABLE public.credit_ledger DROP COLUMN IF EXISTS stripe_ref';
            EXECUTE 'ALTER TABLE public.credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_kind_check';
            EXECUTE 'DROP INDEX IF EXISTS public.web_profiles_stripe_customer';
            EXECUTE 'ALTER TABLE public.web_profiles
              DROP COLUMN IF EXISTS stripe_customer_id,
              DROP COLUMN IF EXISTS stripe_subscription_id';
          END IF;
        END $undo$
      `;
    },
  },
  // ── v32: Stripe webhook hardening ──────────────────────────────────────────
  // grant_pack gains a positive-amount guard — it's service_role-only, but a
  // negative p_tokens would *debit* the account. account_id_for_email backs
  // the webhook's bare-link fallback: a payment link shared without
  // ?client_reference_id resolves the buyer by the email they typed at
  // checkout instead of silently dropping a paid event.
  {
    version: 32,
    name: "v32_stripe_webhook_hardening",
    up: async (sql) => {
      await sql`
        DO $mig$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth')
             AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'credit_ledger') THEN
            EXECUTE $rpc$
              CREATE OR REPLACE FUNCTION public.grant_pack(
                p_account uuid, p_tokens int, p_ref text
              ) RETURNS jsonb
              LANGUAGE plpgsql SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                bal integer;
                dup boolean := false;
              BEGIN
                IF p_tokens IS NULL OR p_tokens <= 0 THEN
                  RAISE EXCEPTION 'invalid_token_amount';
                END IF;
                PERFORM 1 FROM public.web_profiles WHERE id = p_account FOR UPDATE;
                IF NOT FOUND THEN
                  RETURN jsonb_build_object('ok', false, 'reason', 'no_account');
                END IF;
                INSERT INTO public.credit_ledger (account_id, delta, kind, reason, stripe_ref, balance_after)
                SELECT p_account, p_tokens, 'purchase', 'pack_' || p_tokens, p_ref,
                       w.credit_balance + p_tokens
                FROM public.web_profiles w WHERE w.id = p_account
                ON CONFLICT (stripe_ref) WHERE stripe_ref IS NOT NULL DO NOTHING;
                IF NOT FOUND THEN
                  dup := true;
                ELSE
                  UPDATE public.web_profiles
                  SET credit_balance = credit_balance + p_tokens, updated_at = now()
                  WHERE id = p_account
                  RETURNING credit_balance INTO bal;
                END IF;
                SELECT credit_balance INTO bal FROM public.web_profiles WHERE id = p_account;
                RETURN jsonb_build_object('ok', true, 'duplicate', dup, 'balance', bal);
              END
              $body$
            $rpc$;
          END IF;
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
            EXECUTE $rpc$
              CREATE OR REPLACE FUNCTION public.account_id_for_email(p_email text)
              RETURNS uuid
              LANGUAGE plpgsql SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid;
              BEGIN
                SELECT u.id INTO uid FROM auth.users u
                WHERE lower(u.email) = lower(trim(p_email))
                LIMIT 1;
                RETURN uid;
              END
              $body$
            $rpc$;
            EXECUTE 'REVOKE ALL ON FUNCTION public.account_id_for_email(text) FROM PUBLIC';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION public.account_id_for_email(text) FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION public.account_id_for_email(text) FROM authenticated';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.account_id_for_email(text) TO service_role';
            END IF;
          END IF;
        END $mig$
      `;
    },
    down: async (sql) => {
      await sql`
        DO $undo$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
            EXECUTE 'DROP FUNCTION IF EXISTS public.account_id_for_email(text)';
          END IF;
        END $undo$
      `;
    },
  },

  // ── v33: cached image descriptions on the archive row ──────────────────────
  // Vision describes are operator spend billed per call — the extract job and
  // every reply to the same image message used to each pay for a pass. The
  // formatted context string caches on the message row; first writer wins.
  {
    version: 33,
    name: "v33_message_image_context",
    up: async (sql) => {
      await addColumn(sql, "messages", "image_context TEXT");
    },
    down: async (sql) => {
      await sql`ALTER TABLE messages DROP COLUMN IF EXISTS image_context`;
    },
  },
  // Marketplace: creators publish their awakened companion to a forum listing;
  // adopters get a cloned companions row (kind='adopted') owned by them, so
  // billing/memory/journal machinery is per-adopter with zero special cases.
  // The awakened bond stays unique via a partial index on kind='awakened'.
  {
    version: 34,
    name: "v34_companion_marketplace",
    up: async (sql) => {
      await addColumn(sql, "companions", "kind TEXT NOT NULL DEFAULT 'awakened'");
      await addColumn(sql, "companions", "adopted_from_listing_id BIGINT");
      await addColumn(sql, "companions", "listing_version INTEGER NOT NULL DEFAULT 0");
      // One awakened companion per account — adopted clones share the owner's
      // id freely, so the blanket UNIQUE narrows to awakened rows only.
      await sql`ALTER TABLE companions DROP CONSTRAINT IF EXISTS companions_owner_user_id_key`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS companions_one_awakened ON companions(owner_user_id) WHERE kind = 'awakened'`;
      await sql`CREATE INDEX IF NOT EXISTS companions_owner ON companions(owner_user_id)`;

      await sql`
        CREATE TABLE IF NOT EXISTS companion_listings (
          id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          creator_user_id     TEXT NOT NULL,
          source_companion_id BIGINT NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
          name                TEXT NOT NULL DEFAULT '',
          tagline             TEXT NOT NULL DEFAULT '',
          voice_persona       TEXT NOT NULL DEFAULT '',
          core_traits         TEXT[] NOT NULL DEFAULT '{}',
          owner_dynamic       TEXT NOT NULL DEFAULT '',
          backstory           TEXT NOT NULL DEFAULT '',
          greeting            TEXT NOT NULL DEFAULT '',
          avatar_url          TEXT,
          forum_thread_id     TEXT,
          version             INTEGER NOT NULL DEFAULT 1,
          status              TEXT NOT NULL DEFAULT 'active',
          report_count        INTEGER NOT NULL DEFAULT 0,
          add_count           INTEGER NOT NULL DEFAULT 0,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(source_companion_id)
        )
      `;
      await sql`ALTER TABLE companion_listings ENABLE ROW LEVEL SECURITY`;

      await sql`
        CREATE TABLE IF NOT EXISTS companion_persona_versions (
          id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          listing_id  BIGINT NOT NULL REFERENCES companion_listings(id) ON DELETE CASCADE,
          version     INTEGER NOT NULL,
          persona_json JSONB NOT NULL,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(listing_id, version)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS persona_versions_listing ON companion_persona_versions(listing_id)`;
      await sql`ALTER TABLE companion_persona_versions ENABLE ROW LEVEL SECURITY`;

      await sql`
        CREATE TABLE IF NOT EXISTS companion_adoptions (
          id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          user_id          TEXT NOT NULL,
          listing_id       BIGINT NOT NULL REFERENCES companion_listings(id) ON DELETE CASCADE,
          companion_id     BIGINT NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
          adopted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          dropped_at       TIMESTAMPTZ,
          cooldown_until   TIMESTAMPTZ,
          dm_introduced_at TIMESTAMPTZ,
          UNIQUE(user_id, listing_id)
        )
      `;
      await sql`ALTER TABLE companion_adoptions ENABLE ROW LEVEL SECURITY`;
      // One active adoption row per (user, listing); the per-user active-slot
      // count is enforced in code (plan-dependent) over this index.
      await sql`CREATE INDEX IF NOT EXISTS adoptions_active ON companion_adoptions(user_id) WHERE dropped_at IS NULL`;
      await sql`CREATE INDEX IF NOT EXISTS adoptions_listing ON companion_adoptions(listing_id)`;
      await sql`CREATE INDEX IF NOT EXISTS adoptions_companion ON companion_adoptions(companion_id)`;
      await sql`CREATE INDEX IF NOT EXISTS companions_adopted_from ON companions(adopted_from_listing_id) WHERE adopted_from_listing_id IS NOT NULL`;

      await sql`
        CREATE TABLE IF NOT EXISTS listing_reports (
          id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          listing_id       BIGINT NOT NULL REFERENCES companion_listings(id) ON DELETE CASCADE,
          reporter_user_id TEXT NOT NULL,
          reason           TEXT NOT NULL DEFAULT '',
          created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(listing_id, reporter_user_id)
        )
      `;
      await sql`ALTER TABLE listing_reports ENABLE ROW LEVEL SECURITY`;
      await sql`CREATE INDEX IF NOT EXISTS listing_reports_listing ON listing_reports(listing_id)`;

      await addColumn(sql, "user_bot_settings", "active_dm_companion_id BIGINT");
    },
    down: async (sql) => {
      await sql`ALTER TABLE user_bot_settings DROP COLUMN IF EXISTS active_dm_companion_id`;
      await sql`DROP INDEX IF EXISTS listing_reports_listing`;
      await sql`DROP TABLE IF EXISTS listing_reports`;
      await sql`DROP INDEX IF EXISTS adoptions_active`;
      await sql`DROP INDEX IF EXISTS adoptions_listing`;
      await sql`DROP INDEX IF EXISTS adoptions_companion`;
      await sql`DROP INDEX IF EXISTS companions_adopted_from`;
      await sql`DROP TABLE IF EXISTS companion_adoptions`;
      await sql`DROP INDEX IF EXISTS persona_versions_listing`;
      await sql`DROP TABLE IF EXISTS companion_persona_versions`;
      await sql`DROP TABLE IF EXISTS companion_listings`;
      await sql`DROP INDEX IF EXISTS companions_owner`;
      await sql`DROP INDEX IF EXISTS companions_one_awakened`;
      await sql`ALTER TABLE companions DROP COLUMN IF EXISTS listing_version`;
      await sql`ALTER TABLE companions DROP COLUMN IF EXISTS adopted_from_listing_id`;
      await sql`ALTER TABLE companions DROP COLUMN IF EXISTS kind`;
      // Restore the original blanket uniqueness — safe because rollback only
      // happens before any adopted rows exist in practice.
      await sql`ALTER TABLE companions ADD CONSTRAINT companions_owner_user_id_key UNIQUE (owner_user_id)`;
    },
  },

  // ── v35: freehand marketplace listings ────────────────────────────────────
  // Listings no longer have to project an awakened companion — creators can
  // author additional characters directly (free accounts get a couple of live
  // listings, premium uncapped). A NULL source_companion_id marks freehand
  // listings; the UNIQUE(source_companion_id) still dedupes awakened publishes
  // since NULLs are distinct in Postgres.
  {
    version: 35,
    name: "v35_listing_source_nullable",
    up: async (sql) => {
      await sql`ALTER TABLE companion_listings ALTER COLUMN source_companion_id DROP NOT NULL`;
    },
    down: async (sql) => {
      // Rollback removes the freehand feature: every listing without an
      // awakened source must go before NOT NULL can be restored. Adoptions,
      // reports, and persona versions cascade via listing_id; the adopted
      // clone companions rows have no FK on adopted_from_listing_id
      // (deliberate), so they are deleted explicitly first.
      await sql`
        UPDATE user_bot_settings SET active_dm_companion_id = NULL
        WHERE active_dm_companion_id IN (
          SELECT id FROM companions
          WHERE kind = 'adopted' AND adopted_from_listing_id IN (
            SELECT id FROM companion_listings WHERE source_companion_id IS NULL
          )
        )
      `;
      await sql`
        DELETE FROM companions
        WHERE kind = 'adopted' AND adopted_from_listing_id IN (
          SELECT id FROM companion_listings WHERE source_companion_id IS NULL
        )
      `;
      await sql`DELETE FROM companion_listings WHERE source_companion_id IS NULL`;
      await sql`ALTER TABLE companion_listings ALTER COLUMN source_companion_id SET NOT NULL`;
    },
  },
  // v36 — moderation surface. Reports gain a category, creator bans live in
  // marketplace_bans, and every mod action lands in moderation_events. Rate
  // limits derive from existing tables — the (creator, created_at) /
  // (reporter, created_at) / (user, adopted_at) indexes make them cheap.
  {
    version: 36,
    name: "v36_moderation_surface",
    up: async (sql) => {
      await sql`ALTER TABLE listing_reports ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'other'`;

      await sql`
        CREATE TABLE IF NOT EXISTS marketplace_bans (
          discord_user_id TEXT PRIMARY KEY,
          reason          TEXT NOT NULL DEFAULT '',
          banned_by       TEXT NOT NULL DEFAULT '',
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`ALTER TABLE marketplace_bans ENABLE ROW LEVEL SECURITY`;

      await sql`
        CREATE TABLE IF NOT EXISTS moderation_events (
          id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          listing_id    BIGINT REFERENCES companion_listings(id) ON DELETE SET NULL,
          actor_user_id TEXT NOT NULL,
          action        TEXT NOT NULL,
          note          TEXT NOT NULL DEFAULT '',
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS mod_events_listing ON moderation_events(listing_id)`;
      await sql`ALTER TABLE moderation_events ENABLE ROW LEVEL SECURITY`;

      // Per-day counts for publish/report/adopt rate limits.
      await sql`CREATE INDEX IF NOT EXISTS listing_reports_reporter ON listing_reports(reporter_user_id, created_at)`;
      await sql`CREATE INDEX IF NOT EXISTS listings_creator_created ON companion_listings(creator_user_id, created_at)`;
      await sql`CREATE INDEX IF NOT EXISTS adoptions_user_adopted ON companion_adoptions(user_id, adopted_at)`;
    },
    down: async (sql) => {
      // A creator-ban thaws on rollback: banned listings revert to flagged so
      // they re-enter the human-review queue rather than silently reactivating.
      await sql`UPDATE companion_listings SET status = 'flagged', updated_at = NOW() WHERE status = 'banned'`;
      await sql`DROP INDEX IF EXISTS adoptions_user_adopted`;
      await sql`DROP INDEX IF EXISTS listings_creator_created`;
      await sql`DROP INDEX IF EXISTS listing_reports_reporter`;
      await sql`DROP TABLE IF EXISTS moderation_events`;
      await sql`DROP TABLE IF EXISTS marketplace_bans`;
      await sql`ALTER TABLE listing_reports DROP COLUMN IF EXISTS category`;
    },
  },
  // v37 — listing thread comments become a first-class surface: star ratings
  // aggregate onto the card, and comments get their own report pipeline (a
  // comment report shouldn't count toward the listing's auto-flag threshold,
  // so it lives in its own table). Ratings dedupe per (listing, rater) — a
  // re-rate is an upsert; comment reports dedupe per (message, reporter).
  {
    version: 37,
    name: "v37_ratings_and_comment_reports",
    up: async (sql) => {
      await sql`
        CREATE TABLE IF NOT EXISTS listing_ratings (
          id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          listing_id    BIGINT NOT NULL REFERENCES companion_listings(id) ON DELETE CASCADE,
          rater_user_id TEXT NOT NULL,
          stars         SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(listing_id, rater_user_id)
        )
      `;
      await sql`ALTER TABLE listing_ratings ENABLE ROW LEVEL SECURITY`;
      await sql`CREATE INDEX IF NOT EXISTS listing_ratings_listing ON listing_ratings(listing_id)`;

      await sql`
        CREATE TABLE IF NOT EXISTS comment_reports (
          id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          listing_id       BIGINT REFERENCES companion_listings(id) ON DELETE SET NULL,
          thread_id        TEXT NOT NULL,
          message_id       TEXT NOT NULL,
          author_user_id   TEXT NOT NULL,
          reporter_user_id TEXT NOT NULL,
          category         TEXT NOT NULL DEFAULT 'other',
          created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(message_id, reporter_user_id)
        )
      `;
      await sql`ALTER TABLE comment_reports ENABLE ROW LEVEL SECURITY`;
      await sql`CREATE INDEX IF NOT EXISTS comment_reports_message ON comment_reports(message_id)`;
      await sql`CREATE INDEX IF NOT EXISTS comment_reports_reporter ON comment_reports(reporter_user_id, created_at)`;
    },
    down: async (sql) => {
      await sql`DROP INDEX IF EXISTS comment_reports_reporter`;
      await sql`DROP INDEX IF EXISTS comment_reports_message`;
      await sql`DROP TABLE IF EXISTS comment_reports`;
      await sql`DROP INDEX IF EXISTS listing_ratings_listing`;
      await sql`DROP TABLE IF EXISTS listing_ratings`;
    },
  },
  // ── v38: Discord display snapshot on code links ────────────────────────────
  // The OAuth lane renders name + avatar from auth.identities.identity_data;
  // a /link code claim only stamped discord_user_id, so the dashboard showed a
  // bare "#". The fix: the bot snapshots the Discord profile onto the code at
  // mint (it knows the user already — no extra API call), claim_link_code
  // copies it onto web_profiles, the identity trigger stamps the same columns
  // for OAuth links (keeping the two lanes identical in web_profiles), and
  // unlink_discord clears them. Existing code-linked rows backfill at boot —
  // index.ts walks linked rows missing discord_username and re-fetches them.
  {
    version: 38,
    name: "v38_discord_profile_snapshot",
    up: async (sql) => {
      // link_codes is created unconditionally in v27 (the bot needs it without
      // Supabase auth), so its columns are unconditional too.
      await sql`ALTER TABLE link_codes ADD COLUMN IF NOT EXISTS discord_username TEXT`;
      await sql`ALTER TABLE link_codes ADD COLUMN IF NOT EXISTS discord_avatar_url TEXT`;
      await sql`
        DO $mig$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
            EXECUTE 'ALTER TABLE public.web_profiles ADD COLUMN IF NOT EXISTS discord_username TEXT';
            EXECUTE 'ALTER TABLE public.web_profiles ADD COLUMN IF NOT EXISTS discord_avatar_url TEXT';

            -- OAuth lane: stamp the same display fields from identity_data so
            -- web_profiles alone describes either link kind. Delete clears all.
            EXECUTE $fn$
              CREATE OR REPLACE FUNCTION internal.sync_discord_identity()
              RETURNS trigger
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              BEGIN
                IF TG_OP = 'INSERT' AND new.provider = 'discord' THEN
                  IF EXISTS (
                    SELECT 1 FROM public.web_profiles
                    WHERE discord_user_id = new.provider_id AND id <> new.user_id
                  ) THEN
                    RAISE EXCEPTION 'discord_already_linked: this Discord account is already linked to a different Characterly account';
                  END IF;
                  UPDATE public.web_profiles
                  SET discord_user_id = new.provider_id,
                      discord_username = coalesce(
                        nullif(new.identity_data->>'full_name', ''),
                        nullif(new.identity_data->>'name', ''),
                        nullif(new.identity_data->'custom_claims'->>'global_name', '')
                      ),
                      discord_avatar_url = nullif(new.identity_data->>'avatar_url', ''),
                      updated_at = now()
                  WHERE id = new.user_id;
                  RETURN new;
                END IF;
                IF TG_OP = 'DELETE' AND old.provider = 'discord' THEN
                  -- Guard on the exact provider_id so a re-link to a different
                  -- Discord account isn't clobbered by the old row's delete.
                  UPDATE public.web_profiles
                  SET discord_user_id = NULL, discord_username = NULL,
                      discord_avatar_url = NULL, updated_at = now()
                  WHERE id = old.user_id AND discord_user_id = old.provider_id;
                  RETURN old;
                END IF;
                RETURN coalesce(new, old);
              END
              $body$
            $fn$;
            EXECUTE 'REVOKE ALL ON FUNCTION internal.sync_discord_identity() FROM PUBLIC';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION internal.sync_discord_identity() FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION internal.sync_discord_identity() FROM authenticated';
            END IF;

            -- Code lane: copy the profile snapshot the bot stored on the code.
            -- Body identical to v30's hardened claim — only the UPDATE gained
            -- the two snapshot columns.
            EXECUTE $rpc$
              CREATE OR REPLACE FUNCTION public.claim_link_code(p_code text)
              RETURNS void
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
                rec record;
                n integer;
                norm text := upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g'));
              BEGIN
                IF uid IS NULL THEN
                  RAISE EXCEPTION 'not authenticated';
                END IF;
                -- Codes are XXXX-XXXX but users drop the dash — normalize to
                -- the stored form before lookup.
                IF length(norm) <> 8 THEN
                  RAISE EXCEPTION 'invalid_code: that code does not exist — check it and try again';
                END IF;
                norm := substr(norm, 1, 4) || '-' || substr(norm, 5, 4);
                -- FOR UPDATE serializes concurrent claims of the same code —
                -- the second claimant sees the first's claimed_by, not a
                -- duplicate-key error.
                SELECT * INTO rec FROM public.link_codes
                WHERE code = norm
                FOR UPDATE;
                IF NOT FOUND THEN
                  RAISE EXCEPTION 'invalid_code: that code does not exist — check it and try again';
                END IF;
                IF rec.claimed_by IS NOT NULL THEN
                  RAISE EXCEPTION 'code_used: that code was already claimed — run /link again for a fresh one';
                END IF;
                IF rec.expires_at < now() THEN
                  RAISE EXCEPTION 'code_expired: that code expired — run /link again for a fresh one';
                END IF;
                IF EXISTS (
                  SELECT 1 FROM public.web_profiles
                  WHERE discord_user_id = rec.discord_user_id AND id <> uid
                ) THEN
                  RAISE EXCEPTION 'discord_already_linked: this Discord account is already linked to a different Characterly account';
                END IF;
                UPDATE public.web_profiles
                SET discord_user_id = rec.discord_user_id,
                    discord_username = rec.discord_username,
                    discord_avatar_url = rec.discord_avatar_url,
                    updated_at = now()
                WHERE id = uid;
                GET DIAGNOSTICS n = ROW_COUNT;
                IF n = 0 THEN
                  RAISE EXCEPTION 'no_profile: account row missing — contact support';
                END IF;
                UPDATE public.link_codes SET claimed_by = uid WHERE code = rec.code;
              END
              $body$
            $rpc$;
            EXECUTE 'REVOKE ALL ON FUNCTION public.claim_link_code(text) FROM PUBLIC';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION public.claim_link_code(text) FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.claim_link_code(text) TO authenticated';
            END IF;

            -- Unlink must clear the snapshot too, or a code-linked profile
            -- would keep wearing the Discord name/avatar after disconnecting.
            EXECUTE $rpc$
              CREATE OR REPLACE FUNCTION public.unlink_discord()
              RETURNS void
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
              BEGIN
                IF uid IS NULL THEN
                  RAISE EXCEPTION 'not authenticated';
                END IF;
                UPDATE public.web_profiles
                SET discord_user_id = NULL, discord_username = NULL,
                    discord_avatar_url = NULL, updated_at = now()
                WHERE id = uid;
                IF NOT FOUND THEN
                  RAISE EXCEPTION 'no_profile: account row missing';
                END IF;
              END
              $body$
            $rpc$;
            EXECUTE 'REVOKE ALL ON FUNCTION public.unlink_discord() FROM PUBLIC';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION public.unlink_discord() FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.unlink_discord() TO authenticated';
            END IF;

            -- Backfill OAuth-linked profiles missing the new fields (the
            -- trigger predates the columns). Code-linked rows without a
            -- snapshot stay NULL — the bot heals those at boot.
            EXECUTE $bf$
              UPDATE public.web_profiles wp
              SET discord_username = coalesce(
                    nullif(i.identity_data->>'full_name', ''),
                    nullif(i.identity_data->>'name', ''),
                    nullif(i.identity_data->'custom_claims'->>'global_name', '')),
                  discord_avatar_url = nullif(i.identity_data->>'avatar_url', ''),
                  updated_at = now()
              FROM auth.identities i
              WHERE i.user_id = wp.id AND i.provider = 'discord'
                AND wp.discord_user_id = i.provider_id AND wp.discord_username IS NULL
            $bf$;
          END IF;
        END $mig$
      `;
    },
    down: async (sql) => {
      await sql`
        DO $undo$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
            -- Restore the pre-v38 function bodies verbatim.
            EXECUTE $fn$
              CREATE OR REPLACE FUNCTION internal.sync_discord_identity()
              RETURNS trigger
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              BEGIN
                IF TG_OP = 'INSERT' AND new.provider = 'discord' THEN
                  IF EXISTS (
                    SELECT 1 FROM public.web_profiles
                    WHERE discord_user_id = new.provider_id AND id <> new.user_id
                  ) THEN
                    RAISE EXCEPTION 'discord_already_linked: this Discord account is already linked to a different Characterly account';
                  END IF;
                  UPDATE public.web_profiles
                  SET discord_user_id = new.provider_id, updated_at = now()
                  WHERE id = new.user_id;
                  RETURN new;
                END IF;
                IF TG_OP = 'DELETE' AND old.provider = 'discord' THEN
                  UPDATE public.web_profiles
                  SET discord_user_id = NULL, updated_at = now()
                  WHERE id = old.user_id AND discord_user_id = old.provider_id;
                  RETURN old;
                END IF;
                RETURN coalesce(new, old);
              END
              $body$
            $fn$;
            EXECUTE 'REVOKE ALL ON FUNCTION internal.sync_discord_identity() FROM PUBLIC';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION internal.sync_discord_identity() FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION internal.sync_discord_identity() FROM authenticated';
            END IF;

            EXECUTE $rpc$
              CREATE OR REPLACE FUNCTION public.claim_link_code(p_code text)
              RETURNS void
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
                rec record;
                n integer;
                norm text := upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g'));
              BEGIN
                IF uid IS NULL THEN
                  RAISE EXCEPTION 'not authenticated';
                END IF;
                IF length(norm) <> 8 THEN
                  RAISE EXCEPTION 'invalid_code: that code does not exist — check it and try again';
                END IF;
                norm := substr(norm, 1, 4) || '-' || substr(norm, 5, 4);
                SELECT * INTO rec FROM public.link_codes
                WHERE code = norm
                FOR UPDATE;
                IF NOT FOUND THEN
                  RAISE EXCEPTION 'invalid_code: that code does not exist — check it and try again';
                END IF;
                IF rec.claimed_by IS NOT NULL THEN
                  RAISE EXCEPTION 'code_used: that code was already claimed — run /link again for a fresh one';
                END IF;
                IF rec.expires_at < now() THEN
                  RAISE EXCEPTION 'code_expired: that code expired — run /link again for a fresh one';
                END IF;
                IF EXISTS (
                  SELECT 1 FROM public.web_profiles
                  WHERE discord_user_id = rec.discord_user_id AND id <> uid
                ) THEN
                  RAISE EXCEPTION 'discord_already_linked: this Discord account is already linked to a different Characterly account';
                END IF;
                UPDATE public.web_profiles
                SET discord_user_id = rec.discord_user_id, updated_at = now()
                WHERE id = uid;
                GET DIAGNOSTICS n = ROW_COUNT;
                IF n = 0 THEN
                  RAISE EXCEPTION 'no_profile: account row missing — contact support';
                END IF;
                UPDATE public.link_codes SET claimed_by = uid WHERE code = rec.code;
              END
              $body$
            $rpc$;

            EXECUTE $rpc$
              CREATE OR REPLACE FUNCTION public.unlink_discord()
              RETURNS void
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
              BEGIN
                IF uid IS NULL THEN
                  RAISE EXCEPTION 'not authenticated';
                END IF;
                UPDATE public.web_profiles
                SET discord_user_id = NULL, updated_at = now()
                WHERE id = uid;
                IF NOT FOUND THEN
                  RAISE EXCEPTION 'no_profile: account row missing';
                END IF;
              END
              $body$
            $rpc$;

            EXECUTE 'ALTER TABLE public.web_profiles DROP COLUMN IF EXISTS discord_username';
            EXECUTE 'ALTER TABLE public.web_profiles DROP COLUMN IF EXISTS discord_avatar_url';
          END IF;
        END $undo$
      `;
      await sql`ALTER TABLE link_codes DROP COLUMN IF EXISTS discord_username`;
      await sql`ALTER TABLE link_codes DROP COLUMN IF EXISTS discord_avatar_url`;
    },
  },

  // ── v39: Terms/Privacy acceptance events ───────────────────────────────────
  // Clickwrap audit trail for the house verify gate (and later the website
  // signup checkbox). Each acceptance is an append-only row — the max version
  // per (user, document) is the current state, older rows stay as evidence.
  // Plain-Postgres safe: no FK to web_profiles (that table only exists under
  // Supabase auth), account_id is stored loosely.
  {
    version: 39,
    name: "v39_consent_events",
    up: async (sql) => {
      await sql`
        CREATE TABLE IF NOT EXISTS consent_events (
          id              BIGSERIAL PRIMARY KEY,
          discord_user_id TEXT NOT NULL,
          account_id      TEXT,
          document        TEXT NOT NULL DEFAULT 'terms',
          version         INTEGER NOT NULL,
          source          TEXT NOT NULL,
          accepted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS consent_events_user_doc
          ON consent_events (discord_user_id, document, version DESC)
      `;
    },
    down: async (sql) => {
      await sql`DROP TABLE IF EXISTS consent_events`;
    },
  },

  // ── v40: semantic recall embeddings ──────────────────────────────────────
  // Un-dimensioned `vector` columns — keeps model flexibility (a declared dim
  // is required for ANN indexes, which guild-scoped scans don't need at this
  // scale). Code enforces dims (EMBED_DIMS) at write time.
  {
    version: 40,
    name: "v40_semantic_embeddings",
    up: async (sql) => {
      await sql`CREATE EXTENSION IF NOT EXISTS vector`;
      await sql`ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding vector`;
      await sql`ALTER TABLE companion_journal ADD COLUMN IF NOT EXISTS embedding vector`;
    },
    down: async (sql) => {
      await sql`ALTER TABLE memories DROP COLUMN IF EXISTS embedding`;
      await sql`ALTER TABLE companion_journal DROP COLUMN IF EXISTS embedding`;
      // The vector extension stays — shared infra other features may rely on.
    },
  },

  // ── v41: web-side consent capture ─────────────────────────────────────────
  // discord_user_id goes nullable so rows can key on account_id alone (a web
  // signup predates Discord linking). RLS locks the table off PostgREST — it
  // was world-readable/writable to the publishable key — while the RPCs give
  // the site a security-definer path keyed on auth.uid(). Bot access via the
  // postgres role is unaffected.
  {
    version: 41,
    name: "v41_web_consent",
    up: async (sql) => {
      await sql`ALTER TABLE consent_events ALTER COLUMN discord_user_id DROP NOT NULL`;
      await sql`CREATE INDEX IF NOT EXISTS consent_events_account_doc ON consent_events (account_id, document, version DESC)`;
      await sql`ALTER TABLE consent_events ENABLE ROW LEVEL SECURITY`;
      // Auth-dependent: Supabase-hosted only — wrapped so self-host Postgres
      // (no auth schema) still migrates cleanly.
      await sql`
        DO $web$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
            EXECUTE $dfn$
              CREATE OR REPLACE FUNCTION public.my_consent(p_document text)
              RETURNS integer
              LANGUAGE sql
              STABLE
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
                SELECT COALESCE(MAX(version), 0)
                FROM public.consent_events
                WHERE account_id = auth.uid()::text AND document = p_document
              $body$
            $dfn$;
            EXECUTE $dfn$
              CREATE OR REPLACE FUNCTION public.record_consent(p_document text, p_version integer)
              RETURNS void
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE uid uuid := auth.uid();
              BEGIN
                IF uid IS NULL THEN
                  RAISE EXCEPTION 'not authenticated';
                END IF;
                IF p_document <> 'terms' THEN
                  RAISE EXCEPTION 'unsupported consent document';
                END IF;
                -- Version is what the client *says* it showed — bound it so a
                -- forged high version can't evade future re-prompts. Raise the
                -- ceiling in the same migration that bumps TERMS_VERSION.
                IF p_version IS NULL OR p_version < 1 OR p_version > 10 THEN
                  RAISE EXCEPTION 'unsupported consent version';
                END IF;
                INSERT INTO public.consent_events (discord_user_id, account_id, document, version, source)
                VALUES (NULL, uid::text, p_document, p_version, 'web_signup');
              END
              $body$
            $dfn$;
            EXECUTE 'REVOKE ALL ON FUNCTION public.my_consent(text) FROM PUBLIC';
            EXECUTE 'REVOKE ALL ON FUNCTION public.record_consent(text, integer) FROM PUBLIC';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION public.my_consent(text) FROM anon';
              EXECUTE 'REVOKE ALL ON FUNCTION public.record_consent(text, integer) FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.my_consent(text) TO authenticated';
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.record_consent(text, integer) TO authenticated';
            END IF;
          END IF;
        END $web$
      `;
    },
    down: async (sql) => {
      await sql`DROP FUNCTION IF EXISTS public.my_consent(text)`;
      await sql`DROP FUNCTION IF EXISTS public.record_consent(text, integer)`;
      await sql`ALTER TABLE consent_events DISABLE ROW LEVEL SECURITY`;
      await sql`DROP INDEX IF EXISTS consent_events_account_doc`;
      // NOT NULL restore would fail if web rows (NULL uid) exist — that's the
      // intended guard: rolling back past web signups is a data decision.
      await sql`ALTER TABLE consent_events ALTER COLUMN discord_user_id SET NOT NULL`;
    },
  },

  // ── v42: character-card import ────────────────────────────────────────────
  // Imported personas are adopted companions behind a private 'unlisted'
  // listing row — provenance (persona_source + import_meta) is stamped on
  // both so a later marketplace publish carries the card's claimed creator
  // and content hash into moderation. The web surface writes through the
  // import_companion_card RPC (a plpgsql port of adoptListing's insert
  // sequence — keep the two in lockstep); the Discord path uses the same
  // tables via the TS store. card-avatars is a public Storage bucket for
  // card PNGs as avatar URLs — only reachable on Supabase.
  {
    version: 42,
    name: "v42_character_import",
    up: async (sql) => {
      await addColumn(sql, "companions", "persona_source TEXT NOT NULL DEFAULT 'authored'");
      await addColumn(sql, "companions", "import_meta JSONB");
      await addColumn(sql, "companion_listings", "persona_source TEXT NOT NULL DEFAULT 'authored'");
      await addColumn(sql, "companion_listings", "import_meta JSONB");

      await sql`
        DO $web$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth')
             AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'web_profiles') THEN
            EXECUTE $dfn$
              CREATE OR REPLACE FUNCTION public.import_companion_card(p_payload jsonb)
              RETURNS json
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
                did text;
                v_plan text;
                v_max_slots int;
                v_count int;
                v_listing bigint;
                v_companion bigint;
                v_name text;
                v_tagline text;
                v_voice text;
                v_traits text[];
                v_dynamic text;
                v_backstory text;
                v_greeting text;
                v_avatar text;
                v_meta jsonb;
                v_row record;
              BEGIN
                IF uid IS NULL THEN
                  RAISE EXCEPTION 'not authenticated';
                END IF;
                SELECT discord_user_id, plan INTO did, v_plan
                  FROM public.web_profiles WHERE id = uid;
                IF did IS NULL THEN
                  RAISE EXCEPTION 'discord not linked';
                END IF;

                -- Pull + bound the mapped persona fields. The client supplies
                -- already-normalized fields; the server re-caps everything.
                v_name := left(btrim(coalesce(p_payload->>'name', '')), 64);
                IF v_name = '' THEN
                  RAISE EXCEPTION 'name required';
                END IF;
                v_tagline := left(coalesce(p_payload->>'tagline', ''), 200);
                v_voice := left(coalesce(p_payload->>'voice_persona', ''), 2000);
                v_dynamic := left(coalesce(p_payload->>'owner_dynamic', ''), 300);
                v_backstory := left(coalesce(p_payload->>'backstory', ''), 4000);
                v_greeting := left(coalesce(p_payload->>'greeting', ''), 2000);
                v_avatar := left(coalesce(p_payload->>'avatar_url', ''), 500);
                IF v_avatar <> '' AND v_avatar NOT LIKE 'https://%' AND v_avatar NOT LIKE 'http://%' THEN
                  v_avatar := '';
                END IF;
                SELECT coalesce(array_agg(left(t, 48)), '{}'::text[]) INTO v_traits
                  FROM (SELECT jsonb_array_elements_text(
                                 coalesce(p_payload->'core_traits', '[]'::jsonb)) AS t
                        LIMIT 8) s;
                -- The stamp is server-controlled: only the card's claimed
                -- metadata fields come from the payload, all bounded.
                v_meta := jsonb_build_object(
                  'source', 'character_card',
                  'spec', left(coalesce(p_payload->'import_meta'->>'spec', ''), 40),
                  'specVersion', left(coalesce(p_payload->'import_meta'->>'specVersion', ''), 20),
                  'creator', left(coalesce(p_payload->'import_meta'->>'creator', ''), 120),
                  'characterVersion', left(coalesce(p_payload->'import_meta'->>'characterVersion', ''), 40),
                  'filename', left(coalesce(p_payload->'import_meta'->>'filename', ''), 200),
                  'sha256', left(coalesce(p_payload->'import_meta'->>'sha256', ''), 80),
                  'importedVia', 'web',
                  'importedAt', now()
                );

                PERFORM pg_advisory_xact_lock(hashtext('adopt:' || did));

                -- Idempotent: the same file imported twice reuses its unlisted
                -- listing — an active adoption returns as-is, a dropped one
                -- revives, a listing without an adoption just gets its clone.
                SELECT l.id INTO v_listing FROM public.companion_listings l
                  WHERE l.creator_user_id = did AND l.status = 'unlisted'
                    AND l.import_meta->>'sha256' =
                        coalesce(p_payload->'import_meta'->>'sha256', '~~~')
                  LIMIT 1;
                IF v_listing IS NOT NULL THEN
                  SELECT a.companion_id INTO v_companion FROM public.companion_adoptions a
                    WHERE a.user_id = did AND a.listing_id = v_listing;
                  IF v_companion IS NULL THEN
                    SELECT l.* INTO v_row FROM public.companion_listings l WHERE l.id = v_listing;
                    INSERT INTO public.companions (
                      owner_user_id, name, avatar_url, voice_persona, core_traits,
                      owner_dynamic, backstory, onboarding_state, onboarding_turns,
                      kind, adopted_from_listing_id, listing_version, persona_source,
                      import_meta, created_at, updated_at
                    ) VALUES (
                      did, v_row.name, v_row.avatar_url, v_row.voice_persona,
                      v_row.core_traits, v_row.owner_dynamic, v_row.backstory,
                      'active', 0, 'adopted', v_listing, v_row.version,
                      'card_import', v_row.import_meta, now(), now()
                    )
                    RETURNING id INTO v_companion;
                    INSERT INTO public.companion_adoptions (user_id, listing_id, companion_id, adopted_at)
                    VALUES (did, v_listing, v_companion, now());
                    RETURN json_build_object(
                      'companion_id', v_companion, 'listing_id', v_listing,
                      'name', v_row.name, 'reused', true);
                  END IF;
                  UPDATE public.companion_adoptions
                    SET dropped_at = NULL, cooldown_until = NULL, adopted_at = now()
                    WHERE user_id = did AND listing_id = v_listing AND dropped_at IS NOT NULL;
                  SELECT c.name INTO v_name FROM public.companions c WHERE c.id = v_companion;
                  RETURN json_build_object(
                    'companion_id', v_companion, 'listing_id', v_listing,
                    'name', v_name, 'reused', true);
                END IF;

                -- Private-import ceiling — keep in sync with CHARACTER_IMPORT_CAP.
                SELECT COUNT(*) INTO v_count FROM public.companion_listings
                 WHERE creator_user_id = did AND status = 'unlisted';
                IF v_count >= 25 THEN
                  RAISE EXCEPTION 'import cap reached';
                END IF;

                -- Adoption slots — mirrors adoptListing's count (free 1,
                -- premium effectively uncapped). Keep in sync with
                -- FREE_ADOPTION_SLOTS.
                v_max_slots := CASE WHEN v_plan = 'premium' THEN 100 ELSE 1 END;
                SELECT COUNT(*) INTO v_count FROM public.companion_adoptions a
                  LEFT JOIN public.companion_listings l ON l.id = a.listing_id
                  WHERE a.user_id = did AND a.dropped_at IS NULL
                    AND (l.id IS NULL OR l.status <> 'banned');
                IF v_count >= v_max_slots THEN
                  RAISE EXCEPTION 'adoption slot full';
                END IF;

                INSERT INTO public.companion_listings (
                  creator_user_id, source_companion_id, name, tagline, voice_persona,
                  core_traits, owner_dynamic, backstory, greeting, avatar_url,
                  version, status, persona_source, import_meta, created_at, updated_at
                ) VALUES (
                  did, NULL, v_name, v_tagline, v_voice, v_traits, v_dynamic,
                  v_backstory, v_greeting, nullif(v_avatar, ''),
                  1, 'unlisted', 'card_import', v_meta, now(), now()
                )
                RETURNING id INTO v_listing;

                INSERT INTO public.companion_persona_versions (listing_id, version, persona_json)
                VALUES (v_listing, 1, jsonb_build_object(
                  'name', v_name, 'tagline', v_tagline, 'voicePersona', v_voice,
                  'coreTraits', v_traits, 'ownerDynamic', v_dynamic,
                  'backstory', v_backstory, 'greeting', v_greeting,
                  'avatarUrl', nullif(v_avatar, '')))
                ON CONFLICT (listing_id, version) DO NOTHING;

                INSERT INTO public.companions (
                  owner_user_id, name, avatar_url, voice_persona, core_traits,
                  owner_dynamic, backstory, onboarding_state, onboarding_turns,
                  kind, adopted_from_listing_id, listing_version, persona_source,
                  import_meta, created_at, updated_at
                ) VALUES (
                  did, v_name, nullif(v_avatar, ''), v_voice, v_traits, v_dynamic,
                  v_backstory, 'active', 0, 'adopted', v_listing, 1,
                  'card_import', v_meta, now(), now()
                )
                RETURNING id INTO v_companion;

                INSERT INTO public.companion_adoptions (user_id, listing_id, companion_id, adopted_at)
                VALUES (did, v_listing, v_companion, now());

                -- First import claims the DM slot; later imports leave the
                -- user's existing pick alone.
                INSERT INTO public.user_bot_settings (discord_user_id, active_dm_companion_id)
                VALUES (did, v_companion)
                ON CONFLICT (discord_user_id) DO UPDATE
                  SET active_dm_companion_id = EXCLUDED.active_dm_companion_id
                  WHERE public.user_bot_settings.active_dm_companion_id IS NULL;

                RETURN json_build_object(
                  'companion_id', v_companion, 'listing_id', v_listing, 'name', v_name);
              END
              $body$
            $dfn$;
            EXECUTE 'REVOKE ALL ON FUNCTION public.import_companion_card(jsonb) FROM PUBLIC';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION public.import_companion_card(jsonb) FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.import_companion_card(jsonb) TO authenticated';
            END IF;
          END IF;
        END $web$
      `;

      // card-avatars bucket — public reads (avatar URLs must render in
      // Discord embeds), authenticated writes namespaced to the uploader's
      // own uid folder. Only exists on Supabase (storage schema).
      await sql`
        DO $sto$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'storage')
             AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'storage' AND tablename = 'buckets') THEN
            EXECUTE $ins$
              INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
              VALUES ('card-avatars', 'card-avatars', true, 8388608,
                      ARRAY['image/png','image/jpeg','image/webp'])
              ON CONFLICT (id) DO NOTHING
            $ins$;
            IF NOT EXISTS (SELECT 1 FROM pg_policies
                           WHERE schemaname = 'storage' AND tablename = 'objects'
                             AND policyname = 'card_avatars_insert') THEN
              EXECUTE $pol$
                CREATE POLICY card_avatars_insert ON storage.objects
                FOR INSERT TO authenticated
                WITH CHECK (bucket_id = 'card-avatars'
                            AND (storage.foldername(name))[1] = auth.uid()::text)
              $pol$;
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policies
                           WHERE schemaname = 'storage' AND tablename = 'objects'
                             AND policyname = 'card_avatars_update') THEN
              EXECUTE $pol$
                CREATE POLICY card_avatars_update ON storage.objects
                FOR UPDATE TO authenticated
                USING (bucket_id = 'card-avatars'
                       AND (storage.foldername(name))[1] = auth.uid()::text)
              $pol$;
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policies
                           WHERE schemaname = 'storage' AND tablename = 'objects'
                             AND policyname = 'card_avatars_delete') THEN
              EXECUTE $pol$
                CREATE POLICY card_avatars_delete ON storage.objects
                FOR DELETE TO authenticated
                USING (bucket_id = 'card-avatars'
                       AND (storage.foldername(name))[1] = auth.uid()::text)
              $pol$;
            END IF;
          END IF;
        END $sto$
      `;
    },
    down: async (sql) => {
      await sql`DROP FUNCTION IF EXISTS public.import_companion_card(jsonb)`;
      await sql`
        DO $sto$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'storage') THEN
            EXECUTE 'DROP POLICY IF EXISTS card_avatars_insert ON storage.objects';
            EXECUTE 'DROP POLICY IF EXISTS card_avatars_update ON storage.objects';
            EXECUTE 'DROP POLICY IF EXISTS card_avatars_delete ON storage.objects';
            BEGIN
              EXECUTE 'DELETE FROM storage.buckets WHERE id = ''card-avatars''';
            EXCEPTION WHEN foreign_key_violation THEN
              NULL; -- objects still live in the bucket — keep it.
            END;
          END IF;
        END $sto$
      `;
      // Refuse to silently strip provenance off live imports — same
      // data-decision guard as v41's web-consent rollback.
      await sql`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM companions WHERE import_meta IS NOT NULL)
             OR EXISTS (SELECT 1 FROM companion_listings WHERE import_meta IS NOT NULL) THEN
            RAISE EXCEPTION 'v42 rollback refused: imported personas exist';
          END IF;
        END $$
      `;
      await sql`ALTER TABLE companion_listings DROP COLUMN IF EXISTS import_meta`;
      await sql`ALTER TABLE companion_listings DROP COLUMN IF EXISTS persona_source`;
      await sql`ALTER TABLE companions DROP COLUMN IF EXISTS import_meta`;
      await sql`ALTER TABLE companions DROP COLUMN IF EXISTS persona_source`;
    },
  },
  {
    version: 43,
    name: "v43_import_hardening",
    up: async (sql) => {
      // First-live stamp for the daily publish cap — unlisted imports must not
      // consume publish quota just by existing, so created_at can't stand in.
      await addColumn(sql, "companion_listings", "published_at TIMESTAMPTZ");
      // Rows already live get their creation stamp — the honest approximation
      // of first-publish. Unlisted imports stay NULL until they go live.
      await sql`
        UPDATE companion_listings
           SET published_at = created_at
         WHERE status <> 'unlisted' AND published_at IS NULL
      `;

      // Hardened import RPC — the reuse branch ran before the quota checks in
      // v42, so a drop→reimport cycle bypassed slots, cooldown, and the daily
      // adopt cap. Mirrors adoptListing: active no-op returns free, everything
      // else pays cooldown + slot + daily checks first. Also carries the card
      // tag list into provenance and refuses non-array core_traits cleanly.
      await sql`
        DO $web$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth')
             AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'web_profiles') THEN
            EXECUTE $dfn$
              CREATE OR REPLACE FUNCTION public.import_companion_card(p_payload jsonb)
              RETURNS json
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
                did text;
                v_plan text;
                v_max_slots int;
                v_count int;
                v_listing bigint;
                v_companion bigint;
                v_name text;
                v_tagline text;
                v_voice text;
                v_traits text[] := '{}'::text[];
                v_dynamic text;
                v_backstory text;
                v_greeting text;
                v_avatar text;
                v_meta jsonb;
                v_tags jsonb := '[]'::jsonb;
                v_row record;
                v_adoption record;
              BEGIN
                IF uid IS NULL THEN
                  RAISE EXCEPTION 'not authenticated';
                END IF;
                SELECT discord_user_id, plan INTO did, v_plan
                  FROM public.web_profiles WHERE id = uid;
                IF did IS NULL THEN
                  RAISE EXCEPTION 'discord not linked';
                END IF;

                -- Pull + bound the mapped persona fields. The client supplies
                -- already-normalized fields; the server re-caps everything.
                v_name := left(btrim(coalesce(p_payload->>'name', '')), 64);
                IF v_name = '' THEN
                  RAISE EXCEPTION 'name required';
                END IF;
                v_tagline := left(coalesce(p_payload->>'tagline', ''), 200);
                v_voice := left(coalesce(p_payload->>'voice_persona', ''), 2000);
                v_dynamic := left(coalesce(p_payload->>'owner_dynamic', ''), 300);
                v_backstory := left(coalesce(p_payload->>'backstory', ''), 4000);
                v_greeting := left(coalesce(p_payload->>'greeting', ''), 2000);
                v_avatar := left(coalesce(p_payload->>'avatar_url', ''), 500);
                IF v_avatar <> '' AND v_avatar NOT LIKE 'https://%' AND v_avatar NOT LIKE 'http://%' THEN
                  v_avatar := '';
                END IF;
                IF jsonb_typeof(p_payload->'core_traits') = 'array' THEN
                  SELECT coalesce(array_agg(left(t, 48)), '{}'::text[]) INTO v_traits
                    FROM (SELECT jsonb_array_elements_text(p_payload->'core_traits') AS t
                          LIMIT 8) s;
                END IF;
                IF jsonb_typeof(p_payload->'import_meta'->'tags') = 'array' THEN
                  SELECT coalesce(jsonb_agg(left(el, 48)), '[]'::jsonb) INTO v_tags
                    FROM (SELECT jsonb_array_elements_text(p_payload->'import_meta'->'tags') AS el
                          LIMIT 10) s;
                END IF;
                -- The stamp is server-controlled: only the card's claimed
                -- metadata fields come from the payload, all bounded.
                v_meta := jsonb_build_object(
                  'source', 'character_card',
                  'spec', left(coalesce(p_payload->'import_meta'->>'spec', ''), 40),
                  'specVersion', left(coalesce(p_payload->'import_meta'->>'specVersion', ''), 20),
                  'creator', left(coalesce(p_payload->'import_meta'->>'creator', ''), 120),
                  'characterVersion', left(coalesce(p_payload->'import_meta'->>'characterVersion', ''), 40),
                  'filename', left(coalesce(p_payload->'import_meta'->>'filename', ''), 200),
                  'sha256', left(coalesce(p_payload->'import_meta'->>'sha256', ''), 80),
                  'tags', v_tags,
                  'importedVia', 'web',
                  'importedAt', now()
                );

                PERFORM pg_advisory_xact_lock(hashtext('adopt:' || did));
                -- Adoption slots — mirrors adoptListing's count (free 1,
                -- premium effectively uncapped). Keep in sync with
                -- FREE_ADOPTION_SLOTS.
                v_max_slots := CASE WHEN v_plan = 'premium' THEN 100 ELSE 1 END;

                -- Idempotent: the same file imported twice reuses its unlisted
                -- listing — an active adoption returns as-is, a dropped one
                -- revives, a listing without an adoption just gets its clone.
                SELECT l.id INTO v_listing FROM public.companion_listings l
                  WHERE l.creator_user_id = did AND l.status = 'unlisted'
                    AND l.import_meta->>'sha256' =
                        coalesce(p_payload->'import_meta'->>'sha256', '~~~')
                  LIMIT 1;
                IF v_listing IS NOT NULL THEN
                  SELECT a.companion_id, a.dropped_at, a.cooldown_until INTO v_adoption
                    FROM public.companion_adoptions a
                    WHERE a.user_id = did AND a.listing_id = v_listing;
                  -- Pure no-op: already on the roster — no quota consumed.
                  IF v_adoption.companion_id IS NOT NULL AND v_adoption.dropped_at IS NULL THEN
                    SELECT c.name INTO v_name FROM public.companions c
                      WHERE c.id = v_adoption.companion_id;
                    RETURN json_build_object(
                      'companion_id', v_adoption.companion_id, 'listing_id', v_listing,
                      'name', v_name, 'reused', true, 'revived', false);
                  END IF;
                  -- Revive and orphan-adopt both land an active adoption —
                  -- same gates as adoptListing, under the same advisory lock.
                  IF v_adoption.cooldown_until IS NOT NULL AND v_adoption.cooldown_until > now() THEN
                    RAISE EXCEPTION 're-adoption cooldown';
                  END IF;
                  SELECT COUNT(*) INTO v_count FROM public.companion_adoptions a
                    LEFT JOIN public.companion_listings l ON l.id = a.listing_id
                    WHERE a.user_id = did AND a.dropped_at IS NULL
                      AND (l.id IS NULL OR l.status <> 'banned');
                  IF v_count >= v_max_slots THEN
                    RAISE EXCEPTION 'adoption slot full';
                  END IF;
                  -- Anti-farming daily cap — keep in sync with
                  -- MARKET_ADOPT_DAILY_CAP.
                  SELECT COUNT(*) INTO v_count FROM public.companion_adoptions
                    WHERE user_id = did AND adopted_at > now() - interval '1 day';
                  IF v_count >= 20 THEN
                    RAISE EXCEPTION 'daily adoption cap';
                  END IF;
                  IF v_adoption.companion_id IS NULL THEN
                    SELECT l.* INTO v_row FROM public.companion_listings l WHERE l.id = v_listing;
                    INSERT INTO public.companions (
                      owner_user_id, name, avatar_url, voice_persona, core_traits,
                      owner_dynamic, backstory, onboarding_state, onboarding_turns,
                      kind, adopted_from_listing_id, listing_version, persona_source,
                      import_meta, created_at, updated_at
                    ) VALUES (
                      did, v_row.name, v_row.avatar_url, v_row.voice_persona,
                      v_row.core_traits, v_row.owner_dynamic, v_row.backstory,
                      'active', 0, 'adopted', v_listing, v_row.version,
                      'card_import', v_row.import_meta, now(), now()
                    )
                    RETURNING id INTO v_companion;
                    INSERT INTO public.companion_adoptions (user_id, listing_id, companion_id, adopted_at)
                    VALUES (did, v_listing, v_companion, now());
                    RETURN json_build_object(
                      'companion_id', v_companion, 'listing_id', v_listing,
                      'name', v_row.name, 'reused', true, 'revived', true);
                  END IF;
                  UPDATE public.companion_adoptions
                    SET dropped_at = NULL, cooldown_until = NULL, adopted_at = now()
                    WHERE user_id = did AND listing_id = v_listing AND dropped_at IS NOT NULL;
                  SELECT c.name INTO v_name FROM public.companions c WHERE c.id = v_adoption.companion_id;
                  RETURN json_build_object(
                    'companion_id', v_adoption.companion_id, 'listing_id', v_listing,
                    'name', v_name, 'reused', true, 'revived', true);
                END IF;

                -- Private-import ceiling — keep in sync with CHARACTER_IMPORT_CAP.
                SELECT COUNT(*) INTO v_count FROM public.companion_listings
                 WHERE creator_user_id = did AND status = 'unlisted';
                IF v_count >= 25 THEN
                  RAISE EXCEPTION 'import cap reached';
                END IF;
                SELECT COUNT(*) INTO v_count FROM public.companion_adoptions a
                  LEFT JOIN public.companion_listings l ON l.id = a.listing_id
                  WHERE a.user_id = did AND a.dropped_at IS NULL
                    AND (l.id IS NULL OR l.status <> 'banned');
                IF v_count >= v_max_slots THEN
                  RAISE EXCEPTION 'adoption slot full';
                END IF;
                SELECT COUNT(*) INTO v_count FROM public.companion_adoptions
                  WHERE user_id = did AND adopted_at > now() - interval '1 day';
                IF v_count >= 20 THEN
                  RAISE EXCEPTION 'daily adoption cap';
                END IF;

                INSERT INTO public.companion_listings (
                  creator_user_id, source_companion_id, name, tagline, voice_persona,
                  core_traits, owner_dynamic, backstory, greeting, avatar_url,
                  version, status, persona_source, import_meta, created_at, updated_at
                ) VALUES (
                  did, NULL, v_name, v_tagline, v_voice, v_traits, v_dynamic,
                  v_backstory, v_greeting, nullif(v_avatar, ''),
                  1, 'unlisted', 'card_import', v_meta, now(), now()
                )
                RETURNING id INTO v_listing;

                INSERT INTO public.companion_persona_versions (listing_id, version, persona_json)
                VALUES (v_listing, 1, jsonb_build_object(
                  'name', v_name, 'tagline', v_tagline, 'voicePersona', v_voice,
                  'coreTraits', v_traits, 'ownerDynamic', v_dynamic,
                  'backstory', v_backstory, 'greeting', v_greeting,
                  'avatarUrl', nullif(v_avatar, '')))
                ON CONFLICT (listing_id, version) DO NOTHING;

                INSERT INTO public.companions (
                  owner_user_id, name, avatar_url, voice_persona, core_traits,
                  owner_dynamic, backstory, onboarding_state, onboarding_turns,
                  kind, adopted_from_listing_id, listing_version, persona_source,
                  import_meta, created_at, updated_at
                ) VALUES (
                  did, v_name, nullif(v_avatar, ''), v_voice, v_traits, v_dynamic,
                  v_backstory, 'active', 0, 'adopted', v_listing, 1,
                  'card_import', v_meta, now(), now()
                )
                RETURNING id INTO v_companion;

                INSERT INTO public.companion_adoptions (user_id, listing_id, companion_id, adopted_at)
                VALUES (did, v_listing, v_companion, now());

                -- First import claims the DM slot; later imports leave the
                -- user's existing pick alone.
                INSERT INTO public.user_bot_settings (discord_user_id, active_dm_companion_id)
                VALUES (did, v_companion)
                ON CONFLICT (discord_user_id) DO UPDATE
                  SET active_dm_companion_id = EXCLUDED.active_dm_companion_id
                  WHERE public.user_bot_settings.active_dm_companion_id IS NULL;

                RETURN json_build_object(
                  'companion_id', v_companion, 'listing_id', v_listing, 'name', v_name,
                  'reused', false, 'revived', false);
              END
              $body$
            $dfn$;
            EXECUTE 'REVOKE ALL ON FUNCTION public.import_companion_card(jsonb) FROM PUBLIC';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION public.import_companion_card(jsonb) FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.import_companion_card(jsonb) TO authenticated';
            END IF;
          END IF;
        END $web$
      `;

      // v42's update policy had USING but no WITH CHECK — a user could rename
      // an object into another uid's folder. Recreate it checking both sides.
      await sql`
        DO $sto$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'storage')
             AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'storage' AND tablename = 'objects') THEN
            EXECUTE 'DROP POLICY IF EXISTS card_avatars_update ON storage.objects';
            EXECUTE $pol$
              CREATE POLICY card_avatars_update ON storage.objects
              FOR UPDATE TO authenticated
              USING (bucket_id = 'card-avatars'
                     AND (storage.foldername(name))[1] = auth.uid()::text)
              WITH CHECK (bucket_id = 'card-avatars'
                          AND (storage.foldername(name))[1] = auth.uid()::text)
            $pol$;
          END IF;
        END $sto$
      `;
    },
    down: async (sql) => {
      // Restore the v42 function verbatim — rollback means the code rolls back
      // too, so the body must match what the schema expects at v42.
      await sql`
        DO $web$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth')
             AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'web_profiles') THEN
            EXECUTE $dfn$
              CREATE OR REPLACE FUNCTION public.import_companion_card(p_payload jsonb)
              RETURNS json
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
                did text;
                v_plan text;
                v_max_slots int;
                v_count int;
                v_listing bigint;
                v_companion bigint;
                v_name text;
                v_tagline text;
                v_voice text;
                v_traits text[];
                v_dynamic text;
                v_backstory text;
                v_greeting text;
                v_avatar text;
                v_meta jsonb;
                v_row record;
              BEGIN
                IF uid IS NULL THEN
                  RAISE EXCEPTION 'not authenticated';
                END IF;
                SELECT discord_user_id, plan INTO did, v_plan
                  FROM public.web_profiles WHERE id = uid;
                IF did IS NULL THEN
                  RAISE EXCEPTION 'discord not linked';
                END IF;
                v_name := left(btrim(coalesce(p_payload->>'name', '')), 64);
                IF v_name = '' THEN
                  RAISE EXCEPTION 'name required';
                END IF;
                v_tagline := left(coalesce(p_payload->>'tagline', ''), 200);
                v_voice := left(coalesce(p_payload->>'voice_persona', ''), 2000);
                v_dynamic := left(coalesce(p_payload->>'owner_dynamic', ''), 300);
                v_backstory := left(coalesce(p_payload->>'backstory', ''), 4000);
                v_greeting := left(coalesce(p_payload->>'greeting', ''), 2000);
                v_avatar := left(coalesce(p_payload->>'avatar_url', ''), 500);
                IF v_avatar <> '' AND v_avatar NOT LIKE 'https://%' AND v_avatar NOT LIKE 'http://%' THEN
                  v_avatar := '';
                END IF;
                SELECT coalesce(array_agg(left(t, 48)), '{}'::text[]) INTO v_traits
                  FROM (SELECT jsonb_array_elements_text(
                                 coalesce(p_payload->'core_traits', '[]'::jsonb)) AS t
                        LIMIT 8) s;
                v_meta := jsonb_build_object(
                  'source', 'character_card',
                  'spec', left(coalesce(p_payload->'import_meta'->>'spec', ''), 40),
                  'specVersion', left(coalesce(p_payload->'import_meta'->>'specVersion', ''), 20),
                  'creator', left(coalesce(p_payload->'import_meta'->>'creator', ''), 120),
                  'characterVersion', left(coalesce(p_payload->'import_meta'->>'characterVersion', ''), 40),
                  'filename', left(coalesce(p_payload->'import_meta'->>'filename', ''), 200),
                  'sha256', left(coalesce(p_payload->'import_meta'->>'sha256', ''), 80),
                  'importedVia', 'web',
                  'importedAt', now()
                );
                PERFORM pg_advisory_xact_lock(hashtext('adopt:' || did));
                SELECT l.id INTO v_listing FROM public.companion_listings l
                  WHERE l.creator_user_id = did AND l.status = 'unlisted'
                    AND l.import_meta->>'sha256' =
                        coalesce(p_payload->'import_meta'->>'sha256', '~~~')
                  LIMIT 1;
                IF v_listing IS NOT NULL THEN
                  SELECT a.companion_id INTO v_companion FROM public.companion_adoptions a
                    WHERE a.user_id = did AND a.listing_id = v_listing;
                  IF v_companion IS NULL THEN
                    SELECT l.* INTO v_row FROM public.companion_listings l WHERE l.id = v_listing;
                    INSERT INTO public.companions (
                      owner_user_id, name, avatar_url, voice_persona, core_traits,
                      owner_dynamic, backstory, onboarding_state, onboarding_turns,
                      kind, adopted_from_listing_id, listing_version, persona_source,
                      import_meta, created_at, updated_at
                    ) VALUES (
                      did, v_row.name, v_row.avatar_url, v_row.voice_persona,
                      v_row.core_traits, v_row.owner_dynamic, v_row.backstory,
                      'active', 0, 'adopted', v_listing, v_row.version,
                      'card_import', v_row.import_meta, now(), now()
                    )
                    RETURNING id INTO v_companion;
                    INSERT INTO public.companion_adoptions (user_id, listing_id, companion_id, adopted_at)
                    VALUES (did, v_listing, v_companion, now());
                    RETURN json_build_object(
                      'companion_id', v_companion, 'listing_id', v_listing,
                      'name', v_row.name, 'reused', true);
                  END IF;
                  UPDATE public.companion_adoptions
                    SET dropped_at = NULL, cooldown_until = NULL, adopted_at = now()
                    WHERE user_id = did AND listing_id = v_listing AND dropped_at IS NOT NULL;
                  SELECT c.name INTO v_name FROM public.companions c WHERE c.id = v_companion;
                  RETURN json_build_object(
                    'companion_id', v_companion, 'listing_id', v_listing,
                    'name', v_name, 'reused', true);
                END IF;
                SELECT COUNT(*) INTO v_count FROM public.companion_listings
                 WHERE creator_user_id = did AND status = 'unlisted';
                IF v_count >= 25 THEN
                  RAISE EXCEPTION 'import cap reached';
                END IF;
                v_max_slots := CASE WHEN v_plan = 'premium' THEN 100 ELSE 1 END;
                SELECT COUNT(*) INTO v_count FROM public.companion_adoptions a
                  LEFT JOIN public.companion_listings l ON l.id = a.listing_id
                  WHERE a.user_id = did AND a.dropped_at IS NULL
                    AND (l.id IS NULL OR l.status <> 'banned');
                IF v_count >= v_max_slots THEN
                  RAISE EXCEPTION 'adoption slot full';
                END IF;
                INSERT INTO public.companion_listings (
                  creator_user_id, source_companion_id, name, tagline, voice_persona,
                  core_traits, owner_dynamic, backstory, greeting, avatar_url,
                  version, status, persona_source, import_meta, created_at, updated_at
                ) VALUES (
                  did, NULL, v_name, v_tagline, v_voice, v_traits, v_dynamic,
                  v_backstory, v_greeting, nullif(v_avatar, ''),
                  1, 'unlisted', 'card_import', v_meta, now(), now()
                )
                RETURNING id INTO v_listing;
                INSERT INTO public.companion_persona_versions (listing_id, version, persona_json)
                VALUES (v_listing, 1, jsonb_build_object(
                  'name', v_name, 'tagline', v_tagline, 'voicePersona', v_voice,
                  'coreTraits', v_traits, 'ownerDynamic', v_dynamic,
                  'backstory', v_backstory, 'greeting', v_greeting,
                  'avatarUrl', nullif(v_avatar, '')))
                ON CONFLICT (listing_id, version) DO NOTHING;
                INSERT INTO public.companions (
                  owner_user_id, name, avatar_url, voice_persona, core_traits,
                  owner_dynamic, backstory, onboarding_state, onboarding_turns,
                  kind, adopted_from_listing_id, listing_version, persona_source,
                  import_meta, created_at, updated_at
                ) VALUES (
                  did, v_name, nullif(v_avatar, ''), v_voice, v_traits, v_dynamic,
                  v_backstory, 'active', 0, 'adopted', v_listing, 1,
                  'card_import', v_meta, now(), now()
                )
                RETURNING id INTO v_companion;
                INSERT INTO public.companion_adoptions (user_id, listing_id, companion_id, adopted_at)
                VALUES (did, v_listing, v_companion, now());
                INSERT INTO public.user_bot_settings (discord_user_id, active_dm_companion_id)
                VALUES (did, v_companion)
                ON CONFLICT (discord_user_id) DO UPDATE
                  SET active_dm_companion_id = EXCLUDED.active_dm_companion_id
                  WHERE public.user_bot_settings.active_dm_companion_id IS NULL;
                RETURN json_build_object(
                  'companion_id', v_companion, 'listing_id', v_listing, 'name', v_name);
              END
              $body$
            $dfn$;
            EXECUTE 'REVOKE ALL ON FUNCTION public.import_companion_card(jsonb) FROM PUBLIC';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION public.import_companion_card(jsonb) FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.import_companion_card(jsonb) TO authenticated';
            END IF;
          END IF;
        END $web$
      `;
      await sql`
        DO $sto$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'storage')
             AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'storage' AND tablename = 'objects') THEN
            EXECUTE 'DROP POLICY IF EXISTS card_avatars_update ON storage.objects';
            EXECUTE $pol$
              CREATE POLICY card_avatars_update ON storage.objects
              FOR UPDATE TO authenticated
              USING (bucket_id = 'card-avatars'
                     AND (storage.foldername(name))[1] = auth.uid()::text)
            $pol$;
          END IF;
        END $sto$
      `;
      await sql`ALTER TABLE companion_listings DROP COLUMN IF EXISTS published_at`;
    },
  },
  {
    version: 44,
    name: "v44_chat_import",
    up: async (sql) => {
      // Chat-history imports: the transcript lands as normalized turns on this
      // row, a 'chat-import' job distills it into companion_journal, then the
      // turns are cleared — distill-and-discard, we keep the memory not the
      // corpus. Provenance + progress live here; the row survives 'done' so
      // journal entries stay attributable to their import.
      await sql`
        CREATE TABLE IF NOT EXISTS chat_imports (
          id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          owner_user_id   TEXT NOT NULL,
          companion_id    BIGINT NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
          filename        TEXT NOT NULL DEFAULT '',
          sha256          TEXT NOT NULL,
          format          TEXT NOT NULL DEFAULT '',
          status          TEXT NOT NULL DEFAULT 'queued',
          turns           JSONB NOT NULL DEFAULT '[]',
          speakers        JSONB NOT NULL DEFAULT '{}',
          message_count   INTEGER NOT NULL DEFAULT 0,
          kept_count      INTEGER NOT NULL DEFAULT 0,
          processed_turns INTEGER NOT NULL DEFAULT 0,
          error           TEXT,
          meta            JSONB,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(owner_user_id, sha256)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS chat_imports_owner ON chat_imports(owner_user_id, status)`;
      // Same lockdown as every public table — the site reaches imports only
      // through the security-definer RPCs below.
      await sql`ALTER TABLE chat_imports ENABLE ROW LEVEL SECURITY`;

      // Journal provenance: entries written by a live reply are 'live';
      // distilled ones carry 'import' + the import they came from. Cascade
      // means deleting the import record retracts its memories too.
      await addColumn(sql, "companion_journal", "source TEXT NOT NULL DEFAULT 'live'");
      await addColumn(sql, "companion_journal", "import_id BIGINT REFERENCES chat_imports(id) ON DELETE CASCADE");

      await sql`
        DO $web$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth')
             AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'web_profiles') THEN
            -- Roster for the website's companion picker — awakened + active
            -- adoptions, nothing else. auth.uid()-keyed, returns own rows only.
            EXECUTE $dfn$
              CREATE OR REPLACE FUNCTION public.my_companions()
              RETURNS json
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
                did text;
              BEGIN
                IF uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
                SELECT discord_user_id INTO did FROM public.web_profiles WHERE id = uid;
                IF did IS NULL THEN RETURN '[]'::json; END IF;
                RETURN coalesce((
                  SELECT jsonb_agg(jsonb_build_object(
                    'id', c.id, 'name', c.name, 'kind', c.kind, 'avatar_url', c.avatar_url))
                  FROM public.companions c
                  WHERE c.owner_user_id = did
                    AND (c.kind = 'awakened' OR EXISTS (
                      SELECT 1 FROM public.companion_adoptions a
                      WHERE a.companion_id = c.id AND a.user_id = did AND a.dropped_at IS NULL))
                ), '[]'::jsonb)::json;
              END
              $body$
            $dfn$;
            -- Status poll for the import plate — own imports, newest first.
            EXECUTE $dfn2$
              CREATE OR REPLACE FUNCTION public.my_chat_imports()
              RETURNS json
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
                did text;
              BEGIN
                IF uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
                SELECT discord_user_id INTO did FROM public.web_profiles WHERE id = uid;
                IF did IS NULL THEN RETURN '[]'::json; END IF;
                RETURN coalesce((
                  SELECT jsonb_agg(jsonb_build_object(
                    'id', i.id, 'companion_id', i.companion_id, 'status', i.status,
                    'filename', i.filename, 'format', i.format,
                    'message_count', i.message_count, 'kept_count', i.kept_count,
                    'processed_turns', i.processed_turns, 'error', i.error,
                    'created_at', i.created_at) ORDER BY i.created_at DESC)
                  FROM public.chat_imports i WHERE i.owner_user_id = did
                ), '[]'::jsonb)::json;
              END
              $body$
            $dfn2$;
            -- Create + enqueue a chat-history import. Client supplies the
            -- normalized turns + meta; the server re-bounds everything,
            -- validates the companion is on the caller's roster, dedupes on
            -- sha256, and enqueues the distill job itself (INSERT into jobs +
            -- pg_notify — the worker picks it up like any other enqueue).
            EXECUTE $dfn3$
              CREATE OR REPLACE FUNCTION public.import_chat_history(p_payload jsonb)
              RETURNS json
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
                did text;
                v_companion bigint;
                v_count int;
                v_id bigint;
                v_job bigint;
                v_sha text;
                v_turns jsonb;
                v_turn jsonb;
                v_bounded jsonb := '[]'::jsonb;
                v_i int;
                v_speaker text;
                v_status text;
              BEGIN
                IF uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
                SELECT discord_user_id INTO did FROM public.web_profiles WHERE id = uid;
                IF did IS NULL THEN RAISE EXCEPTION 'discord not linked'; END IF;

                v_companion := CASE WHEN (p_payload->>'companion_id') ~ '^[0-9]+$'
                  THEN (p_payload->>'companion_id')::bigint ELSE 0 END;
                IF v_companion = 0 OR NOT EXISTS (
                  SELECT 1 FROM public.companions c
                  WHERE c.id = v_companion AND c.owner_user_id = did
                    AND (c.kind = 'awakened' OR EXISTS (
                      SELECT 1 FROM public.companion_adoptions a
                      WHERE a.companion_id = c.id AND a.user_id = did AND a.dropped_at IS NULL))
                ) THEN RAISE EXCEPTION 'not your companion'; END IF;

                -- Re-bound the turns server-side — the client's parse is a
                -- preview, not a trusted input. Keep in sync with
                -- CHAT_MAX_TURNS / CHAT_MAX_TURN_CHARS in src/chathist.ts.
                v_turns := coalesce(p_payload->'turns', '[]'::jsonb);
                IF jsonb_typeof(v_turns) <> 'array' THEN v_turns := '[]'::jsonb; END IF;
                FOR v_i IN 0..least(jsonb_array_length(v_turns), 4000) - 1 LOOP
                  v_turn := v_turns->v_i;
                  v_speaker := v_turn->>'speaker';
                  IF v_speaker NOT IN ('user', 'char') THEN CONTINUE; END IF;
                  IF length(coalesce(v_turn->>'text', '')) = 0 THEN CONTINUE; END IF;
                  v_bounded := v_bounded || jsonb_build_object(
                    'speaker', v_speaker,
                    'text', left(v_turn->>'text', 1500),
                    'ts', left(coalesce(v_turn->>'ts', ''), 40)
                  );
                END LOOP;
                IF jsonb_array_length(v_bounded) = 0 THEN RAISE EXCEPTION 'no usable turns'; END IF;

                v_sha := left(coalesce(p_payload->'meta'->>'sha256', ''), 80);

                -- Same file twice → the existing row, whatever its state.
                SELECT i.id, i.status INTO v_id, v_status FROM public.chat_imports i
                  WHERE i.owner_user_id = did AND i.sha256 = v_sha AND v_sha <> '';
                IF v_id IS NOT NULL THEN
                  RETURN json_build_object('import_id', v_id, 'status', v_status, 'reused', true);
                END IF;

                -- Pending cap — keep in sync with CHAT_IMPORT_CAP.
                SELECT COUNT(*) INTO v_count FROM public.chat_imports
                  WHERE owner_user_id = did AND status IN ('queued', 'distilling');
                IF v_count >= 3 THEN RAISE EXCEPTION 'import busy'; END IF;

                INSERT INTO public.chat_imports (
                  owner_user_id, companion_id, filename, sha256, format, status,
                  turns, speakers, message_count, meta, created_at, updated_at
                ) VALUES (
                  did, v_companion,
                  left(coalesce(p_payload->>'filename', ''), 200), v_sha,
                  left(coalesce(p_payload->>'format', ''), 10), 'queued',
                  v_bounded,
                  jsonb_build_object(
                    'user', left(coalesce(p_payload->'speakers'->>'user', ''), 120),
                    'char', left(coalesce(p_payload->'speakers'->>'char', ''), 120),
                    'dropped', CASE WHEN (p_payload->'speakers'->>'dropped') ~ '^[0-9]+$'
                      THEN (p_payload->'speakers'->>'dropped')::int ELSE 0 END
                  ),
                  jsonb_array_length(v_bounded),
                  jsonb_build_object(
                    'source', 'chat_history',
                    'format', left(coalesce(p_payload->>'format', ''), 10),
                    'userName', left(coalesce(p_payload->'speakers'->>'user', ''), 120),
                    'charName', left(coalesce(p_payload->'speakers'->>'char', ''), 120),
                    'filename', left(coalesce(p_payload->>'filename', ''), 200),
                    'sha256', v_sha,
                    'firstTs', left(coalesce(p_payload->'meta'->>'firstTs', ''), 40),
                    'lastTs', left(coalesce(p_payload->'meta'->>'lastTs', ''), 40),
                    'importedVia', 'web',
                    'importedAt', now()
                  ),
                  now(), now()
                ) RETURNING id INTO v_id;

                INSERT INTO public.jobs (guild_id, type, payload, run_after)
                VALUES ('dm:' || did, 'chat-import', jsonb_build_object('importId', v_id), now())
                RETURNING id INTO v_job;
                PERFORM pg_notify('jobs', v_job::text);

                RETURN json_build_object('import_id', v_id, 'status', 'queued', 'reused', false);
              END
              $body$
            $dfn3$;
            EXECUTE 'REVOKE ALL ON FUNCTION public.my_companions() FROM PUBLIC';
            EXECUTE 'REVOKE ALL ON FUNCTION public.my_chat_imports() FROM PUBLIC';
            EXECUTE 'REVOKE ALL ON FUNCTION public.import_chat_history(jsonb) FROM PUBLIC';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION public.my_companions() FROM anon';
              EXECUTE 'REVOKE ALL ON FUNCTION public.my_chat_imports() FROM anon';
              EXECUTE 'REVOKE ALL ON FUNCTION public.import_chat_history(jsonb) FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.my_companions() TO authenticated';
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.my_chat_imports() TO authenticated';
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.import_chat_history(jsonb) TO authenticated';
            END IF;
          END IF;
        END $web$
      `;
    },
    down: async (sql) => {
      await sql`DROP FUNCTION IF EXISTS public.my_companions()`;
      await sql`DROP FUNCTION IF EXISTS public.my_chat_imports()`;
      await sql`DROP FUNCTION IF EXISTS public.import_chat_history(jsonb)`;
      // Refuse to silently drop import records + their provenance — same
      // data-decision guard as v41/v42.
      await sql`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM chat_imports) THEN
            RAISE EXCEPTION 'v44 rollback refused: chat imports exist';
          END IF;
        END $$
      `;
      await sql`ALTER TABLE companion_journal DROP COLUMN IF EXISTS import_id`;
      await sql`ALTER TABLE companion_journal DROP COLUMN IF EXISTS source`;
      await sql`DROP TABLE IF EXISTS chat_imports`;
    },
  },
  {
    version: 45,
    name: "v45_chat_import_undo",
    up: async (sql) => {
      // Undo an import — the row's journal cascade retracts every memory it
      // wrote (companion_journal.import_id ON DELETE CASCADE, v44). Returns
      // the deleted row so the site can say what was removed.
      await sql`
        DO $web$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth')
             AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'web_profiles') THEN
            EXECUTE $dfn$
              CREATE OR REPLACE FUNCTION public.delete_chat_import(p_id bigint)
              RETURNS json
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
                did text;
                v_row public.chat_imports%ROWTYPE;
              BEGIN
                IF uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
                SELECT discord_user_id INTO did FROM public.web_profiles WHERE id = uid;
                IF did IS NULL THEN RETURN NULL; END IF;
                DELETE FROM public.chat_imports
                  WHERE id = p_id AND owner_user_id = did
                  RETURNING * INTO v_row;
                IF v_row.id IS NULL THEN RETURN NULL; END IF;
                RETURN json_build_object(
                  'import_id', v_row.id, 'filename', v_row.filename,
                  'kept_count', v_row.kept_count, 'companion_id', v_row.companion_id);
              END
              $body$
            $dfn$;
            EXECUTE 'REVOKE ALL ON FUNCTION public.delete_chat_import(bigint) FROM PUBLIC';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION public.delete_chat_import(bigint) FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.delete_chat_import(bigint) TO authenticated';
            END IF;
          END IF;
        END $web$
      `;
    },
    down: async (sql) => {
      await sql`DROP FUNCTION IF EXISTS public.delete_chat_import(bigint)`;
    },
  },
  {
    version: 46,
    name: "v46_quiet_channels",
    up: async (sql) => {
      // quiet_channels = companion silence without blindness. Replies and
      // companion system cards are suppressed there while archiving and
      // memory extraction keep running — the middle tier between ignored
      // (fully invisible) and normal. Threads inherit via parentId.
      await sql`ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS quiet_channels TEXT[] NOT NULL DEFAULT '{}'`;
    },
    down: async (sql) => {
      await sql`ALTER TABLE server_settings DROP COLUMN IF EXISTS quiet_channels`;
    },
  },
  {
    version: 47,
    name: "v47_app_installs",
    up: async (sql) => {
      // app_installs — the install-greeting ledger. Discord's
      // APPLICATION_AUTHORIZED / APPLICATION_DEAUTHORIZED webhook events land
      // here via the website worker (record_app_install RPC, service-role
      // only); the bot's install-greet sweep DMs a welcome card to every
      // ungreeted authorized install. greeted_at is permanent — reinstalls
      // never re-greet.
      await sql`
        CREATE TABLE IF NOT EXISTS app_installs (
          discord_user_id   TEXT PRIMARY KEY,
          event             TEXT NOT NULL,
          meta              JSONB,
          greeted_at        TIMESTAMPTZ,
          deauthorized_at   TIMESTAMPTZ,
          attempts          INT NOT NULL DEFAULT 0,
          last_error        TEXT,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS app_installs_pending
          ON app_installs (created_at)
          WHERE greeted_at IS NULL AND deauthorized_at IS NULL
      `;
      await sql`ALTER TABLE app_installs ENABLE ROW LEVEL SECURITY`;
      await sql`
        CREATE OR REPLACE FUNCTION public.record_app_install(p_user_id text, p_event text, p_meta jsonb)
        RETURNS void
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = ''
        AS $body$
        BEGIN
          INSERT INTO public.app_installs (discord_user_id, event, meta, deauthorized_at)
          VALUES (p_user_id, p_event, p_meta,
                  CASE WHEN p_event = 'deauthorized' THEN NOW() ELSE NULL END)
          ON CONFLICT (discord_user_id) DO UPDATE SET
            event = EXCLUDED.event,
            meta = EXCLUDED.meta,
            deauthorized_at = EXCLUDED.deauthorized_at,
            updated_at = NOW();
        END
        $body$
      `;
      await sql`REVOKE ALL ON FUNCTION public.record_app_install(text, text, jsonb) FROM PUBLIC`;
      await sql`
        DO $role$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
            EXECUTE 'REVOKE ALL ON FUNCTION public.record_app_install(text, text, jsonb) FROM anon';
          END IF;
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
            EXECUTE 'REVOKE ALL ON FUNCTION public.record_app_install(text, text, jsonb) FROM authenticated';
          END IF;
        END $role$
      `;
    },
    down: async (sql) => {
      await sql`DROP FUNCTION IF EXISTS public.record_app_install(text, text, jsonb)`;
      // Same data-decision guard as v41/v42/v44 — don't silently drop the
      // install ledger.
      await sql`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM app_installs) THEN
            RAISE EXCEPTION 'v47 rollback refused: app installs exist';
          END IF;
        END $$
      `;
      await sql`DROP TABLE IF EXISTS app_installs`;
    },
  },
  {
    version: 48,
    name: "v48_support_tickets",
    up: async (sql) => {
      // support_tickets — the house ticket system's ledger. One row per
      // private thread under #support-ticket; the partial unique index makes
      // "one open ticket per user" a database guarantee, not just a handler
      // check — two concurrent modal submits can't double-open.
      await sql`
        CREATE TABLE IF NOT EXISTS support_tickets (
          thread_id   TEXT PRIMARY KEY,
          guild_id    TEXT NOT NULL,
          opener_id   TEXT NOT NULL,
          subject     TEXT NOT NULL,
          details     TEXT NOT NULL,
          status      TEXT NOT NULL DEFAULT 'open',
          opened_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          closed_at   TIMESTAMPTZ,
          closer_id   TEXT
        )
      `;
      await sql`
        CREATE UNIQUE INDEX IF NOT EXISTS support_tickets_one_open_per_user
          ON support_tickets (opener_id) WHERE status = 'open'
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS support_tickets_open
          ON support_tickets (guild_id, opened_at) WHERE status = 'open'
      `;
      await sql`ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY`;
    },
    down: async (sql) => {
      // Same data-decision guard as v47 — don't silently drop ticket history.
      await sql`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM support_tickets) THEN
            RAISE EXCEPTION 'v48 rollback refused: support tickets exist';
          END IF;
        END $$
      `;
      await sql`DROP TABLE IF EXISTS support_tickets`;
    },
  },
  {
    version: 49,
    name: "v49_install_event_ordering",
    up: async (sql) => {
      // Discord retries webhook deliveries — a redelivered AUTHORIZED landing
      // after a real DEAUTHORIZED used to resurrect the row (deauthorized_at
      // cleared, the install-greet sweep then DMs a revoked install). The
      // event's own timestamp rides inside meta; only apply an event that
      // isn't older than the one already recorded.
      await sql`
        CREATE OR REPLACE FUNCTION public.record_app_install(p_user_id text, p_event text, p_meta jsonb)
        RETURNS void
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = ''
        AS $body$
        BEGIN
          INSERT INTO public.app_installs (discord_user_id, event, meta, deauthorized_at)
          VALUES (p_user_id, p_event, p_meta,
                  CASE WHEN p_event = 'deauthorized' THEN NOW() ELSE NULL END)
          ON CONFLICT (discord_user_id) DO UPDATE SET
            event = EXCLUDED.event,
            meta = EXCLUDED.meta,
            deauthorized_at = EXCLUDED.deauthorized_at,
            updated_at = NOW()
          WHERE coalesce(public.app_installs.meta->>'timestamp', '')
                <= coalesce(EXCLUDED.meta->>'timestamp', '');
        END
        $body$
      `;
      await sql`REVOKE ALL ON FUNCTION public.record_app_install(text, text, jsonb) FROM PUBLIC`;
      await sql`
        DO $role$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
            EXECUTE 'REVOKE ALL ON FUNCTION public.record_app_install(text, text, jsonb) FROM anon';
          END IF;
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
            EXECUTE 'REVOKE ALL ON FUNCTION public.record_app_install(text, text, jsonb) FROM authenticated';
          END IF;
        END $role$
      `;
    },
    down: async (sql) => {
      // Restore the v47 last-write-wins body verbatim.
      await sql`
        CREATE OR REPLACE FUNCTION public.record_app_install(p_user_id text, p_event text, p_meta jsonb)
        RETURNS void
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = ''
        AS $body$
        BEGIN
          INSERT INTO public.app_installs (discord_user_id, event, meta, deauthorized_at)
          VALUES (p_user_id, p_event, p_meta,
                  CASE WHEN p_event = 'deauthorized' THEN NOW() ELSE NULL END)
          ON CONFLICT (discord_user_id) DO UPDATE SET
            event = EXCLUDED.event,
            meta = EXCLUDED.meta,
            deauthorized_at = EXCLUDED.deauthorized_at,
            updated_at = NOW();
        END
        $body$
      `;
    },
  },
  {
    version: 50,
    name: "v50_refund_clawback",
    up: async (sql) => {
      // Refunds were audit-only: buy pack → spend tokens → refund → keep the
      // value. refunded_of links a refund row to the purchase it reverses;
      // clawback_pack debits the newest unrefunded pack under the account row
      // lock and lets the balance go negative when the tokens were already
      // spent — a debt the next grants pay off first. FIFO by recency is the
      // matching heuristic: Stripe charge events don't carry the
      // session→pack mapping, so an exact pack match isn't recoverable.
      await sql`
        DO $mig$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth')
             AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'credit_ledger') THEN
            EXECUTE 'ALTER TABLE public.credit_ledger ADD COLUMN IF NOT EXISTS refunded_of BIGINT';
            EXECUTE $rpc$
              CREATE OR REPLACE FUNCTION public.clawback_pack(p_account uuid, p_charge text)
              RETURNS jsonb
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                v_purchase record;
                v_bal integer;
              BEGIN
                PERFORM 1 FROM public.web_profiles WHERE id = p_account FOR UPDATE;
                IF NOT FOUND THEN
                  RETURN jsonb_build_object('ok', false, 'reason', 'no_account');
                END IF;
                IF p_charge IS NULL OR p_charge = '' THEN
                  RETURN jsonb_build_object('ok', false, 'reason', 'no_charge');
                END IF;
                -- stripe_ref unique index is the belt; this check is the
                -- suspenders — either way a redelivered refund debits once.
                IF EXISTS (SELECT 1 FROM public.credit_ledger WHERE stripe_ref = 'refund:' || p_charge) THEN
                  SELECT credit_balance INTO v_bal FROM public.web_profiles WHERE id = p_account;
                  RETURN jsonb_build_object('ok', true, 'duplicate', true, 'balance', v_bal);
                END IF;
                SELECT l.id, l.delta INTO v_purchase FROM public.credit_ledger l
                  WHERE l.account_id = p_account AND l.kind = 'purchase'
                    AND NOT EXISTS (
                      SELECT 1 FROM public.credit_ledger r WHERE r.refunded_of = l.id)
                  ORDER BY l.id DESC LIMIT 1;
                IF v_purchase.id IS NULL THEN
                  -- No pack to claw (e.g. a subscription charge) — keep the
                  -- audit row so the refund is still visible in the ledger.
                  INSERT INTO public.credit_ledger (account_id, delta, kind, reason, stripe_ref, balance_after)
                  SELECT p_account, 0, 'adjust', 'stripe_refund:' || p_charge, 'refund:' || p_charge, w.credit_balance
                  FROM public.web_profiles w WHERE w.id = p_account;
                  SELECT credit_balance INTO v_bal FROM public.web_profiles WHERE id = p_account;
                  RETURN jsonb_build_object('ok', true, 'clawed', 0, 'balance', v_bal);
                END IF;
                UPDATE public.web_profiles
                  SET credit_balance = credit_balance - v_purchase.delta, updated_at = now()
                  WHERE id = p_account
                  RETURNING credit_balance INTO v_bal;
                INSERT INTO public.credit_ledger
                  (account_id, delta, kind, reason, stripe_ref, balance_after, refunded_of)
                VALUES (p_account, -v_purchase.delta, 'refund', 'stripe_refund:' || p_charge,
                        'refund:' || p_charge, v_bal, v_purchase.id);
                RETURN jsonb_build_object('ok', true, 'duplicate', false, 'clawed', v_purchase.delta, 'balance', v_bal);
              END
              $body$
            $rpc$;
            EXECUTE 'REVOKE ALL ON FUNCTION public.clawback_pack(uuid, text) FROM PUBLIC';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION public.clawback_pack(uuid, text) FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION public.clawback_pack(uuid, text) FROM authenticated';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.clawback_pack(uuid, text) TO service_role';
            END IF;
          END IF;
        END $mig$
      `;
    },
    down: async (sql) => {
      await sql`
        DO $undo$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
            EXECUTE 'DROP FUNCTION IF EXISTS public.clawback_pack(uuid, text)';
            EXECUTE 'ALTER TABLE public.credit_ledger DROP COLUMN IF EXISTS refunded_of';
          END IF;
        END $undo$
      `;
    },
  },
  {
    version: 51,
    name: "v51_chat_import_dedupe",
    up: async (sql) => {
      // The dedupe SELECT-then-INSERT raced: two concurrent same-sha256 calls
      // both passed the check and the loser hit a raw unique-violation.
      // ON CONFLICT DO NOTHING makes the constraint itself the arbiter and
      // returns the winner's row as 'reused' — matching the pre-check's
      // contract and also absorbing the sha256='' edge that previously
      // violated on a second import.
      //
      // Also corrects ->>'meta'->>'sha256' to ->'meta'->>'sha256': the outer
      // ->> yields text and text->> doesn't exist, so every web import raised
      // an operator error at the v_sha line — the web path never worked.
      // (Fixed in the v44 body above and the down body below too — a partial
      // apply or a rollback should still produce a working function.)
      await sql`
        DO $web$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth')
             AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'web_profiles') THEN
            EXECUTE $dfn$
              CREATE OR REPLACE FUNCTION public.import_chat_history(p_payload jsonb)
              RETURNS json
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
                did text;
                v_companion bigint;
                v_count int;
                v_id bigint;
                v_job bigint;
                v_sha text;
                v_turns jsonb;
                v_turn jsonb;
                v_bounded jsonb := '[]'::jsonb;
                v_i int;
                v_speaker text;
                v_status text;
              BEGIN
                IF uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
                SELECT discord_user_id INTO did FROM public.web_profiles WHERE id = uid;
                IF did IS NULL THEN RAISE EXCEPTION 'discord not linked'; END IF;

                v_companion := CASE WHEN (p_payload->>'companion_id') ~ '^[0-9]+$'
                  THEN (p_payload->>'companion_id')::bigint ELSE 0 END;
                IF v_companion = 0 OR NOT EXISTS (
                  SELECT 1 FROM public.companions c
                  WHERE c.id = v_companion AND c.owner_user_id = did
                    AND (c.kind = 'awakened' OR EXISTS (
                      SELECT 1 FROM public.companion_adoptions a
                      WHERE a.companion_id = c.id AND a.user_id = did AND a.dropped_at IS NULL))
                ) THEN RAISE EXCEPTION 'not your companion'; END IF;

                -- Re-bound the turns server-side — the client's parse is a
                -- preview, not a trusted input. Keep in sync with
                -- CHAT_MAX_TURNS / CHAT_MAX_TURN_CHARS in src/chathist.ts.
                v_turns := coalesce(p_payload->'turns', '[]'::jsonb);
                IF jsonb_typeof(v_turns) <> 'array' THEN v_turns := '[]'::jsonb; END IF;
                FOR v_i IN 0..least(jsonb_array_length(v_turns), 4000) - 1 LOOP
                  v_turn := v_turns->v_i;
                  v_speaker := v_turn->>'speaker';
                  IF v_speaker NOT IN ('user', 'char') THEN CONTINUE; END IF;
                  IF length(coalesce(v_turn->>'text', '')) = 0 THEN CONTINUE; END IF;
                  v_bounded := v_bounded || jsonb_build_object(
                    'speaker', v_speaker,
                    'text', left(v_turn->>'text', 1500),
                    'ts', left(coalesce(v_turn->>'ts', ''), 40)
                  );
                END LOOP;
                IF jsonb_array_length(v_bounded) = 0 THEN RAISE EXCEPTION 'no usable turns'; END IF;

                v_sha := left(coalesce(p_payload->'meta'->>'sha256', ''), 80);

                -- Same file twice → the existing row, whatever its state.
                SELECT i.id, i.status INTO v_id, v_status FROM public.chat_imports i
                  WHERE i.owner_user_id = did AND i.sha256 = v_sha AND v_sha <> '';
                IF v_id IS NOT NULL THEN
                  RETURN json_build_object('import_id', v_id, 'status', v_status, 'reused', true);
                END IF;

                -- Pending cap — keep in sync with CHAT_IMPORT_CAP.
                SELECT COUNT(*) INTO v_count FROM public.chat_imports
                  WHERE owner_user_id = did AND status IN ('queued', 'distilling');
                IF v_count >= 3 THEN RAISE EXCEPTION 'import busy'; END IF;

                INSERT INTO public.chat_imports (
                  owner_user_id, companion_id, filename, sha256, format, status,
                  turns, speakers, message_count, meta, created_at, updated_at
                ) VALUES (
                  did, v_companion,
                  left(coalesce(p_payload->>'filename', ''), 200), v_sha,
                  left(coalesce(p_payload->>'format', ''), 10), 'queued',
                  v_bounded,
                  jsonb_build_object(
                    'user', left(coalesce(p_payload->'speakers'->>'user', ''), 120),
                    'char', left(coalesce(p_payload->'speakers'->>'char', ''), 120),
                    'dropped', CASE WHEN (p_payload->'speakers'->>'dropped') ~ '^[0-9]+$'
                      THEN (p_payload->'speakers'->>'dropped')::int ELSE 0 END
                  ),
                  jsonb_array_length(v_bounded),
                  jsonb_build_object(
                    'source', 'chat_history',
                    'format', left(coalesce(p_payload->>'format', ''), 10),
                    'userName', left(coalesce(p_payload->'speakers'->>'user', ''), 120),
                    'charName', left(coalesce(p_payload->'speakers'->>'char', ''), 120),
                    'filename', left(coalesce(p_payload->>'filename', ''), 200),
                    'sha256', v_sha,
                    'firstTs', left(coalesce(p_payload->'meta'->>'firstTs', ''), 40),
                    'lastTs', left(coalesce(p_payload->'meta'->>'lastTs', ''), 40),
                    'importedVia', 'web',
                    'importedAt', now()
                  ),
                  now(), now()
                )
                ON CONFLICT (owner_user_id, sha256) DO NOTHING
                RETURNING id INTO v_id;

                IF v_id IS NULL THEN
                  -- Lost a same-file race — hand back the winner's row exactly
                  -- like the pre-check would have.
                  SELECT i.id, i.status INTO v_id, v_status FROM public.chat_imports i
                    WHERE i.owner_user_id = did AND i.sha256 = v_sha;
                  RETURN json_build_object('import_id', v_id, 'status', v_status, 'reused', true);
                END IF;

                INSERT INTO public.jobs (guild_id, type, payload, run_after)
                VALUES ('dm:' || did, 'chat-import', jsonb_build_object('importId', v_id), now())
                RETURNING id INTO v_job;
                PERFORM pg_notify('jobs', v_job::text);

                RETURN json_build_object('import_id', v_id, 'status', 'queued', 'reused', false);
              END
              $body$
            $dfn$;
          END IF;
        END $web$
      `;
    },
    down: async (sql) => {
      // Restore the pre-v51 SELECT-then-INSERT dedupe. The ->'meta'->>
      // operator fix is kept — restoring the broken ->>'meta'->> would
      // re-break the function for every web caller.
      await sql`
        DO $web$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth')
             AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'web_profiles') THEN
            EXECUTE $dfn$
              CREATE OR REPLACE FUNCTION public.import_chat_history(p_payload jsonb)
              RETURNS json
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
                did text;
                v_companion bigint;
                v_count int;
                v_id bigint;
                v_job bigint;
                v_sha text;
                v_turns jsonb;
                v_turn jsonb;
                v_bounded jsonb := '[]'::jsonb;
                v_i int;
                v_speaker text;
                v_status text;
              BEGIN
                IF uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
                SELECT discord_user_id INTO did FROM public.web_profiles WHERE id = uid;
                IF did IS NULL THEN RAISE EXCEPTION 'discord not linked'; END IF;

                v_companion := CASE WHEN (p_payload->>'companion_id') ~ '^[0-9]+$'
                  THEN (p_payload->>'companion_id')::bigint ELSE 0 END;
                IF v_companion = 0 OR NOT EXISTS (
                  SELECT 1 FROM public.companions c
                  WHERE c.id = v_companion AND c.owner_user_id = did
                    AND (c.kind = 'awakened' OR EXISTS (
                      SELECT 1 FROM public.companion_adoptions a
                      WHERE a.companion_id = c.id AND a.user_id = did AND a.dropped_at IS NULL))
                ) THEN RAISE EXCEPTION 'not your companion'; END IF;

                v_turns := coalesce(p_payload->'turns', '[]'::jsonb);
                IF jsonb_typeof(v_turns) <> 'array' THEN v_turns := '[]'::jsonb; END IF;
                FOR v_i IN 0..least(jsonb_array_length(v_turns), 4000) - 1 LOOP
                  v_turn := v_turns->v_i;
                  v_speaker := v_turn->>'speaker';
                  IF v_speaker NOT IN ('user', 'char') THEN CONTINUE; END IF;
                  IF length(coalesce(v_turn->>'text', '')) = 0 THEN CONTINUE; END IF;
                  v_bounded := v_bounded || jsonb_build_object(
                    'speaker', v_speaker,
                    'text', left(v_turn->>'text', 1500),
                    'ts', left(coalesce(v_turn->>'ts', ''), 40)
                  );
                END LOOP;
                IF jsonb_array_length(v_bounded) = 0 THEN RAISE EXCEPTION 'no usable turns'; END IF;

                v_sha := left(coalesce(p_payload->'meta'->>'sha256', ''), 80);

                SELECT i.id, i.status INTO v_id, v_status FROM public.chat_imports i
                  WHERE i.owner_user_id = did AND i.sha256 = v_sha AND v_sha <> '';
                IF v_id IS NOT NULL THEN
                  RETURN json_build_object('import_id', v_id, 'status', v_status, 'reused', true);
                END IF;

                SELECT COUNT(*) INTO v_count FROM public.chat_imports
                  WHERE owner_user_id = did AND status IN ('queued', 'distilling');
                IF v_count >= 3 THEN RAISE EXCEPTION 'import busy'; END IF;

                INSERT INTO public.chat_imports (
                  owner_user_id, companion_id, filename, sha256, format, status,
                  turns, speakers, message_count, meta, created_at, updated_at
                ) VALUES (
                  did, v_companion,
                  left(coalesce(p_payload->>'filename', ''), 200), v_sha,
                  left(coalesce(p_payload->>'format', ''), 10), 'queued',
                  v_bounded,
                  jsonb_build_object(
                    'user', left(coalesce(p_payload->'speakers'->>'user', ''), 120),
                    'char', left(coalesce(p_payload->'speakers'->>'char', ''), 120),
                    'dropped', CASE WHEN (p_payload->'speakers'->>'dropped') ~ '^[0-9]+$'
                      THEN (p_payload->'speakers'->>'dropped')::int ELSE 0 END
                  ),
                  jsonb_array_length(v_bounded),
                  jsonb_build_object(
                    'source', 'chat_history',
                    'format', left(coalesce(p_payload->>'format', ''), 10),
                    'userName', left(coalesce(p_payload->'speakers'->>'user', ''), 120),
                    'charName', left(coalesce(p_payload->'speakers'->>'char', ''), 120),
                    'filename', left(coalesce(p_payload->>'filename', ''), 200),
                    'sha256', v_sha,
                    'firstTs', left(coalesce(p_payload->'meta'->>'firstTs', ''), 40),
                    'lastTs', left(coalesce(p_payload->'meta'->>'lastTs', ''), 40),
                    'importedVia', 'web',
                    'importedAt', now()
                  ),
                  now(), now()
                ) RETURNING id INTO v_id;

                INSERT INTO public.jobs (guild_id, type, payload, run_after)
                VALUES ('dm:' || did, 'chat-import', jsonb_build_object('importId', v_id), now())
                RETURNING id INTO v_job;
                PERFORM pg_notify('jobs', v_job::text);

                RETURN json_build_object('import_id', v_id, 'status', 'queued', 'reused', false);
              END
              $body$
            $dfn$;
          END IF;
        END $web$
      `;
    },
  },
  {
    version: 52,
    name: "v52_link_code_relink_guard",
    up: async (sql) => {
      // claim_link_code guarded the TARGET Discord id against double-linking
      // but not the CLAIMANT: an account already linked to Discord A could
      // claim B's code and the UPDATE silently stole the link, leaving A's
      // profile/billing orphaned. Re-linking stays possible via an explicit
      // unlink_discord() first — never as a side effect of claiming a code.
      await sql`
        DO $web$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth')
             AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'link_codes') THEN
            EXECUTE $rpc$
              CREATE OR REPLACE FUNCTION public.claim_link_code(p_code text)
              RETURNS void
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
                rec record;
                n integer;
                norm text := upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g'));
              BEGIN
                IF uid IS NULL THEN
                  RAISE EXCEPTION 'not authenticated';
                END IF;
                -- Codes are XXXX-XXXX but users drop the dash — normalize to
                -- the stored form before lookup.
                IF length(norm) <> 8 THEN
                  RAISE EXCEPTION 'invalid_code: that code does not exist — check it and try again';
                END IF;
                norm := substr(norm, 1, 4) || '-' || substr(norm, 5, 4);
                -- FOR UPDATE serializes concurrent claims of the same code —
                -- the second claimant sees the first's claimed_by, not a
                -- duplicate-key error.
                SELECT * INTO rec FROM public.link_codes
                WHERE code = norm
                FOR UPDATE;
                IF NOT FOUND THEN
                  RAISE EXCEPTION 'invalid_code: that code does not exist — check it and try again';
                END IF;
                IF rec.claimed_by IS NOT NULL THEN
                  RAISE EXCEPTION 'code_used: that code was already claimed — run /link again for a fresh one';
                END IF;
                IF rec.expires_at < now() THEN
                  RAISE EXCEPTION 'code_expired: that code expired — run /link again for a fresh one';
                END IF;
                IF EXISTS (
                  SELECT 1 FROM public.web_profiles
                  WHERE discord_user_id = rec.discord_user_id AND id <> uid
                ) THEN
                  RAISE EXCEPTION 'discord_already_linked: this Discord account is already linked to a different Characterly account';
                END IF;
                -- The claimant's own link is a one-way door inside this RPC:
                -- already linked to a DIFFERENT Discord account → must unlink
                -- explicitly first, or a stray code silently hijacks the link.
                IF EXISTS (
                  SELECT 1 FROM public.web_profiles
                  WHERE id = uid AND discord_user_id IS NOT NULL AND discord_user_id <> rec.discord_user_id
                ) THEN
                  RAISE EXCEPTION 'account_already_linked: this Characterly account is already linked to a different Discord account — unlink it first';
                END IF;
                UPDATE public.web_profiles
                SET discord_user_id = rec.discord_user_id,
                    discord_username = rec.discord_username,
                    discord_avatar_url = rec.discord_avatar_url,
                    updated_at = now()
                WHERE id = uid;
                GET DIAGNOSTICS n = ROW_COUNT;
                IF n = 0 THEN
                  RAISE EXCEPTION 'no_profile: account row missing — contact support';
                END IF;
                UPDATE public.link_codes SET claimed_by = uid WHERE code = rec.code;
              END
              $body$
            $rpc$;
            EXECUTE 'REVOKE ALL ON FUNCTION public.claim_link_code(text) FROM PUBLIC';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION public.claim_link_code(text) FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.claim_link_code(text) TO authenticated';
            END IF;
          END IF;
        END $web$
      `;
    },
    down: async (sql) => {
      // Restore the v38 body verbatim — same function minus the relink guard.
      await sql`
        DO $web$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth')
             AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'link_codes') THEN
            EXECUTE $rpc$
              CREATE OR REPLACE FUNCTION public.claim_link_code(p_code text)
              RETURNS void
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
                rec record;
                n integer;
                norm text := upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g'));
              BEGIN
                IF uid IS NULL THEN
                  RAISE EXCEPTION 'not authenticated';
                END IF;
                IF length(norm) <> 8 THEN
                  RAISE EXCEPTION 'invalid_code: that code does not exist — check it and try again';
                END IF;
                norm := substr(norm, 1, 4) || '-' || substr(norm, 5, 4);
                SELECT * INTO rec FROM public.link_codes
                WHERE code = norm
                FOR UPDATE;
                IF NOT FOUND THEN
                  RAISE EXCEPTION 'invalid_code: that code does not exist — check it and try again';
                END IF;
                IF rec.claimed_by IS NOT NULL THEN
                  RAISE EXCEPTION 'code_used: that code was already claimed — run /link again for a fresh one';
                END IF;
                IF rec.expires_at < now() THEN
                  RAISE EXCEPTION 'code_expired: that code expired — run /link again for a fresh one';
                END IF;
                IF EXISTS (
                  SELECT 1 FROM public.web_profiles
                  WHERE discord_user_id = rec.discord_user_id AND id <> uid
                ) THEN
                  RAISE EXCEPTION 'discord_already_linked: this Discord account is already linked to a different Characterly account';
                END IF;
                UPDATE public.web_profiles
                SET discord_user_id = rec.discord_user_id,
                    discord_username = rec.discord_username,
                    discord_avatar_url = rec.discord_avatar_url,
                    updated_at = now()
                WHERE id = uid;
                GET DIAGNOSTICS n = ROW_COUNT;
                IF n = 0 THEN
                  RAISE EXCEPTION 'no_profile: account row missing — contact support';
                END IF;
                UPDATE public.link_codes SET claimed_by = uid WHERE code = rec.code;
              END
              $body$
            $rpc$;
          END IF;
        END $web$
      `;
    },
  },

  // ── v53: web hardening follow-ups ─────────────────────────────────────────
  // Three gaps from the web-surface review:
  //  1. v52 stopped claim_link_code silently re-linking an already-linked
  //     account — but the OAuth lane (linkIdentity → auth.identities INSERT →
  //     sync_discord_identity) stamped discord_user_id unconditionally, so an
  //     OAuth link could still swap A for B without an explicit unlink.
  //  2. import_companion_card accepted any https:// avatar URL — fine while
  //     avatars only render inside Discord's proxy or the owner's dashboard,
  //     but a tracking pixel anywhere else. Now only the caller's own
  //     card-avatars bucket path counts; anything else strips to NULL.
  //  3. card-avatars write policies scope paths to the uid folder but never
  //     bounded object COUNT — a user could park unlimited 8 MB blobs. A
  //     storage.objects insert trigger caps each folder at 50 (imports
  //     dedupe by sha256 name, so the ceiling is far above legitimate use).
  {
    version: 53,
    name: "v53_web_hardening",
    up: async (sql) => {
      await sql`
        DO $web$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
            -- v38 body + the claimant-side relink guard (same policy and error
            -- tag as v52's claim_link_code).
            EXECUTE $fn$
              CREATE OR REPLACE FUNCTION internal.sync_discord_identity()
              RETURNS trigger
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              BEGIN
                IF TG_OP = 'INSERT' AND new.provider = 'discord' THEN
                  IF EXISTS (
                    SELECT 1 FROM public.web_profiles
                    WHERE discord_user_id = new.provider_id AND id <> new.user_id
                  ) THEN
                    RAISE EXCEPTION 'discord_already_linked: this Discord account is already linked to a different Characterly account';
                  END IF;
                  -- Already linked to a DIFFERENT Discord → explicit
                  -- unlink_discord() first; OAuth must not silently swap.
                  IF EXISTS (
                    SELECT 1 FROM public.web_profiles
                    WHERE id = new.user_id AND discord_user_id IS NOT NULL
                      AND discord_user_id <> new.provider_id
                  ) THEN
                    RAISE EXCEPTION 'account_already_linked: this Characterly account is already linked to a different Discord account — unlink it first';
                  END IF;
                  UPDATE public.web_profiles
                  SET discord_user_id = new.provider_id,
                      discord_username = coalesce(
                        nullif(new.identity_data->>'full_name', ''),
                        nullif(new.identity_data->>'name', ''),
                        nullif(new.identity_data->'custom_claims'->>'global_name', '')
                      ),
                      discord_avatar_url = nullif(new.identity_data->>'avatar_url', ''),
                      updated_at = now()
                  WHERE id = new.user_id;
                  RETURN new;
                END IF;
                IF TG_OP = 'DELETE' AND old.provider = 'discord' THEN
                  -- Guard on the exact provider_id so a re-link to a different
                  -- Discord account isn't clobbered by the old row's delete.
                  UPDATE public.web_profiles
                  SET discord_user_id = NULL, discord_username = NULL,
                      discord_avatar_url = NULL, updated_at = now()
                  WHERE id = old.user_id AND discord_user_id = old.provider_id;
                  RETURN old;
                END IF;
                RETURN coalesce(new, old);
              END
              $body$
            $fn$;
            EXECUTE 'REVOKE ALL ON FUNCTION internal.sync_discord_identity() FROM PUBLIC';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION internal.sync_discord_identity() FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION internal.sync_discord_identity() FROM authenticated';
            END IF;

            -- v43 body + avatar URL constrained to the caller's own
            -- card-avatars folder.
            EXECUTE $dfn$
              CREATE OR REPLACE FUNCTION public.import_companion_card(p_payload jsonb)
              RETURNS json
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
                did text;
                v_plan text;
                v_max_slots int;
                v_count int;
                v_listing bigint;
                v_companion bigint;
                v_name text;
                v_tagline text;
                v_voice text;
                v_traits text[] := '{}'::text[];
                v_dynamic text;
                v_backstory text;
                v_greeting text;
                v_avatar text;
                v_meta jsonb;
                v_tags jsonb := '[]'::jsonb;
                v_row record;
                v_adoption record;
              BEGIN
                IF uid IS NULL THEN
                  RAISE EXCEPTION 'not authenticated';
                END IF;
                SELECT discord_user_id, plan INTO did, v_plan
                  FROM public.web_profiles WHERE id = uid;
                IF did IS NULL THEN
                  RAISE EXCEPTION 'discord not linked';
                END IF;

                -- Pull + bound the mapped persona fields. The client supplies
                -- already-normalized fields; the server re-caps everything.
                v_name := left(btrim(coalesce(p_payload->>'name', '')), 64);
                IF v_name = '' THEN
                  RAISE EXCEPTION 'name required';
                END IF;
                v_tagline := left(coalesce(p_payload->>'tagline', ''), 200);
                v_voice := left(coalesce(p_payload->>'voice_persona', ''), 2000);
                v_dynamic := left(coalesce(p_payload->>'owner_dynamic', ''), 300);
                v_backstory := left(coalesce(p_payload->>'backstory', ''), 4000);
                v_greeting := left(coalesce(p_payload->>'greeting', ''), 2000);
                v_avatar := left(coalesce(p_payload->>'avatar_url', ''), 500);
                -- Only our own bucket's public URL counts — an arbitrary https
                -- URL would be a tracking pixel anywhere this avatar renders
                -- outside Discord's image proxy. The uid folder segment ties
                -- it to an object the caller could actually have uploaded.
                IF v_avatar <> '' AND v_avatar NOT LIKE '%/storage/v1/object/public/card-avatars/' || uid::text || '/%' THEN
                  v_avatar := '';
                END IF;
                IF jsonb_typeof(p_payload->'core_traits') = 'array' THEN
                  SELECT coalesce(array_agg(left(t, 48)), '{}'::text[]) INTO v_traits
                    FROM (SELECT jsonb_array_elements_text(p_payload->'core_traits') AS t
                          LIMIT 8) s;
                END IF;
                IF jsonb_typeof(p_payload->'import_meta'->'tags') = 'array' THEN
                  SELECT coalesce(jsonb_agg(left(el, 48)), '[]'::jsonb) INTO v_tags
                    FROM (SELECT jsonb_array_elements_text(p_payload->'import_meta'->'tags') AS el
                          LIMIT 10) s;
                END IF;
                -- The stamp is server-controlled: only the card's claimed
                -- metadata fields come from the payload, all bounded.
                v_meta := jsonb_build_object(
                  'source', 'character_card',
                  'spec', left(coalesce(p_payload->'import_meta'->>'spec', ''), 40),
                  'specVersion', left(coalesce(p_payload->'import_meta'->>'specVersion', ''), 20),
                  'creator', left(coalesce(p_payload->'import_meta'->>'creator', ''), 120),
                  'characterVersion', left(coalesce(p_payload->'import_meta'->>'characterVersion', ''), 40),
                  'filename', left(coalesce(p_payload->'import_meta'->>'filename', ''), 200),
                  'sha256', left(coalesce(p_payload->'import_meta'->>'sha256', ''), 80),
                  'tags', v_tags,
                  'importedVia', 'web',
                  'importedAt', now()
                );

                PERFORM pg_advisory_xact_lock(hashtext('adopt:' || did));
                -- Adoption slots — mirrors adoptListing's count (free 1,
                -- premium effectively uncapped). Keep in sync with
                -- FREE_ADOPTION_SLOTS.
                v_max_slots := CASE WHEN v_plan = 'premium' THEN 100 ELSE 1 END;

                -- Idempotent: the same file imported twice reuses its unlisted
                -- listing — an active adoption returns as-is, a dropped one
                -- revives, a listing without an adoption just gets its clone.
                SELECT l.id INTO v_listing FROM public.companion_listings l
                  WHERE l.creator_user_id = did AND l.status = 'unlisted'
                    AND l.import_meta->>'sha256' =
                        coalesce(p_payload->'import_meta'->>'sha256', '~~~')
                  LIMIT 1;
                IF v_listing IS NOT NULL THEN
                  SELECT a.companion_id, a.dropped_at, a.cooldown_until INTO v_adoption
                    FROM public.companion_adoptions a
                    WHERE a.user_id = did AND a.listing_id = v_listing;
                  -- Pure no-op: already on the roster — no quota consumed.
                  IF v_adoption.companion_id IS NOT NULL AND v_adoption.dropped_at IS NULL THEN
                    SELECT c.name INTO v_name FROM public.companions c
                      WHERE c.id = v_adoption.companion_id;
                    RETURN json_build_object(
                      'companion_id', v_adoption.companion_id, 'listing_id', v_listing,
                      'name', v_name, 'reused', true, 'revived', false);
                  END IF;
                  -- Revive and orphan-adopt both land an active adoption —
                  -- same gates as adoptListing, under the same advisory lock.
                  IF v_adoption.cooldown_until IS NOT NULL AND v_adoption.cooldown_until > now() THEN
                    RAISE EXCEPTION 're-adoption cooldown';
                  END IF;
                  SELECT COUNT(*) INTO v_count FROM public.companion_adoptions a
                    LEFT JOIN public.companion_listings l ON l.id = a.listing_id
                    WHERE a.user_id = did AND a.dropped_at IS NULL
                      AND (l.id IS NULL OR l.status <> 'banned');
                  IF v_count >= v_max_slots THEN
                    RAISE EXCEPTION 'adoption slot full';
                  END IF;
                  -- Anti-farming daily cap — keep in sync with
                  -- MARKET_ADOPT_DAILY_CAP.
                  SELECT COUNT(*) INTO v_count FROM public.companion_adoptions
                    WHERE user_id = did AND adopted_at > now() - interval '1 day';
                  IF v_count >= 20 THEN
                    RAISE EXCEPTION 'daily adoption cap';
                  END IF;
                  IF v_adoption.companion_id IS NULL THEN
                    SELECT l.* INTO v_row FROM public.companion_listings l WHERE l.id = v_listing;
                    INSERT INTO public.companions (
                      owner_user_id, name, avatar_url, voice_persona, core_traits,
                      owner_dynamic, backstory, onboarding_state, onboarding_turns,
                      kind, adopted_from_listing_id, listing_version, persona_source,
                      import_meta, created_at, updated_at
                    ) VALUES (
                      did, v_row.name, v_row.avatar_url, v_row.voice_persona,
                      v_row.core_traits, v_row.owner_dynamic, v_row.backstory,
                      'active', 0, 'adopted', v_listing, v_row.version,
                      'card_import', v_row.import_meta, now(), now()
                    )
                    RETURNING id INTO v_companion;
                    INSERT INTO public.companion_adoptions (user_id, listing_id, companion_id, adopted_at)
                    VALUES (did, v_listing, v_companion, now());
                    RETURN json_build_object(
                      'companion_id', v_companion, 'listing_id', v_listing,
                      'name', v_row.name, 'reused', true, 'revived', true);
                  END IF;
                  UPDATE public.companion_adoptions
                    SET dropped_at = NULL, cooldown_until = NULL, adopted_at = now()
                    WHERE user_id = did AND listing_id = v_listing AND dropped_at IS NOT NULL;
                  SELECT c.name INTO v_name FROM public.companions c WHERE c.id = v_adoption.companion_id;
                  RETURN json_build_object(
                    'companion_id', v_adoption.companion_id, 'listing_id', v_listing,
                    'name', v_name, 'reused', true, 'revived', true);
                END IF;

                -- Private-import ceiling — keep in sync with CHARACTER_IMPORT_CAP.
                SELECT COUNT(*) INTO v_count FROM public.companion_listings
                 WHERE creator_user_id = did AND status = 'unlisted';
                IF v_count >= 25 THEN
                  RAISE EXCEPTION 'import cap reached';
                END IF;
                SELECT COUNT(*) INTO v_count FROM public.companion_adoptions a
                  LEFT JOIN public.companion_listings l ON l.id = a.listing_id
                  WHERE a.user_id = did AND a.dropped_at IS NULL
                    AND (l.id IS NULL OR l.status <> 'banned');
                IF v_count >= v_max_slots THEN
                  RAISE EXCEPTION 'adoption slot full';
                END IF;
                SELECT COUNT(*) INTO v_count FROM public.companion_adoptions
                  WHERE user_id = did AND adopted_at > now() - interval '1 day';
                IF v_count >= 20 THEN
                  RAISE EXCEPTION 'daily adoption cap';
                END IF;

                INSERT INTO public.companion_listings (
                  creator_user_id, source_companion_id, name, tagline, voice_persona,
                  core_traits, owner_dynamic, backstory, greeting, avatar_url,
                  version, status, persona_source, import_meta, created_at, updated_at
                ) VALUES (
                  did, NULL, v_name, v_tagline, v_voice, v_traits, v_dynamic,
                  v_backstory, v_greeting, nullif(v_avatar, ''),
                  1, 'unlisted', 'card_import', v_meta, now(), now()
                )
                RETURNING id INTO v_listing;

                INSERT INTO public.companion_persona_versions (listing_id, version, persona_json)
                VALUES (v_listing, 1, jsonb_build_object(
                  'name', v_name, 'tagline', v_tagline, 'voicePersona', v_voice,
                  'coreTraits', v_traits, 'ownerDynamic', v_dynamic,
                  'backstory', v_backstory, 'greeting', v_greeting,
                  'avatarUrl', nullif(v_avatar, '')))
                ON CONFLICT (listing_id, version) DO NOTHING;

                INSERT INTO public.companions (
                  owner_user_id, name, avatar_url, voice_persona, core_traits,
                  owner_dynamic, backstory, onboarding_state, onboarding_turns,
                  kind, adopted_from_listing_id, listing_version, persona_source,
                  import_meta, created_at, updated_at
                ) VALUES (
                  did, v_name, nullif(v_avatar, ''), v_voice, v_traits, v_dynamic,
                  v_backstory, 'active', 0, 'adopted', v_listing, 1,
                  'card_import', v_meta, now(), now()
                )
                RETURNING id INTO v_companion;

                INSERT INTO public.companion_adoptions (user_id, listing_id, companion_id, adopted_at)
                VALUES (did, v_listing, v_companion, now());

                -- First import claims the DM slot; later imports leave the
                -- user's existing pick alone.
                INSERT INTO public.user_bot_settings (discord_user_id, active_dm_companion_id)
                VALUES (did, v_companion)
                ON CONFLICT (discord_user_id) DO UPDATE
                  SET active_dm_companion_id = EXCLUDED.active_dm_companion_id
                  WHERE public.user_bot_settings.active_dm_companion_id IS NULL;

                RETURN json_build_object(
                  'companion_id', v_companion, 'listing_id', v_listing, 'name', v_name,
                  'reused', false, 'revived', false);
              END
              $body$
            $dfn$;
            EXECUTE 'REVOKE ALL ON FUNCTION public.import_companion_card(jsonb) FROM PUBLIC';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION public.import_companion_card(jsonb) FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.import_companion_card(jsonb) TO authenticated';
            END IF;
          END IF;
        END $web$
      `;

      // Per-folder object cap on card-avatars. Write policies already scope a
      // user to their uid folder; this bounds what they can put in it. Upserts
      // re-fire the INSERT trigger, so the count excludes new.name — a same-
      // name overwrite never double-counts against the cap.
      await sql`
        DO $sto$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'storage')
             AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'storage' AND tablename = 'objects') THEN
            EXECUTE 'CREATE SCHEMA IF NOT EXISTS internal';
            EXECUTE $fn$
              CREATE OR REPLACE FUNCTION internal.card_avatars_insert_cap()
              RETURNS trigger
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              BEGIN
                IF new.bucket_id <> 'card-avatars' THEN
                  RETURN new;
                END IF;
                IF (SELECT count(*) FROM storage.objects
                    WHERE bucket_id = 'card-avatars'
                      AND name <> new.name
                      AND (storage.foldername(name))[1] = (storage.foldername(new.name))[1]) >= 50 THEN
                  RAISE EXCEPTION 'avatar storage cap reached';
                END IF;
                RETURN new;
              END
              $body$
            $fn$;
            EXECUTE 'REVOKE ALL ON FUNCTION internal.card_avatars_insert_cap() FROM PUBLIC';
            EXECUTE 'DROP TRIGGER IF EXISTS card_avatars_insert_cap ON storage.objects';
            EXECUTE 'CREATE TRIGGER card_avatars_insert_cap BEFORE INSERT ON storage.objects FOR EACH ROW EXECUTE FUNCTION internal.card_avatars_insert_cap()';
          END IF;
        END $sto$
      `;
    },
    down: async (sql) => {
      await sql`
        DO $sto$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'storage')
             AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'storage' AND tablename = 'objects') THEN
            EXECUTE 'DROP TRIGGER IF EXISTS card_avatars_insert_cap ON storage.objects';
            EXECUTE 'DROP FUNCTION IF EXISTS internal.card_avatars_insert_cap()';
          END IF;
        END $sto$
      `;
      await sql`
        DO $web$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
            -- Restore the v38 sync body verbatim (no relink guard).
            EXECUTE $fn$
              CREATE OR REPLACE FUNCTION internal.sync_discord_identity()
              RETURNS trigger
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              BEGIN
                IF TG_OP = 'INSERT' AND new.provider = 'discord' THEN
                  IF EXISTS (
                    SELECT 1 FROM public.web_profiles
                    WHERE discord_user_id = new.provider_id AND id <> new.user_id
                  ) THEN
                    RAISE EXCEPTION 'discord_already_linked: this Discord account is already linked to a different Characterly account';
                  END IF;
                  UPDATE public.web_profiles
                  SET discord_user_id = new.provider_id,
                      discord_username = coalesce(
                        nullif(new.identity_data->>'full_name', ''),
                        nullif(new.identity_data->>'name', ''),
                        nullif(new.identity_data->'custom_claims'->>'global_name', '')
                      ),
                      discord_avatar_url = nullif(new.identity_data->>'avatar_url', ''),
                      updated_at = now()
                  WHERE id = new.user_id;
                  RETURN new;
                END IF;
                IF TG_OP = 'DELETE' AND old.provider = 'discord' THEN
                  UPDATE public.web_profiles
                  SET discord_user_id = NULL, discord_username = NULL,
                      discord_avatar_url = NULL, updated_at = now()
                  WHERE id = old.user_id AND discord_user_id = old.provider_id;
                  RETURN old;
                END IF;
                RETURN coalesce(new, old);
              END
              $body$
            $fn$;
            EXECUTE 'REVOKE ALL ON FUNCTION internal.sync_discord_identity() FROM PUBLIC';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION internal.sync_discord_identity() FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION internal.sync_discord_identity() FROM authenticated';
            END IF;
          END IF;
        END $web$
      `;
      // The v43 import_companion_card body is restored verbatim below — it
      // differs from v53's only in the avatar branch.
      await sql`
        DO $web$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth')
             AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'web_profiles') THEN
            EXECUTE $dfn$
              CREATE OR REPLACE FUNCTION public.import_companion_card(p_payload jsonb)
              RETURNS json
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
                did text;
                v_plan text;
                v_max_slots int;
                v_count int;
                v_listing bigint;
                v_companion bigint;
                v_name text;
                v_tagline text;
                v_voice text;
                v_traits text[] := '{}'::text[];
                v_dynamic text;
                v_backstory text;
                v_greeting text;
                v_avatar text;
                v_meta jsonb;
                v_tags jsonb := '[]'::jsonb;
                v_row record;
                v_adoption record;
              BEGIN
                IF uid IS NULL THEN
                  RAISE EXCEPTION 'not authenticated';
                END IF;
                SELECT discord_user_id, plan INTO did, v_plan
                  FROM public.web_profiles WHERE id = uid;
                IF did IS NULL THEN
                  RAISE EXCEPTION 'discord not linked';
                END IF;

                v_name := left(btrim(coalesce(p_payload->>'name', '')), 64);
                IF v_name = '' THEN
                  RAISE EXCEPTION 'name required';
                END IF;
                v_tagline := left(coalesce(p_payload->>'tagline', ''), 200);
                v_voice := left(coalesce(p_payload->>'voice_persona', ''), 2000);
                v_dynamic := left(coalesce(p_payload->>'owner_dynamic', ''), 300);
                v_backstory := left(coalesce(p_payload->>'backstory', ''), 4000);
                v_greeting := left(coalesce(p_payload->>'greeting', ''), 2000);
                v_avatar := left(coalesce(p_payload->>'avatar_url', ''), 500);
                IF v_avatar <> '' AND v_avatar NOT LIKE 'https://%' AND v_avatar NOT LIKE 'http://%' THEN
                  v_avatar := '';
                END IF;
                IF jsonb_typeof(p_payload->'core_traits') = 'array' THEN
                  SELECT coalesce(array_agg(left(t, 48)), '{}'::text[]) INTO v_traits
                    FROM (SELECT jsonb_array_elements_text(p_payload->'core_traits') AS t
                          LIMIT 8) s;
                END IF;
                IF jsonb_typeof(p_payload->'import_meta'->'tags') = 'array' THEN
                  SELECT coalesce(jsonb_agg(left(el, 48)), '[]'::jsonb) INTO v_tags
                    FROM (SELECT jsonb_array_elements_text(p_payload->'import_meta'->'tags') AS el
                          LIMIT 10) s;
                END IF;
                v_meta := jsonb_build_object(
                  'source', 'character_card',
                  'spec', left(coalesce(p_payload->'import_meta'->>'spec', ''), 40),
                  'specVersion', left(coalesce(p_payload->'import_meta'->>'specVersion', ''), 20),
                  'creator', left(coalesce(p_payload->'import_meta'->>'creator', ''), 120),
                  'characterVersion', left(coalesce(p_payload->'import_meta'->>'characterVersion', ''), 40),
                  'filename', left(coalesce(p_payload->'import_meta'->>'filename', ''), 200),
                  'sha256', left(coalesce(p_payload->'import_meta'->>'sha256', ''), 80),
                  'tags', v_tags,
                  'importedVia', 'web',
                  'importedAt', now()
                );

                PERFORM pg_advisory_xact_lock(hashtext('adopt:' || did));
                v_max_slots := CASE WHEN v_plan = 'premium' THEN 100 ELSE 1 END;

                SELECT l.id INTO v_listing FROM public.companion_listings l
                  WHERE l.creator_user_id = did AND l.status = 'unlisted'
                    AND l.import_meta->>'sha256' =
                        coalesce(p_payload->'import_meta'->>'sha256', '~~~')
                  LIMIT 1;
                IF v_listing IS NOT NULL THEN
                  SELECT a.companion_id, a.dropped_at, a.cooldown_until INTO v_adoption
                    FROM public.companion_adoptions a
                    WHERE a.user_id = did AND a.listing_id = v_listing;
                  IF v_adoption.companion_id IS NOT NULL AND v_adoption.dropped_at IS NULL THEN
                    SELECT c.name INTO v_name FROM public.companions c
                      WHERE c.id = v_adoption.companion_id;
                    RETURN json_build_object(
                      'companion_id', v_adoption.companion_id, 'listing_id', v_listing,
                      'name', v_name, 'reused', true, 'revived', false);
                  END IF;
                  IF v_adoption.cooldown_until IS NOT NULL AND v_adoption.cooldown_until > now() THEN
                    RAISE EXCEPTION 're-adoption cooldown';
                  END IF;
                  SELECT COUNT(*) INTO v_count FROM public.companion_adoptions a
                    LEFT JOIN public.companion_listings l ON l.id = a.listing_id
                    WHERE a.user_id = did AND a.dropped_at IS NULL
                      AND (l.id IS NULL OR l.status <> 'banned');
                  IF v_count >= v_max_slots THEN
                    RAISE EXCEPTION 'adoption slot full';
                  END IF;
                  SELECT COUNT(*) INTO v_count FROM public.companion_adoptions
                    WHERE user_id = did AND adopted_at > now() - interval '1 day';
                  IF v_count >= 20 THEN
                    RAISE EXCEPTION 'daily adoption cap';
                  END IF;
                  IF v_adoption.companion_id IS NULL THEN
                    SELECT l.* INTO v_row FROM public.companion_listings l WHERE l.id = v_listing;
                    INSERT INTO public.companions (
                      owner_user_id, name, avatar_url, voice_persona, core_traits,
                      owner_dynamic, backstory, onboarding_state, onboarding_turns,
                      kind, adopted_from_listing_id, listing_version, persona_source,
                      import_meta, created_at, updated_at
                    ) VALUES (
                      did, v_row.name, v_row.avatar_url, v_row.voice_persona,
                      v_row.core_traits, v_row.owner_dynamic, v_row.backstory,
                      'active', 0, 'adopted', v_listing, v_row.version,
                      'card_import', v_row.import_meta, now(), now()
                    )
                    RETURNING id INTO v_companion;
                    INSERT INTO public.companion_adoptions (user_id, listing_id, companion_id, adopted_at)
                    VALUES (did, v_listing, v_companion, now());
                    RETURN json_build_object(
                      'companion_id', v_companion, 'listing_id', v_listing,
                      'name', v_row.name, 'reused', true, 'revived', true);
                  END IF;
                  UPDATE public.companion_adoptions
                    SET dropped_at = NULL, cooldown_until = NULL, adopted_at = now()
                    WHERE user_id = did AND listing_id = v_listing AND dropped_at IS NOT NULL;
                  SELECT c.name INTO v_name FROM public.companions c WHERE c.id = v_adoption.companion_id;
                  RETURN json_build_object(
                    'companion_id', v_adoption.companion_id, 'listing_id', v_listing,
                    'name', v_name, 'reused', true, 'revived', true);
                END IF;

                SELECT COUNT(*) INTO v_count FROM public.companion_listings
                 WHERE creator_user_id = did AND status = 'unlisted';
                IF v_count >= 25 THEN
                  RAISE EXCEPTION 'import cap reached';
                END IF;
                SELECT COUNT(*) INTO v_count FROM public.companion_adoptions a
                  LEFT JOIN public.companion_listings l ON l.id = a.listing_id
                  WHERE a.user_id = did AND a.dropped_at IS NULL
                    AND (l.id IS NULL OR l.status <> 'banned');
                IF v_count >= v_max_slots THEN
                  RAISE EXCEPTION 'adoption slot full';
                END IF;
                SELECT COUNT(*) INTO v_count FROM public.companion_adoptions
                  WHERE user_id = did AND adopted_at > now() - interval '1 day';
                IF v_count >= 20 THEN
                  RAISE EXCEPTION 'daily adoption cap';
                END IF;

                INSERT INTO public.companion_listings (
                  creator_user_id, source_companion_id, name, tagline, voice_persona,
                  core_traits, owner_dynamic, backstory, greeting, avatar_url,
                  version, status, persona_source, import_meta, created_at, updated_at
                ) VALUES (
                  did, NULL, v_name, v_tagline, v_voice, v_traits, v_dynamic,
                  v_backstory, v_greeting, nullif(v_avatar, ''),
                  1, 'unlisted', 'card_import', v_meta, now(), now()
                )
                RETURNING id INTO v_listing;

                INSERT INTO public.companion_persona_versions (listing_id, version, persona_json)
                VALUES (v_listing, 1, jsonb_build_object(
                  'name', v_name, 'tagline', v_tagline, 'voicePersona', v_voice,
                  'coreTraits', v_traits, 'ownerDynamic', v_dynamic,
                  'backstory', v_backstory, 'greeting', v_greeting,
                  'avatarUrl', nullif(v_avatar, '')))
                ON CONFLICT (listing_id, version) DO NOTHING;

                INSERT INTO public.companions (
                  owner_user_id, name, avatar_url, voice_persona, core_traits,
                  owner_dynamic, backstory, onboarding_state, onboarding_turns,
                  kind, adopted_from_listing_id, listing_version, persona_source,
                  import_meta, created_at, updated_at
                ) VALUES (
                  did, v_name, nullif(v_avatar, ''), v_voice, v_traits, v_dynamic,
                  v_backstory, 'active', 0, 'adopted', v_listing, 1,
                  'card_import', v_meta, now(), now()
                )
                RETURNING id INTO v_companion;

                INSERT INTO public.companion_adoptions (user_id, listing_id, companion_id, adopted_at)
                VALUES (did, v_listing, v_companion, now());

                INSERT INTO public.user_bot_settings (discord_user_id, active_dm_companion_id)
                VALUES (did, v_companion)
                ON CONFLICT (discord_user_id) DO UPDATE
                  SET active_dm_companion_id = EXCLUDED.active_dm_companion_id
                  WHERE public.user_bot_settings.active_dm_companion_id IS NULL;

                RETURN json_build_object(
                  'companion_id', v_companion, 'listing_id', v_listing, 'name', v_name,
                  'reused', false, 'revived', false);
              END
              $body$
            $dfn$;
            EXECUTE 'REVOKE ALL ON FUNCTION public.import_companion_card(jsonb) FROM PUBLIC';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION public.import_companion_card(jsonb) FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.import_companion_card(jsonb) TO authenticated';
            END IF;
          END IF;
        END $web$
      `;
    },
  },

  // ── v54: adoptee chat threads ─────────────────────────────────────────────
  // Adopted companions live in named private threads under the house's
  // #adoptees channel — one thread per adoption, mapped back through
  // companion_adoptions.chat_thread_id. DMs belong to the awakened bond only.
  {
    version: 54,
    name: "v54_adoptee_threads",
    up: async (sql) => {
      await addColumn(sql, "companion_adoptions", "chat_thread_id TEXT");
      await sql`CREATE INDEX IF NOT EXISTS adoptions_thread ON companion_adoptions(chat_thread_id) WHERE chat_thread_id IS NOT NULL`;
    },
    down: async (sql) => {
      await sql`DROP INDEX IF EXISTS adoptions_thread`;
      await sql`ALTER TABLE companion_adoptions DROP COLUMN IF EXISTS chat_thread_id`;
    },
  },

  // ── v55: rolling "story so far" summaries ──────────────────────────────────
  // One row per (companion, scope, channel): a rolling first-person recap of
  // everything older than the live transcript window. `covered_until` is the
  // watermark — the summary job only folds in messages between it and the
  // live window's tail. `msgs_since` is the enqueue counter (reset atomically
  // when a job is claimed). `user_edited` marks a summary the owner rewrote —
  // the summarizer treats it as authoritative prior state.
  {
    version: 55,
    name: "v55_story_summaries",
    up: async (sql) => {
      await sql`
        CREATE TABLE IF NOT EXISTS conversation_summaries (
          id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          companion_id  BIGINT NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
          origin_scope  TEXT NOT NULL,
          channel_id    TEXT NOT NULL DEFAULT '',
          summary       TEXT NOT NULL DEFAULT '',
          user_edited   BOOLEAN NOT NULL DEFAULT FALSE,
          covered_until TIMESTAMPTZ,
          msgs_since    INTEGER NOT NULL DEFAULT 0,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(companion_id, origin_scope, channel_id)
        )
      `;
      // Same lockdown as v23/v25 — public table needs RLS on Supabase.
      await sql`ALTER TABLE conversation_summaries ENABLE ROW LEVEL SECURITY`;
    },
    down: async (sql) => {
      await sql`DROP TABLE IF EXISTS conversation_summaries`;
    },
  },

  // ── v56: fiction-scoped memories ──────────────────────────────────────────
  // `companion_id` on memories scopes a row to one character. NULL = a real
  // fact shared across every companion of the subject's; a set id = a
  // 'story_fact' (roleplay beat) that only that companion recalls. The old
  // four-column unique constraint becomes an expression index so NULL and
  // set ids don't collide — NULL is folded to 0 (ids are identity ≥1).
  {
    version: 56,
    name: "v56_story_facts",
    up: async (sql) => {
      // FK + CASCADE: deleting a companion deletes its story_facts outright —
      // fiction belongs to the character, so nothing should linger orphaned.
      await addColumn(sql, "memories", "companion_id BIGINT REFERENCES companions(id) ON DELETE CASCADE");
      await sql`ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_guild_id_subject_id_kind_content_key`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS memories_unique_key ON memories(guild_id, subject_id, kind, content, COALESCE(companion_id, 0))`;
      await sql`CREATE INDEX IF NOT EXISTS memories_companion ON memories(companion_id) WHERE companion_id IS NOT NULL`;
      // The cascade has to reach dependents too: evidence/history/event links
      // for a deleted memory must go with it, not block the delete. These were
      // previously un-cascaded because nothing ever hard-deleted a memories row
      // — guild purge removed dependents first by hand.
      await sql`ALTER TABLE memory_evidence DROP CONSTRAINT IF EXISTS memory_evidence_memory_id_fkey`;
      await sql`ALTER TABLE memory_evidence ADD CONSTRAINT memory_evidence_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE`;
      await sql`ALTER TABLE memory_history DROP CONSTRAINT IF EXISTS memory_history_memory_id_fkey`;
      await sql`ALTER TABLE memory_history ADD CONSTRAINT memory_history_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE`;
      await sql`ALTER TABLE event_memories DROP CONSTRAINT IF EXISTS event_memories_memory_id_fkey`;
      await sql`ALTER TABLE event_memories ADD CONSTRAINT event_memories_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE`;
    },
    down: async (sql) => {
      await sql`ALTER TABLE memory_evidence DROP CONSTRAINT IF EXISTS memory_evidence_memory_id_fkey`;
      await sql`ALTER TABLE memory_evidence ADD CONSTRAINT memory_evidence_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES memories(id)`;
      await sql`ALTER TABLE memory_history DROP CONSTRAINT IF EXISTS memory_history_memory_id_fkey`;
      await sql`ALTER TABLE memory_history ADD CONSTRAINT memory_history_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES memories(id)`;
      await sql`ALTER TABLE event_memories DROP CONSTRAINT IF EXISTS event_memories_memory_id_fkey`;
      await sql`ALTER TABLE event_memories ADD CONSTRAINT event_memories_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES memories(id)`;
      await sql`DROP INDEX IF EXISTS memories_companion`;
      await sql`DROP INDEX IF EXISTS memories_unique_key`;
      // Story facts let the same content exist once per companion — restoring
      // the 4-column constraint needs those rows collapsed first.
      await sql`
        DELETE FROM memories a USING memories b
        WHERE a.id > b.id AND a.guild_id = b.guild_id AND a.subject_id = b.subject_id
          AND a.kind = b.kind AND a.content = b.content
      `;
      await sql`ALTER TABLE memories DROP COLUMN IF EXISTS companion_id`;
      await sql`ALTER TABLE memories ADD CONSTRAINT memories_guild_id_subject_id_kind_content_key UNIQUE(guild_id, subject_id, kind, content)`;
    },
  },

  // ── v57: user memory control + digest consent ────────────────────────────
  // `pinned` on memories/companion_journal: user-asserted "never forget this"
  // rows — always recalled, excluded from prune/stale-quarantine.
  // `members.share_facts_with_companion_owners`: per-member opt-in for the
  // server→DM digest to relay THEIR facts into a companion owner's private
  // DM. Default off — before this, any consented member's lore could ride the
  // digest into someone else's inbox.
  // RPCs give the website dashboard a memory editor over the caller's own DM
  // scope — same auth pattern as my_companions (auth.uid → web_profiles →
  // discord_user_id resolved server-side; nothing is client-trusted).
  {
    version: 57,
    name: "v57_user_memory_control",
    up: async (sql) => {
      await addColumn(sql, "memories", "pinned BOOLEAN NOT NULL DEFAULT FALSE");
      await addColumn(sql, "companion_journal", "pinned BOOLEAN NOT NULL DEFAULT FALSE");
      await addColumn(sql, "members", "share_facts_with_companion_owners SMALLINT NOT NULL DEFAULT 0");
      await sql`CREATE INDEX IF NOT EXISTS memories_pinned ON memories(guild_id, subject_id) WHERE pinned`;

      await sql`
        DO $web$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth')
             AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'web_profiles') THEN

            -- Everything the caller's companion holds about them in their DM
            -- lane: their real facts (shared across their companions), this
            -- companion's story facts, its journal entries, and the rolling
            -- "story so far" recap. One round trip for the memory page.
            EXECUTE $dfn$
              CREATE OR REPLACE FUNCTION public.my_memory_overview(p_companion_id bigint)
              RETURNS json
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
                did text;
                v_scope text;
              BEGIN
                IF uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
                SELECT discord_user_id INTO did FROM public.web_profiles WHERE id = uid;
                IF did IS NULL THEN RAISE EXCEPTION 'discord not linked'; END IF;
                v_scope := 'dm:' || did;
                -- The companion must be on the caller's roster (owned or
                -- actively adopted) — otherwise this leaks a stranger's lane.
                IF NOT EXISTS (
                  SELECT 1 FROM public.companions c
                  WHERE c.id = p_companion_id
                    AND (c.owner_user_id = did OR EXISTS (
                      SELECT 1 FROM public.companion_adoptions a
                      WHERE a.companion_id = c.id AND a.user_id = did AND a.dropped_at IS NULL))
                ) THEN RAISE EXCEPTION 'not your companion'; END IF;

                RETURN json_build_object(
                  'memories', coalesce((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', m.id, 'kind', m.kind, 'content', m.content,
                      'status', m.status, 'confidence', m.confidence,
                      'pinned', m.pinned, 'subject_id', m.subject_id,
                      'created_at', m.created_at
                    ) ORDER BY m.pinned DESC, m.importance * m.confidence DESC)
                    FROM public.memories m
                    WHERE m.guild_id = v_scope AND m.status <> 'forgotten'
                      AND (m.subject_id = did
                           OR m.subject_id = 'companion:' || p_companion_id
                           OR m.companion_id = p_companion_id)
                  ), '[]'::jsonb),
                  'journal', coalesce((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', j.id, 'kind', j.kind, 'content', j.content,
                      'pinned', j.pinned, 'importance', j.importance,
                      'created_at', j.created_at
                    ) ORDER BY j.created_at DESC)
                    FROM public.companion_journal j
                    WHERE j.origin_scope = v_scope AND j.companion_id = p_companion_id
                      AND j.status = 'active'
                  ), '[]'::jsonb),
                  'summaries', coalesce((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', s.id, 'channel_id', s.channel_id, 'summary', s.summary,
                      'user_edited', s.user_edited, 'updated_at', s.updated_at
                    ))
                    FROM public.conversation_summaries s
                    WHERE s.origin_scope = v_scope AND s.companion_id = p_companion_id
                      AND s.summary <> ''
                  ), '[]'::jsonb)
                );
              END
              $body$
            $dfn$;

            -- Pin/unpin one of the caller's DM memories. Pins always ride the
            -- prompt; a user can only pin rows inside their own DM scope
            -- (their facts, their companion's facts, or that companion's
            -- story facts).
            EXECUTE $dfn2$
              CREATE OR REPLACE FUNCTION public.memory_pin(p_id bigint, p_pinned boolean)
              RETURNS void
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
                did text;
              BEGIN
                IF uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
                SELECT discord_user_id INTO did FROM public.web_profiles WHERE id = uid;
                IF did IS NULL THEN RAISE EXCEPTION 'discord not linked'; END IF;
                UPDATE public.memories m SET pinned = p_pinned, updated_at = NOW()
                WHERE m.id = p_id AND m.guild_id = 'dm:' || did
                  AND (m.subject_id = did
                       OR (m.subject_id LIKE 'companion:%' AND EXISTS (
                         SELECT 1 FROM public.companions c
                         WHERE c.id = substring(m.subject_id from 11)::bigint
                           AND (c.owner_user_id = did OR EXISTS (
                             SELECT 1 FROM public.companion_adoptions a
                             WHERE a.companion_id = c.id AND a.user_id = did AND a.dropped_at IS NULL))))
                       OR (m.companion_id IS NOT NULL AND EXISTS (
                         SELECT 1 FROM public.companions c
                         WHERE c.id = m.companion_id
                           AND (c.owner_user_id = did OR EXISTS (
                             SELECT 1 FROM public.companion_adoptions a
                             WHERE a.companion_id = c.id AND a.user_id = did AND a.dropped_at IS NULL)))));
                IF NOT FOUND THEN RAISE EXCEPTION 'not your memory'; END IF;
                INSERT INTO public.memory_history (memory_id, action, details_json)
                VALUES (p_id, 'web_pin', jsonb_build_object('pinned', p_pinned));
              END
              $body$
            $dfn2$;

            -- Edit the text of one of the caller's DM memories.
            EXECUTE $dfn3$
              CREATE OR REPLACE FUNCTION public.memory_update(p_id bigint, p_content text)
              RETURNS void
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
                did text;
                v_old text;
              BEGIN
                IF uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
                SELECT discord_user_id INTO did FROM public.web_profiles WHERE id = uid;
                IF did IS NULL THEN RAISE EXCEPTION 'discord not linked'; END IF;
                IF length(btrim(coalesce(p_content, ''))) < 2 THEN RAISE EXCEPTION 'empty content'; END IF;
                SELECT m.content INTO v_old FROM public.memories m
                WHERE m.id = p_id AND m.guild_id = 'dm:' || did
                  AND (m.subject_id = did
                       OR (m.subject_id LIKE 'companion:%' AND EXISTS (
                         SELECT 1 FROM public.companions c
                         WHERE c.id = substring(m.subject_id from 11)::bigint
                           AND (c.owner_user_id = did OR EXISTS (
                             SELECT 1 FROM public.companion_adoptions a
                             WHERE a.companion_id = c.id AND a.user_id = did AND a.dropped_at IS NULL))))
                       OR (m.companion_id IS NOT NULL AND EXISTS (
                         SELECT 1 FROM public.companions c
                         WHERE c.id = m.companion_id
                           AND (c.owner_user_id = did OR EXISTS (
                             SELECT 1 FROM public.companion_adoptions a
                             WHERE a.companion_id = c.id AND a.user_id = did AND a.dropped_at IS NULL)))));
                IF v_old IS NULL THEN RAISE EXCEPTION 'not your memory'; END IF;
                UPDATE public.memories SET content = left(p_content, 1000), status = 'active',
                  confidence = GREATEST(confidence, 0.9), updated_at = NOW(), last_confirmed_at = NOW()
                WHERE id = p_id;
                INSERT INTO public.memory_history (memory_id, action, details_json)
                VALUES (p_id, 'web_edit', jsonb_build_object('previousContent', left(v_old, 500)));
              END
              $body$
            $dfn3$;

            -- Forget (soft-delete) one of the caller's DM memories — same
            -- semantics as /forget in Discord.
            EXECUTE $dfn4$
              CREATE OR REPLACE FUNCTION public.memory_forget(p_id bigint)
              RETURNS void
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
                did text;
              BEGIN
                IF uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
                SELECT discord_user_id INTO did FROM public.web_profiles WHERE id = uid;
                IF did IS NULL THEN RAISE EXCEPTION 'discord not linked'; END IF;
                UPDATE public.memories m SET status = 'forgotten', pinned = FALSE, updated_at = NOW()
                WHERE m.id = p_id AND m.guild_id = 'dm:' || did
                  AND (m.subject_id = did
                       OR (m.subject_id LIKE 'companion:%' AND EXISTS (
                         SELECT 1 FROM public.companions c
                         WHERE c.id = substring(m.subject_id from 11)::bigint
                           AND (c.owner_user_id = did OR EXISTS (
                             SELECT 1 FROM public.companion_adoptions a
                             WHERE a.companion_id = c.id AND a.user_id = did AND a.dropped_at IS NULL))))
                       OR (m.companion_id IS NOT NULL AND EXISTS (
                         SELECT 1 FROM public.companions c
                         WHERE c.id = m.companion_id
                           AND (c.owner_user_id = did OR EXISTS (
                             SELECT 1 FROM public.companion_adoptions a
                             WHERE a.companion_id = c.id AND a.user_id = did AND a.dropped_at IS NULL)))));
                IF NOT FOUND THEN RAISE EXCEPTION 'not your memory'; END IF;
                INSERT INTO public.memory_history (memory_id, action, details_json)
                VALUES (p_id, 'web_forgot', '{}'::jsonb);
              END
              $body$
            $dfn4$;

            -- Drop one of the caller's companion's journal entries (their DM
            -- lane only — guild journal entries stay a Discord-side surface).
            EXECUTE $dfn5$
              CREATE OR REPLACE FUNCTION public.journal_forget(p_id bigint)
              RETURNS void
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
                did text;
              BEGIN
                IF uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
                SELECT discord_user_id INTO did FROM public.web_profiles WHERE id = uid;
                IF did IS NULL THEN RAISE EXCEPTION 'discord not linked'; END IF;
                UPDATE public.companion_journal j SET status = 'forgotten', pinned = FALSE
                WHERE j.id = p_id AND j.origin_scope = 'dm:' || did
                  AND EXISTS (SELECT 1 FROM public.companions c
                    WHERE c.id = j.companion_id
                      AND (c.owner_user_id = did OR EXISTS (
                        SELECT 1 FROM public.companion_adoptions a
                        WHERE a.companion_id = c.id AND a.user_id = did AND a.dropped_at IS NULL)));
                IF NOT FOUND THEN RAISE EXCEPTION 'not your journal entry'; END IF;
              END
              $body$
            $dfn5$;

            -- Owner-authored "story so far" — the editable story box. Writes
            -- mark user_edited so the summarizer folds around the owner's text.
            EXECUTE $dfn6$
              CREATE OR REPLACE FUNCTION public.story_summary_save(p_companion_id bigint, p_channel_id text, p_summary text)
              RETURNS void
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
                did text;
              BEGIN
                IF uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
                SELECT discord_user_id INTO did FROM public.web_profiles WHERE id = uid;
                IF did IS NULL THEN RAISE EXCEPTION 'discord not linked'; END IF;
                IF NOT EXISTS (
                  SELECT 1 FROM public.companions c
                  WHERE c.id = p_companion_id
                    AND (c.owner_user_id = did OR EXISTS (
                      SELECT 1 FROM public.companion_adoptions a
                      WHERE a.companion_id = c.id AND a.user_id = did AND a.dropped_at IS NULL))
                ) THEN RAISE EXCEPTION 'not your companion'; END IF;
                UPDATE public.conversation_summaries
                SET summary = left(coalesce(p_summary, ''), 4000), user_edited = TRUE, updated_at = NOW()
                WHERE companion_id = p_companion_id AND origin_scope = 'dm:' || did
                  AND channel_id = coalesce(p_channel_id, '');
                IF NOT FOUND THEN
                  INSERT INTO public.conversation_summaries (companion_id, origin_scope, channel_id, summary, user_edited)
                  VALUES (p_companion_id, 'dm:' || did, coalesce(p_channel_id, ''), left(coalesce(p_summary, ''), 4000), TRUE);
                END IF;
              END
              $body$
            $dfn6$;

            -- Same exposure as every other account RPC: authenticated only.
            -- REVOKE from PUBLIC is what actually removes the implicit grant.
            EXECUTE 'REVOKE ALL ON FUNCTION public.my_memory_overview(bigint) FROM PUBLIC';
            EXECUTE 'REVOKE ALL ON FUNCTION public.memory_pin(bigint, boolean) FROM PUBLIC';
            EXECUTE 'REVOKE ALL ON FUNCTION public.memory_update(bigint, text) FROM PUBLIC';
            EXECUTE 'REVOKE ALL ON FUNCTION public.memory_forget(bigint) FROM PUBLIC';
            EXECUTE 'REVOKE ALL ON FUNCTION public.journal_forget(bigint) FROM PUBLIC';
            EXECUTE 'REVOKE ALL ON FUNCTION public.story_summary_save(bigint, text, text) FROM PUBLIC';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION public.my_memory_overview(bigint) FROM anon';
              EXECUTE 'REVOKE ALL ON FUNCTION public.memory_pin(bigint, boolean) FROM anon';
              EXECUTE 'REVOKE ALL ON FUNCTION public.memory_update(bigint, text) FROM anon';
              EXECUTE 'REVOKE ALL ON FUNCTION public.memory_forget(bigint) FROM anon';
              EXECUTE 'REVOKE ALL ON FUNCTION public.journal_forget(bigint) FROM anon';
              EXECUTE 'REVOKE ALL ON FUNCTION public.story_summary_save(bigint, text, text) FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.my_memory_overview(bigint) TO authenticated';
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.memory_pin(bigint, boolean) TO authenticated';
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.memory_update(bigint, text) TO authenticated';
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.memory_forget(bigint) TO authenticated';
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.journal_forget(bigint) TO authenticated';
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.story_summary_save(bigint, text, text) TO authenticated';
            END IF;
          END IF;
        END
        $web$
      `;
    },
    down: async (sql) => {
      await sql`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
            DROP FUNCTION IF EXISTS public.my_memory_overview(bigint);
            DROP FUNCTION IF EXISTS public.memory_pin(bigint, boolean);
            DROP FUNCTION IF EXISTS public.memory_update(bigint, text);
            DROP FUNCTION IF EXISTS public.memory_forget(bigint);
            DROP FUNCTION IF EXISTS public.journal_forget(bigint);
            DROP FUNCTION IF EXISTS public.story_summary_save(bigint, text, text);
          END IF;
        END
        $$
      `;
      await sql`DROP INDEX IF EXISTS memories_pinned`;
      await sql`ALTER TABLE members DROP COLUMN IF EXISTS share_facts_with_companion_owners`;
      await sql`ALTER TABLE companion_journal DROP COLUMN IF EXISTS pinned`;
      await sql`ALTER TABLE memories DROP COLUMN IF EXISTS pinned`;
    },
  },

  // ── v58: dashboard memory-editor hardening ────────────────────────────────
  // Bug-fix pass over the v57 RPCs:
  //  • memory_pin / memory_update now refuse forgotten/superseded rows —
  //    editing a dead row used to silently resurrect it (superseded edits
  //    could twin the replacement). Pinning also activates live-but-gated
  //    rows (candidate/contested/quarantined), else "always recalled" lied.
  //  • The companion-subject check uses a numeric regex before the ::bigint
  //    cast — a non-numeric 'companion:x' subject would 500 the call.
  //  • story_summary_save upserts with covered_until=NOW() on insert, and an
  //    empty save is a reset (watermark parked at now), matching Discord's
  //    /companion story + reset-story — otherwise the next fold dragged the
  //    whole backlog into fresh "canon".
  //  • my_memory_overview no longer lists superseded rows.
  //  • journal_pin: the pin surface companion_journal.pinned was missing —
  //    the flag existed but nothing could set it.
  {
    version: 58,
    name: "v58_memory_editor_hardening",
    up: async (sql) => {
      await sql`
        DO $web$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth')
             AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'web_profiles') THEN

            EXECUTE $dfn$
              CREATE OR REPLACE FUNCTION public.my_memory_overview(p_companion_id bigint)
              RETURNS json
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
                did text;
                v_scope text;
              BEGIN
                IF uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
                SELECT discord_user_id INTO did FROM public.web_profiles WHERE id = uid;
                IF did IS NULL THEN RAISE EXCEPTION 'discord not linked'; END IF;
                v_scope := 'dm:' || did;
                IF NOT EXISTS (
                  SELECT 1 FROM public.companions c
                  WHERE c.id = p_companion_id
                    AND (c.owner_user_id = did OR EXISTS (
                      SELECT 1 FROM public.companion_adoptions a
                      WHERE a.companion_id = c.id AND a.user_id = did AND a.dropped_at IS NULL))
                ) THEN RAISE EXCEPTION 'not your companion'; END IF;

                RETURN json_build_object(
                  'memories', coalesce((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', m.id, 'kind', m.kind, 'content', m.content,
                      'status', m.status, 'confidence', m.confidence,
                      'pinned', m.pinned, 'subject_id', m.subject_id,
                      'created_at', m.created_at
                    ) ORDER BY m.pinned DESC, m.importance * m.confidence DESC)
                    FROM public.memories m
                    WHERE m.guild_id = v_scope AND m.status NOT IN ('forgotten','superseded')
                      AND (m.subject_id = did
                           OR m.subject_id = 'companion:' || p_companion_id
                           OR m.companion_id = p_companion_id)
                  ), '[]'::jsonb),
                  'journal', coalesce((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', j.id, 'kind', j.kind, 'content', j.content,
                      'pinned', j.pinned, 'importance', j.importance,
                      'created_at', j.created_at
                    ) ORDER BY j.created_at DESC)
                    FROM public.companion_journal j
                    WHERE j.origin_scope = v_scope AND j.companion_id = p_companion_id
                      AND j.status = 'active'
                  ), '[]'::jsonb),
                  'summaries', coalesce((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', s.id, 'channel_id', s.channel_id, 'summary', s.summary,
                      'user_edited', s.user_edited, 'updated_at', s.updated_at
                    ))
                    FROM public.conversation_summaries s
                    WHERE s.origin_scope = v_scope AND s.companion_id = p_companion_id
                      AND s.summary <> ''
                  ), '[]'::jsonb)
                );
              END
              $body$
            $dfn$;

            -- Pin/unpin a DM memory. Pinning is itself the assertion, so a
            -- candidate/contested/quarantined row promotes to active — a
            -- pinned row that stayed gated would never ride recall anyway.
            EXECUTE $dfn2$
              CREATE OR REPLACE FUNCTION public.memory_pin(p_id bigint, p_pinned boolean)
              RETURNS void
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
                did text;
              BEGIN
                IF uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
                SELECT discord_user_id INTO did FROM public.web_profiles WHERE id = uid;
                IF did IS NULL THEN RAISE EXCEPTION 'discord not linked'; END IF;
                UPDATE public.memories m SET pinned = p_pinned, updated_at = NOW(),
                  status = CASE WHEN p_pinned AND m.status IN ('candidate','contested','quarantined') THEN 'active' ELSE m.status END
                WHERE m.id = p_id AND m.guild_id = 'dm:' || did
                  AND m.status NOT IN ('forgotten','superseded')
                  AND (m.subject_id = did
                       OR (m.subject_id ~ '^companion:[0-9]+$' AND EXISTS (
                         SELECT 1 FROM public.companions c
                         WHERE c.id = substring(m.subject_id from 11)::bigint
                           AND (c.owner_user_id = did OR EXISTS (
                             SELECT 1 FROM public.companion_adoptions a
                             WHERE a.companion_id = c.id AND a.user_id = did AND a.dropped_at IS NULL))))
                       OR (m.companion_id IS NOT NULL AND EXISTS (
                         SELECT 1 FROM public.companions c
                         WHERE c.id = m.companion_id
                           AND (c.owner_user_id = did OR EXISTS (
                             SELECT 1 FROM public.companion_adoptions a
                             WHERE a.companion_id = c.id AND a.user_id = did AND a.dropped_at IS NULL)))));
                IF NOT FOUND THEN RAISE EXCEPTION 'not your memory'; END IF;
                INSERT INTO public.memory_history (memory_id, action, details_json)
                VALUES (p_id, 'web_pin', jsonb_build_object('pinned', p_pinned));
              END
              $body$
            $dfn2$;

            -- Edit the text of a live DM memory. Dead rows refuse — a status
            -- filter, not just the resurrect-to-active write.
            EXECUTE $dfn3$
              CREATE OR REPLACE FUNCTION public.memory_update(p_id bigint, p_content text)
              RETURNS void
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
                did text;
                v_old text;
              BEGIN
                IF uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
                SELECT discord_user_id INTO did FROM public.web_profiles WHERE id = uid;
                IF did IS NULL THEN RAISE EXCEPTION 'discord not linked'; END IF;
                IF length(btrim(coalesce(p_content, ''))) < 2 THEN RAISE EXCEPTION 'empty content'; END IF;
                SELECT m.content INTO v_old FROM public.memories m
                WHERE m.id = p_id AND m.guild_id = 'dm:' || did
                  AND m.status NOT IN ('forgotten','superseded')
                  AND (m.subject_id = did
                       OR (m.subject_id ~ '^companion:[0-9]+$' AND EXISTS (
                         SELECT 1 FROM public.companions c
                         WHERE c.id = substring(m.subject_id from 11)::bigint
                           AND (c.owner_user_id = did OR EXISTS (
                             SELECT 1 FROM public.companion_adoptions a
                             WHERE a.companion_id = c.id AND a.user_id = did AND a.dropped_at IS NULL))))
                       OR (m.companion_id IS NOT NULL AND EXISTS (
                         SELECT 1 FROM public.companions c
                         WHERE c.id = m.companion_id
                           AND (c.owner_user_id = did OR EXISTS (
                             SELECT 1 FROM public.companion_adoptions a
                             WHERE a.companion_id = c.id AND a.user_id = did AND a.dropped_at IS NULL)))));
                IF v_old IS NULL THEN RAISE EXCEPTION 'not your memory'; END IF;
                UPDATE public.memories SET content = left(p_content, 1000), status = 'active',
                  confidence = GREATEST(confidence, 0.9), updated_at = NOW(), last_confirmed_at = NOW()
                WHERE id = p_id;
                INSERT INTO public.memory_history (memory_id, action, details_json)
                VALUES (p_id, 'web_edit', jsonb_build_object('previousContent', left(v_old, 500)));
              END
              $body$
            $dfn3$;

            -- Forget (soft-delete) a DM memory — same semantics as /forget.
            EXECUTE $dfn4$
              CREATE OR REPLACE FUNCTION public.memory_forget(p_id bigint)
              RETURNS void
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
                did text;
              BEGIN
                IF uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
                SELECT discord_user_id INTO did FROM public.web_profiles WHERE id = uid;
                IF did IS NULL THEN RAISE EXCEPTION 'discord not linked'; END IF;
                UPDATE public.memories m SET status = 'forgotten', pinned = FALSE, updated_at = NOW()
                WHERE m.id = p_id AND m.guild_id = 'dm:' || did
                  AND (m.subject_id = did
                       OR (m.subject_id ~ '^companion:[0-9]+$' AND EXISTS (
                         SELECT 1 FROM public.companions c
                         WHERE c.id = substring(m.subject_id from 11)::bigint
                           AND (c.owner_user_id = did OR EXISTS (
                             SELECT 1 FROM public.companion_adoptions a
                             WHERE a.companion_id = c.id AND a.user_id = did AND a.dropped_at IS NULL))))
                       OR (m.companion_id IS NOT NULL AND EXISTS (
                         SELECT 1 FROM public.companions c
                         WHERE c.id = m.companion_id
                           AND (c.owner_user_id = did OR EXISTS (
                             SELECT 1 FROM public.companion_adoptions a
                             WHERE a.companion_id = c.id AND a.user_id = did AND a.dropped_at IS NULL)))));
                IF NOT FOUND THEN RAISE EXCEPTION 'not your memory'; END IF;
                INSERT INTO public.memory_history (memory_id, action, details_json)
                VALUES (p_id, 'web_forgot', '{}'::jsonb);
              END
              $body$
            $dfn4$;

            -- Pin/unpin a journal entry — the missing counterpart to
            -- journal_forget. Pinned entries always ride recall and never
            -- prune; only the caller's own DM lane is writable.
            EXECUTE $dfn5$
              CREATE OR REPLACE FUNCTION public.journal_pin(p_id bigint, p_pinned boolean)
              RETURNS void
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
                did text;
              BEGIN
                IF uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
                SELECT discord_user_id INTO did FROM public.web_profiles WHERE id = uid;
                IF did IS NULL THEN RAISE EXCEPTION 'discord not linked'; END IF;
                UPDATE public.companion_journal j SET pinned = p_pinned
                WHERE j.id = p_id AND j.origin_scope = 'dm:' || did AND j.status = 'active'
                  AND EXISTS (SELECT 1 FROM public.companions c
                    WHERE c.id = j.companion_id
                      AND (c.owner_user_id = did OR EXISTS (
                        SELECT 1 FROM public.companion_adoptions a
                        WHERE a.companion_id = c.id AND a.user_id = did AND a.dropped_at IS NULL)));
                IF NOT FOUND THEN RAISE EXCEPTION 'not your journal entry'; END IF;
              END
              $body$
            $dfn5$;

            EXECUTE $dfn6$
              CREATE OR REPLACE FUNCTION public.journal_forget(p_id bigint)
              RETURNS void
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
                did text;
              BEGIN
                IF uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
                SELECT discord_user_id INTO did FROM public.web_profiles WHERE id = uid;
                IF did IS NULL THEN RAISE EXCEPTION 'discord not linked'; END IF;
                UPDATE public.companion_journal j SET status = 'forgotten', pinned = FALSE
                WHERE j.id = p_id AND j.origin_scope = 'dm:' || did
                  AND EXISTS (SELECT 1 FROM public.companions c
                    WHERE c.id = j.companion_id
                      AND (c.owner_user_id = did OR EXISTS (
                        SELECT 1 FROM public.companion_adoptions a
                        WHERE a.companion_id = c.id AND a.user_id = did AND a.dropped_at IS NULL)));
                IF NOT FOUND THEN RAISE EXCEPTION 'not your journal entry'; END IF;
              END
              $body$
            $dfn6$;

            -- Owner-authored "story so far". Upserts so a first write on a
            -- rowless lane lands; covered_until=NOW() on insert keeps a fresh
            -- canon from dragging the whole backlog in on the next fold. An
            -- empty save is a reset — the watermark parks at now instead of
            -- rewinding to epoch.
            EXECUTE $dfn7$
              CREATE OR REPLACE FUNCTION public.story_summary_save(p_companion_id bigint, p_channel_id text, p_summary text)
              RETURNS void
              LANGUAGE plpgsql
              SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                uid uuid := auth.uid();
                did text;
              BEGIN
                IF uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
                SELECT discord_user_id INTO did FROM public.web_profiles WHERE id = uid;
                IF did IS NULL THEN RAISE EXCEPTION 'discord not linked'; END IF;
                IF NOT EXISTS (
                  SELECT 1 FROM public.companions c
                  WHERE c.id = p_companion_id
                    AND (c.owner_user_id = did OR EXISTS (
                      SELECT 1 FROM public.companion_adoptions a
                      WHERE a.companion_id = c.id AND a.user_id = did AND a.dropped_at IS NULL))
                ) THEN RAISE EXCEPTION 'not your companion'; END IF;
                IF length(btrim(coalesce(p_summary, ''))) > 0 THEN
                  INSERT INTO public.conversation_summaries (companion_id, origin_scope, channel_id, summary, user_edited, covered_until)
                  VALUES (p_companion_id, 'dm:' || did, coalesce(p_channel_id, ''), left(p_summary, 4000), TRUE, NOW())
                  ON CONFLICT (companion_id, origin_scope, channel_id)
                  DO UPDATE SET summary = EXCLUDED.summary, user_edited = TRUE, updated_at = NOW();
                ELSE
                  UPDATE public.conversation_summaries
                  SET summary = '', user_edited = FALSE, covered_until = NOW(), msgs_since = 0, updated_at = NOW()
                  WHERE companion_id = p_companion_id AND origin_scope = 'dm:' || did
                    AND channel_id = coalesce(p_channel_id, '');
                END IF;
              END
              $body$
            $dfn7$;

            -- journal_pin joins the same exposure contract as the other
            -- account RPCs (the rest were granted in v57).
            EXECUTE 'REVOKE ALL ON FUNCTION public.journal_pin(bigint, boolean) FROM PUBLIC';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION public.journal_pin(bigint, boolean) FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.journal_pin(bigint, boolean) TO authenticated';
            END IF;
          END IF;
        END
        $web$
      `;
    },
    down: async (sql) => {
      // journal_pin is the only new surface — drop it. The v57 functions it
      // replaces were strictly less safe; downgrading them back isn't useful.
      await sql`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
            DROP FUNCTION IF EXISTS public.journal_pin(bigint, boolean);
          END IF;
        END
        $$
      `;
    },
  },

  // ── v59: multi-server marketplace deployments ─────────────────────────────
  // The marketplace + adoptees surfaces stop being house-only singletons:
  //  • guild_deployments — one row per participating server (the house row is
  //    seeded from env at boot, not here — env isn't visible to SQL).
  //    status lifecycle: granted → active → disabled.
  //  • listing_posts — the mirror map: one canonical companion_listings row
  //    fans out to one forum thread per deployed server. forum_thread_id stays
  //    as the house post pointer during the transition.
  //  • companion_listings.creator_tags — creator tag picks as NAMES (tag ids
  //    differ per forum; names are the sync currency).
  //  • companion_adoptions.chat_guild_id / chat_channel_id — which server hosts
  //    the adopter's private thread. NULL = house (no backfill needed).
  {
    version: 59,
    name: "v59_multi_server_marketplace",
    up: async (sql) => {
      await sql`
        CREATE TABLE IF NOT EXISTS guild_deployments (
          guild_id                TEXT PRIMARY KEY,
          status                  TEXT NOT NULL DEFAULT 'granted',
          marketplace_channel_id  TEXT,
          adoptees_channel_id     TEXT,
          category_id             TEXT,
          deployed_by             TEXT,
          deployed_at             TIMESTAMPTZ,
          last_error              TEXT,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`ALTER TABLE guild_deployments ENABLE ROW LEVEL SECURITY`;

      await sql`
        CREATE TABLE IF NOT EXISTS listing_posts (
          listing_id  BIGINT NOT NULL REFERENCES companion_listings(id) ON DELETE CASCADE,
          guild_id    TEXT NOT NULL,
          thread_id   TEXT,
          status      TEXT NOT NULL DEFAULT 'live',
          last_error  TEXT,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (listing_id, guild_id)
        )
      `;
      // Thread ids are globally unique — any mirror resolves to its listing.
      // Partial: failed rows carry NULL thread_id and must not collide.
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS listing_posts_thread_idx ON listing_posts(thread_id) WHERE thread_id IS NOT NULL`;
      await sql`ALTER TABLE listing_posts ENABLE ROW LEVEL SECURITY`;

      await sql`ALTER TABLE companion_listings ADD COLUMN IF NOT EXISTS creator_tags TEXT[] NOT NULL DEFAULT '{}'`;
      await sql`ALTER TABLE companion_adoptions ADD COLUMN IF NOT EXISTS chat_guild_id TEXT`;
      await sql`ALTER TABLE companion_adoptions ADD COLUMN IF NOT EXISTS chat_channel_id TEXT`;
      // No new thread index needed — v54's `adoptions_thread` is the same
      // (chat_thread_id) WHERE chat_thread_id IS NOT NULL.
    },
    down: async (sql) => {
      await sql`DROP TABLE IF EXISTS listing_posts`;
      await sql`DROP TABLE IF EXISTS guild_deployments`;
      // Cleans up the duplicate shipped in the first version of this
      // migration on DBs that already applied it.
      await sql`DROP INDEX IF EXISTS companion_adoptions_thread_idx`;
      await sql`ALTER TABLE companion_listings DROP COLUMN IF EXISTS creator_tags`;
      await sql`ALTER TABLE companion_adoptions DROP COLUMN IF EXISTS chat_guild_id`;
      await sql`ALTER TABLE companion_adoptions DROP COLUMN IF EXISTS chat_channel_id`;
    },
  },
  // ── v60: two-bucket tokens + exact refund clawback ─────────────────────────
  //  • web_profiles.purchased_balance — the persistent slice of credit_balance
  //    (packs, bonuses). The daily refill now tops up only the allowance
  //    (credit_balance − purchased_balance), so buying a pack no longer
  //    suppresses the free refill. Backfill treats the current balance as
  //    purchased first, capped at net unrefunded purchases (user-favorable).
  //  • credit_ledger.payment_intent — recorded at grant time so a refund
  //    matches the exact pack it reverses (was: newest pack, any charge).
  //  • 'grant_bonus' ledger kind — the launch bonus is no longer a 'purchase'
  //    (never clawed back as if it were a pack, labeled honestly).
  //  • clawback_pack prorates partial refunds by amount_refunded/amount and
  //    is cumulative per purchase, so successive partial refunds add up.
  {
    version: 60,
    name: "v60_token_buckets_exact_clawback",
    up: async (sql) => {
      await sql`
        DO $mig$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth')
             AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'credit_ledger') THEN
            EXECUTE 'ALTER TABLE public.web_profiles
              ADD COLUMN IF NOT EXISTS purchased_balance INT NOT NULL DEFAULT 0';
            EXECUTE 'ALTER TABLE public.credit_ledger ADD COLUMN IF NOT EXISTS payment_intent TEXT';
            EXECUTE 'CREATE INDEX IF NOT EXISTS credit_ledger_payment_intent
              ON public.credit_ledger (payment_intent) WHERE payment_intent IS NOT NULL';
            EXECUTE 'ALTER TABLE public.credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_kind_check';
            EXECUTE 'ALTER TABLE public.credit_ledger
              ADD CONSTRAINT credit_ledger_kind_check
              CHECK (kind IN (''grant_daily'',''grant_weekly'',''grant_bonus'',''spend'',''refund'',''adjust'',''purchase''))';
            EXECUTE $q$
              UPDATE public.credit_ledger SET kind = 'grant_bonus', reason = 'launch_bonus'
              WHERE kind = 'purchase' AND stripe_ref LIKE 'launch-bonus:%'
            $q$;
            EXECUTE $q$
              UPDATE public.web_profiles w SET purchased_balance = LEAST(GREATEST(w.credit_balance, 0), p.net)
              FROM (
                SELECT account_id, GREATEST(SUM(delta), 0)::int AS net FROM public.credit_ledger
                WHERE kind IN ('purchase', 'grant_bonus') OR (kind = 'refund' AND refunded_of IS NOT NULL)
                GROUP BY account_id
              ) p
              WHERE p.account_id = w.id
            $q$;

            EXECUTE 'DROP FUNCTION IF EXISTS public.grant_pack(uuid, int, text)';
            EXECUTE $rpc$
              CREATE OR REPLACE FUNCTION public.grant_pack(
                p_account uuid, p_tokens int, p_ref text,
                p_payment_intent text DEFAULT NULL, p_kind text DEFAULT 'purchase'
              ) RETURNS jsonb
              LANGUAGE plpgsql SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                bal integer;
                dup boolean := false;
              BEGIN
                IF p_tokens IS NULL OR p_tokens <= 0 THEN
                  RAISE EXCEPTION 'invalid_token_amount';
                END IF;
                IF p_kind NOT IN ('purchase', 'grant_bonus') THEN
                  RAISE EXCEPTION 'invalid_grant_kind';
                END IF;
                PERFORM 1 FROM public.web_profiles WHERE id = p_account FOR UPDATE;
                IF NOT FOUND THEN
                  RETURN jsonb_build_object('ok', false, 'reason', 'no_account');
                END IF;
                INSERT INTO public.credit_ledger (account_id, delta, kind, reason, stripe_ref, payment_intent, balance_after)
                SELECT p_account, p_tokens, p_kind,
                       CASE WHEN p_kind = 'grant_bonus'
                            THEN COALESCE(replace(split_part(p_ref, ':', 1), '-', '_'), 'grant_bonus')
                            ELSE 'pack_' || p_tokens END,
                       p_ref, p_payment_intent, w.credit_balance + p_tokens
                FROM public.web_profiles w WHERE w.id = p_account
                ON CONFLICT (stripe_ref) WHERE stripe_ref IS NOT NULL DO NOTHING;
                IF NOT FOUND THEN
                  dup := true;
                ELSE
                  UPDATE public.web_profiles
                  SET credit_balance = credit_balance + p_tokens,
                      purchased_balance = purchased_balance + p_tokens,
                      updated_at = now()
                  WHERE id = p_account;
                END IF;
                SELECT credit_balance INTO bal FROM public.web_profiles WHERE id = p_account;
                RETURN jsonb_build_object('ok', true, 'duplicate', dup, 'balance', bal);
              END
              $body$
            $rpc$;

            EXECUTE 'DROP FUNCTION IF EXISTS public.clawback_pack(uuid, text)';
            EXECUTE $rpc$
              CREATE OR REPLACE FUNCTION public.clawback_pack(
                p_account uuid, p_charge text,
                p_payment_intent text DEFAULT NULL,
                p_amount int DEFAULT NULL,
                p_amount_refunded int DEFAULT NULL,
                p_charged_at timestamptz DEFAULT NULL
              ) RETURNS jsonb
              LANGUAGE plpgsql SECURITY DEFINER
              SET search_path = ''
              AS $body$
              DECLARE
                v_purchase record;
                v_target integer;
                v_already integer;
                v_claw integer;
                v_bal integer;
                v_ref text;
              BEGIN
                PERFORM 1 FROM public.web_profiles WHERE id = p_account FOR UPDATE;
                IF NOT FOUND THEN
                  RETURN jsonb_build_object('ok', false, 'reason', 'no_account');
                END IF;
                IF p_charge IS NULL OR p_charge = '' THEN
                  RETURN jsonb_build_object('ok', false, 'reason', 'no_charge');
                END IF;
                v_ref := 'refund:' || p_charge || ':' || COALESCE(p_amount_refunded::text, 'full');
                IF EXISTS (SELECT 1 FROM public.credit_ledger WHERE stripe_ref = v_ref) THEN
                  SELECT credit_balance INTO v_bal FROM public.web_profiles WHERE id = p_account;
                  RETURN jsonb_build_object('ok', true, 'duplicate', true, 'balance', v_bal);
                END IF;
                -- Exact match: the pack this charge paid for.
                IF p_payment_intent IS NOT NULL THEN
                  SELECT l.id, l.delta INTO v_purchase FROM public.credit_ledger l
                  WHERE l.account_id = p_account AND l.kind = 'purchase' AND l.payment_intent = p_payment_intent
                  LIMIT 1;
                END IF;
                -- Pre-v60 packs carry no payment_intent: match the one granted
                -- right after this charge (checkout completes seconds later).
                -- The webhook omits p_charged_at for invoice (subscription)
                -- charges, so those never fall through to a pack.
                IF v_purchase.id IS NULL AND p_charged_at IS NOT NULL THEN
                  SELECT l.id, l.delta INTO v_purchase FROM public.credit_ledger l
                  WHERE l.account_id = p_account AND l.kind = 'purchase' AND l.payment_intent IS NULL
                    AND l.created_at BETWEEN p_charged_at - interval '5 minutes' AND p_charged_at + interval '1 hour'
                  ORDER BY abs(extract(epoch FROM l.created_at - p_charged_at))
                  LIMIT 1;
                END IF;
                IF v_purchase.id IS NULL THEN
                  -- Nothing to claw (subscription charge, unmatched) — keep
                  -- the audit row so the refund is visible in the ledger.
                  INSERT INTO public.credit_ledger (account_id, delta, kind, reason, stripe_ref, balance_after)
                  SELECT p_account, 0, 'adjust', 'stripe_refund:' || p_charge, v_ref, w.credit_balance
                  FROM public.web_profiles w WHERE w.id = p_account
                  ON CONFLICT (stripe_ref) WHERE stripe_ref IS NOT NULL DO NOTHING;
                  SELECT credit_balance INTO v_bal FROM public.web_profiles WHERE id = p_account;
                  RETURN jsonb_build_object('ok', true, 'clawed', 0, 'balance', v_bal);
                END IF;
                -- Prorate partial refunds; amount_refunded is cumulative on the
                -- charge, so claw only what earlier refunds haven't.
                v_target := CASE
                  WHEN p_amount IS NOT NULL AND p_amount > 0 AND p_amount_refunded IS NOT NULL
                    THEN LEAST(v_purchase.delta, round(v_purchase.delta::numeric * p_amount_refunded / p_amount)::int)
                  ELSE v_purchase.delta END;
                SELECT COALESCE(-SUM(delta), 0) INTO v_already FROM public.credit_ledger WHERE refunded_of = v_purchase.id;
                v_claw := v_target - v_already;
                IF v_claw <= 0 THEN
                  SELECT credit_balance INTO v_bal FROM public.web_profiles WHERE id = p_account;
                  RETURN jsonb_build_object('ok', true, 'duplicate', true, 'clawed', 0, 'balance', v_bal);
                END IF;
                -- Debit the pack slice first; anything already spent becomes
                -- allowance debt that the next daily grants pay down.
                UPDATE public.web_profiles
                  SET credit_balance = credit_balance - v_claw,
                      purchased_balance = GREATEST(purchased_balance - v_claw, 0),
                      updated_at = now()
                  WHERE id = p_account
                  RETURNING credit_balance INTO v_bal;
                INSERT INTO public.credit_ledger
                  (account_id, delta, kind, reason, stripe_ref, balance_after, refunded_of)
                VALUES (p_account, -v_claw, 'refund', 'stripe_refund:' || p_charge, v_ref, v_bal, v_purchase.id);
                RETURN jsonb_build_object('ok', true, 'duplicate', false, 'clawed', v_claw, 'balance', v_bal);
              END
              $body$
            $rpc$;

            EXECUTE 'REVOKE ALL ON FUNCTION public.grant_pack(uuid, int, text, text, text) FROM PUBLIC';
            EXECUTE 'REVOKE ALL ON FUNCTION public.clawback_pack(uuid, text, text, int, int, timestamptz) FROM PUBLIC';
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION public.grant_pack(uuid, int, text, text, text) FROM anon';
              EXECUTE 'REVOKE ALL ON FUNCTION public.clawback_pack(uuid, text, text, int, int, timestamptz) FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
              EXECUTE 'REVOKE ALL ON FUNCTION public.grant_pack(uuid, int, text, text, text) FROM authenticated';
              EXECUTE 'REVOKE ALL ON FUNCTION public.clawback_pack(uuid, text, text, int, int, timestamptz) FROM authenticated';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.grant_pack(uuid, int, text, text, text) TO service_role';
              EXECUTE 'GRANT EXECUTE ON FUNCTION public.clawback_pack(uuid, text, text, int, int, timestamptz) TO service_role';
            END IF;
          END IF;
        END $mig$
      `;
    },
    down: async (sql) => {
      // Reverts to single-bucket semantics: the new RPC signatures go, the
      // v32/v50 ones come back via a re-run of those bodies' shape (3-/2-arg),
      // and the bonus rows fold back into 'purchase'.
      await sql`
        DO $undo$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth')
             AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'credit_ledger') THEN
            EXECUTE 'DROP FUNCTION IF EXISTS public.grant_pack(uuid, int, text, text, text)';
            EXECUTE 'DROP FUNCTION IF EXISTS public.clawback_pack(uuid, text, text, int, int, timestamptz)';
            EXECUTE $q$UPDATE public.credit_ledger SET kind = 'purchase' WHERE kind = 'grant_bonus'$q$;
            EXECUTE 'ALTER TABLE public.credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_kind_check';
            EXECUTE 'ALTER TABLE public.credit_ledger
              ADD CONSTRAINT credit_ledger_kind_check
              CHECK (kind IN (''grant_daily'',''grant_weekly'',''spend'',''refund'',''adjust'',''purchase''))';
            EXECUTE 'DROP INDEX IF EXISTS public.credit_ledger_payment_intent';
            EXECUTE 'ALTER TABLE public.credit_ledger DROP COLUMN IF EXISTS payment_intent';
            EXECUTE 'ALTER TABLE public.web_profiles DROP COLUMN IF EXISTS purchased_balance';
          END IF;
        END $undo$
      `;
      // Re-create the prior RPCs by re-running their migrations' up bodies —
      // v31 first: it carries grant_pack's REVOKE/GRANT (a fresh function
      // would otherwise default to PUBLIC execute); v32 swaps in its body.
      await migrations.find(m => m.version === 31)!.up(sql);
      await migrations.find(m => m.version === 32)!.up(sql);
      await migrations.find(m => m.version === 50)!.up(sql);
    },
  },
  // ── v61: missed-signal sweep indexes ───────────────────────────────────────
  // The 15-minute sweep used to walk every dm: scope ever seen (a DISTINCT over
  // all of messages, then several queries per scope). It now asks for just the
  // scopes with work — these partial indexes keep both legs of that query off
  // a full scan: unclassified rows by age, and pending extraction marks.
  {
    version: 61,
    name: "v61_sweep_indexes",
    up: async (sql) => {
      await sql`CREATE INDEX IF NOT EXISTS messages_untriaged ON messages(created_at) WHERE triage_result IS NULL`;
      await sql`CREATE INDEX IF NOT EXISTS messages_pending_extract ON messages(guild_id) WHERE triage_result IN ('durable', 'regex', 'queued')`;
    },
    down: async (sql) => {
      await sql`DROP INDEX IF EXISTS messages_untriaged`;
      await sql`DROP INDEX IF EXISTS messages_pending_extract`;
    },
  },
  {
    // v62: first-party analytics. analytics_events = pseudonymous funnel rows
    // (which product step a Discord id reached — never message content);
    // metrics_daily = durable daily rollup of the in-process inc() counters.
    // Both are deny-all under RLS (bot-owned; the Data API sees nothing, same
    // posture as app_installs). analytics_opt_out on user_bot_settings gates
    // future tracking and is set by /opt-out, cleared by /opt-in.
    version: 62,
    name: "v62_analytics",
    up: async (sql) => {
      await sql`
        CREATE TABLE IF NOT EXISTS analytics_events (
          id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          discord_user_id  TEXT,
          event            TEXT NOT NULL,
          scope            TEXT,
          meta             JSONB NOT NULL DEFAULT '{}',
          created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS analytics_events_by_event ON analytics_events(event, created_at)`;
      await sql`CREATE INDEX IF NOT EXISTS analytics_events_by_user ON analytics_events(discord_user_id)`;
      await sql`ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY`;
      await sql`
        CREATE TABLE IF NOT EXISTS metrics_daily (
          day    DATE NOT NULL,
          name   TEXT NOT NULL,
          count  BIGINT NOT NULL DEFAULT 0,
          PRIMARY KEY (day, name)
        )
      `;
      await sql`ALTER TABLE metrics_daily ENABLE ROW LEVEL SECURITY`;
      await sql`ALTER TABLE user_bot_settings ADD COLUMN IF NOT EXISTS analytics_opt_out BOOLEAN NOT NULL DEFAULT FALSE`;
    },
    down: async (sql) => {
      await sql`DROP TABLE IF EXISTS analytics_events`;
      await sql`DROP TABLE IF EXISTS metrics_daily`;
      await sql`ALTER TABLE user_bot_settings DROP COLUMN IF EXISTS analytics_opt_out`;
    },
  },
  {
    // v63: self-serve deployments. grant_kind distinguishes ops-granted
    // ('ops') deployments from self-serve linked-account grants ('self') —
    // deploys stay attributable; ops revoke (status='disabled') still
    // requires an ops re-grant. login_channel_id tracks the deployed #log-in
    // link surface alongside the forum + adoptees ids.
    version: 63,
    name: "v63_self_serve_deployments",
    up: async (sql) => {
      await sql`ALTER TABLE guild_deployments ADD COLUMN IF NOT EXISTS grant_kind TEXT NOT NULL DEFAULT 'ops'`;
      await sql`ALTER TABLE guild_deployments ADD COLUMN IF NOT EXISTS login_channel_id TEXT`;
    },
    down: async (sql) => {
      await sql`ALTER TABLE guild_deployments DROP COLUMN IF EXISTS grant_kind`;
      await sql`ALTER TABLE guild_deployments DROP COLUMN IF EXISTS login_channel_id`;
    },
  },
  {
    // v64: server-side rating aggregates. The site shelf previously SELECTed
    // every listing_ratings row and averaged in JS — one row per listing here
    // keeps the index query bounded as ratings grow. A view (not a PostgREST
    // aggregate) because db-aggregates-enabled is not guaranteed on; the
    // security_invoker flag keeps base-table RLS semantics for non-service
    // roles. Column is `rating_count`, not `count` — PostgREST treats bare
    // `count` in select as its legacy count function, not a column.
    version: 64,
    name: "v64_listing_rating_stats_view",
    up: async (sql) => {
      await sql`
        CREATE OR REPLACE VIEW listing_rating_stats
        WITH (security_invoker = true) AS
        SELECT listing_id,
               avg(stars)::float8 AS avg,
               count(*)::int4     AS rating_count
        FROM listing_ratings
        GROUP BY listing_id
      `;
    },
    down: async (sql) => {
      await sql`DROP VIEW IF EXISTS listing_rating_stats`;
    },
  },
];

/** Highest known migration version — tests assert against this instead of a
 * hardcoded number so adding a migration doesn't silently stale them. */
export const LATEST_MIGRATION_VERSION = Math.max(...migrations.map(m => m.version));

export async function runMigrations(sql: Sql, targetVersion?: number): Promise<void> {
  // Ensure the base tables exist on a fresh database.
  await sql`
    CREATE TABLE IF NOT EXISTS messages (
      id         TEXT PRIMARY KEY,
      guild_id   TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      author_id  TEXT NOT NULL,
      author_name TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      author_is_bot BOOLEAN NOT NULL DEFAULT FALSE
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS memories (
      id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      guild_id            TEXT NOT NULL,
      subject_id          TEXT NOT NULL,
      kind                TEXT NOT NULL,
      content             TEXT NOT NULL,
      confidence          DOUBLE PRECISION NOT NULL,
      importance          DOUBLE PRECISION NOT NULL,
      mentions            INTEGER NOT NULL DEFAULT 1,
      confirmation_count  INTEGER NOT NULL DEFAULT 0,
      contradiction_count INTEGER NOT NULL DEFAULT 0,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_confirmed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_contradicted_at TIMESTAMPTZ,
      status              TEXT NOT NULL DEFAULT 'candidate',
      superseded_by       BIGINT,
      supersedes_memory_id BIGINT,
      explicitness        DOUBLE PRECISION NOT NULL DEFAULT 0.5,
      reason              TEXT NOT NULL DEFAULT '',
      UNIQUE(guild_id, subject_id, kind, content)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS memories_lookup ON memories(guild_id, subject_id, status, importance DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS messages_context ON messages(guild_id, channel_id, created_at DESC)`;
  await sql`
    CREATE TABLE IF NOT EXISTS memory_evidence (
      id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      memory_id               BIGINT NOT NULL REFERENCES memories(id),
      message_id              TEXT NOT NULL,
      author_id               TEXT NOT NULL,
      quote                   TEXT NOT NULL,
      reason                  TEXT NOT NULL,
      explicitness            DOUBLE PRECISION NOT NULL,
      observed_at             TIMESTAMPTZ NOT NULL,
      evidence_type           TEXT NOT NULL DEFAULT 'uncertain_inference',
      effect                  TEXT NOT NULL DEFAULT 'context',
      message_content_snapshot TEXT NOT NULL DEFAULT '',
      message_timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(memory_id, message_id)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS evidence_memory ON memory_evidence(memory_id, observed_at DESC)`;
  await sql`
    CREATE TABLE IF NOT EXISTS server_settings (
      guild_id          TEXT PRIMARY KEY,
      memory_enabled    SMALLINT NOT NULL DEFAULT 0,
      reply_enabled     SMALLINT NOT NULL DEFAULT 0,
      proactive_enabled SMALLINT NOT NULL DEFAULT 0,
      raw_retention_days INTEGER NOT NULL DEFAULT 30
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  const row = await sql<[{ version: number | null }]>`SELECT MAX(version) as version FROM schema_migrations`;
  const current = row[0].version ?? 0;
  const target = targetVersion ?? Math.max(...migrations.map(m => m.version));

  if (current === target) return;

  if (target > current) {
    for (const migration of migrations) {
      if (migration.version > current && migration.version <= target) {
        console.log(`Applying migration ${migration.version}: ${migration.name}`);
        await sql.begin(async sql => {
          // The pool's statement_timeout bounds migrations too — a heavy index
          // build would otherwise die mid-boot. Migrations are meant to finish.
          await sql`SET LOCAL statement_timeout = 0`;
          await migration.up(sql as unknown as Sql);
          await sql`INSERT INTO schema_migrations (version) VALUES (${migration.version}) ON CONFLICT DO NOTHING`;
        });
      }
    }
  } else {
    for (const migration of [...migrations].reverse()) {
      if (migration.version <= current && migration.version > target) {
        console.log(`Rolling back migration ${migration.version}: ${migration.name}`);
        await sql.begin(async sql => {
          await sql`SET LOCAL statement_timeout = 0`;
          await migration.down(sql as unknown as Sql);
          await sql`DELETE FROM schema_migrations WHERE version = ${migration.version}`;
        });
      }
    }
  }
}

export async function getMigrationVersion(sql: Sql): Promise<number> {
  const rows = await sql<[{ version: number | null }]>`SELECT MAX(version) as version FROM schema_migrations`;
  return rows[0].version ?? 0;
}
