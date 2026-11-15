# Development Guide

## Prerequisites

| Tool | Required | Verified on this machine |
| --- | --- | --- |
| Node.js | ≥ 20.9 | 24.19.0 |
| npm | ≥ 10 | 11.17.0 |
| Git | any recent | 2.55.0 |
| Docker | local PostgreSQL and image builds (not needed for `dev`, tests or `build`) | 29.6.2 CLI; daemon (Docker Desktop) must be running |

## Getting started

```bash
npm install
cp .env.example .env.local     # optional for now; defaults cover dev
npm run dev                    # http://localhost:3000 → redirects to /fa or /en
```

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Dev server (Turbopack) |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint (includes module-boundary rule) |
| `npm run typecheck` | Generate route types, then `tsc --noEmit` |
| `npm test` | Unit tests once (Vitest) |
| `npm run test:watch` | Unit tests in watch mode |
| `npm run test:db` | Integration tests against real PostgreSQL (needs `TEST_DATABASE_URL`, see "Database tooling") |
| `npm run db:check` | Static migration policy check (no database needed) |
| `npm run db:status` / `db:migrate` / `db:migrate:down` | Migration CLI (needs `MIGRATION_DATABASE_URL` or `DATABASE_URL`) |
| `npm run db:generate` | `drizzle-kit` drafts SQL into git-ignored `drizzle/_generated/` for review |
| `npm run test:e2e` | Playwright end-to-end tests against the production build (run `npm run build` first) |
| `npm run check` | lint + typecheck + unit tests + `db:check` + build — run before every commit |

## Next.js version note

This project uses Next.js 16.4. Several conventions differ from older
versions (`proxy.ts` instead of `middleware.ts`, `retry` in error boundaries,
`next/root-params`, Cache Components). Read the bundled docs in
`node_modules/next/dist/docs/` before using an unfamiliar API.

## Conventions

### Code placement

- **Routes (`src/app`)** stay thin: read params, call a module, render.
- **Business logic** lives in `src/modules/<name>`, exposed only via `index.ts`.
- **Shared code** (`src/shared`) must be domain-agnostic. If it mentions
  products, orders or customers, it belongs in a module.
- Route-private components go in `_components/` next to the route.

### Module rules

- Import modules as `@/modules/<name>` only (ESLint enforces).
- Before importing another module, add it to your module's `dependsOn`.
- Never query another module's tables.
- When adding a module: create `src/modules/<name>/index.ts`, add the name to
  `moduleNames` in `src/shared/kernel/module.ts`, register it in
  `src/modules/registry.ts`, and update `docs/ARCHITECTURE.md`.

### TypeScript

- Strict mode with `noUncheckedIndexedAccess`; handle `undefined` from index
  access rather than using `!`.
- Use `import type` for type-only imports (lint-enforced).
- Validate all external input (forms, params, webhooks, env) with Zod.

### Internationalization

- Never hard-code user-facing strings in components; add them to
  `src/shared/i18n/dictionaries/en.ts`, then `fa.ts` (typecheck fails otherwise).
- Server Components: `await getDictionary()` / `await getLocale()` from
  `@/shared/i18n/server`.
- Client Components: receive strings as props, or use the static
  `dictionaries` map with the locale from `useParams()` (as in `error.tsx`).
- Use logical utilities only: `ms-*`/`me-*`, `ps-*`/`pe-*`, `start-*`/`end-*`,
  `border-s`/`border-e`, `text-start`. Avoid `ml-*`, `pr-*`, `left-*`, `text-left`.
- Format numbers, dates and money with `Intl` using `localeMeta[locale].intl`
  — Persian gets Persian digits automatically.
- Do not apply letter-spacing to Persian text (it breaks letter joining); the
  `tracking-*` tokens are already reset under `:lang(fa)`.
- Wrap embedded LTR fragments (SKUs, codes, emails) in `dir="ltr"`.

### Money

- Use `money()`, `addMoney()`, `formatMoney()` from `@/shared/money/money`.
- Amounts are integers in minor units. Never use floats for prices.

## Design system

Tokens live in `src/app/globals.css` (`@theme`). Tailwind's default colour
palette is removed — only brand tokens are available.

### Colour

| Token | Hex | Use |
| --- | --- | --- |
| `ivory` / `canvas` | #F6F3EE | Page background |
| `ivory-deep` | #EDE8DF | Panels, image placeholders |
| `white` / `surface` | #FFFFFF | Cards, inputs, overlays |
| `charcoal` / `ink` | #242321 | Text, primary buttons, dark sections |
| `charcoal-soft` | #3A3835 | Hover on charcoal |
| `stone-ink` / `muted` | #66625B | Small secondary text (5.5:1) |
| `stone` | #88847D | Large text, icons, indices (3.4:1) |
| `line` | #DCD6CC | Hairline borders and rules |
| `champagne` / `accent` | #B69A76 | Decorative accents; text only on charcoal |
| `champagne-soft` | #E4D8C7 | Selection, subtle highlights |

### Typography

- `text-display`, `text-headline`, `text-title`, `text-lead` are fluid
  (`clamp`) sizes; use `<Heading level>` rather than raw classes.
- `font-display` = Cormorant Garamond (Latin) / Vazirmatn (Persian).
- `.eyebrow` for small labels above headings.

### Principles

- Restraint: generous whitespace, hairline rules, few colours per view.
- Sharp edges; the arch is the one signature curve, reserved for imagery frames.
- Motion is slow and eased (`ease-editorial`) and disabled under
  `prefers-reduced-motion`.
- Focus is always visible (1px charcoal outline, 3px offset).
- Phone-first: 16px gutters on mobile, `max-w-page` (88rem) on desktop.

### Primitives (`@/shared/ui`)

`Container`, `Heading`, `Eyebrow`, `Rule`, `Button`, `ButtonLink`,
`buttonClasses`. Fonts are in `@/shared/ui/fonts` (server-only usage).

## Database tooling

Migrations live in `drizzle/NNNN_name/{migration.sql,down.sql}` and are applied
by our own runner, not by `drizzle-kit` (which only drafts SQL).

- Never run `db:migrate` against a database you care about without deciding to.
  Nothing runs migrations automatically.
- Up migrations: one transaction each; destructive statements need a
  `-- fc:allow-destructive: <reason>` marker; no transaction control, no `CONCURRENTLY`.
- `down.sql` must be safe: guard calls (`fc_assert_table_empty`, `fc_assert_column_empty`)
  before each `DROP`; no `DELETE`/`UPDATE`/`TRUNCATE`. Down is refused when
  `NODE_ENV=production` unless `--allow-production` is passed.
- Applied files are checksummed (SHA-256, line endings normalized). Editing an
  applied migration, or a missing or out-of-order file, fails the run.
- App role: set `DB_APP_ROLE` so migrations grant only DML to the runtime role;
  production should use a separate `MIGRATION_DATABASE_URL` owner role.
- Integration tests: set `TEST_DATABASE_URL` to an admin URL (role needs
  CREATEDB and CREATEROLE), e.g. the local Compose server with database
  `postgres`. Each test file creates and drops its own throwaway database.

## Environment variables

See `.env.example`. All variables are validated in `src/config/env.ts`; the
server fails to start with a clear message if any are invalid. Never commit
`.env.local` or any real secret; `.env.example` holds only placeholders and the
throwaway local-PostgreSQL development URL.

## Testing

### Unit tests (Vitest)

- Files live next to the code as `*.test.ts` under `src/`; run with `npm test`.
- Node environment, `@/` alias configured in `vitest.config.mts`. No DOM
  environment is installed — add one only when component tests need it.
- `src/config/env.ts` validates at import time, so env tests stub variables
  with `vi.stubEnv`, call `vi.resetModules()` and `import()` it fresh (see
  `src/config/env.test.ts`).
- `src/modules/registry.test.ts` fails if the module graph gains a cycle or a
  duplicate-owned aggregate.

### End-to-end tests (Playwright)

- Specs live in `e2e/` and run in Chromium against the **production build**
  (`next start` on port 3100, started by Playwright), so run `npm run build`
  first. Playwright always starts its own server and never reuses one, so it
  cannot test a stale build; if port 3100 is busy the run fails — stop the old
  process or set `E2E_PORT`.
- Install the browser once: `npx playwright install chromium`. If the download
  fails (for example HTTP 403 from the browser CDN in some regions), use an
  installed Google Chrome instead: set `PLAYWRIGHT_CHANNEL=chrome` (PowerShell:
  `$env:PLAYWRIGHT_CHANNEL = "chrome"`) before `npm run test:e2e`. This was
  verified on Windows: all executed e2e tests passed with installed Chrome.
- Copy and assertions come from the real dictionaries, so wording changes do
  not break tests.
- `PLAYWRIGHT_CHANNEL=chrome` uses an installed Chrome instead of the bundled
  Chromium; `E2E_PORT` changes the port.
- The two localized-404 tests are `test.fixme`: `app/[locale]/not-found.tsx`
  renders only when a route under `[locale]` calls `notFound()`, which nothing
  does yet. Unknown URLs currently show the global bilingual 404 (tested).
  Enable them with the first dynamic route (catalog).

### CI

`.github/workflows/ci.yml` runs on pushes to `main`/`master` and on pull
requests: `npm ci` → lint → typecheck → unit tests → production build →
Playwright → (separate job) `docker build`. Playwright runs after the build
because it serves that build. The build downloads Google Fonts (ADR-005), so
runners need network access.

## Local database

```bash
docker compose up -d      # PostgreSQL 18, bound to 127.0.0.1:5432
docker compose ps         # wait until the service is "healthy"
docker compose down       # stop; data persists in the postgres-data volume
docker compose down -v    # stop and delete all local data
```

- The development credentials in `docker-compose.yml` and `.env.example`
  (`fashion` / `fashion_dev_only`) are throwaway values. Never use them for
  anything shared, staging or production.
- Override user, password, database name or port with a git-ignored `.env`
  next to `docker-compose.yml` (`POSTGRES_USER`, `POSTGRES_PASSWORD`,
  `POSTGRES_DB`, `POSTGRES_PORT`), and keep `DATABASE_URL` in `.env.local`
  in sync.
- The image tag is pinned (`postgres:18.6-alpine`, a published tag in Docker's
  official-images manifest). Bump it deliberately; PostgreSQL 18 images keep
  data under `/var/lib/postgresql`, which is where the volume is mounted.
- The application does not use the database yet; phase 2A added the data
  foundation (see "Database tooling").

## Production image

```bash
docker build -t fashion-commerce \
  --build-arg NEXT_PUBLIC_SITE_URL=https://example.com .
docker run --rm -p 3000:3000 --env-file .env.production fashion-commerce
```

- Multi-stage `Dockerfile`: `npm ci` → `next build` with
  `NEXT_OUTPUT=standalone` → minimal runtime image running `node server.js`
  as the non-root user `1001:1001` (numeric, so Kubernetes `runAsNonRoot` can
  verify it), with a `wget` healthcheck on `/fa`.
- `output: "standalone"` is opt-in through `NEXT_OUTPUT=standalone` (set by the
  Dockerfile) so normal builds and `next start` are unchanged.
- `NEXT_PUBLIC_*` values are inlined at build time (use `--build-arg`); server
  secrets are never baked into the image — pass them at run time.
- The build needs outbound network for Google Fonts (ADR-005).
- Verified on Windows (Docker Desktop): the image builds, the application
  container reaches Healthy, and `GET /fa` returns HTTP 200.
