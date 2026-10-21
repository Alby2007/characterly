# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The design surfaces are the website (`website/`, Vite multi-page app on Cloudflare Workers at https://characterly.app, plus the worker-rendered `/characters` shelf in `src/site-shelf.ts`) and the branded auth emails (`supabase/email/`, `supabase/templates/`). The product itself runs inside Discord; its in-Discord UI (embeds, buttons, modals, forum cards) is constrained by Discord's components.

## Stack

**Decided (2026-10-21): Astro on Cloudflare Workers**, keeping the `characterly-website` worker and its domains. A full front-end rebuild is being specced in `docs/frontend-spec.md`. It replaces the Vite multi-page site and the worker-rendered shelf (`src/site-shelf.ts` + `public/shelf.css`) with one Astro codebase: static marketing and legal pages, server-rendered `/characters`, and small Supabase-backed islands for auth and the dashboard. Until it ships, the current `website/` remains live.

## Users

**Primary: Character-AI migrants.** People who already chat with characters on Character.AI, SillyTavern-style tools or card-sharing sites, and want companions that actually remember them and live where their friends already are, in Discord. They arrive with expectations from those tools (a character shelf, character cards, chat history) and often with existing characters they want to bring along via `/companion import` (`.png`/`.json` cards, `.jsonl` chat exports).

Secondary audiences, served but not designed around first:
- Creators who publish characters to the shelf (`/companion publish`, `/companion create`, import).
- Discord server admins who add the bot to their own servers, and partner servers running a marketplace deployment.

Their jobs on the website: understand what Characterly is and why it beats what they use now, browse the public shelf, sign up and link Discord, manage tokens and Premium, see and edit what each companion remembers, and import a character card.

## Product Purpose

Characterly gives every person one permanent, personal AI companion, awakened in 1:1 Discord DMs, plus any number of characters adopted off a community shelf. Companions remember you through inspectable, consent-gated memory, chat in private threads, and can be summoned into your own servers, where they speak under their own name and avatar.

Success: a migrant arrives, adopts or imports a character, and finds it remembering them in Discord from the first hello. They come back daily (token allowance refills daily), and some upgrade to Premium.

## Positioning

The pairing is the point: **a companion that remembers you and moves with you between your DMs and your Discord servers.** Neither half alone is the claim.

- **Memory you can inspect.** Memories are verified against source context, cite their provenance, and are visible and editable (`/memory list`, the dashboard's "What X remembers" plate: pin, edit, forget). Memories about you only form with opt-in. Roleplay stays fiction and never becomes facts about the real you.
- **Lives in Discord.** Private `#adoptees` threads, summoning into your servers, multiple companions in a scene with bounded companion-to-companion banter. DM confidences inform the companion in public only as subtext and are never disclosed (Vault Rule); server goings-on come back to DMs as a debrief.

## Operating Context

- Funnel: landing page → "Continue with Discord" OAuth (the lead path in every link gate) or email signup → join the Characterly hub server → adopt off the shelf or awaken in DMs → dashboard for billing and memory.
- The shelf lives in two places: the hub server's forum channel (bot-minted listing threads with Add / Rate / Report) and the indexable `/characters` web pages. Partner servers mirror the catalog.
- Hosted chat spends tokens (2 per human turn, 1 per companion-to-companion hop). BYOK users connect their own provider key in Discord for unlimited use; on the site BYOK is a footnote, because hosted is the funnel.
- Web clickwrap: authed users without consent at the current `TERMS_VERSION` are held behind an acceptance modal.

## Capabilities and Constraints

- **Terminology (use consistently):** *awaken* (your one permanent companion, locked in, one per account), *adopt* (clone a shelf listing as your own copy), *summon* / *dismiss* (bring a companion into a server channel), *the shelf* (marketplace), *tokens* (hosted spend; the total balance is the daily allowance plus purchased packs), *Premium*, *BYOK*.
- **Plans:** Free gets 30 hosted tokens a day, one awakened companion, one adoption slot and two live listings. Premium ($7.99/month) gets 150 a day, live memory, web tools, unlimited adoptions and listings. Token packs need Premium and never expire. The Stripe catalog is the source of truth; mirror any change in copy.
- **Shelf is SFW-only.** Publish and edit screening is fail-closed, adopted-companion replies are screened, reports go to human review, and a companion breaks character to point at crisis lines.
- **Privacy:** DM content never surfaces to other people in a server. `/opt-out` and `/memory forget` delete data, and account deletion is on the dashboard. Creator attribution on public pages is generic ("a community creator"); Discord snowflakes never render.
- **Security contract on public pages:** every user-authored field is escaped. Only `status=active` listings render, and private imports stay invisible.
- **Current website stack (being replaced, see Stack):** plain HTML + vanilla JS modules on Vite, self-hosted fonts, Supabase JS for auth/RPC. There is no framework, and the shelf pages are rendered by the worker with standalone `public/shelf.css`.

## Brand Commitments

- Name: **Characterly**. The Characterly bot is invisible plumbing and a system announcer. It never speaks in character; companions speak as themselves.
- Copy voice: plain, specific, second person. Say what the product does and avoid hype words.
- Existing marks: `website/public/mark.svg` (crescent + star seal, also the favicon) and `website/public/seal.svg`.
- **Web scope (confirmed):** the website stays a funnel plus back office. It persuades, links Discord, and manages billing, memory and import. No browsing-to-adopt, adopting or chatting happens on the web; Discord is home.
- **The current visual world ("The Familiar", recorded in `DESIGN.md`) is being replaced, not refined.** The user judged it "vibe coded" and wrong for migrants. It remains evidence of the old site until the rebuild's DESIGN.md supersedes it. Binding anti-references for the new front end:
  - the stock AI "premium" look: a dark ground with gold accents, italic display serif and tracked mono labels;
  - ornament standing in for product: seals, corner ticks, figure captions, glows and other costume;
  - template page structure: hero → stat strip → feature sections → pricing → FAQ as the default sequence;
  - literary or whimsical copy. Say plainly what the product does.

## Evidence on Hand

- **Live shelf data only:** real listings, ratings and add-counts on `/characters` (and the forum). Ratings and `aggregateRating` appear only when a real count exists.
- **None yet:** no testimonials, user or member counts, press, or case studies. Future pages must not invent any of these, or imply them through placeholder quotes or numbers.
- Real product artifacts usable as demonstration: the companion draft card, slash commands, the dashboard memory panel, and character-card import.

## Product Principles

1. **Memory is the relationship, and the user owns it.** Anything a companion knows should be visible, explainable and forgettable by the person it's about.
2. **Meet migrants where they already are.** Honour their existing vocabulary and artifacts (character cards, chat history, a shelf to browse), and make "bring what you have" effortless.
3. **Discord is home, the web is the back office.** The site persuades, then hands off to Discord. Account, billing and memory controls on the web stay plain and trustworthy.
4. **Show, never inflate.** Prove things with the real product and live shelf data, never with invented social proof.
5. **Safety and consent are features, stated plainly** and never buried.

## Accessibility & Inclusion

No formal conformance target has been set (open decision). Existing practice to preserve: all motion is disabled under `prefers-reduced-motion`, and scroll reveals hide content only when JS is present.
