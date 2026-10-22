# Security model — trust boundaries

Where the untrusted input is and what defends each crossing. This is a map:
each boundary points at the doc or source that owns the details — don't
maintain two copies.

```
members ──► Discord ──► bot ──► LLM providers        (keys: operator env / BYOK)
                          │    ▲
                          ▼    │
                       Postgres (Supabase) ◄── site (publishable key + RLS)
                          ▲                    ▲         │
                          │                    │         ▼
                worker lanes (/discord/events,      Stripe ──► edge fns
                /avatar, /track)                    (service-role writes only)
```

## Boundary-by-boundary

**User text → LLM prompts.** Every member- or third-party-authored string
passes a `src/prompt-safety.ts` helper before interpolation — `promptInline`,
`promptName`, `sanitizeBlock` + `wrapUntrusted`, `sanitizeJsonValue`.
Pipeline prompts carry the `MEMBER_TEXT_IS_DATA` clause; the reply prompt
adds the VAULT RULE (DM subtext never leaks to servers) and the DIGEST RULE.
Structural guarantee: adversarial text can sound imperative but can't escape
its labeled slot. → `AGENTS.md` § Prompt hygiene, `architecture.md`
(cross-context section), `src/prompt-injection.test.ts`.

**Prompt output → Discord.** `containsPrivateSubtext` suppresses a server
reply echoing a vault line verbatim and refunds the turn. Adopted-companion
replies are additionally screened on both billing lanes; a flag swaps in a
neutral refusal + refund (fail-open: screen errors send the reply and
increment `safety.screen_error`). → `docs/moderation.md`.

**Untrusted URLs → network.** Every URL input (avatars, covers, tools'
`visit_url`, BYOK `base_url`) passes `isSafeUrl` +
`resolvesToPrivateAddress` — public http(s) only, no private IPs/localhost/
unresolvable hosts. LLM calls to guild-chosen endpoints additionally ride
`guardedLlmFetch` (`src/brains.ts`): `isSafeUrl` re-checked per hop,
`safeLookup` re-validates DNS inside the connect path (anti-rebinding), and
redirects are followed manually (≤3 hops, replayable bodies only) — a BYOK
endpoint can't turn the bot into an internal-network request primitive.
The operator's env URL is exempt by design (self-hosters legitimately run
LAN model servers). → `src/tools.ts`, `src/brains.ts`, `src/avatars.ts`.

**Bot → Postgres.** RLS enabled on every `public` table with zero
Data-API policies (deny-all); the bot's `postgres` role bypasses. The
exceptions are deliberately narrow and documented per table. →
`docs/schema.md` intro.

**Browser → Supabase.** The publishable key is public by design — access is
RLS, not secrecy. Direct client writes are almost nothing: the security-definer
RPCs are the write lanes (`claim_link_code`, `record_consent`,
`import_companion_card`, `import_chat_history`, `my_*` editors,
`delete_own_account`), each `auth.uid()`-keyed and server-validated.
`web_profiles.discord_user_id` is trigger-written only; users can never
write it on their own row. → `docs/website.md`, `docs/schema.md`,
`docs/architecture.md` § Web accounts.

**Discord → worker.** `POST /discord/events` verifies Discord's Ed25519
signature before anything touches `record_app_install` (service-role only);
the endpoint fails closed (401) when `DISCORD_APP_PUBLIC_KEY` is unset —
Discord's own health probes expect that. → `docs/operations.md` § Install
greeting, `src/discord-events.ts`.

**Bot → worker → storage.** `PUT /avatar` / `POST /avatar/gc` gate on
`AVATAR_UPLOAD_SECRET` compared in constant time; unset disables the lane.
The bucket is public-read; uploads are path-scoped and count-capped per uid.
→ `src/avatars.ts`, `web/src/worker.ts`, `docs/schema.md` (v53).

**Stripe → edge fns.** `stripe-webhook` verifies `Stripe-Signature`
(WebCrypto HMAC-SHA256, 5-min tolerance) and only acks unresolvable/duplicate
events — everything else 500s for Stripe retry. `create-checkout` is
JWT-verified, forces `client_reference_id` to the caller, and checks plan
server-side. Pack fulfillment dedupes on `credit_ledger.stripe_ref`. →
`docs/operations.md` § Billing.

**Forged interaction ids → actions.** Every button/modal submit re-verifies:
categories whitelist against `REPORT_CATEGORIES`/`HOUSE_REPORT_CATEGORIES`,
report pings suppress mention parsing so a quote can't ping, mod-action
targets resolve from the stored row (never the customId's author field),
creator bans are enforced on every write path. → `docs/moderation.md`,
`src/ops/automod.ts`.

**House actors → moderation.** Three tiers: `/ops` (person-allowlisted
`OPS_USER_IDS` — controls the host), marketplace mods
(`MARKETPLACE_MOD_ROLE_IDS`, fallback ManageGuild), house staff
(ManageMessages/ManageGuild for `house:modmsg`). → `docs/operations.md`,
`docs/moderation.md`.

**API keys at rest.** User/provider keys are AES-256-GCM encrypted in
`guild_keys` under `KEY_ENCRYPTION_SECRET`; rotation orphans all rows by
design. Secret inventory + rotation runbook: → `docs/operations.md`
§ Secrets & rotation.

**Companion personas → chat.** Listings are untrusted authored content:
publish/edit screens are fail-closed (blocklist → `safetyVerdict` on the
operator model), imported cards carry `sha256` provenance, adopted replies
are output-screened (above). Awakened companions are first-party private
content and unscreened by design. → `docs/moderation.md`.

**Data retention.** Raw messages purge on `RAW_MESSAGE_RETENTION_DAYS`;
`/opt-out` hard-deletes memories/journal about a subject; imported
transcripts are distill-and-discard (no stored corpus); guild-kick and
self-delete paths cascade. → `docs/configuration.md`, `docs/architecture.md`
§ Consent model, root `PRIVACY.md`.

## Deliberate non-goals

- **Awakened-companion output is unscreened** — first-party consented private
  content; the marketplace screen boundary is adoption, not generation.
- **Adoptee threads are admin-visible** (house `staffModerate` grant;
  partner-guild admins disclosed at adopt-confirm) — "private" means
  member-private, not staff-invisible.
- **Fail-open reply screen** — availability beats blocking on provider
  hiccups; the metric is the tripwire.
