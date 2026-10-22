# Docs index

One line per doc. When a page and the code disagree, the code is right —
file a fix, don't trust prose.

## Start here

| Reader | Path |
|--------|------|
| New contributor | `development.md` → `architecture.md` → `schema.md` |
| Operating prod | `operations.md` → `configuration.md` |
| Security/audit review | `security-model.md` → `schema.md` (RLS) → `moderation.md` |
| Touching the site | `website.md` → `frontend-spec.md` → `../web/README.md` |

## Reference

| Doc | What it covers |
|-----|----------------|
| `architecture.md` | Module map, companions/onboarding, marketplace summary, scene routing, journal, story continuity, data-flow diagrams, consent model, web accounts |
| `schema.md` | Every table, column, index + migration history (through v66) |
| `configuration.md` | Every env var + runtime `/server` settings + website config |
| `development.md` | Scripts, test suite, migrations, debugging, project structure, CI/CD |

## Feature docs

| Doc | What it covers |
|-----|----------------|
| `marketplace.md` | Publish/adopt end-to-end: slots, cooldowns, threads, ratings, tags, partner deployments, floodgate |
| `moderation.md` | Content policy + enforcement: screening lanes, report→review, rate limits, NSFW-lane shape, SQL runbook |
| `event-pipeline.md` | Event detection: heuristic scoring, continuity decisions, significance formula |
| `website.md` | The `web/` Astro site: pages, worker lanes, account linking, Supabase Auth setup |
| `security-model.md` | Trust boundaries and the defenses on each — a map that points at the detailed sections |

## Ops

| Doc | What it covers |
|-----|----------------|
| `operations.md` | The runbook: deploy pipeline, VM/systemd, `/ops` console, common failures, billing, fleet cap, secrets, scheduled work |

## Historical (point-in-time, don't cite as current)

| Doc | What it was |
|-----|-------------|
| `frontend-spec.md` | The Astro rebuild spec — shipped and live; kept as the design rationale |
| `phase-1-audit.md`, `phase-1b-complete.md`, `phase-1c-plan.md` | Memory-engine phase reports (Sep 2026) |
| `handoff.md` | Local ops scratch — **gitignored**, never committed |
