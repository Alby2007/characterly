---
name: Characterly
description: The Character Archive. A pale field, one character standing on it, and an archive panel that fills in as they get to know you.
colors:
  field: "#ebeefd"
  field-deep: "#dfe3f6"
  panel: "#ffffff"
  ink: "#14183a"
  ink-2: "#454d78"
  ink-3: "#5c638c"
  line: "#d8ddf2"
  line-strong: "#b9c1e4"
  dm: "#3450f0"
  dm-tint: "#e2e7ff"
  srv: "#cf1f5e"
  srv-tint: "#ffe0eb"
  go: "#ffb21e"
  go-hi: "#ffc34f"
  go-ink: "#241500"
  danger: "#c02436"
  danger-tint: "#fde6e8"
  ok: "#17784f"
  ok-tint: "#ddf3e8"
typography:
  display:
    fontFamily: "Archivo Variable, Archivo, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "clamp(44px, 6.4vw, 96px)"
    fontWeight: 850
    lineHeight: 0.95
    letterSpacing: "-0.025em"
    fontVariation: "'wdth' 125"
  headline:
    fontFamily: "Archivo Variable, Archivo, system-ui, sans-serif"
    fontSize: "clamp(28px, 3.2vw, 46px)"
    fontWeight: 850
    lineHeight: 0.95
    letterSpacing: "-0.025em"
    fontVariation: "'wdth' 125"
  name:
    fontFamily: "Archivo Variable, Archivo, system-ui, sans-serif"
    fontSize: "clamp(36px, 3.6vw, 52px)"
    fontWeight: 850
    lineHeight: 0.95
    letterSpacing: "-0.025em"
    fontVariation: "'wdth' 125"
  title:
    fontFamily: "Archivo Variable, Archivo, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 750
    lineHeight: 1.25
    letterSpacing: "-0.005em"
    fontVariation: "'wdth' 100"
  body:
    fontFamily: "Archivo Variable, Archivo, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.55
    fontFeature: "tnum"
    fontVariation: "'wdth' 100"
  label:
    fontFamily: "Archivo Variable, Archivo, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 750
    letterSpacing: "0.1em"
    fontVariation: "'wdth' 110"
  scope:
    fontFamily: "Archivo Variable, Archivo, system-ui, sans-serif"
    fontSize: "11.5px"
    fontWeight: 800
    letterSpacing: "0.06em"
    fontVariation: "'wdth' 110"
rounded:
  panel: "14px"
  control: "8px"
  scope: "6px"
  pill: "999px"
spacing:
  gutter: "32px"
  gutter-narrow: "20px"
  wrap: "1240px"
  nav-h: "72px"
  section: "clamp(88px, 10vw, 140px)"
  row: "14px"
components:
  button-primary:
    backgroundColor: "{colors.go}"
    textColor: "{colors.go-ink}"
    rounded: "{rounded.control}"
    padding: "12px 22px"
    height: "48px"
  button-primary-hover:
    backgroundColor: "{colors.go-hi}"
    textColor: "{colors.go-ink}"
  button-primary-lg:
    backgroundColor: "{colors.go}"
    textColor: "{colors.go-ink}"
    rounded: "{rounded.control}"
    padding: "16px 28px"
    height: "60px"
  button-secondary:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "12px 22px"
    height: "48px"
  button-secondary-hover:
    backgroundColor: "{colors.field-deep}"
    textColor: "{colors.ink}"
  input:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "11px 14px"
    height: "48px"
  archive-panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "26px 28px 24px"
  scope-dm:
    backgroundColor: "{colors.dm}"
    textColor: "{colors.panel}"
    typography: "{typography.scope}"
    rounded: "{rounded.scope}"
    padding: "4px 8px"
  scope-srv:
    backgroundColor: "{colors.srv}"
    textColor: "{colors.panel}"
    typography: "{typography.scope}"
    rounded: "{rounded.scope}"
    padding: "4px 8px"
  scope-kind:
    backgroundColor: "{colors.field-deep}"
    textColor: "{colors.ink-2}"
    typography: "{typography.scope}"
    rounded: "{rounded.scope}"
    padding: "4px 8px"
  tag:
    backgroundColor: "{colors.field-deep}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
  filter-selected:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.panel}"
    rounded: "{rounded.pill}"
    padding: "6px 14px"
    height: "40px"
---

# Design System: Characterly

## Overview

**Creative North Star: "The Character Archive"**

Every companion has an archive page that fills in as they get to know you: the character-archive screen of a gacha game, with every gacha mechanic removed. The page is a pale, cool field sampled from the hero art's own ground, so an illustrated character stands directly on the page instead of inside a frame. Beside them sits one white archive panel: a name set huge and wide, a line of real facts, tabs, and a ruled list of memory entries, each tagged with where it was heard and marked with what you did to it.

The system is light, open and typographic. One variable family (Archivo) does all the work, swinging from expanded black for hooks, names and prices to normal width for UI and reading. Hierarchy comes from rules, not containers: a 2px ink rule opens a section, 1px hairlines separate rows, and the only filled surfaces are the white archive panel and the field itself. Colour is semantic before it is decorative. Blue means private to your DMs, pink means heard in a server, gold means the one thing to do next.

Light theme only (`color-scheme: light`). Motion is small and functional: the tab ink slides, the panel settles, a new entry unlocks, a forgotten one is struck through before it goes. All of it switches off under reduced motion.

**Key Characteristics:**
- Pale cool field with characters standing on it, never boxed.
- One white archive panel with one hairline and a soft, low shadow.
- Expanded black display type (wdth 125, weight 850) against normal-width UI type; tabular numerals everywhere.
- Scope colour as data: blue = DMs, pink = server, nothing else wears them.
- Gold appears once per view, on the primary action.
- Rules (2px ink, 1px hairline) carry grouping; no nested cards.

## Colors

A cool, near-monochrome navy-on-lavender base with three saturated, strictly assigned signal colours.

### Primary
- **Discord-Hour Gold** (go): the one primary action per view ("Continue with Discord", "Go Premium") and the matching badge. Its hover is **Lit Gold** (go-hi), which also tints text selection. Text on gold is **Gold Shadow Ink** (go-ink), never white.

### Secondary
- **Private Blue** (dm): data that lives only in your DMs: the YOUR DMS scope tag, DM speaker names in the two-lanes demonstration. It also serves as the focus ring and input focus border, its tint (dm-tint) as focus halo and drag-over fill.

### Tertiary
- **Server Pink** (srv): data heard in a server channel: the #CHANNEL scope tag and server speaker names. Its tint (srv-tint) is reserved for the same meaning.

### Neutral
- **Archive Field** (field): the page ground, sampled from the hero art so illustrated characters sit on it seamlessly; also the nav backdrop at 92% and the `theme-color`.
- **Deep Field** (field-deep): placeholder art tiles, quiet tags and badges, inline code, secondary-button hover.
- **Archive White** (panel): the archive panel, document body, dashboard panels, footer, inputs.
- **Night Navy Ink** (ink): all primary text, 2px section rules, the tab ink bar, step numerals, selected filters, the brand tile.
- **Ink Second** (ink-2): ledes, supporting copy, nav links at rest.
- **Ink Third** (ink-3): meta lines, row keys, marks at rest, the corner "Example" tag.
- **Hairline** (line) and **Strong Hairline** (line-strong): row separators and dividers; strong hairline for input strokes, lane dividers and the dashed import drop zone.
- **State colours**: danger / danger-tint for destructive buttons and error messages; ok / ok-tint for success messages, completed setup steps and positive ledger values.

### Named Rules
**The Scope Is Data Rule.** Private Blue appears only on DM-scoped data and Server Pink only on server-heard data (focus treatment excepted for blue). Never use either for decoration, links or emphasis; the visitor reads them as provenance.

**The One Gold Rule.** Each view has at most one gold element: the primary action (or the badge that names it). Secondary actions are white with a 2px ink stroke or plain underlined links.

## Typography

**Display Font:** Archivo Variable at width 125 (with Archivo, system-ui fallback)
**Body Font:** Archivo Variable at width 100
**Label Font:** Archivo Variable at width 110, uppercase

**Character:** One family stretched to two voices: a wide, black, tightly tracked voice for hooks, names and numbers that should feel like a character card, and a plain, sturdy normal-width voice for reading and controls. Numerals are tabular throughout.

### Hierarchy
- **Display** (850, clamp(44px, 6.4vw, 96px), 0.95): page h1 and the landing hook. Balanced wrapping.
- **Headline** (850, clamp(28px, 3.2vw, 46px), 0.95): section h2s; sized down per surface (22-36px) for panel and guide headings, staying wide and black.
- **Name** (850, clamp(36px, 3.6vw, 52px), 0.95): the companion's name in the archive head. Prices and the token balance use the same wide black voice at 48-52px.
- **Title** (750, 20px, 1.25): h3s, plan names, card titles. Shelf character names sit at an intermediate wdth 112, 800.
- **Body** (400, 17px / 16px under 600px, 1.55): reading text; ledes at clamp(18px, 1.6vw, 21px) in ink-2, max 58ch; long prose capped near 64-72ch. Memory entry text is 550 weight at 1.35.
- **Label** (750, 12px, 0.1em, uppercase, wdth 110): footer column heads, FAQ group heads, table-of-contents head. Scope tags and badges use the same uppercase wide-ish voice at 11.5-12px, 800.

### Named Rules
**The Two Widths Rule.** Width 125 is for hooks, names, prices and big numerals only; everything a user reads at length or clicks is width 100. Do not set UI controls wide.

**The No Eyebrow Rule.** Uppercase labels head lists and footer columns or tag data. They never sit above a headline as a kicker. "Example" is a corner tag on its panel or figure, or inline meta, never an eyebrow over the name.

## Layout

Content sits in a centred wrap (1240px max) with a 32px gutter, 20px under 600px. The nav is sticky at 72px on a 92% field wash and gains a hairline only after scrolling. Sections are spaced generously at clamp(88px, 10vw, 140px); section heads cap at 760px.

The landing hero is a two-column grid (about 0.74fr art / 1fr copy) filling the viewport: the hook spans both columns across the top, the character stands full height on the left and fades into the field with a bottom mask instead of a hard crop, the archive panel and actions sit on the right. Inner layouts are two-column grids with 40-56px gaps (portrait plus archive on character pages; 1.55fr / 1fr main and side on the dashboard; 240px table of contents plus document on legal pages). The shelf is an auto-fill grid of square art at minmax(200px, 1fr), 32px / 20px gaps.

Rows inside lists use a fixed key column (112-180px) and 14px vertical padding, collapsing to a single column under 600px. Breakpoints: 1100px (hero ratio, shelf strip to 3), 960px (nav to menu button, footer to 2 columns), 860px (all two-column grids stack; hero becomes hook, sub, actions, head-and-shoulders art, archive), 600px (narrow gutter, single-column rows, 2-up shelf).

## Elevation & Depth

Mostly flat. Depth comes from the white panel on the field and from rules; shadows are soft, long and low, never hard or offset. Only three things lift: the archive panel (and the sign-in card that shares its role), the modal, and the gold button.

### Shadow Vocabulary
- **Archive lift** (`box-shadow: 0 30px 60px -40px rgba(20, 24, 58, 0.45)`): the archive panel and the sign-in card; a pool of shadow below, not a halo.
- **Modal lift** (`box-shadow: 0 40px 80px -30px rgba(20, 24, 58, 0.5)`): native dialog, over a 45% navy backdrop.
- **Gold glow** (`box-shadow: 0 8px 20px -10px rgba(201, 135, 0, 0.85)`): the primary button; tightens to `0 3px 10px -6px` on press.
- **Segment lift** (`box-shadow: 0 1px 3px rgba(20, 24, 58, 0.15)`): the selected option in a segmented control.

### Named Rules
**The Soft Shadow Rule.** Every shadow is blurred with a negative spread and tinted navy (or gold for the action). No hard offset shadows, no stacked elevations.

**The Rules Not Boxes Rule.** Group with a 2px ink rule at the top and 1px hairlines between rows. The white panel is the only container; do not nest bordered boxes inside it or tile content into cards.

## Shapes

Two radii: soft panel corners (14px) for the archive panel, document body, dashboard panels, modal and square character art; tighter control corners (8px) for buttons, inputs, messages, small art tiles and file chips. Scope tags and badges use 6px; tags and filters are full pills; avatars and step numerals are circles. Strokes are 1px hairlines for surfaces and rows, 1.5px for inputs and small controls, 2px ink for secondary buttons and section rules; the premium plan is marked by a 4px ink top rule. Drop zones are dashed. The brand mark is a navy rounded tile with a white crescent and gold star, drawn flat.

## Components

### Buttons
Solid and blunt: heavy label, ink stroke, a small press.
- **Shape:** control corners (8px), 48px minimum height (60px large, 40px small).
- **Primary:** gold fill and border, gold-shadow ink, 750 weight, gold glow shadow. Often carries the Discord glyph at 20px.
- **Hover / Focus:** primary lightens to Lit Gold; secondary fills with Deep Field. Press moves down 1px. Focus is a 3px Private Blue outline at 2px offset.
- **Secondary:** white with a 2px ink border. **Danger:** danger-coloured border and text, danger-tint hover. **Disabled:** 50% opacity, no shadow.
- **Links:** underlined, 700 weight, strong-hairline underline darkening to ink on hover, 44px hit area.

### Chips
- **Tag:** Deep Field pill, ink-2 text, 13px 650.
- **Filter:** white pill with 1.5px strong-hairline stroke; selected fills with ink and white text, with the count in a muted lavender.
- **Badge:** 6px corners, uppercase wdth 110 label; ok and gold variants.

### Cards / Containers
- **Corner Style:** soft panel corners (14px).
- **Background:** Archive White on the field.
- **Shadow Strategy:** archive lift for the archive panel and sign-in card; dashboard panels and the document body are flat with a hairline.
- **Border:** one 1px hairline.
- **Internal Padding:** 24-28px (20px under 600px); documents 44px / 48px.
- Shelf characters are not cards: square art (14px) with name, tagline and meta set beneath on the field.

### Inputs / Fields
- **Style:** white, 1.5px strong-hairline stroke, 8px corners, 48px high, label above in 14px 700 ink-2.
- **Focus:** border turns Private Blue with a 3px dm-tint halo; hover darkens the stroke to ink-3.
- **Error / Success:** messages are tinted blocks (danger-tint with deep red text, ok-tint with deep green).

### Navigation
Brand in wide black at 21px with the tile mark; links 15px 650 in ink-2, gaining ink colour and a 2px ink underline on hover and current page. The single gold action sits at the end. Under 960px links fold into a 44px menu button that opens a full-width list of 19px rows split by hairlines.

### Archive Panel (signature)
The companion's archive: name (wide black), a meta line of real facts ("Adopted · yours", "Remembers you since 3 Oct"), then tabs over panels. Tabs are 15px 700 text with no fill; a 3px ink bar slides under the selected tab (0.28s). The panel content settles in from 10px right (0.32s). Without JavaScript every panel renders open under its own small heading. An "Example" corner tag sits top-right when the content is illustrative.

### Memory Entry (signature)
A ruled row: scope tag (112px column) · entry text · mark. Scope tags are YOUR DMS (blue), #CHANNEL (pink) or a kind label (Deep Field). Marks are drawn stroke icons (24px grid, 2px stroke, 16px) with a word beside them (Pinned, Edited by you, Forgotten) so they read in greyscale. Forgetting strikes the text through at 2px in ink-3, shows the Forgotten mark, then removes the row. New entries unlock upward from 8px (0.5s), staggered.

## Do's and Don'ts

### Do:
- **Do** stand illustrated characters directly on the field (#ebeefd) and fade crops into it with a mask.
- **Do** tag every remembered fact with its scope: blue for DMs, pink for server.
- **Do** keep one gold action per view and make everything else ink-stroked or a link.
- **Do** separate sections with a 2px ink rule and rows with 1px hairlines.
- **Do** set hooks, names and prices at wdth 125 / 850 and everything else at wdth 100, with tabular numerals.
- **Do** pair every mark icon with a word, drawn from the single 2px-stroke icon set.
- **Do** strike through, then remove, when something is forgotten.
- **Do** turn off every animation and transition under prefers-reduced-motion.

### Don't:
- **Don't** use blue or pink for decoration, links or emphasis.
- **Don't** put a second gold element in a view.
- **Don't** nest bordered boxes inside panels or tile content into card grids.
- **Don't** place uppercase labels above headlines as eyebrows; "Example" goes in the corner or inline.
- **Don't** use hard offset shadows; every shadow is blurred and navy- or gold-tinted.
- **Don't** add a dark theme or candlelit/parchment surfaces.
- **Don't** use glyph or emoji icons for marks.
