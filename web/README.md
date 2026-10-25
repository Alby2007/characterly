# Characterly website (Astro)

The site from `docs/frontend-spec.md`: one Astro app on Cloudflare Workers — **live at https://characterly.app** as the `characterly-website` worker. It replaced `website/` (Vite, now archived at `archive/website/`) and the worker-rendered shelf templates in `src/site-shelf.ts` (whose data layer these pages still import). Visual world: "The Character Archive" (spec §2, shipped tokens in `DESIGN.md`).

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
| `src/pages/` | `index` (SSR, live shelf strip), `characters/` (SSR), `[doc]` (terms/privacy/security/safety, prerendered from the root `.md` files), `guides/`, `account`, `dashboard`, `chat/` (web chat: roster prerendered, `chat/[id]` SSR shell; both in `run_worker_first`), `404`, `sitemap.xml` |
| `src/scripts/` | Browser code: `auth.ts` (Supabase helpers), `account.ts`, `dashboard.ts`, `memories.ts`, `import-card.ts`, `import-history.ts`, `nav.ts`, `archive-tabs.ts`, `webchat.ts` (web chat RPCs + Realtime, contract in `docs/web-chat-frontend.md`), `chat-roster.ts`, `chat-thread.ts`, `adopt.ts` |
| `src/lib/config.ts` | Links, Supabase public config, `TERMS_VERSION`, plans and prices: the only place prices live |
| `src/styles/global.css` | Tokens and shared components |

Shared with the bot (one source, tested there): `src/charcard.ts`, `src/chathist.ts`, `src/discord-events.ts`, `src/site-shelf.ts` data functions, `src/seed-personas.ts`.

## Deploy

`npm run deploy` builds (`astro build`) and ships the `characterly-website` worker via `wrangler deploy` — it serves the apex directly, no cutover step needed (that's done). `CLOUDFLARE_ENV=preview npm run deploy` ships `characterly-website-preview`; add its `https://<host>/**` to the Supabase redirect allowlist if auth is exercised there (checkout still won't work — `create-checkout` CORS only allows `SITE_URL`).

Worker secrets (set via `wrangler secret put` or the dashboard): `DISCORD_APP_PUBLIC_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `AVATAR_UPLOAD_SECRET`.


