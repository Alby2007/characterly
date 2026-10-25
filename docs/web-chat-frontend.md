# Web chat — frontend contract (v73–v74)

Backend for companion chat on the website. Live as of migration v73 (hardened in v74); turns run
on the bot VM through the existing jobs queue — the website never forks the
pipeline. **This document is the contract the web chat UI is built against.**

## Auth

Every call is a PostgREST RPC under the user's Supabase session — same
`supabase.rpc(name, args)` pattern the dashboard already uses. All functions
are `SECURITY DEFINER`; tables are RLS-gated (own rows only). Anon gets nothing.

## Account model (read-only context)

- Identity = `web_profiles.id` = `auth.uid()`. The frontend never passes ids —
  the RPCs resolve the caller.
- **Linked** accounts (`web_profiles.discord_user_id` set) chat on the
  `dm:<discord_id>` bond — same companion bond, memory, journal and credits as
  their Discord DMs. **Unlinked** accounts get a separate `web:<uuid>` bond.
  Linking Discord later does NOT merge the two — and since v74 the scope is
  per-ADOPTION, not per-account-state: a bond created pre-link keeps its
  `web:<uuid>` scope (and stays visible/droppable/chat-able) after linking.
  A listing adopted fresh post-link keys to `dm:<did>` instead.
- v1 is **hosted-only**: every reply costs 2 tokens from `credit_balance`
  (daily allowance first, then purchased packs — server-side, invisible to the
  client beyond balance). No BYOK UI yet.

## RPCs

All return a single `json`/`jsonb` value. Errors come back as
`{ok:false, reason}` — treat `reason` as the UI switch, never parse English.

### `web_adopt_listing(p_listing_id bigint)`

Adopt a marketplace listing → creates/reuses the adoption + its clone +
opens the conversation (with the greeting as first message).

```jsonc
// ok
{ "ok": true, "adoption_id": 3, "companion_id": 4, "conversation_id": 2,
  "name": "Nightforge", "reused": false, "revived": false }
// fail
{ "ok": false, "reason": "not_found" | "delisted" | "own_listing" | "cooldown" }
// cooldown adds: "cooldown_until": <timestamptz>
```

- `reused` = already had this adoption (button becomes "Open chat", not an error).
- `revived` = re-adopting after a drop (same bond resumes).
- `cooldown` = dropped <12h ago; show the timestamp.
- **No slot cap on web** — adopt as many as desired.

### `web_my_adoptions()`

`[{adoption_id, companion_id, listing_id, name, avatar_url, tagline,
   listing_status, origin, adopted_at, open_conversation_id}]` — newest first.
Linked users see their Discord adoptions too (they can continue them on web).

### `web_open_conversation(p_adoption_id bigint)`

`{ok:true, conversation_id, created}` or `{ok:false, reason:"no_adoption"}`.
One live conversation per adoption — archive + reopen = "new chat".

### `web_my_conversations()`

`[{id, companion_id, adoption_id, name, avatar_url, scope, archived,
   created_at, last_activity_at, pending, last_message:{id,role,content,status,created_at}}]`
— sorted `last_activity_at` desc. `pending` = a reply is in flight (sidebar dot).

### `web_send_message(p_conversation_id bigint, p_text text, p_client_msg_id uuid)`

Inserts the user row + a `pending` companion placeholder, enqueues the turn.
**Always generate `p_client_msg_id` client-side per send** — a retried send
returns `{reused:true}` with the original ids instead of double-posting.

```jsonc
{ "ok": true, "user_message_id": 41, "companion_message_id": 42, "reused": false }
{ "ok": false, "reason": "archived" | "empty" | "too_long" | "companion_gone" | "banned" }
```

- `too_long` = >4000 chars. `companion_gone` = adoption dropped elsewhere.
- Billing failures surface later on the placeholder row (see below), not here.

### `web_conversation_messages(p_conversation_id bigint, p_after_id bigint default 0, p_limit int default 100)`

History + polling fallback. `[{id, role, content, status, fail_reason,
client_msg_id, created_at}]` — oldest-first, `id > after_id`, cap 200.
Pass the max seen `id` as `after_id` to poll incrementally.

### `web_archive_conversation(p_conversation_id bigint, p_archived boolean default true)`

`{ok:true}` — the "close chat" affordance. Sending to an archived conv →
`archived`. Reopen via `web_open_conversation`.

### `web_drop_adoption(p_adoption_id bigint)`

Give the companion back: `{ok:true}` or `{reason:"no_adoption"}`. Archives its
open conversations and starts the 12h re-adopt cooldown. Confirm dialog first.

### `web_report_listing(p_listing_id bigint, p_category text, p_reason text default '')`

`{ok:true, count, flagged}` — `flagged` means the report threshold tripped the
listing off the shelf. Fails: `daily_cap` (rate-limited), `dup` (already
reported this listing). Categories come from the same taxonomy the site uses
elsewhere — check `reportListing` call sites for the canonical list.

## Messages

| role        | meaning                                          |
|-------------|--------------------------------------------------|
| `user`      | the visitor's text (always `done`)                |
| `companion` | a reply — placeholder until generation lands      |
| `system`    | notice row (refusals, crisis card, limit info)    |

`status`: `pending` → `generating` → `done` | `failed`.
On `failed`, `fail_reason` is the vocabulary:

| fail_reason     | UX                                                    |
|-----------------|-------------------------------------------------------|
| `archived`      | conversation closed elsewhere                         |
| `no_companion`  | adoption dropped/companion deleted                    |
| `banned`        | listing banned — chat frozen                          |
| `no_trigger`    | internal (missing user text) — generic error           |
| `no_reply`      | turn finished without a reply — billing refusals land  |
|                 | here too; a `system` row right after explains why      |

Billing/capacity refusals are delivered as **system rows**, not fail_reason:
empty wallet → "out of tokens" copy pointing at `/dashboard` (buy tokens);
fleet pressure → try-later copy. Render system rows as centered notices.

## Live updates

### Primary: Supabase Realtime private broadcast

Every `web_messages` INSERT/UPDATE pushes to the account's private channel:

- **Channel:** `web-messages:<web_profile_id>` — subscribe with
  `supabase.channel('web-messages:' + user.id, { config: { private: true } })`.
- **Event:** `'message'` (broadcast event name).
- **Payload:** `{type:'web_message', conversation_id, id, role, status,
  content, fail_reason, created_at}` — full row each time; a `done` broadcast
  carries the reply text. Authorization is DB-side (`realtime.messages` policy);
  a user can only join their own channel.
- Apply updates by `id` — pending→generating→done arrive as separate events.

### Fallback: poll `web_conversation_messages`

Every ~2.5s while any `pending`/`generating` row exists in the open convo;
`after_id` = last seen id. The conversation list's `pending` flag is the cheap
sidebar signal.

## Flows

- **Adopt → chat:** listing page button → `web_adopt_listing` → route to
  `/chat/<conversation_id>`; the greeting is already the first message.
- **Roster → chat:** `web_my_conversations` sidebar → open convo →
  `web_conversation_messages` (initial page) → subscribe/poll.
- **Send:** `web_send_message` → optimistic user row + pending bubble →
  realtime/poll resolves it.
- **Linked Discord users:** their `dm:`-scope adoptions appear in
  `web_my_adoptions` — opening one continues the same bond (memory carries).
  Their Discord-side adoptions show `origin:'discord'`. Adoptions made on the
  web before linking keep their `web:` scope and still list here.
- **One open conversation per adoption** is DB-enforced — racing
  `web_open_conversation` calls can't mint doubles; they converge on the
  same conversation_id.
- **Stuck replies:** if a companion row stays `pending`/`generating` past
  ~2 min it's almost certainly a dead-lettered job — render it as the
  `no_reply` failure state client-side rather than polling forever (a late
  `done` still applies over it if the turn eventually lands).

## Explicitly NOT in v1 (don't build UI for these)

Regenerate/edit/delete buttons, images in chat, group chats, share links,
BYOK key entry, companion creation (onboarding interview lives on Discord).
Web chat is adopt-from-marketplace only.
