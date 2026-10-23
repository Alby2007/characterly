# Node runtime CVEs — October 2026 response note

Oct 21, 2026: Node shipped security releases **22.23.4 / 24.22.1 / 26.12.1**
covering a Brotli-decoder RCE, two TLS hostname-verification bypasses, a DNS
NUL-truncation, an HTTP keep-alive response-confusion bug, and dependency
updates (c-ares, ca-certificates incl. the eMudhra intermediate-CA compromise,
OpenSSL, SQLite, bundled undici). **Node 20 is EOL and received no fix** — the
`engines` floor now excludes it (and the odd unpatched 23/25 lines).

## What applies to us

| CVE | Sev | Our exposure |
|---|---|---|
| **CVE-2026-111497** Brotli decoder OOB write → RCE / memory disclosure | High | **Real.** Any `fetch()`/undici response with `content-encoding: br` auto-decompresses through the vulnerable zlib binding. The sharpest edge is **BYOK `base_url`**: a user can point their brain at any public endpoint — `isSafeUrl` only blocks private addresses — so an attacker-registered account could serve crafted Brotli to `guardedLlmFetch` and hit code exec inside the bot process. Also reachable via `GROQ_BASE_URL`/`VISION_BASE_URL`/`EMBED_BASE_URL` env overrides (operator-set, trusted) and any fetched untrusted endpoint. |
| **CVE-2026-105483 / -106069 / -106072** TLS hostname bypasses (fullwidth digits, octal/hex/short-form IP literals like `１２７.0.0.1`, `0177.0.0.1`, `0x7f.0.0.1`, `127.1`) | High/Med | **Real on the BYOK + fetch surfaces.** Non-canonical IP spellings could authenticate a cert against a *different* IP — i.e. MITM of outbound calls carrying secrets (LLM keys incl. user BYOK keys, Discord token, DB creds) by an attacker with network position or a CA-issued numeric-DNS-SAN cert. Also weakens `isSafeUrl`'s IP-literal gate: `isPrivateIpv4` may not classify `0177.0.0.1` as private while the resolver still connects to 127.0.0.1. |
| **CVE-2026-105482** `dns.resolve*`/`dns.reverse` NUL truncation | High | **Not hit.** Our DNS gating uses `dns.lookup` (`safeLookup` in tools.ts), which was covered by the earlier CVE-2026-48930 fix — the resolve*/reverse family we never call. |
| **CVE-2026-105481** keep-alive accepts a pre-request response | Med | Theoretical — a reused socket to an LLM/Supabase endpoint could return an attacker-staged response. Needs control of the endpoint or the path. |
| CVE-2026-106074 / -106070 / -106071 / -106073 (snapshots, ZipFile, permission model) | Med/Low | **Not applicable** — no startup snapshots, no ZipFile, no `--permission`. |

### Vendored undici (`import "undici"` in `brains.ts` — the BYOK dispatcher)

Separate layer from the runtime: we pin `undici` in node_modules, and the
Oct-15 advisory batch applies to our range. `undici >=6.29.1` fixes:

- **GHSA-qrxm-fqhp-jwvm** (High): a TLS 1.2 endpoint that renegotiates with a
  different cert crashes the process — **any user-controlled BYOK endpoint was
  a one-shot kill switch for the whole bot.**
- **GHSA-xjj6-f33q-929c** (High): unhandled error on excessive content-encodings
  → DoS via any fetched endpoint.
- GHSA-2m5v-pch6-74hx (dropped `checkServerIdentity`): **not applicable** — our
  `Agent` only passes `connect.lookup`, which the advisory confirms is
  unaffected.
- Cache-poisoning / WebSocket / EventSource advisories: we don't use those
  interceptors or clients.

Note `safeRequest`/`fetchImageBytes`/`visit_url` use raw `http.request` — **no
auto-decompression** — so the SSRF-guarded image/URL paths never touched the
Brotli decoder. The exposure was concentrated in `fetch()`/undici paths.

## What could have been exposed

If the Brotli RCE or a TLS bypass was ever exercised against the bot process,
assume everything in its env + memory was readable:

| Secret | Where | Rotation |
|---|---|---|
| `DISCORD_TOKEN` | VM `.env` | Dev portal → regenerate; update VM `.env`, restart |
| `DATABASE_URL` (postgres password) | VM `.env` | Supabase → reset DB password; update pooler string |
| `KEY_ENCRYPTION_SECRET` | VM `.env` | **Rotating orphans every stored BYOK key** (`guild_keys` becomes undecryptable → users re-run `/setup`). If memory was actually read, decrypted BYOK keys were in RAM anyway — then users should rotate *provider* keys regardless of what we do. |
| `GROQ_API_KEY` | VM `.env` | Groq console → new key |
| `AVATAR_UPLOAD_SECRET` | VM `.env` + worker secret | Rotate both sides (wrangler secret + VM env) |
| BYOK user keys | `guild_keys` (encrypted at rest; plaintext in RAM during calls) | Consider force-invalidating `guild_keys` rows → users re-setup |
| GitHub `ORACLE_*` deploy secrets | GitHub only — not on the VM | Only if you believe a CI runner itself was hit (runs floated `22`, unpatched until Oct 21) — low likelihood |

Not exposed: Stripe keys (edge functions, Deno), Supabase service role
(worker/edge-function secrets), website worker env (Cloudflare runtime —
they patch their own V8/`nodejs_compat` layer independently).

## Actions taken / required

Done in-repo: `engines` floor `^22.23.4 || ^24.22.1 || >=26.12.1`,
`.nvmrc` → 22.23.4, vendored `undici ^6.29.1`, this note. **The deploy
pipeline now provisions the runtime too** — the SSH step checks `node -v`
on the VM and installs the patch for its LTS line (checksum-verified)
before rebuilding, so the next green push lands the fix automatically.

**Required — outside the repo:**
1. ~~Prod VM manual upgrade~~ — handled by the deploy floor enforcement
   (only needed again when the floor itself moves).
2. **Dev machines**: same check (`node -v`).
3. **CI**: `node-version: 22` floats → now resolves to 22.23.4. No change
   needed; any run before Oct 21 briefly ran unpatched but CI runners are
   ephemeral and the suite holds no prod secrets.
4. **Rotation**: the table above is worst-case inventory, not confirmed
   compromise. Minimum sensible rotation if you can't rule it out:
   `DISCORD_TOKEN`, `GROQ_API_KEY`, `AVATAR_UPLOAD_SECRET`, DB password.
   `KEY_ENCRYPTION_SECRET` rotation is the expensive one — decide based on
   how exposed you think the BYOK-fetch path was.
