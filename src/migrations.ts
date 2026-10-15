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

const migrations: Migration[] = [
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
    // archive, no replies, no member writes, excluded from server-build scans.
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
                    RAISE EXCEPTION 'discord_already_linked: this Discord account is already linked to a different Companionly account';
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
                  RAISE EXCEPTION 'discord_already_linked: this Discord account is already linked to a different Companionly account';
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
                  RAISE EXCEPTION 'discord_already_linked: this Discord account is already linked to a different Companionly account';
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
                  RAISE EXCEPTION 'discord_already_linked: this Discord account is already linked to a different Companionly account';
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
