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
| `active` | SMALLINT | `1` = active in server (`listGuildCompanions`); `0` = dismissed (`/companion action:dismiss`) |
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

**Semantic dedup:** the trigram path only catches lexically similar rephrasings. A nightly maintenance pass (`applyRetention`, also at end of ingest) hands each member's memory list to `Brain.dedupMemoriesBatch`, which returns `duplicate` groups and `contradicts` pairs. Confirmed duplicate groups merge via `applyDedupGroups`/`mergeDuplicate`: evidence moves to a deterministic canonical row (active > candidate, then confidence, then lowest id) — except rows colliding on `message_id`, which stay on the superseded loser because `memory_history.evidence_id` references them. The losers become `superseded` with `superseded_by` pointing at the canonical — never deleted. Canonical status/confidence are untouched (merging cannot promote). Guards drop groups that mix subjects, kinds, or non-live statuses; `episode` kind and `unknown` subjects are never offered. `contradicts` verdicts only log `dedup_contradiction` history rows — no status change.

#### Memory lifecycle statuses

| Status | Meaning |
|--------|---------|
| `candidate` | New memory below confidence or promotion threshold; never used in replies. Promotion requires corroboration — `confirmation_count ≥ 2` supporting evidence rows of a promotable type push confidence past the threshold; a single sighting can never activate, and `unknown` subjects are inert until claimed |
| `active` | Confirmed and surfaced in replies |
| `contested` | Contradicting evidence received; confidence frozen; `net_score` drives resolution. A standoff with no new signal in 30 days settles by its standing sign — support-leaning returns to `candidate`, contradiction-leaning to `quarantined` |
| `quarantined` | Old candidate (>7 days) or old low-confidence active (>90 days, confidence <0.75) |
| `superseded` | Replaced by a correction **or** merged as a duplicate; linked to the surviving row via `superseded_by` |
| `forgotten` | Manually forgotten via `/forget`; never used in replies |

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
| `ignored_channels` | TEXT[] | Channels excluded from archiving, replies, member writes, and historical ingest — managed via `/ignore-channel` / `/unignore-channel` |
| `llm_daily_cap` | INTEGER | Per-guild LLM call budget per UTC day (default 1000; 0 = all calls blocked) — set via `/limits` |

Row is created with dormant defaults (`memory_enabled=0`, `reply_enabled=0`) on first sight of a guild — an admin enables observation via `/memory-resume`. Administrators can override via `/memory-pause`, `/memory-resume`, and the `RAW_MESSAGE_RETENTION_DAYS` env variable.

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

Encrypted LLM API keys (BYOK), written by `/companion action:key`, `/setup`, or the onboarding **Paste API Key** modal. Keyed by scope (`dm:<userId>` for a user's personal key, or `<guildId>`). Lives in a dedicated table so export/purge paths never casually touch ciphertext.

| Column | Type | Notes |
|--------|------|-------|
| `guild_id` | TEXT PK | Scope ID: `dm:<userId>` for personal user keys (primary in Characterly) or Discord server ID |
| `key_enc` | BYTEA | AES-256-GCM ciphertext (`iv ‖ ciphertext ‖ tag`, `src/secrets.ts`) — there is no plaintext key column |
| `key_hint` | TEXT | Last 4 chars of the key, for masked display (`…abcd`) |
| `base_url` | TEXT NULL | Custom OpenAI-compatible endpoint; NULL = auto-detected from key prefix (`gsk_`, `sk-or-`, `sk-`, `xai-`) or env default |
| `model` | TEXT NULL | Per-key model override (v22) — required for custom base URLs (a self-hosted server won't serve the detected default), optional otherwise |
| `validated_at` | TIMESTAMPTZ NULL | NULL = stored but never verified live (provider unreachable at setup time) |
| `created_at` / `updated_at` | TIMESTAMPTZ | Upsert timestamps |

Decryption requires `KEY_ENCRYPTION_SECRET`; rotating that secret orphans existing rows (recovery = re-run `/companion action:key` or `/setup`).

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

Member registry — one row per (guild, user). Built by `recordMessage()` so both the live bot and ingest populate it.

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

Structured person facets — the **source of truth** for profile cards; `summary`/`facets_json` are renderings of these rows. Provenance-backed: every facet cites the memories that justify it, so `/forget`/`supersede`/merge cascade immediately.

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

Extraction: deterministic regexes on `person_fact`/`person_preference` content run inside `buildProfiles` (also the lazy backfill); an LLM pass proposes `trait`/`interest`/`skill` gated on `source_hash`. Only `active` rows render anywhere; `contested` surfaces in `/memory-triage`.

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
| `kind` | TEXT | `moment` · `opinion` · `inside_joke` · `promise` |
| `content` | TEXT | First-person journal text |
| `about_subject_ids` | TEXT[] | Subjects the entry mentions — consent-gated at write *and* read time |
| `importance` | DOUBLE | 0–1, ranks recall order and prune eviction |
| `status` | TEXT | `active` · `forgotten` |
| `source_message_id` | TEXT NULL | The companion's own reply that produced the entry (provenance + idempotency key) |
| `created_at` / `updated_at` | TIMESTAMPTZ | |
| `last_recalled_at` | TIMESTAMPTZ NULL | Stamped on each `journalFor` hit — drives the 30-day decay in `pruneJournal` |

**Unique constraint:** `(companion_id, origin_scope, source_message_id, kind, content)` — a crashed job resaving identical output can't stack rows. **Indexes:** `companion_journal_lookup (companion_id, origin_scope, status, importance DESC)`; `companion_journal_about` GIN on `about_subject_ids`. RLS enabled (v25) with no policies — Data-API deny-all. Write-time trgm dedup drops paraphrases (similarity ≥ 0.75); nightly `pruneJournal` caps 200 active entries per (companion, scope).

---

### `web_profiles`

Web account profiles for Supabase Auth users (v26) — the "real life user" half, named `web_profiles` because `profiles` is already the subject-profile table. Only created when the `auth` schema exists (Supabase); plain Postgres skips it.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | FK → `auth.users.id ON DELETE CASCADE` — the Supabase Auth user |
| `display_name` | TEXT | Editable display name (seeded from `raw_user_meta_data`) |
| `discord_user_id` | TEXT UNIQUE NULL | Linked Discord snowflake — **server-managed** (v27): written only by the `on_identity_sync` trigger or the `claim_link_code` rpc; not user-writable |
| `stripe_customer_id` | TEXT UNIQUE NULL | Reserved for billing — server-managed, not user-writable |
| `created_at` / `updated_at` | TIMESTAMPTZ | |

**RLS:** own-row `SELECT`/`INSERT`/`UPDATE` policies for `authenticated`; `UPDATE` granted only on `(display_name, updated_at)` (v27) so a user can never forge `discord_user_id` or `stripe_customer_id` on their own row.

**Supporting functions & triggers** (all under the auth-schema gate, `SECURITY DEFINER`, `search_path = ''`, revoked from PUBLIC/anon):

- `internal.handle_new_user()` + `on_auth_user_created` (v26; metadata fallbacks `display_name`/`full_name`/`name` from v28) — inserts a `web_profiles` row for each new `auth.users` row.
- `internal.sync_discord_identity()` + `on_identity_sync` on `auth.identities` (v27) — on `INSERT`/`DELETE` of a `discord` identity, copies `provider_id` into `web_profiles.discord_user_id` (or NULLs it back out, guarded on the exact provider_id). Covers OAuth signup, `linkIdentity`, auto-merged identities, unlink, and account deletion; a duplicate link raises `discord_already_linked`. v27 also backfilled pre-existing Discord sign-ins.
- `public.claim_link_code(p_code)` (v27; v28 adds a rowcount check so a missing `web_profiles` row raises `no_profile` instead of silently consuming the code) — `EXECUTE` granted to `authenticated`; validates a `/link` code (exists, unclaimed, unexpired, Discord account not already linked elsewhere) and stamps `discord_user_id`. Errors are `tag: message` strings (`invalid_code`, `code_used`, `code_expired`, `discord_already_linked`, `no_profile`).
- `public.unlink_discord()` (v28) — `EXECUTE` granted to `authenticated`; clears the caller's `discord_user_id`. Needed because code-claimed links have no `auth.identities` row for `unlinkIdentity` to remove (identity-backed links should unlink via `unlinkIdentity`, which the trigger mirrors).
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

**Index:** `link_codes_user (discord_user_id, expires_at)`. **RLS:** enabled with zero policies — only the bot (postgres role) reads/writes; web claims funnel through the security-definer rpc. Lives outside the auth-schema gate so `/link` works on any database.

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

`web_profiles` also gains (same migration): `plan` (`'free'|'premium'`, default `free`), `credit_balance`, `last_daily_grant_on`, `last_weekly_grant_on` (dormant since v31 — premium is a single 150/day floor now). Grants are **lazy refills**: `spendCredits` tops the balance up to the plan's daily floor under the row lock before debiting — no scheduler, downtime-safe, and a refill can't bank beyond the floor. v31 also adds `stripe_customer_id` / `stripe_subscription_id` for the billing webhook's customer→account mapping.

---

### `user_bot_settings`

Per-Discord-user bot toggles (v29), keyed by `discord_user_id` **outside** the auth-schema gate so the bot reads them with zero joins on any Postgres. The site writes through `upsert_my_settings`, which stamps the caller's own linked `discord_user_id` — users can't set toggles for a Discord account that isn't theirs.

| Column | Type | Notes |
|--------|------|-------|
| `discord_user_id` | TEXT PK | |
| `c2c_enabled` | BOOLEAN | Default true — companion replies to other companions (those turns spend the owner's tokens) |
| `low_credit_alerts` | BOOLEAN | Default true — once-per-UTC-day DM when the balance runs low |
| `active_dm_companion_id` | BIGINT NULL | Which roster companion answers the user's DMs (v34); null = the awakened companion. Cleared automatically when the picked adoption is dropped |
| `updated_at` | TIMESTAMPTZ | |

**RLS:** enabled, zero policies — the bot reads/writes via the postgres role; the site uses `my_bot_settings()` / `upsert_my_settings(patch)` / `my_byok_status()` security-definer rpcs (authenticated role only).

---

### `companion_listings`

The marketplace's publishable persona (v34): a creator's awakened companion projected into the hub server's forum channel via `/companion action:publish`. Editable and versioned — adopters hold *live references*: persona edits bump `version` and propagate into every adopted clone's `companions` row.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGINT PK | Referenced by `market:add:<id>` / `market:report:<id>` button custom IDs |
| `creator_user_id` | TEXT | Discord user ID of the publisher (must hold a linked web account) |
| `source_companion_id` | BIGINT UNIQUE | FK → `companions.id` — the awakened companion the listing projects |
| `name` / `tagline` | TEXT | Display name + listing-card blurb |
| `voice_persona` / `core_traits` / `owner_dynamic` / `backstory` | — | Persona fields cloned into adopters' `companions` rows |
| `greeting` | TEXT | First DM the character sends on adoption — stamps `dm_introduced_at` on successful send |
| `avatar_url` | TEXT NULL | |
| `forum_thread_id` | TEXT NULL | The bot-created forum post (its embed card owns the Add/Report buttons) |
| `version` | INTEGER | Increments on every upsert; each version is snapshotted in `companion_persona_versions` |
| `status` | TEXT | `'active'` → `'flagged'` (auto at report threshold) or `'delisted'` (unpublish/mod) — non-active statuses block new adoptions |
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

One row per (user, listing) adoption relationship (v34). `companion_id` points at the adopter-owned clone; `dropped_at`/`cooldown_until` drive the 12-hour re-adopt cooldown; `dm_introduced_at` is stamped only when the greeting DM actually lands and gates server summoning.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGINT PK | |
| `user_id` | TEXT | The adopter (partial index `adoptions_active` on `dropped_at IS NULL` feeds the free-tier slot count) |
| `listing_id` | BIGINT | FK → `companion_listings.id ON DELETE CASCADE` (indexed) |
| `companion_id` | BIGINT | FK → `companions.id ON DELETE CASCADE` — the `kind='adopted'` clone (indexed) |
| `adopted_at` | TIMESTAMPTZ | Resets on re-adoption |
| `dropped_at` / `cooldown_until` | TIMESTAMPTZ NULL | Set together by `dropAdoption`; re-adoption clears both and reuses the same clone |
| `dm_introduced_at` | TIMESTAMPTZ NULL | Stamped by `markDmIntroduced` after the greeting send succeeds |

**RLS:** enabled, zero policies.

---

### `listing_reports`

Moderation foundation (v34): one row per (listing, reporter) so reports dedupe naturally; the report counter on `companion_listings` auto-flags at `MARKETPLACE_REPORT_FLAG_THRESHOLD` and pings `MARKETPLACE_MOD_CHANNEL_ID`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGINT PK | |
| `listing_id` | BIGINT | FK → `companion_listings.id ON DELETE CASCADE` (indexed) |
| `reporter_user_id` | TEXT | Composite unique with `listing_id` — a user reports once |
| `reason` | TEXT | Optional free text (v1 reports have no modal) |
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
