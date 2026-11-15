# Project Plan — fashion-commerce

Premium fashion e-commerce platform: women's clothing, children's clothing,
accessories and underwear, sold online and in physical boutiques from one
inventory, with Persian (RTL) and English (LTR), multi-currency pricing, an
AI stylist, visual search, future virtual try-on, and a full admin dashboard.

Work is delivered in small, verifiable phases. Each phase ends with
`npm run check` (lint + typecheck + build) green, plus the tests that phase
introduces.

## Status

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Foundation: Next.js app, i18n/RTL, env validation, design tokens, module boundaries, docs | **Done** |
| 1 | Quality gates: Vitest, Playwright, CI workflow, Dockerfile + docker-compose (Postgres) | **Done — local verification complete on Windows** (see "Phase 1 — verification"); still pending: the first real GitHub Actions run; remaining item: two localized-404 e2e tests are `fixme` |
| 2A | Data foundation: DB pool, transaction helper, migration runner (checksums, safe down), transactional outbox + `handled_events`, real-PostgreSQL tests | **Implemented; awaiting Windows verification** (see "Phase 2A") |
| 2B | Identity: users, scrypt passwords, sessions (`__Host-session`), login throttling, CSRF, kernel authorization contracts | Planned — needs approval |
| 2C | Catalog: products, variants (composite FKs), categories, brands, attributes, localized content, image metadata (no prices) | Planned |
| 2D | Inventory: locations, ledger, reservations, DB-function-only writes, delta-matrix tests | Planned |
| 2E | Integration: composition root wiring, end-to-end flows, hardening | Planned |
| 6 | Storefront: category/product pages, search, cart | Planned |
| 7 | Commerce: checkout, orders, multi-currency price lists, payment & shipping ports (sandbox adapters only) | Planned |
| 8 | POS: registers, shifts, in-store sales against unified stock | Planned |
| 9 | Customers & marketing: accounts, addresses, promotions, gift cards | Planned |
| 10 | Finance & analytics: ledgers, reconciliation, reporting | Planned |
| 11 | AI: provider port, stylist, embeddings, visual search; virtual try-on research | Planned |

## Phase 0 — delivered

- Next.js 16.4 App Router, React 19.3, TypeScript (strict + `noUncheckedIndexedAccess`), Tailwind CSS 4.3, ESLint 9.
- Locale routing under `/{locale}` (`fa` default, `en`), negotiated in `src/proxy.ts`; `<html lang dir>` per locale.
- Vazirmatn for Persian; Cormorant Garamond + Instrument Sans for Latin; self-hosted via `next/font`.
- Zod-validated environment (`src/config/env.ts`), checked at boot via `src/instrumentation.ts`.
- Localized `error.tsx` / `not-found.tsx`, bilingual `global-error.tsx` / `global-not-found.tsx`.
- 12 business modules with declared ownership and an acyclic dependency graph; deep imports blocked by ESLint.
- Design tokens (brand palette, contrast-checked), base UI primitives, foundation home page.
- Money primitives in integer minor units with IRR/toman display handling.

## Phase 1 — delivered

- Vitest unit tests: locale config and `switchLocalePath`, money helpers, env validation, module registry and `findDependencyCycle`.
- Playwright e2e (Chromium, production build): default-locale redirect, Persian RTL / English LTR, language switching and cookie, global bilingual 404. Localized-404 tests are `fixme` until a route calls `notFound()`.
- `docker-compose.yml` with pinned PostgreSQL 18.6, persistent volume, health check, localhost-only throwaway credentials; `.env.example` updated.
- Multi-stage `Dockerfile` using opt-in `output: "standalone"` (ADR-012) and `.dockerignore`.
- GitHub Actions CI: lint, typecheck, unit tests, build, Playwright, and a Docker image build.

## Phase 1 — verification

Run locally on Windows (Docker Desktop) after integration. No source, dependency or test changes were needed.

| Check | Result |
| --- | --- |
| `npm run typecheck`, Vitest, ESLint, production build | Pass |
| Playwright e2e | 17 passed, 2 intentionally skipped (the localized-404 `fixme` tests) |
| Playwright Chromium download | Blocked by the regional CDN (HTTP 403); fell back to installed Windows Chrome (`PLAYWRIGHT_CHANNEL=chrome`), and all executed e2e tests passed |
| `docker compose config` | Pass |
| PostgreSQL 18.6 container | Running and healthy |
| Docker image `fashion-commerce:latest` | Build passed (exit 0) |
| Application container | Running and Healthy; HTTP smoke test `GET /fa` returned 200 |

Local Phase 1 verification is complete.

Pending:

- The first real GitHub Actions run (the workflow is in place but has not yet run on GitHub).

Remaining item:

- Two localized-404 e2e tests stay `test.fixme` until a route under `[locale]` calls `notFound()` (planned with the first dynamic route, the catalog phase).

## Phase 2A — data foundation

Scope: infrastructure only. No Identity, Catalog or Inventory tables exist yet (ADR-013 to ADR-021).

- Dependencies (exact): `drizzle-orm` 0.45.4, `pg` 8.23.1; dev: `@types/pg` 8.23.1, `drizzle-kit` 0.31.11, `tsx` 4.23.15.
- `src/shared/db`: pool, `runInTransaction` (retries 40001/40P01), migration runner (SHA-256 checksums, advisory lock, drift detection, up/down policy lint, safe down with `fc_assert_*` guards, production down blocked by default).
- `src/shared/events`: transactional outbox, dispatcher (`SKIP LOCKED`, per-event savepoint, backoff, dead letter), `handled_events` de-duplication.
- Migration `drizzle/0001_foundation`: guard and grant helper functions, `outbox_events`, `handled_events`.
- Tests: `npm test` (unit) and `npm run test:db` (real PostgreSQL; throwaway databases, never the dev database). CI has a `database` job on `postgres:18.6-alpine`.
- Verified in a Linux cloud copy against PostgreSQL 18.6 (lint, typecheck, unit, integration, `db:check`). **Not yet run on Windows**; the production build was not run there either (Google Fonts unreachable).
- No migration has been run against the development database.

## Explicit non-goals (for now)

- No real payment provider, credentials, deployment, or production data.
- No full database schema; each module adds its own tables in its phase.
- No dependency is added before the phase that needs it.

## Open questions for the product owner

- Final brand name and wordmark (the UI currently uses the working name "Fashion Commerce").
- Launch currencies and whether IRR prices display in toman (current default) or rial.
- Which payment providers (domestic Shaparak gateways vs. international) to target first.
- Additional locales (e.g. Arabic) — the i18n layer already supports adding them.
