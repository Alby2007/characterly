# ARCHIVED — old Characterly website (Vite)

**This is the pre-Astro site. It is not deployed.** The live website is the
Astro + Cloudflare Workers app in `web/` (worker `characterly-website`,
`wrangler.jsonc`). The cutover happened Oct 2026 — this tree is kept for
reference only; don't edit it to change the live site.

If you ever need to resurrect it:

```bash
cd archive/website
npm install
npm run dev      # http://localhost:5173
npm run build    # production bundle → dist/
```

Its `src/config.js` / `src/legal.js` responsibilities moved to
`web/src/lib/config.ts` / `web/src/lib/legal.ts` (legal docs now render at
build time instead of in the browser).
