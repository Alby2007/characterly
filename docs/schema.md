# Database Schema

Characterly stores all state in Postgres — Supabase in production, or any Postgres via `DATABASE_URL`. Tables are created on first run and evolved by the versioned migration system in `src/migrations.ts` (`v1`–`v28`).

**Supabase lockdown (v23+):** every `public`-schema table has `ENABLE ROW LEVEL SECURITY` with zero Data-API policies — deny-all for `anon`/`authenticated`, while the bot's `postgres` role bypasses RLS. The exceptions are the web-account tables (`web_profiles`, `link_codes`), which have their own policy/grant design documented below. All Supabase-specific DDL is conditional on the `auth` schema existing, so plain-Postgres test/local databases run every migration unchanged.

---

## Tables

### `companions`

Each user awakens **one permanent companion per account** in 1:1 DMs (`dm:<owner_user_id>`); once `onboarding_state = 'active'`, an awakened companion's identity is permanently locked. Marketplace adoptions (v34) add **cloned rows** for the same owner with `kind = 'adopted'` — one clone per adoption, owned by the adopter so billing, memories, journals, and guild presence all resolve per-adopter with zero special cases.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGINT PK | `GENERATED ALWAYS AS IDENTITY`; referenced as subject ID `companion:<id>` in `members`, `memories`, and `relationships` |
| `owner_user_id` | TEXT | Discord user ID of the companion's owner. Unique **only for `kind='awakened'`** — enforced by partial unique index `companions_one_awakened` (v34); adopted clones share the owner's id freely |
| `name` | TEXT | Companion's display name |
| `avatar_url` | TEXT NULL | Public image URL used for webhook avatars and profile cards |
| `voice_persona` | TEXT | How the companion talks and acts |
| `core_traits` | TEXT[] | Up to 8 core personality trait tags |
| `owner_dynamic` | TEXT | The companion's bond/relationship with their owner |
| `backstory` | TEXT | Optional slice-of-life background or lore |
| `onboarding_state` | TEXT | `'onboarding'` (mutable draft) or `'active'` (permanently locked; adopted clones insert as `'active'`) |
| `onboarding_turns` | INTEGER | Number of DM onboarding turns completed |
| `kind` | TEXT | `'awakened'` (default — the permanent bond) or `'adopted'` (marketplace clone synced from its listing) |
| `adopted_from_listing_id` | BIGINT NULL | For adopted clones: the `companion_listings` row they were cloned from |
| `listing_version` | INTEGER | Persona version the adopted clone was last synced to (0 for awakened) |
| `persona_source` | TEXT | `'authored'` (default — conversation-grown persona) or `'card_import'` (v42 — cloned from an imported character card) |
| `import_meta` | JSONB NULL | Import provenance: card spec/specVersion, claimed creator, filename, `sha256` of the source file, `importedVia` (`web`/`discord`), `importedAt` |
| `created_at` / `updated_at` | TIMESTAMPTZ | Creation and last-update timestamps |

**Indexes:** `companions_one_awakened` partial unique `(owner_user_id) WHERE kind='awakened'`; `companions_owner (owner_user_id)`; `companions_adopted_from (adopted_from_listing_id) WHERE adopted_from_listing_id IS NOT NULL`.

---

### `guild_companions`

Tracks which personal companions have been summoned into which Discord servers (v21).

| Column | Type | Notes |
|--------|------|-------|
| `guild_id` | TEXT | Discord server ID (composite PK) |
| `companion_id` | BIGINT | FK → `companions.id ON DELETE CASCADE` (composite PK) |
| `summoned_by` | TEXT | Discord user ID of the owner who summoned them |
| `active` | SMALLINT | `1` = active in server (`listGuildCompanions`); `0` = dismissed (`/companion dismiss`) |
| `summoned_at` | TIMESTAMPTZ | Timestamp of most recent summon |

**Index:** `guild_companions_lookup (guild_id, active)`.

---

### `webhook_messages`

Maps Discord webhook message IDs sent via `sendAsCompanion` back to the speaking companion and tracks consecutive companion-to-companion `chain_depth` (v21).

| Column | Type | Notes |
|--------|------|-------|
| `message_id` | TEXT PK | Discord message snowflake ID returned by the channel webhook |
| `guild_id` | TEXT | Discord server ID |
| `channel_id` | TEXT | Discord channel ID |
| `companion_id` | BIGINT | FK → `companions.id ON DELETE CASCADE` |
| `chain_depth` | INTEGER | `0` when replying to a human; increments on each companion-to-companion hop (capped by `MAX_COMPANION_CHAIN_DEPTH`) |
| `created_at` | TIMESTAMPTZ | Send timestamp |

**Index:** `webhook_messages_guild (guild_id, created_at DESC)`.

---

### `messages`

Raw Discord message archive. Purged on a rolling retention window.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | Discord message snowflake ID |
| `guild_id` | TEXT | Discord server ID |
| `channel_id` | TEXT | Discord channel ID |
| `author_id` | TEXT | Discord user ID |
| `author_name` | TEXT | Display name at time of message |
| `content` | TEXT | Full message text |
| `created_at` | TEXT | ISO-8601 timestamp |
| `triage_result` | TEXT \| NULL | Durability/extraction state (v6): `'regex'` passed the regex gate, `'durable'` flagged by LLM triage, `'noise'` rejected, `'queued'` has a live extract job (v17), `'dead'` its only job dead-lettered (terminal for the sweep, still reachable by `/profile-build`), `'extracted'` extraction ran (terminal for the sweep — a retried job resumes at contest/pipeline without re-extracting, and `/profile-build` may rescan an `'extracted'` row that produced no evidence rows). NULL = not yet triaged |
| `image_context` | TEXT \| NULL | Cached vision description for the message's image attachments (v33) — the extract job and reply paths share the first describe pass instead of re-billing |
| `reply_to_id` | TEXT \| NULL | Discord ID of the message this one replies to (v7) |
| `author_is_bot` | BOOLEAN | `true` when the author was another bot (v18) — archive-only context: the sweep never triages/extracts these rows, a queued extract job drops them, and they're excluded from profiles and the interaction graph |

**Index:** `messages_context (guild_id, channel_id, created_at DESC)` — used by `recentContext()`.

**Retention:** `deleteRawMessagesOlderThan(guildId, days)` deletes rows older than the configured window. Evidence quotes in `memory_evidence` are kept separately and survive this purge. Separately, `pruneDerivedData(guildId)` caps the append-only tables at 90 days: `memory_history`, `unresolved_names`, `alias_candidates`, and closed candidate-tier `events` (promoted `event` rows are kept) — plus `guild_usage` rows older than 30 days. `memory_evidence` is intentionally not pruned.

---

### `memories`

One row per curated fact, preference, episode, or piece of server lore. The core memory store.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `guild_id` | TEXT | Server scope |
| `subject_id` | TEXT | Discord user ID the memory is about, or `"server"` for lore |
| `subject_name` | TEXT | Display name at time of creation (v5) |
| `kind` | TEXT | `person_fact` · `person_preference` · `server_lore` · `episode` |
| `content` | TEXT | Human-readable memory statement |
| `confidence` | REAL | 0–1; deterministic (see `confidence.ts`) |
| `importance` | REAL | 0–1; kind-based default |
| `explicitness` | REAL | 0–1; evidence-type-based default |
| `mentions` | INTEGER | Confirmation count (incremented on each supporting evidence insert) |
| `confirmation_count` | INTEGER | Same as `mentions`; retained for query clarity |
| `contradiction_count` | INTEGER | Number of contradicting evidence rows |
| `status` | TEXT | See lifecycle states below |
| `superseded_by` | INTEGER | FK → `memories.id` of the replacement, when superseded |
| `embedding` | VECTOR NULL | Semantic-recall vector (v40) — written at save time or by the backfill sweep; un-dimensioned by design, dims enforced in code via `EMBED_DIMS` |
| `supersedes_memory_id` | INTEGER | FK → `memories.id` of the memory this one replaced |
| `net_score` | REAL | Age-weighted support−contradiction score; only set during `contested` (v2) |
| `frozen_confidence` | REAL | Confidence snapshot taken when memory first entered `contested`; cleared on resolution (v2) |
| `pattern_id` | INTEGER | FK → `behavioral_patterns.id`; set when an episode is consolidated (v2) |
| `primary_evidence_type` | TEXT | Evidence type of the first evidence row; enforces promotion gate in bulk maintenance (v3) |
| `event_id` | INTEGER | FK → `events.id`; set when memory is linked to an event (v4) |
| `reason` | TEXT | LLM-supplied explanation for why this memory was extracted |
| `created_at` | TEXT | ISO-8601 |
| `updated_at` | TEXT | ISO-8601 |
| `last_confirmed_at` | TEXT | ISO-8601; updated on each supporting evidence insert |
| `last_contradicted_at` | TEXT | ISO-8601; updated on contradicting evidence insert |

**Unique constraint:** `(guild_id, subject_id, kind, content)` — exact deduplication prevents duplicate rows for the same fact.

**Indexes:** `memories_lookup (guild_id, subject_id, status, importance DESC)`; `memories_content_trgm` — GIN trigram index (v11) powering the near-duplicate fallback in `saveMemory()`: when the exact key misses, the best `similarity(content)` row in the same `(guild_id, subject_id, kind)` scope is reinforced instead. Matches and near-misses are audited in `memory_history` as `dedup_matched` / `dedup_near_miss`.

**Semantic dedup:** the trigram path only catches lexically similar rephrasings. A nightly maintenance pass (`applyRetention`) hands each member's memory list to `Brain.dedupMemoriesBatch`, which returns `duplicate` groups and `contradicts` pairs. Confirmed duplicate groups merge via `applyDedupGroups`/`mergeDuplicate`: evidence moves to a deterministic canonical row (active > candidate, then confidence, then lowest id) — except rows colliding on `message_id`, which stay on the superseded loser because `memory_history.evidence_id` references them. The losers become `superseded` with `superseded_by` pointing at the canonical — never deleted. Canonical status/confidence are untouched (merging cannot promote). Guards drop groups that mix subjects, kinds, or non-live statuses; `episode` kind and `unknown` subjects are never offered. `contradicts` verdicts only log `dedup_contradiction` history rows — no status change.

#### Memory lifecycle statuses

| Status | Meaning |
|--------|---------|
| `candidate` | New memory below confidence or promotion threshold; never used in replies. Promotion requires corroboration — `confirmation_count ≥ 2` supporting evidence rows of a promotable type push confidence past the threshold; a single sighting can never activate, and `unknown` subjects are inert until claimed |
| `active` | Confirmed and surfaced in replies |
| `contested` | Contradicting evidence received; confidence frozen; `net_score` drives resolution. A standoff with no new signal in 30 days settles by its standing sign — support-leaning returns to `candidate`, contradiction-leaning to `quarantined` |
| `quarantined` | Old candidate (>7 days) or old low-confidence active (>90 days, confidence <0.75) |
| `superseded` | Replaced by a correction **or** merged as a duplicate; linked to the surviving row via `superseded_by` |
| `forgotten` | Manually forgotten via `/memory forget`; never used in replies |

---

### `memory_evidence`

One row per `(memory_id, message_id)` pair. Provenance for every memory.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `memory_id` | INTEGER | FK → `memories.id` |
| `message_id` | TEXT | Discord message snowflake ID (not FK — message may have been purged) |
| `author_id` | TEXT | Discord user ID of the message author |
| `quote` | TEXT | Truncated message content (≤1000 chars) |
| `reason` | TEXT | LLM-supplied reason this message supports the memory |
| `explicitness` | REAL | 0–1; determined by evidence type |
| `observed_at` | TEXT | ISO-8601 observation timestamp |
| `evidence_type` | TEXT | `explicit_fact` · `clear_preference` · `direct_observation` · `reported_by_other` · `sarcasm_or_joke` · `uncertain_inference` · `correction` |
| `effect` | TEXT | `support` · `contradict` · `correct` · `context` |
| `message_content_snapshot` | TEXT | Full message content snapshot (≤1000 chars) |
| `message_timestamp` | TEXT | ISO-8601; used for age-weighted conflict resolution |
| `created_at` | TEXT | ISO-8601 |

**Unique constraint:** `(memory_id, message_id)` — the same Discord message cannot create duplicate evidence rows for the same memory, making replays idempotent.

**Index:** `evidence_memory (memory_id, observed_at DESC)`.

---

### `memory_history`

Append-only audit trail of every lifecycle transition.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `memory_id` | INTEGER | FK → `memories.id` |
| `action` | TEXT | e.g. `support`, `promote`, `contradict`, `correction_evidence`, `conflict_resolved`, `conflict_unresolved`, `conflict_demoted`, `subject_confirmed`, `superseded`, `correction_activated`, `dedup_matched`, `dedup_near_miss`, `dedup_merged`, `dedup_contradiction`, `attr_near_miss` |
| `previous_confidence` | REAL | Confidence before the action |
| `new_confidence` | REAL | Confidence after the action |
| `previous_status` | TEXT | Status before the action |
| `new_status` | TEXT | Status after the action |
| `evidence_id` | INTEGER | FK → `memory_evidence.id` (nullable) |
| `details_json` | TEXT | JSON blob with additional context |
| `created_at` | TEXT | ISO-8601 |

**Index:** `memory_history_lookup (memory_id, created_at DESC)`.

---

### `server_settings`

One row per guild. Controls pause state and retention.

| Column | Type | Notes |
|--------|------|-------|
| `guild_id` | TEXT PK | Discord server ID |
| `memory_enabled` | INTEGER | 0 = paused; 1 = active |
| `reply_enabled` | INTEGER | 0 = silent; 1 = replies allowed |
| `proactive_enabled` | INTEGER | **Legacy/inert (v13).** The proactive-speaking feature was removed when the bot became pure plumbing; the column remains for schema compatibility but nothing reads it to send a message |
| `raw_retention_days` | INTEGER | Rolling window for raw message purge |
| `announced_at` | TIMESTAMPTZ NULL | Set once the join disclosure card posts — the idempotency marker for `announceIfNeeded` |
| `ignored_channels` | TEXT[] | Channels excluded from archiving, replies, and member writes — managed via `/server ignore` / `/server unignore` |
| `quiet_channels` | TEXT[] | Channels where companions stay silent (no replies or system cards) while archiving/extraction continue — managed via `/server quiet` / `/server unquiet`; threads inherit their parent's listing |
| `llm_daily_cap` | INTEGER | Per-guild LLM call budget per UTC day (default 1000; 0 = all calls blocked) — set via `/server limits` |

Row is created with dormant defaults (`memory_enabled=0`, `reply_enabled=0`) on first sight of a guild — an admin enables observation via `/server resume`. Administrators can override via `/server pause`, `/server resume`, `/server companions-pause` (`reply_enabled` only), and the `RAW_MESSAGE_RETENTION_DAYS` env variable.

---

### `jobs`

The deferred-cognition queue (v17). One row per pending unit of background work — `extract` (a `message_id` payload), `journal-write` (companion journal entries after a reply), and `pair-analysis` (holistic relationship reads). A legacy `proactive-fire` type survives as an inert no-op.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGINT PK | `GENERATED ALWAYS AS IDENTITY` |
| `guild_id` | TEXT | Owning guild — claims exclude at-cap guilds; `purgeGuild` deletes the guild's rows |
| `type` | TEXT | Job kind — the worker dispatches on it (`extract`) |
| `payload` | JSONB | Handler input (`{ message_id }` for extract) |
| `run_after` | TIMESTAMPTZ | Earliest claim time — backoff delays and claim leases live here |
| `attempts` | INTEGER | Claim count; `attempts >= 5` dead-letters the row (kept for inspection, never claimed) |
| `created_at` | TIMESTAMPTZ | Enqueue time |

**Index:** `jobs_claim (run_after) WHERE attempts < 5` — the claim query touches only live jobs.

Claim protocol (`src/jobs.ts`): `UPDATE … SET attempts+1, run_after = now()+10min` inside `FOR UPDATE SKIP LOCKED` — a claimed job leases itself out of the runnable set; completion deletes the row, failure re-schedules to backoff, and a crashed worker's job becomes claimable again when the lease expires. `BudgetExceeded` reschedules to next UTC midnight **without** consuming an attempt.

---

### `guild_usage`

Per-guild daily LLM-call counters (v17) — the `meteredClient` seam charges here before every `responses.create`/`chat.completions.create`.

| Column | Type | Notes |
|--------|------|-------|
| `guild_id` | TEXT | Composite PK with `day` |
| `day` | DATE | UTC day — counters reset automatically at the boundary |
| `llm_calls` | INTEGER | Calls charged that day |

`chargeLlmCall` increments atomically (`INSERT … ON CONFLICT DO UPDATE … WHERE llm_calls < cap RETURNING`) — a zero-row result throws `BudgetExceeded`. `cap=0` blocks every call.

---

### `guild_keys`

Encrypted LLM API keys (BYOK), written by `/companion key`, `/setup`, or the onboarding **Paste API Key** modal. Keyed by scope (`dm:<userId>` for a user's personal key, or `<guildId>`). Lives in a dedicated table so export/purge paths never casually touch ciphertext.

| Column | Type | Notes |
|--------|------|-------|
| `guild_id` | TEXT PK | Scope ID: `dm:<userId>` for personal user keys (primary in Characterly) or Discord server ID |
| `key_enc` | BYTEA | AES-256-GCM ciphertext (`iv ‖ ciphertext ‖ tag`, `src/secrets.ts`) — there is no plaintext key column |
| `key_hint` | TEXT | Last 4 chars of the key, for masked display (`…abcd`) |
| `base_url` | TEXT NULL | Custom OpenAI-compatible endpoint; NULL = auto-detected from key prefix (`gsk_`, `sk-or-`, `sk-`, `xai-`) or env default |
| `model` | TEXT NULL | Per-key model override (v22) — required for custom base URLs (a self-hosted server won't serve the detected default), optional otherwise |
| `validated_at` | TIMESTAMPTZ NULL | NULL = stored but never verified live (provider unreachable at setup time) |
| `created_at` / `updated_at` | TIMESTAMPTZ | Upsert timestamps |

Decryption requires `KEY_ENCRYPTION_SECRET`; rotating that secret orphans existing rows (recovery = re-run `/companion key` or `/setup`).

---

### `behavioral_patterns`

Consolidated episode patterns. One row per recognised recurring behaviour per subject.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `guild_id` | TEXT | Server scope |
| `subject_id` | TEXT | Discord user ID |
| `description` | TEXT | Human-readable pattern description (currently copied from the highest-confidence episode; LLM synthesis is a planned future improvement) |
| `episode_count` | INTEGER | Number of linked episodes |
| `confidence` | REAL | Average confidence of linked episodes |
| `status` | TEXT | `active` (only value currently used) |
| `created_at` | TEXT | ISO-8601 |
| `updated_at` | TEXT | ISO-8601 |

**Index:** `patterns_lookup (guild_id, subject_id, status)`.

**Promotion rule:** `consolidateEpisodes()` runs during daily maintenance. It requires ≥3 unlinked `active`-status episodes per subject. Candidates and quarantined episodes are excluded.

---

### `events`

One row per detected server incident.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `guild_id` | TEXT | Server scope |
| `channel_id` | TEXT | Channel where the event occurred |
| `title` | TEXT | LLM-generated title (empty until classified) |
| `summary` | TEXT | LLM-generated summary (empty until classified) |
| `significance` | REAL | 0–1 deterministic score (see `event-significance.ts`) |
| `tier` | TEXT | `candidate` or `event` |
| `occurred_at` | TEXT | Timestamp of the first message in the event |
| `closed_at` | TEXT | ISO-8601 when the event window was closed (null = still open) |
| `reference_count` | INTEGER | Number of times the event was referenced after closing |
| `classifications` | INTEGER | Re-classification pass counter (v18) — each discard-verdict pass bumps it; `>= 3` stops re-scoring so a stuck candidate can't burn an LLM call on every future reference |
| `created_at` | TEXT | ISO-8601 |
| `updated_at` | TEXT | ISO-8601 |

**Indexes:** `events_guild_channel (guild_id, channel_id, occurred_at DESC)`, `events_guild_open (guild_id, tier, closed_at)`.

---

### `event_participants`

Which users were involved in an event.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `event_id` | INTEGER | FK → `events.id` |
| `user_id` | TEXT | Discord user ID |
| `user_name` | TEXT | Display name |
| `role` | TEXT | `subject` · `antagonist` · `participant` · `observer` |

**Unique constraint:** `(event_id, user_id)`.

---

### `event_messages`

Which Discord messages are part of an event.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `event_id` | INTEGER | FK → `events.id` |
| `message_id` | TEXT | Discord message snowflake ID |

**Unique constraint:** `(event_id, message_id)`.

---

### `event_memories`

Which memories are linked to an event.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `event_id` | INTEGER | FK → `events.id` |
| `memory_id` | INTEGER | FK → `memories.id` |
| `link_type` | TEXT | `generated` (created during event) · `referenced` (back-reference) · `retroactive` (promoted after closing) |

**Unique constraint:** `(event_id, memory_id)`.

---

### `members`

Member registry — one row per (guild, user). Built by `recordMessage()` on the live path.

| Column | Type | Notes |
|--------|------|-------|
| `guild_id` | TEXT | Server scope (composite PK) |
| `user_id` | TEXT | Discord user ID (composite PK) |
| `known_names` | TEXT[] | Every display name observed for this user; backs the entity-resolution alias map |
| `first_seen_at` | TEXT | ISO-8601 |
| `last_seen_at` | TEXT | ISO-8601 |
| `message_count` | INTEGER | Total recorded messages |
| `opted_out` | INTEGER | 1 = hard revoke: `/opt-out` forgets existing memories, hard-deletes relationship observations/edges and `companion_journal` entries about them (`forgetJournalAbout`), deletes the profile, and clears `opted_in` — opt-out always wins |
| `opted_in` | INTEGER | 1 = consent for derived data (person memories, relationship observations, attributes, profiles, dossiers). Effective consent = `opted_in=1 AND opted_out=0`. Set by `/opt-in` and `/profile-build` |

---

### `relationship_observations`

Raw LLM relationship assertions. One row per (subject, other, message) — idempotent evidence for the derived edges in `relationships`. This is the holding state: an assertion stays invisible until verification.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `guild_id` | TEXT | Server scope |
| `subject_id` | TEXT | Discord user ID the assertion is about |
| `other_id` | TEXT | Discord user ID of the other party |
| `message_id` | TEXT | Source message snowflake |
| `nature` | TEXT | Free-text dynamic: "close friends", "antagonizes", "dating", … |
| `valence` | REAL \| NULL | −1 hostile … 0 neutral … +1 close |
| `reason` | TEXT | LLM-supplied explanation |
| `verdict` | TEXT \| NULL | Sincerity verdict (v8): `'literal'` counts toward edges; `'joke'`/`'unclear'`/NULL never do. NULL = not yet verified |
| `author_id` | TEXT \| NULL | The assertor — who made the claim (v19, backfilled from the source message). Drives opt-out deletion of authored claims and party-authored weighting in edge aggregation; NULL on `pair_window` rows (the system is the assertor) |
| `source` | TEXT | `'message'` (single-message extraction) or `'pair_window'` (pair-analysis job write) — provenance for the two write paths (v20) |
| `created_at` | TEXT | ISO-8601 |

**Unique constraint:** `(subject_id, other_id, message_id)`. **Index:** `relationship_obs_lookup (guild_id, subject_id, other_id)`.

---

### `relationships`

Durable relationship edges — fully derived. `recomputeEdges()` deletes and rebuilds this table from `literal`-verdicted observations only, so unverified, `unclear`, or `joke` assertions never form or feed an edge. New edges materialize at the next verification pass, not at record time.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `guild_id` | TEXT | Server scope |
| `subject_id` | TEXT | Discord user ID |
| `other_id` | TEXT | Discord user ID |
| `summary` | TEXT | *Modal* nature over the five most recent literal-verdicted observations (`MODE() WITHIN GROUP`) — a contradictory flip can't rewrite history on one claim (v20) |
| `valence` | REAL \| NULL | *Weighted* average over the same recent-5 window — observations authored by an edge party count double a third party's (v20) |
| `observation_count` | INTEGER | Count of literal-verdicted observations; `/profile` and profile synthesis surface edges at ≥2 |
| `behavioral_count` | INTEGER | Contact count in the deterministic interaction graph (90-day mention/name-ref frequency), stamped onto claimed edges (v20) |
| `party_count` | INTEGER | How many of the recent-5 observations were self-reported by an edge party — zero renders as "all secondhand" (v20) |
| `trend` | TEXT \| NULL | `'warming'`/`'cooling'` when the recent-5 weighted valence diverges ±0.2 from the prior window (v20) |
| `inferred` | INTEGER | `1` = behavioral-only edge (≥5 contacts in 90d, zero claims) — renders strictly as contact frequency, never a relationship claim (v20) |
| `last_observed_at` | TEXT | ISO-8601 |
| `updated_at` | TEXT | ISO-8601 |

**Unique constraint:** `(guild_id, subject_id, other_id)`. **Index:** `relationships_lookup (guild_id, subject_id)`.

---

### `profiles`

Synthesized per-chatter profile cards, rebuilt only when their input fingerprint changes.

| Column | Type | Notes |
|--------|------|-------|
| `guild_id` | TEXT | Server scope (composite PK) |
| `subject_id` | TEXT | Discord user ID (composite PK) |
| `display_name` | TEXT | Best current display name |
| `summary` | TEXT | LLM-written bio |
| `facets_json` | TEXT | JSON rendered deterministically from `profile_attributes` + edges: `traits`, `interests`, `notableRelationships`, `roleInServer`, plus `dossier.sections` — per-section results `{ hash, builtAt, data }` for `voice`, `life_situation`, `temperament`, `beliefs`, `relationship_map`, `reputation`, `timeline`; list items carry `source_ids` memory citations |
| `source_hash` | TEXT | SHA-256 fingerprint of semantic build inputs (memories, candidates, patterns, edges, events — raw activity churn excluded); gates LLM attribute extraction |
| `attr_hash` | TEXT | SHA-256 fingerprint of the render inputs: active attribute rows + bio context (patterns, edges, events, stats); identical hash → prose render skipped |
| `built_at` | TEXT | ISO-8601 of last LLM synthesis |
| `updated_at` | TEXT | ISO-8601 |

---

### `profile_attributes`

Structured person facets — the **source of truth** for profile cards; `summary`/`facets_json` are renderings of these rows. Provenance-backed: every facet cites the memories that justify it, so `/memory forget`/`supersede`/merge cascade immediately.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGINT PK | Identity |
| `guild_id` | TEXT | Server scope |
| `subject_id` | TEXT | Discord user ID |
| `field` | TEXT | One of eight: singular `pronouns`/`timezone`/`location`/`occupation`/`birthday`; multi-valued `trait`/`interest`/`skill` (`SINGULAR_FIELDS` in `src/attributes.ts` is the classifier) |
| `value` | TEXT | Display form |
| `value_norm` | TEXT | `trim().toLowerCase()` — uniqueness/fold key only |
| `confidence` | DOUBLE | `max()` of surviving cited memories' confidence; corroboration is reported via `array_length(memory_ids)` |
| `memory_ids` | BIGINT[] | Provenance — citing memory IDs (set union, no dupes) |
| `status` | TEXT | Derived from cited-memory statuses + `superseded_by`: all-forgotten/empty → `forgotten`; any `contested` → `contested`; any `active` → `active`; all-`superseded` → `superseded` |
| `superseded_by` | BIGINT | The only asserted input to status — set on singular-field replacement and LLM `replaces` |
| `first_seen_at`/`last_seen_at` | TIMESTAMPTZ | |

`UNIQUE (guild_id, subject_id, field, value_norm)` — case/whitespace variants can't produce sibling rows. Indexes: `(guild_id, subject_id, status)` lookup; GIN trigram on `value_norm` for the polarity-gated near-dup fold (≥0.6 folds, 0.4–0.6 logs `attr_near_miss`).

Extraction: deterministic regexes on `person_fact`/`person_preference` content run inside `buildProfiles` (also the lazy backfill); an LLM pass proposes `trait`/`interest`/`skill` gated on `source_hash`. Only `active` rows render anywhere; `contested` surfaces in `/server triage`.

---

### `alias_candidates`

Provenance for learned display-name aliases (v9). When the bot hears someone addressed by a name that isn't in `members.known_names`, the candidate is logged here before the alias is trusted.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGINT PK | Identity |
| `guild_id` | TEXT | Server scope |
| `user_id` | TEXT | Discord user ID the alias may belong to |
| `name` | TEXT | Candidate display name |
| `source` | TEXT | How the candidate was observed |
| `evidence_message_id` | TEXT | Message that produced the candidate |
| `created_at` | TIMESTAMPTZ | |

**Unique constraint:** `(guild_id, user_id, name, evidence_message_id)`. Pruned at 90 days by `pruneDerivedData`.

---

### `unresolved_names`

Names that failed entity resolution (v10) — the discovery surface for aliases the self-naming path can't catch and for recurring non-member entities.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGINT PK | Identity |
| `guild_id` | TEXT | Server scope |
| `name` | TEXT | Unresolved name as written |
| `message_id` | TEXT | Message where resolution failed |
| `created_at` | TIMESTAMPTZ | |

**Unique constraint:** `(guild_id, name, message_id)`. Pruned at 90 days by `pruneDerivedData`.

---

### `companion_journal`

A companion's own first-person episodic memory (v25) — what *it* experienced ("Alice and I roasted her tea take"), written after each reply by the deferred `journal-write` job. `origin_scope` keys recall: entries surface only where they formed, and `dm:<owner>` entries additionally ride the vault subtext into servers.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGINT PK | Identity |
| `companion_id` | BIGINT | FK → `companions.id ON DELETE CASCADE` |
| `origin_scope` | TEXT | `<guildId>` or `dm:<userId>` — recall is scoped to where the entry formed |
| `kind` | TEXT | `moment` · `opinion` · `inside_joke` · `promise` · `bond` (v44 — the pinned "what we were" summary; written only by the chat-import path) |
| `content` | TEXT | First-person journal text |
| `about_subject_ids` | TEXT[] | Subjects the entry mentions — consent-gated at write *and* read time |
| `importance` | DOUBLE | 0–1, ranks recall order and prune eviction |
| `status` | TEXT | `active` · `forgotten` |
| `source_message_id` | TEXT NULL | The companion's own reply that produced the entry (provenance + idempotency key) |
| `source` | TEXT | `'live'` (default — written after a reply) or `'import'` (v44 — distilled from an uploaded transcript) |
| `import_id` | BIGINT NULL | FK → `chat_imports.id ON DELETE CASCADE` (v44) — the import that wrote the entry; retracted with the import |
| `created_at` / `updated_at` | TIMESTAMPTZ | |
| `last_recalled_at` | TIMESTAMPTZ NULL | Stamped on each `journalFor` hit — drives the 30-day decay in `pruneJournal` |
| `embedding` | VECTOR NULL | Semantic-recall vector (v40) — powers `semanticJournal` alongside `journalFor` |

**Unique constraint:** `(companion_id, origin_scope, source_message_id, kind, content)` — a crashed job resaving identical output can't stack rows. **Indexes:** `companion_journal_lookup (companion_id, origin_scope, status, importance DESC)`; `companion_journal_about` GIN on `about_subject_ids`. RLS enabled (v25) with no policies — Data-API deny-all. Write-time trgm dedup drops paraphrases (similarity ≥ 0.75); nightly `pruneJournal` caps 200 active entries per (companion, scope). Imported entries (v44) carry `created_at` backdated to their transcript window's end so `[age]` reads honestly in recall. `pinned` (v57) entries always recall first and are exempt from pruning.

---

### `conversation_summaries`

The rolling "story so far" recap (v55) — one row per `(companion_id, origin_scope, channel_id)` holding a first-person summary of everything older than the live transcript window. Written by the `summary-update` job (`src/summary-job.ts`), triggered every `SUMMARY_REPLY_INTERVAL` (10) companion replies via an atomic `msgs_since` counter + claim; `storyWindow` folds the slice between `covered_until` and the newest `STORY_KEEP_RECENT` (25 guild / `DM_CONTEXT_MESSAGES` in DM lanes) archived rows, capped at 60 per pass — newest-eligible first, so a fresh lane's first recap seeds near the present instead of grinding the whole backlog. `user_edited` marks owner-authored recaps (`/companion story` modal or the dashboard RPC) — the summarizer treats them as canon, and clears the flag when it next writes (a fold that loses the read-check-write race drops rather than clobbering a newer edit). Owner reset (`/companion reset-story`, or an empty save) clears the text and parks `covered_until` at now so the wiped backlog can't re-fold; `/opt-out` wipes the scope's rows; guild purge and companion deletion (`ON DELETE CASCADE`) cover them. RLS enabled, deny-all — the site reaches them only through the `my_memory_overview` / `story_summary_save` owner-scoped RPCs (v57, hardened in v58).

---

### `chat_imports`

A queued/running/finished chat-history import (v44). The normalized transcript lives in `turns` only while the `chat-import` job distills it — on `done` or `failed` the turns are cleared: **distill-and-discard, we keep the memory not the corpus**.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGINT PK | Identity |
| `owner_user_id` | TEXT | The importer's Discord user id |
| `companion_id` | BIGINT | FK → `companions.id ON DELETE CASCADE` — the roster companion receiving the history (dies with it) |
| `filename` / `sha256` / `format` | TEXT | Source file name, content hash, detected format (`jsonl`/`json`) |
| `status` | TEXT | `queued` → `distilling` → `done` · `failed` |
| `turns` | JSONB | `{speaker: 'user'|'char', text, ts}` — cleared at `done`/`failed` |
| `speakers` | JSONB | `{user, char, dropped}` — resolved names + skipped third-party count |
| `message_count` / `processed_turns` / `kept_count` | INT | Total turns, windows checkpoint (resume point), journal entries written |
| `error` | TEXT NULL | Failure reason |
| `meta` | JSONB | Provenance + the rolling `rollingSummary` carried between windows (and across job retries) |

**Unique constraint:** `(owner_user_id, sha256)` — the same file re-imported by the same user dedupes to the original row. **Index:** `chat_imports_owner (owner_user_id, status)`. RLS deny-all — the site reaches imports through `my_companions` / `my_chat_imports` / `import_chat_history` / `delete_chat_import` security-definer RPCs (auth-gated, created only when `auth` + `web_profiles` exist). `import_chat_history` re-bounds turns server-side, validates the companion is on the caller's roster, and enqueues the job itself (INSERT into `jobs` + `pg_notify`). `failChatImport` retracts the partial journal (`DELETE … WHERE import_id`) — a half-imported memory is worse than none. **Undo** (v45): `delete_chat_import` / `deleteChatImport` deletes the row owner-scoped — `companion_journal.import_id ON DELETE CASCADE` retracts every memory it wrote; safe mid-distill (further journal writes fail the FK and the worker drops stale). Rollback refuses while rows exist.

---

### `app_installs`

Discord app-install ledger (v47) — one row per Discord user who authorized the app to their account. Written **only** by the `record_app_install` RPC (security definer, revoked from PUBLIC/anon/authenticated — called by the website worker with the service key on verified Webhook Events); read by the bot's install-greet sweep.

| Column | Type | Notes |
|--------|------|-------|
| `discord_user_id` | TEXT PK | The installer |
| `event` | TEXT | `authorized` or `deauthorized` — last event wins (upsert) |
| `meta` | JSONB | Event payload (scopes, timestamp, raw data) |
| `greeted_at` | TIMESTAMPTZ NULL | Set once the welcome DM lands (or the user already has a companion) — **permanent dedupe: reinstalls never re-greet** |
| `deauthorized_at` | TIMESTAMPTZ NULL | Set on `APPLICATION_DEAUTHORIZED` — sweep skips |
| `attempts` / `last_error` | INT / TEXT | Send-retry bookkeeping (sweep caps at 5) |
| `created_at` / `updated_at` | TIMESTAMPTZ | |

**Index:** partial `app_installs_pending (created_at) WHERE greeted_at IS NULL AND deauthorized_at IS NULL` — the sweep's work list. RLS deny-all. Rollback refuses while rows exist (same guard as v41/v42/v44).

---

### `analytics_events`

Pseudonymous product-funnel events (v62) — which product step a Discord id reached, written fire-and-forget by `MemoryStore.trackEvent`. **Never** message content, prompts, or model output; `meta` carries coarse ids/counts only. The event name is a closed union (`AnalyticsEvent` in `src/database.ts`) so the `(event, created_at)` index can't be exploded by ad-hoc names. `/opt-out` deletes a user's rows and flips `user_bot_settings.analytics_opt_out`, which the INSERT itself guards on — tracking can't resume without `/opt-in`. Funnel reporting uses `count(DISTINCT discord_user_id)` so repeated prompts don't inflate conversion. `purgeGuild` deletes rows whose `scope` matches the dead guild, then writes its own `guild_purged` tombstone. Daily maintenance prunes rows past 400 days.

| Column | Type | Notes |
|--------|------|-------|
| `discord_user_id` | TEXT NULL | The actor; NULL for guild-level events (`guild_added`, `guild_purged`) |
| `event` | TEXT | One of the `AnalyticsEvent` names — `install_greeted`, `onboard_start`, `awaken`, `summon`, `summon_deadend`, `adopt`, `house_join`, `verified`, `guild_added`, `guild_purged` |
| `scope` | TEXT NULL | Guild id or `dm:<uid>` when the event is scope-bound |
| `meta` | JSONB | Coarse ids/counts only (`{}` default) |
| `created_at` | TIMESTAMPTZ | |

**Indexes:** `analytics_events_by_event (event, created_at)` for funnel windows; `analytics_events_by_user (discord_user_id)` for opt-out deletes. RLS deny-all — bot-owned only.

---

### `metrics_daily`

Durable daily rollup of the in-process `inc()` counters (v62). `drainMetrics()` in `src/metrics.ts` returns per-name deltas since the last drain; a 5-minute interval plus a best-effort shutdown drain upserts them here (`ON CONFLICT … count + EXCLUDED.count`). Restarts lose at most one unflushed interval; `metricsSnapshot()`/`/ops logs` still read the live cumulative counters.

| Column | Type | Notes |
|--------|------|-------|
| `day` | DATE | UTC day — composite PK with `name` |
| `name` | TEXT | Counter name (the ~290 `inc()` call sites) |
| `count` | BIGINT | Increments recorded that day |

RLS deny-all. No retention bound — rows are a few hundred bytes each.

---

### `support_tickets`

House support-ticket ledger (v48) — one row per private thread under `#support-ticket`. Written by the ticket modal handler (`createSupportTicket`), read by the open/close buttons.

| Column | Type | Notes |
|--------|------|-------|
| `thread_id` | TEXT PK | The private thread IS the ticket |
| `guild_id` | TEXT | Always the house guild |
| `opener_id` | TEXT | Discord user who filed |
| `subject` / `details` | TEXT | Modal intake fields |
| `status` | TEXT | `open` · `closed` |
| `opened_at` / `closed_at` / `closer_id` | TIMESTAMPTZ / TIMESTAMPTZ / TEXT | Lifecycle |

**Indexes:** partial unique `support_tickets_one_open_per_user (opener_id) WHERE status='open'` — the one-open-ticket-per-user rule as a database guarantee (double-submits hit it as a no-op via `ON CONFLICT (opener_id) WHERE status='open'`); partial `support_tickets_open (guild_id, opened_at) WHERE status='open'`. RLS deny-all. Rollback refuses while rows exist.

---

### `web_profiles`

Web account profiles for Supabase Auth users (v26) — the "real life user" half, named `web_profiles` because `profiles` is already the subject-profile table. Only created when the `auth` schema exists (Supabase); plain Postgres skips it.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | FK → `auth.users.id ON DELETE CASCADE` — the Supabase Auth user |
| `display_name` | TEXT | Editable display name (seeded from `raw_user_meta_data`) |
| `discord_user_id` | TEXT UNIQUE NULL | Linked Discord snowflake — **server-managed** (v27): written only by the `on_identity_sync` trigger or the `claim_link_code` rpc; not user-writable |
| `discord_username` | TEXT NULL | Display snapshot of the linked Discord account (v38) — stamped by the trigger/`claim_link_code` like `discord_user_id`; display-only, never an auth key |
| `discord_avatar_url` | TEXT NULL | Same snapshot — the avatar URL the dashboard renders |
| `stripe_customer_id` | TEXT UNIQUE NULL | Reserved for billing — server-managed, not user-writable |
| `created_at` / `updated_at` | TIMESTAMPTZ | |

**RLS:** own-row `SELECT`/`INSERT`/`UPDATE` policies for `authenticated`; `UPDATE` granted only on `(display_name, updated_at)` (v27) so a user can never forge `discord_user_id` or `stripe_customer_id` on their own row.

**Supporting functions & triggers** (all under the auth-schema gate, `SECURITY DEFINER`, `search_path = ''`, revoked from PUBLIC/anon):

- `internal.handle_new_user()` + `on_auth_user_created` (v26; metadata fallbacks `display_name`/`full_name`/`name` from v28) — inserts a `web_profiles` row for each new `auth.users` row.
- `internal.sync_discord_identity()` + `on_identity_sync` on `auth.identities` (v27) — on `INSERT`/`DELETE` of a `discord` identity, copies `provider_id` into `web_profiles.discord_user_id` (or NULLs it back out, guarded on the exact provider_id). Covers OAuth signup, `linkIdentity`, auto-merged identities, unlink, and account deletion; a duplicate link raises `discord_already_linked`. v27 also backfilled pre-existing Discord sign-ins. v38 extended it to stamp `discord_username`/`discord_avatar_url` from `identity_data` (`full_name` → `name` → `custom_claims.global_name`, plus `avatar_url`), so OAuth-linked profiles carry the same display snapshot as code-linked ones.
- `public.claim_link_code(p_code)` (v27; v28 adds a rowcount check so a missing `web_profiles` row raises `no_profile` instead of silently consuming the code) — `EXECUTE` granted to `authenticated`; validates a `/link` code (exists, unclaimed, unexpired, Discord account not already linked elsewhere) and stamps `discord_user_id` plus — since v38 — the `discord_username`/`discord_avatar_url` snapshot the bot stored on the code at mint. Errors are `tag: message` strings (`invalid_code`, `code_used`, `code_expired`, `discord_already_linked`, `no_profile`).
- `public.unlink_discord()` (v28) — `EXECUTE` granted to `authenticated`; clears the caller's `discord_user_id` and, since v38, the display snapshot too. Needed because code-claimed links have no `auth.identities` row for `unlinkIdentity` to remove (identity-backed links should unlink via `unlinkIdentity`, which the trigger mirrors).
- `public.delete_own_account()` (v26) — `EXECUTE` granted to `authenticated`; deletes the caller's `auth.users` row (cascades to `web_profiles`).

---

### `link_codes`

One-time Discord → web linking codes (v27). `/link` in Discord mints a code (`XXXX-XXXX`, unambiguous alphabet); the site claims it via `claim_link_code`.

| Column | Type | Notes |
|--------|------|-------|
| `code` | TEXT PK | The one-time code (uppercased at claim) |
| `discord_user_id` | TEXT | Discord user the code was minted for |
| `created_at` | TIMESTAMPTZ | |
| `expires_at` | TIMESTAMPTZ | 10-minute lifetime; minting a new code deletes prior/expired rows for the user |
| `claimed_by` | UUID NULL | `auth.users.id` that claimed it — set exactly once |
| `discord_username` / `discord_avatar_url` | TEXT NULL | Display snapshot of the Discord user at mint time (v38) — `claim_link_code` copies it onto `web_profiles` |

**Index:** `link_codes_user (discord_user_id, expires_at)`. **RLS:** enabled with zero policies — only the bot (postgres role) reads/writes; web claims funnel through the security-definer rpc. Lives outside the auth-schema gate so `/link` works on any database.

---

### `consent_events`

Append-only clickwrap audit trail (v39, extended v41) — every Terms/Privacy acceptance is a row; the max `version` matching `discord_user_id` **or** `account_id` is the current state and older rows stay as evidence. Two writers: the house verify gate (`source='discord_verify'`, `discord_user_id` set) and the website (`source='web_signup'`, `account_id` only — a web signup predates Discord linking, so `discord_user_id` went nullable in v41).

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGSERIAL PK | |
| `discord_user_id` | TEXT NULL | The Discord user who clicked accept — NULL on web-signup rows |
| `account_id` | TEXT NULL | `web_profiles.id` (or `'selfhosted'`) — loose TEXT, no FK: `web_profiles` only exists under Supabase auth while this table is plain-Postgres |
| `document` | TEXT | Which document set — `'terms'` covers the ToS+Privacy pair today |
| `version` | INT | The version stamped on the control they clicked — what they actually saw, not "current at click time" |
| `source` | TEXT | Where the acceptance happened — `discord_verify`, `web_signup` |
| `accepted_at` | TIMESTAMPTZ | Defaults `now()` |

**Indexes:** `consent_events_user_doc (discord_user_id, document, version DESC)` + v41's `consent_events_account_doc (account_id, document, version DESC)`.

**RLS/web surface (v41):** RLS is enabled with no policies — fail-closed to PostgREST. The site's publishable key reaches the table only through two `SECURITY DEFINER` functions, both inside the `auth`-schema gate so plain Postgres skips them: `my_consent(p_document) → int` returns the caller's (`auth.uid()`) max accepted version, and `record_consent(p_document, p_version)` inserts a `web_signup` row for the caller (`document='terms'` and `1 ≤ version ≤ 10` enforced — raise the ceiling alongside a `TERMS_VERSION` bump). `EXECUTE` is granted to `authenticated` only — anonymous visitors can't read or write consent state. Bot access via the postgres role bypasses RLS as usual.

---

### `credit_ledger`

Audit trail for hosted-lane credits (user-facing name: "tokens") — v29. Every grant, spend, refund, and manual adjustment appends a row with the resulting `balance_after`; `web_profiles.credit_balance` is the cached head. Lives behind the same auth-schema gate as `web_profiles`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGINT IDENTITY PK | |
| `account_id` | UUID FK → `web_profiles(id)` | Cascade-deletes with the account |
| `delta` | INT | Signed credit change |
| `kind` | TEXT | `grant_daily` · `grant_weekly` (v29–v30 only) · `spend` · `refund` · `adjust` · `purchase` (v31+) |
| `stripe_ref` | TEXT NULL | Stripe session id — unique; webhook redelivery dedupes on it (v31+) |
| `reason` | TEXT NULL | Spend/refund reason (`dm_turn`, `guild_turn`, `c2c`, `*_refund`) |
| `balance_after` | INT | Running balance — written inside the spend transaction |
| `created_at` | TIMESTAMPTZ | |

**Index:** `credit_ledger_account (account_id, id DESC)`. **RLS:** enabled; `credit_ledger_select_own` lets authenticated users read their own rows (the dashboard ledger).

`web_profiles` also gains (same migration): `plan` (`'free'|'premium'`, default `free`), `credit_balance`, `last_daily_grant_on`, `last_weekly_grant_on` (dormant since v31 — premium is a single 150/day floor now). Grants are **lazy refills**: `spendCredits` tops the daily allowance (`credit_balance − purchased_balance`, v60) up to the plan's floor under the row lock before debiting — no scheduler, downtime-safe, and a refill can't bank beyond the floor. Pack/bonus tokens (`purchased_balance`) persist on top, are spent only after the allowance, and never suppress the refill. v31 also adds `stripe_customer_id` / `stripe_subscription_id` for the billing webhook's customer→account mapping.

---

### `user_bot_settings`

Per-Discord-user bot toggles (v29), keyed by `discord_user_id` **outside** the auth-schema gate so the bot reads them with zero joins on any Postgres. The site writes through `upsert_my_settings`, which stamps the caller's own linked `discord_user_id` — users can't set toggles for a Discord account that isn't theirs.

| Column | Type | Notes |
|--------|------|-------|
| `discord_user_id` | TEXT PK | |
| `c2c_enabled` | BOOLEAN | Default true — companion replies to other companions (those turns spend the owner's tokens) |
| `low_credit_alerts` | BOOLEAN | Default true — once-per-UTC-day DM when the balance runs low |
| `active_dm_companion_id` | BIGINT NULL | Which roster companion answers the user's DMs (v34); null = the awakened companion. Takes effect only once the awakened companion is active — onboarding owns the DM until then. Cleared automatically when the picked adoption is dropped |
| `analytics_opt_out` | BOOLEAN | Default false — v62. Set by `/opt-out` (also wipes the user's `analytics_events` rows), cleared by `/opt-in`. `trackEvent`'s INSERT carries a `NOT EXISTS` guard against it — bot-managed only, not exposed through `upsert_my_settings` |
| `updated_at` | TIMESTAMPTZ | |

**RLS:** enabled, zero policies — the bot reads/writes via the postgres role; the site uses `my_bot_settings()` / `upsert_my_settings(patch)` / `my_byok_status()` security-definer rpcs (authenticated role only).

---

### `companion_listings`

The marketplace's publishable persona (v34): a creator's awakened companion projected into the hub server's forum channel via `/companion publish`. Editable and versioned — adopters hold *live references*: persona edits bump `version` and propagate into every adopted clone's `companions` row.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGINT PK | Referenced by `market:add:<id>` / `market:report:<id>` button custom IDs |
| `creator_user_id` | TEXT | Discord user ID of the publisher (must hold a linked web account) |
| `source_companion_id` | BIGINT UNIQUE NULL | FK → `companions.id` — the awakened companion the listing projects; **NULL** for freehand creator-authored characters (v35 — nullable, and Postgres treats NULLs as distinct so awakened publishes still dedupe) |
| `name` / `tagline` | TEXT | Display name + listing-card blurb |
| `voice_persona` / `core_traits` / `owner_dynamic` / `backstory` | — | Persona fields cloned into adopters' `companions` rows |
| `greeting` | TEXT | First DM the character sends on adoption — stamps `dm_introduced_at` on successful send |
| `avatar_url` | TEXT NULL | |
| `forum_thread_id` | TEXT NULL | The bot-created forum post (its embed card owns the Add/Report buttons) |
| `version` | INTEGER | Increments on every upsert; each version is snapshotted in `companion_persona_versions` |
| `status` | TEXT | `'unlisted'` (v42 — private import draft: creator-only adoption, invisible to marketplace queries and listing caps) → `'active'` → `'flagged'` (auto at report threshold — a moderation hold: creators can't delist/relist/republish it away) → `'delisted'` (unpublish/mod; clones keep working) or `'banned'` (mod kill switch — clones freeze everywhere via the `adopted_from_listing_id` join). Non-active statuses block non-creator adoptions |
| `persona_source` | TEXT | `'authored'` (default) or `'card_import'` (v42 — created from an imported character card) |
| `import_meta` | JSONB NULL | Import provenance: card spec/specVersion, claimed creator, filename, `sha256` of the source file, `importedVia`, `importedAt`. Surfaces in moderation report alerts; powers `findUnlistedByHash` dedupe |
| `published_at` | TIMESTAMPTZ NULL | First time the listing went live — set at insert for authored rows, on the `unlisted → active` flip for imports (v43). The daily publish cap counts this, so private imports never consume publish quota |
| `report_count` / `add_count` | INTEGER | Denormalized counters |
| `created_at` / `updated_at` | TIMESTAMPTZ | |

**RLS:** enabled, zero policies — bot-owned, no site access.

---

### `companion_persona_versions`

Append-only audit trail for listing personas (v34): one row per `(listing_id, version)` with the full persona as `persona_json` — "the character said X on version 3" stays checkable even while the live listing moves forward.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGINT PK | |
| `listing_id` | BIGINT | FK → `companion_listings.id ON DELETE CASCADE` (indexed) |
| `version` | INTEGER | Composite unique with `listing_id` |
| `persona_json` | JSONB | Snapshot of name/tagline/persona/greeting/avatar fields |
| `created_at` | TIMESTAMPTZ | |

**RLS:** enabled, zero policies.

---

### `companion_adoptions`

One row per (user, listing) adoption relationship (v34). `companion_id` points at the adopter-owned clone; `dropped_at`/`cooldown_until` drive the 12-hour re-adopt cooldown; `dm_introduced_at` is stamped only when the greeting actually lands in the adoptee thread and gates server summoning; `chat_thread_id` (v54) is the registry mapping the adoption to its private `#adoptees` thread.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGINT PK | |
| `user_id` | TEXT | The adopter (partial index `adoptions_active` on `dropped_at IS NULL` feeds the free-tier slot count) |
| `listing_id` | BIGINT | FK → `companion_listings.id ON DELETE CASCADE` (indexed) |
| `companion_id` | BIGINT | FK → `companions.id ON DELETE CASCADE` — the `kind='adopted'` clone (indexed) |
| `adopted_at` | TIMESTAMPTZ | Resets on re-adoption |
| `dropped_at` / `cooldown_until` | TIMESTAMPTZ NULL | Set together by `dropAdoption`; re-adoption clears both and reuses the same clone |
| `dm_introduced_at` | TIMESTAMPTZ NULL | Stamped by `markDmIntroduced` after the greeting send succeeds |
| `chat_thread_id` | TEXT NULL | The adoption's private thread under `#adoptees` (v54, partial index `adoptions_thread`). Persists across drop→re-adopt so history continues |

**RLS:** enabled, zero policies.

---

### `listing_reports`

Moderation foundation (v34): one row per (listing, reporter) so reports dedupe naturally; the report counter on `companion_listings` auto-flags at `MARKETPLACE_REPORT_FLAG_THRESHOLD` and pings `MARKETPLACE_MOD_CHANNEL_ID`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGINT PK | |
| `listing_id` | BIGINT | FK → `companion_listings.id ON DELETE CASCADE` (indexed) |
| `reporter_user_id` | TEXT | Composite unique with `listing_id` — a user reports once |
| `category` | TEXT | Report category from the picker (v36): `minor`/`sexual`/`harmful`/`hate`/`spam`/`theft`/`other` — indexed with `created_at` for the daily report cap |
| `reason` | TEXT | Optional free text |
| `created_at` | TIMESTAMPTZ | |

**RLS:** enabled, zero policies.

---

### `listing_ratings`

Star ratings on a listing's card (v37) — one row per `(listing_id, rater_user_id)`, so a re-rate is an upsert that moves the vote without growing the table. The card shows `AVG(stars)` + count.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGINT PK | |
| `listing_id` | BIGINT | FK → `companion_listings.id ON DELETE CASCADE` (indexed) |
| `rater_user_id` | TEXT | Composite unique with `listing_id` |
| `stars` | SMALLINT | `CHECK (stars BETWEEN 1 AND 5)` |
| `created_at` / `updated_at` | TIMESTAMPTZ | `updated_at` moves on re-rate |

**RLS:** enabled, zero policies.

---

### `comment_reports`

Message-scoped reports for comments inside listing threads (v37) — separate from `listing_reports` so a reported *comment* doesn't count toward the listing's auto-flag threshold. Dedupes per `(message_id, reporter_user_id)`; the reporter's daily budget is shared with `listing_reports` under the same `report:<userId>` advisory lock.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGINT PK | |
| `listing_id` | BIGINT NULL | FK → `companion_listings.id ON DELETE SET NULL` — resolved via `listingByThreadId` at report time; NULL if the thread↔listing mapping is gone |
| `thread_id` / `message_id` | TEXT | The reported comment's thread + message snowflakes |
| `author_user_id` | TEXT | The comment's author — lets the Timeout mod action resolve the target from the stored row, not the (forgeable) button id |
| `reporter_user_id` | TEXT | Composite unique with `message_id`; indexed with `created_at` for the shared daily cap |
| `category` | TEXT | Same allowlist as listing reports minus `theft` (`other` fallback on forged ids) |
| `created_at` | TIMESTAMPTZ | |

**RLS:** enabled, zero policies.

---

### `marketplace_bans`

Creator publish-bans (v36), keyed by Discord user id so the self-host lane (no web accounts) can use them too. A ban publish-locks the creator and `banCreator` marks all their live listings `banned` — which freezes their adopted clones via the roster/DM/guild joins.

| Column | Type | Notes |
|--------|------|-------|
| `discord_user_id` | TEXT PK | |
| `reason` | TEXT | Mod-supplied reason |
| `banned_by` | TEXT | Acting moderator's Discord id |
| `created_at` | TIMESTAMPTZ | |

**RLS:** enabled, zero policies.

---

### `moderation_events`

Audit log for marketplace moderation actions (v36) — one row per mod-button action or creator ban. `listing_id` is `ON DELETE SET NULL` so the audit trail survives a hard-deleted listing.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGINT PK | |
| `listing_id` | BIGINT NULL | FK → `companion_listings.id` (indexed) |
| `actor_user_id` | TEXT | Acting moderator's Discord id |
| `action` | TEXT | `unflag` / `delist` / `ban` / `ban_creator` |
| `note` | TEXT | Optional note/reason |
| `created_at` | TIMESTAMPTZ | |

**RLS:** enabled, zero policies.

---

### `schema_migrations`

Version tracking for the migration system.

| Column | Type | Notes |
|--------|------|-------|
| `version` | INTEGER PK | Migration version number |
| `applied_at` | TEXT | ISO-8601 |

---

## Migration history

| Version | Name | What it added |
|---------|------|--------------|
| 1 | `phase_1a_add_evidence_tracking` | `confirmation_count`, `contradiction_count`, `updated_at`, `last_contradicted_at`, `supersedes_memory_id` on `memories`; `evidence_type`, `effect`, `message_content_snapshot`, `message_timestamp`, `created_at` on `memory_evidence`; `memory_history` table |
| 2 | `phase_1c_conflict_and_patterns` | `net_score`, `frozen_confidence`, `pattern_id` on `memories`; `behavioral_patterns` table |
| 3 | `phase_1c_primary_evidence_type` | `primary_evidence_type` on `memories` |
| 4 | `v02_events` | `event_id` on `memories`; `events`, `event_participants`, `event_messages`, `event_memories` tables |
| 5 | `v02_memory_subject_name` | `subject_name` on `memories` |
| 6 | `v02_message_triage_result` | `triage_result` on `messages` — persists LLM triage verdicts so re-ingests never re-triage |
| 7 | `v03_profiles_and_relationships` | `reply_to_id` on `messages`; `members`, `relationship_observations`, `relationships`, `profiles` tables |
| 8 | `v04_relationship_verdicts` | `verdict` on `relationship_observations` — joke assertions excluded from edge roll-up |
| 9 | `v05_alias_learning` | `alias_candidates` table — provenance for learned display-name aliases |
| 10 | `v06_unresolved_names` | `unresolved_names` table — names that failed entity resolution |
| 11 | `v11_memory_trigram_dedup` | `pg_trgm` extension + `memories_content_trgm` GIN index for near-duplicate memory matching |
| 12 | `v12_profile_attributes` | `profile_attributes` table + `profiles.attr_hash` — structured provenance-backed facets become the profile source of truth; create-only, no backfill |
| 13 | `v13_proactive_enabled` | `proactive_enabled` on `server_settings` — per-server opt-in for proactive speaking, default off |
| 14 | `v14_member_opted_in` | `opted_in` on `members` — derived data becomes consent-gated: person memories, relationships, attributes, profiles form only for `opted_in=1 AND opted_out=0` |
| 15 | `v15_guild_keys` | `guild_keys` table — AES-256-GCM encrypted API keys keyed by scope (`dm:<userId>` or `<guildId>`) |
| 16 | `v16_consent_posture` | `server_settings` defaults flip to dormant (`memory_enabled=0`, `reply_enabled=0`); `announced_at` marks the join disclosure |
| 17 | `v17_scale_rails` | `jobs` queue + `guild_usage` daily counters; `ignored_channels` and `llm_daily_cap` on `server_settings` |
| 18 | `v18_bot_flag_and_event_classifications` | `messages.author_is_bot` (archive-only context for other bots) and `events.classifications` (bounds re-classification passes) |
| 19 | `v19_relationship_observation_author` | `relationship_observations.author_id` — assertor provenance for opt-out deletion and party-authored weighting |
| 20 | `v20_relationship_intelligence` | `relationship_observations.source` (`'message'` vs `'pair_window'`); `relationships.behavioral_count`, `party_count`, `trend`, and `inferred` |
| 21 | `v21_companions_and_webhooks` | `companions` (1 permanent companion per user account), `guild_companions` (server summons), and `webhook_messages` (webhook attribution + `chain_depth`) |
| 22 | `v22_guild_keys_model` | `guild_keys.model` — per-key model override, required for custom base URLs |
| 23 | `v23_rls_lockdown` | `ENABLE ROW LEVEL SECURITY` on every `public` table (deny-all for `anon`/`authenticated`); revoked default table grants to those roles; moved `pg_trgm` into `extensions` schema when present |
| 24 | `v24_fk_indexes` | Covering indexes for unindexed FKs: `guild_companions(companion_id)`, `memory_history(evidence_id)`, `webhook_messages(companion_id)` |
| 25 | `v25_companion_journal` | `companion_journal` — first-person origin-scoped companion journal entries |
| 26 | `v26_web_profiles` | `public.web_profiles` (RLS, own-row policies), `internal.handle_new_user` trigger on `auth.users`, `public.delete_own_account` rpc — Supabase Auth web accounts |
| 27 | `v27_discord_link` | `link_codes` + `public.claim_link_code` rpc; `internal.sync_discord_identity` trigger on `auth.identities`; `web_profiles` update grants narrowed to `(display_name, updated_at)` — Discord ↔ web account linking |
| 28 | `v28_link_hardening` | `public.unlink_discord` rpc (code-claimed links); `claim_link_code` rowcount guard; `handle_new_user` falls back to OAuth `full_name`/`name` metadata |
| 29 | `v29_credits_and_bot_settings` | `plan`/`credit_balance`/lazy-grant columns on `web_profiles`; `credit_ledger` (own-row select policy); `user_bot_settings` (auth-gate-free, keyed by `discord_user_id`); `my_bot_settings`/`upsert_my_settings`/`my_byok_status` rpcs — hosted credits + per-user bot toggles |
| 30 | `v30_account_credits_hardening` | Revokes `authenticated INSERT` on `web_profiles` (trigger is the only row creator) + backfills missing profiles from `auth.users`; `claim_link_code` locks the code row `FOR UPDATE` and normalizes dashless input; `credit_ledger` policy uses `(select auth.uid())` |
| 31 | `v31_stripe_packs` | `web_profiles` gains `stripe_customer_id`/`stripe_subscription_id` (unique partial index on customer); `credit_ledger` gains `'purchase'` kind + `stripe_ref` (unique partial — webhook idempotency); `grant_pack` rpc (service_role only — atomic pack credit under the account row lock) |
| 32 | `v32_stripe_webhook_hardening` | `grant_pack` gains a positive-amount guard; `account_id_for_email` rpc (service_role only) resolves checkout emails → `web_profiles.id` for bare payment links |
| 33 | `v33_message_image_context` | `messages.image_context` — cached vision description shared by the extract job and reply paths |
| 34 | `v34_companion_marketplace` | Companion marketplace: `companions.kind`/`adopted_from_listing_id`/`listing_version`, partial unique index `companions_one_awakened` replaces the blanket owner uniqueness, `companion_listings`/`companion_persona_versions`/`companion_adoptions`/`listing_reports` tables, `user_bot_settings.active_dm_companion_id` |
| 35 | `v35_listing_source_nullable` | `companion_listings.source_companion_id` drops `NOT NULL` — freehand creator-authored listings (`/companion create`) have no awakened source |
| 36 | `v36_moderation_surface` | `listing_reports.category`, `marketplace_bans`, `moderation_events`, and the per-day rate-limit indexes (`reporter_user_id`/`creator_user_id`/`user_id` + timestamps) |
| 37 | `v37_ratings_and_comment_reports` | `listing_ratings` (upsert-per-rater, `stars` 1–5 CHECK) + `comment_reports` (dedupe per `(message_id, reporter_user_id)`, shared daily report budget) — listing threads become the comment + rating surface |
| 38 | `v38_discord_profile_snapshot` | `link_codes` + `web_profiles` gain `discord_username`/`discord_avatar_url`; `claim_link_code` copies the mint-time snapshot, the identity trigger stamps it from `identity_data`, `unlink_discord` clears it; OAuth rows backfilled — code-linked accounts render name/avatar like OAuth ones |
| 39 | `v39_consent_events` | `consent_events` — append-only Terms/Privacy clickwrap log (`discord_user_id`, `account_id`, `document`, `version`, `source`, `accepted_at`) backing the verify-gate acceptance step and the sweep's unconsented-member revocation |
| 40 | `v40_semantic_recall` | `vector` extension + un-dimensioned `embedding` columns on `memories` and `companion_journal` — hybrid semantic recall, dims enforced in code (`EMBED_DIMS`), no ANN index (guild-scope scans are tiny) |
| 41 | `v41_web_consent` | `consent_events.discord_user_id` → nullable (web signups have no Discord id yet), `consent_events_account_doc` index, RLS enabled (fail-closed to PostgREST) + auth-gated `my_consent`/`record_consent` security-definer RPCs — the site's `web_signup` write path |
| 42 | `v42_character_import` | `persona_source`/`import_meta` on `companions` + `companion_listings` (import provenance), auth-gated `import_companion_card` security-definer RPC (private `unlisted` listing + adopted clone + DM-pick claim, idempotent on `sha256`), `card-avatars` storage bucket with uid-folder policies; rollback refuses while imports exist |
| 43 | `v43_import_hardening` | `companion_listings.published_at` (first-live stamp — the daily publish cap counts this, not `created_at`; live rows backfilled from `created_at`), hardened `import_companion_card` (reuse branch pays cooldown/slot/daily-adopt checks like `adoptListing`, card tags carried into provenance), `card_avatars_update` gains `WITH CHECK` so objects can't be renamed into another uid's folder |
| 44 | `v44_chat_import` | `chat_imports` (transcript → journal distillation pipeline: `turns` cleared at done/failed — distill-and-discard), `companion_journal.source`/`import_id` (import provenance + retraction scope), `kind='bond'` for the pinned "what we were" summary, auth-gated `my_companions`/`my_chat_imports`/`import_chat_history` security-definer RPCs; rollback refuses while imports exist |
| 45 | `v45_chat_import_undo` | auth-gated `delete_chat_import(p_id)` security-definer RPC — owner-scoped row delete; the `import_id` cascade retracts the distilled journal (the website's Undo button + `/companion imports`) |
| 46 | `v46_quiet_channels` | `server_settings.quiet_channels TEXT[]` — companion silence without blindness: replies and system cards suppressed while archiving/extraction continue; threads inherit via `parentId` |
| 47 | `v47_app_installs` | `app_installs` (install ledger for the welcome-DM sweep) + `record_app_install` security-definer RPC (service-role only — the website worker's webhook sink); rollback refuses while installs exist |
| 48 | `v48_support_tickets` | `support_tickets` + partial unique index `one_open_per_user` — the house ticket system's ledger; rollback refuses while tickets exist |
| 54 | `v54_adoptee_threads` | `companion_adoptions.chat_thread_id` + partial index `adoptions_thread` — adoptee private-thread registry; drop→re-adopt reuses the same thread so history continues |
| 60 | `v60_token_buckets_exact_clawback` | `web_profiles.purchased_balance` (persistent pack/bonus slice of `credit_balance`; backfilled from net unrefunded purchases), `credit_ledger.payment_intent` + index, `grant_bonus` ledger kind (launch-bonus rows reclassified), `grant_pack(…, p_payment_intent, p_kind)` and `clawback_pack(…, p_payment_intent, p_amount, p_amount_refunded, p_charged_at)` — exact-PI match (pre-v60 packs by grant time), prorated + cumulative partial refunds, subscription refunds never claw packs |
| 61 | `v61_sweep_indexes` | partial indexes `messages_untriaged (created_at) WHERE triage_result IS NULL` and `messages_pending_extract (guild_id) WHERE triage_result IN ('durable','regex','queued')` — back `dmScopesNeedingSweep` so the 15-min sweep visits only DM scopes with work |
| 62 | `v62_analytics` | `analytics_events` (pseudonymous funnel events, `NOT EXISTS analytics_opt_out` gate), `metrics_daily` (durable `inc()` rollup), `user_bot_settings.analytics_opt_out` — all RLS deny-all, bot-owned |
