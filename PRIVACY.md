# Characterly Privacy Policy

_Last updated: 2026-10-18_

Characterly ("the bot") is a Discord bot that hosts personal AI companions. This policy describes what it stores, why, and how to remove it. Plain English, no legalese.

## What the bot stores

**Dormant until enabled.** When the bot joins a server it posts a disclosure card and records **nothing** — observation starts only after a server admin runs `/server resume`. Everything below applies once enabled.

**Raw message archive.** Messages in channels the bot can read are archived to a PostgreSQL database so the bot can reply with context, extract knowledge, and audit where a memory came from. Raw messages are retained for **30 days** by default (the operator may configure 1–365 days) and then permanently deleted — including the verbatim quote/snapshot columns inside memory evidence (audit metadata like evidence type and reason is kept, the quoted words are not).

**Member registry.** Per server, per user: display names/nicknames observed, message count, and first/last activity timestamps. This exists so the bot can tell who a name refers to — it is infrastructure, not a profile.

**Server-level knowledge.** Facts and lore about the server itself (in-jokes, events, what the community is) plus detected server events. These are shared context and do not require individual consent.

**Derived personal data — opt-in only.** Memories about a person, structured profile attributes (pronouns, interests, timezone, etc.), generated profile cards and dossiers, and relationship observations/edges are created **only for members who explicitly opt in** via `/profile-build` or `/opt-in`. Members who never opt in get no derived data.

**Companion journal.** When a companion speaks it may privately journal — short first-person notes about what it experienced (a shared moment, a joke, a promise). Entries are paraphrased, never verbatim quotes; an entry that involves you is only written if you are opted in, and it stays scoped to where it formed. Entries about you are deleted on `/opt-out`, shown in `/memory export`, and a server's entries are wiped if the bot is removed.

**Story recaps.** Each companion keeps a rolling first-person "story so far" summary per conversation, so it remembers what happened beyond the live message window. Recaps are scoped to that companion and that chat, update as you talk, and are yours to edit (`/companion story` or the account page), reset (`/companion reset-story`), or delete via `/opt-out`.

**Story facts vs real facts.** Things that happen in roleplay are stored as *story facts* scoped to the companion they happened with — they never become facts about the real you, never show up for your other companions, and never leave that character's context. Facts about real life are shared across your own companions, so you only tell them something once.

**Crossing the DM boundary — your call.** By default, facts about you stay inside the server where they formed. A companion debriefing its owner in DMs may carry **server lore** and the **owner's own** facts — never yours — unless you explicitly enable `/memory share-facts` in that server. Turn it off at any time and your facts stop crossing.

**Adopted-companion threads.** Chats with companions you adopt from the marketplace live in private threads under `#adoptees` in the Characterly community server. Messages there are archived and processed exactly like DM conversations (same retention, extraction, and deletion controls) — but unlike DMs, Discord private threads are also visible to members with thread-moderation permissions, which on `#adoptees` is restricted to server **Admins** only — Moderator-role holders cannot see them. Admins only open these threads for safety and support purposes; automated community moderation never runs inside them.

**Third-party processing.** Message content is sent to a large-language-model API (currently Groq; configurable to any OpenAI-compatible provider) for memory extraction, verification, and reply generation. Servers may supply their own provider key via `/setup` — stored encrypted, never shown after entry.

**Usage analytics.** The bot records first-party product analytics: which Discord id reached which product step (install greeted, onboarding started, companion awakened, summoned, adopted, house joined, verified), plus aggregate daily counters of operational events. These rows never contain message content, prompts, or AI replies — only that an event happened. The website similarly counts page views and funnel clicks (sign-up, checkout, link) through Cloudflare Analytics Engine — first-party, no cookies, no cross-site tracking, no stored IP addresses or user identifiers. `/opt-out` deletes your event rows and stops future tracking; daily counter rollups and site page views are non-identifying aggregates that don't name you.

## What the bot does not do

- It does not message users first in DMs, sell data, or share data between servers.
- It does not build profiles or person-memories for members who haven't opted in.
- It does not respond to other bots or store their messages as memory sources.

## Deletion and your controls

- **Deleting a Discord message** removes its archived copy and scrubs the verbatim text from any evidence it produced (audit metadata like evidence type is kept).
- **Editing a message** updates the archived copy. Evidence snapshots deliberately keep the original text, as the record of what a memory was derived from.
- **`/opt-out`** removes all your derived data and prevents any new derived data about you: relationships, profile, and attributes are deleted outright; memories are marked forgotten (invisible to every read path — the row's audit metadata is kept, while its verbatim quotes are scrubbed immediately); companion journal entries involving you are deleted, story recaps in your DM lane are removed, and your usage-analytics event rows are deleted with future tracking stopped. Your raw messages remain in the archive until retention expires.
- **`/memory forget`** removes a single memory.
- **`/memory remember`** pins a fact you state yourself so it's always in context; `/memory list` with `pin:` un-pins it, and right-clicking any message offers **Pin to memory**.
- **`/companion story` / `reset-story`** let you read, rewrite, or clear the running story recap for the current chat.
- **`/memory share-facts`** controls whether facts about you may ride a companion's private debrief to its owner — off by default.
- **The account page (`/dashboard`)** shows everything your companion remembers in your DM lane — memories, journal, and the story recap — with pin, edit, and forget controls.
- **`/memory export`** lets you download everything the bot holds about you.
- Server admins can set a shorter retention window via `/server purge` or disable memory/reply features entirely via `/server pause`.
- **`/privacy`** shows any member exactly what is stored, the retention window, and their own consent state.
- **Removing the bot from a server deletes every row it stored there** — raw messages, memories, profiles, keys, and settings — immediately and permanently.

## Contact

Operated by [Alby2007](https://github.com/Alby2007). Questions or deletion requests: open a **#support-ticket** in the [Characterly community server](https://discord.gg/vCjQ9v3md) — tickets create a private staff-only thread — or delete your account directly from the dashboard's Delete section.
