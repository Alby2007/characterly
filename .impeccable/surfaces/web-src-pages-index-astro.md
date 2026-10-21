---
version: 1
slug: "web-src-pages-index-astro"
primary_target: "web/src/pages/index.astro"
related_targets: []
---

# Landing (/) — surface brief

Scope: the public landing page of the rebuilt site (web/src/pages/index.astro). Visitor mode: Persuade. Audience: Character.AI migrants (PRODUCT.md). Action: Continue with Discord. Proof: a companion's archive showing scoped, editable memory; live shelf strip; card import. Spec: docs/frontend-spec.md §2, §5.1.

## Direction contract

THESIS: Each companion has an archive page that fills in as they get to know you — the gacha character-archive screen, minus every gacha mechanic. Refuses the search-bar-over-card-grid marketplace page and the old candlelit study.

OWN-WORLD: Pale cool field (#f2f5ff family), deep navy ink, white archive panels with one hairline, blue = DM-private, pink = server-heard, gold = the one primary action. Archivo variable: expanded black for hooks and names, normal width for UI; tabular numerals. Full-height illustrated character art standing on the open field. No boxes for grouping, no ornament.

STORY: The visitor sees Wren's archive about one person, understands memory is real, scoped (DM vs server) and editable (pin / edit / forget marks), learns they can bring their own character, and continues with Discord.

FIRST VIEWPORT: Left: Wren full-height (~80vh) on the open field, hook "They remember you." set huge beside/over her shoulder line. Right: Wren's archive panel — name, "Adopted · yours" and "Remembers you since…", tabs Profile / What she remembers / First hello (working), 4–5 memory entries tagged YOUR DMS or #CHANNEL with pinned/edited/forgotten marks, labelled EXAMPLE. Gold "Continue with Discord" under the panel; "Browse the shelf" and "Bring your character" as links.

FORM: assigned direction (re-roll 1, candidate 7 of the grounded list: gacha character-archive screen). seed:043c186d159d7264

Signature interaction: archive tabs (slide-and-settle); memory entries "unlock" on add; forget = strike, then remove. Motion snaps under reduced motion.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Decisions recorded during build

- Bond meter CUT on product truth: Characterly has no bond level, so a meter would claim a feature that does not exist (PRODUCT.md: no invented capabilities). The panel's meta line carries a real fact instead ("Remembers you since 3 Oct"). The archive's "fills in" idea is carried by the memory entries and their marks.
- "Three steps, about two minutes" section KEPT: it is the spec §4 primary path (Continue with Discord → join the server → adopt or import) and the only place the landing explains what happens after the click.
