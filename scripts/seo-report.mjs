import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { createSign } from 'node:crypto';

// ops:seo — Google Search Console readout for characterly.app.
//
// Setup (one-time):
//   1. GCP project → enable the Search Console API → service account → JSON key
//   2. Search Console → Settings → Users and permissions → add the SA email
//   3. GOOGLE_APPLICATION_CREDENTIALS=<path to key json> in .env
//   GSC_SITE_URL defaults to the domain property; use https://characterly.app/
//   for a URL-prefix property instead.
//
// No googleapis dependency — the SA JWT is signed directly (service accounts
// only ever need the two-step token flow this file implements).

const SITE = process.env.GSC_SITE_URL ?? 'sc-domain:characterly.app';
const API = 'https://www.googleapis.com/webmasters/v3';
const INSPECT = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';

const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url');

async function accessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${unsigned}.${sig}`,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`token exchange ${res.status}: ${JSON.stringify(body)}`);
  return body.access_token;
}

async function gsc(token, method, path, body) {
  const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json?.error?.message ?? json)}`);
  return json;
}

const fmt = d => d.toISOString().slice(0, 10);
const table = rows => rows.length ? rows.map(r => '  ' + r.join('  ')).join('\n') : '  (no rows yet)';

// ── Pull ─────────────────────────────────────────────────────────────────────

const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!credPath) {
  console.error('GOOGLE_APPLICATION_CREDENTIALS is not set — point it at the service-account JSON key.');
  process.exit(1);
}
const sa = JSON.parse(await readFile(credPath, 'utf8'));
const token = await accessToken(sa);
const site = encodeURIComponent(SITE);

// Analytics lag ~2-3 days; ask for the last 28 full days ending 3 days ago.
const end = new Date(Date.now() - 3 * 86_400_000);
const start = new Date(end.getTime() - 27 * 86_400_000);
const range = { startDate: fmt(start), endDate: fmt(end), rowLimit: 25 };

const [sitemaps, byQuery, byPage] = await Promise.all([
  gsc(token, 'GET', `/sites/${site}/sitemaps`),
  gsc(token, 'POST', `/sites/${site}/searchAnalytics/query`, { ...range, dimensions: ['query'] }),
  gsc(token, 'POST', `/sites/${site}/searchAnalytics/query`, { ...range, dimensions: ['page'] }),
]);

// ── Report ───────────────────────────────────────────────────────────────────

console.log(`Search Console — ${SITE} · ${fmt(start)} → ${fmt(end)}\n`);

console.log('Sitemaps:');
const maps = sitemaps.sitemap ?? [];
if (!maps.length) console.log('  (none on file)');
for (const s of maps) {
  console.log(`  ${s.path}`);
  console.log(`    submitted ${s.lastSubmitted ?? '?'} · last fetched ${s.lastDownloaded ?? 'never'} · ${s.errors ?? 0} errors · ${s.warnings ?? 0} warnings · ${s.contents?.[0]?.submitted ?? '?'} urls`);
}

const section = (title, rows) => {
  console.log(`\n${title}:`);
  console.log(table(rows.map(r => [
    String(r.clicks).padStart(5), `${r.impressions}`.padStart(6) + ' imp',
    `${(r.ctr * 100).toFixed(1)}%`.padStart(6), `pos ${r.position.toFixed(1)}`,
    r.keys?.[0] ?? '',
  ])));
};
console.log('  (cols: clicks · impressions · CTR · avg position · key)');
section('Top queries', byQuery.rows ?? []);
section('Top pages', byPage.rows ?? []);

// Index status on the pages that matter most.
const inspectUrls = [
  'https://characterly.app/',
  'https://characterly.app/characters',
  'https://characterly.app/guides/import-character-cards',
];
console.log('\nIndex status:');
for (const url of inspectUrls) {
  const r = await gsc(token, 'POST', INSPECT, { inspectionUrl: url, siteUrl: SITE })
    .catch(e => ({ error: String(e) }));
  const res = r.inspectionResult?.indexStatusResult;
  console.log(`  ${res ? `${res.verdict} · ${res.coverageState}` : r.error ?? 'unavailable'} — ${url}`);
}
