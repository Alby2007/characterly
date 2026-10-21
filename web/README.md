# Characterly website (Astro)

The rebuilt site from `docs/frontend-spec.md`: one Astro app on Cloudflare Workers, replacing `website/` (Vite) and the worker-rendered shelf templates in `src/site-shelf.ts`. Visual world: "The Character Archive" (spec §2, direction contract in `.impeccable/surfaces/web-src-pages-index-astro.md`).

**Status:** built and verified locally, **not deployed**. The live site is still `website/`.

## Run it

```bash
cd web
npm install
npm run dev        # http://localhost:4321 (Astro dev)
npm run preview    # production build under wrangler dev, real CSP
npm test           # redirect / allowlist / worker rules
```

Without `SUPABASE_SERVICE_ROLE_KEY` in `.dev.vars`, `npm run dev` shows the first-party seed roster on the shelf (dev only; see `devFixture` in `src/lib/shelf.ts`). Sign-in and the dashboard talk to the real Supabase project.

## Layout

| Path | What |
|---|---|
| `src/worker.ts` | Worker entry: `/discord/events`, `/avatar`, `/avatar/gc`, `/track`, canonical-host redirect (API paths exempt), security headers, `page_view`. Everything else goes to Astro's handler. |
| `src/pages/` | `index` (SSR, live shelf strip), `characters/` (SSR), `[doc]` (terms/privacy/security/safety, prerendered from the root `.md` files), `guides/`, `account`, `dashboard`, `404`, `sitemap.xml` |
| `src/scripts/` | Browser code: `auth.ts` (Supabase helpers), `account.ts`, `dashboard.ts`, `memories.ts`, `import-card.ts`, `import-history.ts`, `nav.ts`, `archive-tabs.ts` |
| `src/lib/config.ts` | Links, Supabase public config, `TERMS_VERSION`, plans and prices: the only place prices live |
| `src/styles/global.css` | Tokens and shared components |

Shared with the bot (one source, tested there): `src/charcard.ts`, `src/chathist.ts`, `src/discord-events.ts`, `src/site-shelf.ts` data functions, `src/seed-personas.ts`.

## Deploy and cutover

The worker keeps the name `characterly-website`, so `npm run deploy` replaces the old site. Before the first deploy:

1. `wrangler secret put` for `DISCORD_APP_PUBLIC_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `AVATAR_UPLOAD_SECRET`. They are the same values as today.
2. Deploy `supabase/functions/create-checkout` first. It now refuses checkout for accounts without a linked Discord (409 "link Discord first").
3. Optional preview: deploy under another name and add its `https://<host>/**` to the Supabase redirect allowlist. Checkout won't work there, because `create-checkout` CORS only allows `SITE_URL`.
4. After cutover, check:
   - the Discord webhook and the bot's avatar calls against the apex;
   - Analytics Engine `page_view` and `web_event`.

   Then retire `website/` and the HTML templates in `src/site-shelf.ts`, and update `docs/website.md`.

## Outstanding assets

- `public/og.png` is missing, so social previews point at a file that doesn't exist yet. It needs a 1200×630 image from the Wren art.
- `public/apple-touch-icon.png` is the old dark icon. It needs regenerating from `public/favicon.svg`.
