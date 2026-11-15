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
| 2A | Data foundation: DB pool, transaction helper, migration runner (checksums, safe down), transactional outbox + `handled_events`, real-PostgreSQL tests | **Done — local verification complete on Windows** (see "Phase 2A"); still pending: the first real GitHub Actions run |
| 2B | Identity: users, scrypt passwords, sessions (`__Host-session`), login throttling, CSRF, kernel authorization contracts | **Done — local verification complete on Windows** (see "Phase 2B"); still pending: the first real GitHub Actions run |
| 2C | Catalog: products, variants (composite FKs), categories, brands, attributes, localized content, image metadata (no prices) | **In progress — Step 1 (schema) implemented; awaiting review** (see "Phase 2C") |
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

Scope: infrastructure only. Phase 2A added no Identity, Catalog or Inventory tables (ADR-013 to ADR-021).

- Dependencies (exact): `drizzle-orm` 0.45.4, `pg` 8.23.1; dev: `@types/pg` 8.23.1, `drizzle-kit` 0.31.11, `tsx` 4.23.15.
- `src/shared/db`: pool, `runInTransaction` (retries 40001/40P01), migration runner (SHA-256 checksums, advisory lock, drift detection, up/down policy lint, safe down with `fc_assert_*` guards, production down blocked by default).
- `src/shared/events`: transactional outbox, dispatcher (`SKIP LOCKED`, per-event savepoint, backoff, dead letter), `handled_events` de-duplication.
- Migration `drizzle/0001_foundation`: guard and grant helper functions, `outbox_events`, `handled_events`.
- Tests: `npm test` (unit) and `npm run test:db` (real PostgreSQL; throwaway databases, never the dev database). CI has a `database` job on `postgres:18.6-alpine`.
- Verified in a Linux cloud copy against PostgreSQL 18.6 (lint, typecheck, unit, integration, `db:check`), then on Windows on 2026-11-14 (`npm ci`, lint, typecheck, unit tests, `db:check`, `npm run test:db` against the Compose PostgreSQL, production build): all passed, and the throwaway test databases were removed.
- No migration has been run against the development database.

## Phase 2B — identity & access

Scope: service layer only (ADR-022, ADR-023). No HTTP routes, no UI, no SMS OTP, no OAuth.

- Kernel: `src/shared/kernel/authorization.ts` (Actor, Permission, Scope, Authorizer, RequestContext with `can`/`authorize`, catalog merge).
- Migration `drizzle/0002_identity`: nine tables, least-privilege grants (audit log append-only for the app role), guarded `down.sql`.
- `src/modules/identity`: domain (scrypt, keys, cookie, CSRF, throttle policy, grants), application services (login, sessions, throttle, audit, users, authorizer, catalog sync, request context) and `createIdentity()`.
- CLI: `npm run identity:create-admin`. Startup check for an insecure site URL in production.
- Tests: unit tests for the domain and kernel; integration tests on a throwaway PostgreSQL (schema drift, down guard, audit immutability, login, throttling, sessions, rotation races, RBAC, last-owner protection).
- Runner tests now copy only `0001_foundation` into their fixtures so later module migrations do not affect them.
- Known limits: distributed attackers can keep one account at the 15-minute delay (no hard lockout by design); scrypt uses the libuv thread pool (throttling bounds it); no audit retention or archival yet; no route handlers yet.
- Verified on Windows on 2026-11-15 against the Compose PostgreSQL 18.6: `npm run check` (lint, typecheck, 205 unit tests in 16 files, `db:check` with 2 migrations, production build) and `npm run test:db` (95 integration tests in 5 files) all passed; no throwaway `fc_test_` databases or `fc_` roles remained afterwards.
- Not run in GitHub Actions yet. No migration has been run against the development database.

## Phase 2C — catalog

Approved scope: service layer only (ADR-024, ADR-025). No prices, stock, HTTP routes, UI, seed data or collections. Delivered in steps, each reviewed before the next.

| Step | Scope | Status |
| --- | --- | --- |
| 1 | ADR-024/025, migration `drizzle/0003_catalog`, `src/modules/catalog/infrastructure/schema.ts`, schema and constraint integration tests | **Implemented; awaiting review** |
| 2 | Domain: slugs, SKU/GTIN, variant matrix, category tree, publication rules, permission catalog, unit tests | Planned |
| 3 | Taxonomy services: categories, brands, attributes and values | Planned |
| 4 | Products, translations, descriptive attributes | Planned |
| 5 | Axes and variants | Planned |
| 6 | Images | Planned |
| 7 | Public read queries, outbox events, docs, Windows verification script | Planned |

Step 1:

- Migration `0003_catalog`: 19 tables, the GTIN check function, a deferred trigger for axis positions, least-privilege grants (no `DELETE` on master rows) and a guarded `down.sql`.
- Integration tests (`src/modules/catalog/catalog-schema.int.test.ts`): Drizzle parity (columns, generated columns, CHECK, UNIQUE, foreign keys, indexes), an up/down round trip back to the exact previous schema, FCD01 refusal with data, no seed rows, app-role privileges, and the key constraints (primary category membership, axis and value ownership, variant combinations, frozen axes, SKU/GTIN, typed descriptive values, image views and colour links, slugs).
- `identity.int.test.ts` now migrates only up to `0002_identity`, so its down-migration tests keep reverting identity rather than the newest migration.
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
