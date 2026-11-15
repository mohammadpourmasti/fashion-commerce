# Architecture

## Overview

A **modular monolith**: one Next.js application and one deployable, split
internally into business modules with explicit ownership and dependencies.
This keeps operations simple (one build, one database, one deploy) while
preserving the seams needed to extract a module later if scale demands it.

```
Browser ──► proxy.ts (locale negotiation)
              │
              ▼
        Next.js App Router (src/app)        ← routing, rendering, server actions
              │  calls public APIs only
              ▼
        Business modules (src/modules/*)   ← domain logic, use cases, persistence
              │
              ▼
        Shared kernel (src/shared, src/config)
              │
              ▼
  PostgreSQL (Drizzle) · S3-compatible storage · AI providers · payment/shipping adapters
```

## Stack

| Concern | Choice |
| --- | --- |
| Framework | Next.js 16.4 (App Router, Cache Components, Turbopack) |
| UI | React 19.3, Tailwind CSS 4.3 |
| Language | TypeScript 5.9, strict |
| Validation | Zod 4 |
| Database | PostgreSQL + Drizzle ORM |
| Auth | Session-based auth + RBAC in `identity` *(phase 2B: service layer; HTTP routes and UI later)* |
| Media | S3-compatible object storage *(phase 4)* |
| Testing | Vitest (unit) + Playwright (e2e) |
| Deploy | Docker image (Next.js standalone output), Node runtime |

## Source layout

```
src/
  app/                    Routes only. Thin: parse input, call modules, render.
    [locale]/             Root layout (lang/dir), localized pages, error + not-found
    global-error.tsx      Bilingual fallback when the root layout fails
    global-not-found.tsx  Bilingual 404 for URLs matching no route
  config/env.ts           Zod-validated environment (public + server)
  instrumentation.ts      Validates server env at boot
  proxy.ts                Locale redirect + NEXT_LOCALE cookie
  modules/                Business modules (see below)
    registry.ts           All module descriptors + cycle check
  shared/
    i18n/                 Locale config, dictionaries, server helpers
    db/                   Pool, transaction helper, migration runner, test helpers
    events/               Transactional outbox, dispatcher, handled_events
    kernel/               Cross-module contracts (ModuleDescriptor)
    lib/                  Tiny framework-free utilities
    money/                Money in integer minor units, formatting
    ui/                   Design-system primitives and fonts
```

## Business modules

| Module | Owns | May depend on |
| --- | --- | --- |
| `identity` | users, sessions, roles, permissions | — |
| `catalog` | products, variants, categories, collections, attributes, media refs | — |
| `inventory` | locations, stock levels, movements, reservations | catalog |
| `customers` | profiles, addresses, size profiles, consent | identity |
| `payments` | payment intents, transactions, refunds (gateway port) | — |
| `shipping` | zones, methods, shipments (carrier port) | — |
| `commerce` | carts, orders, returns, price lists | catalog, inventory, customers, payments, shipping |
| `pos` | registers, shifts, POS sales, receipts | identity, catalog, inventory, customers, commerce, payments |
| `finance` | ledger entries, tax rules, settlements | commerce, payments, pos |
| `marketing` | promotions, discount codes, campaigns, gift cards | catalog, customers |
| `analytics` | events, report snapshots | — (consumes events) |
| `ai` | provider config, embeddings, stylist sessions | catalog, customers |

The table mirrors the descriptors in `src/modules/*/index.ts`, which are the
source of truth.

### Boundary rules

1. **Public API only.** Import a module through `@/modules/<name>`. Deep
   imports (`@/modules/catalog/domain/...`) fail ESLint.
2. **Declared dependencies only.** A module calls only modules in its
   `dependsOn`. The graph must stay acyclic (`findDependencyCycle`).
3. **Data ownership.** Each table belongs to exactly one module. Other modules
   read it via that module's API, never by querying the table.
4. **Downstream via events.** Modules that react to others (finance, analytics,
   marketing triggers) subscribe to domain events instead of being called by
   upstream modules. `shared/events` provides a transactional outbox (written in
   the same transaction as the business change) and a dispatcher with
   at-least-once delivery; consumers de-duplicate through `handled_events`
   (ADR-020). Ordering is not guaranteed.
5. **Ports for the outside world.** Payments, shipping, storage and AI are
   interfaces inside their module, with adapters per provider. No provider SDK
   is imported outside its adapter.

### Internal module layout (introduced as modules are built)

```
modules/<name>/
  index.ts          Public API (the only importable entry)
  domain/           Entities, value objects, invariants — no framework imports
  application/      Use cases; authorization checks happen here
  infrastructure/   Drizzle tables/repositories, provider adapters
  schemas.ts        Zod schemas for inputs crossing the boundary
```

## Internationalization

- Every page is under `/{locale}`; `fa` (default, RTL) and `en` (LTR).
- `src/proxy.ts` redirects un-prefixed URLs using the `NEXT_LOCALE` cookie, then
  `Accept-Language`, then the default.
- The root layout reads the locale with `next/root-params` and sets
  `<html lang dir>`; `generateStaticParams` prerenders both locales.
- Dictionaries are typed TypeScript objects; `en.ts` defines the shape and every
  other locale must satisfy it (missing keys fail typecheck).
- Layout uses CSS logical properties (`ms-`, `pe-`, `start-`, `border-e`) so
  one markup tree serves both directions.
- Product content (names, descriptions) will be stored per locale in the
  database, separate from UI dictionaries.

## Multi-currency

- `Money = { amountMinor: integer, currency: ISO 4217 }`; never floats.
- IRR is the system of record for Iranian prices; toman is display-only.
- Prices are stored per currency in price lists (explicit prices, not
  live conversion), so a USD price is a merchandising decision, not an
  exchange-rate artifact. FX rates may assist price-list generation.
- Database columns: `bigint` minor units + `char(3)` currency.

## Identity and authorization

Business modules depend only on the kernel contracts in `src/shared/kernel/authorization.ts`. A `RequestContext` carries the actor and `authorize()`; identity implements the `Authorizer` port and the composition root passes it in. See ADR-016, ADR-022 and ADR-023.

## Catalog data

Catalog tables (ADR-018, ADR-024, ADR-025) hold structure only — no prices or stock. Variants use at most three positional axes; composite foreign keys ensure a variant uses only values its product offers, one per axis, in a unique combination, and freeze a product's axes once variants exist. Products, variants and other master rows are archived or discontinued, never deleted. Localized content lives in per-locale translation tables; images are metadata with a view (`front`, `back`, `detail`, `gallery`) and an optional link to one of the product's colour-axis values (never a size or other axis).

## Security baseline

- Secrets only via validated server env; `NEXT_PUBLIC_*` never holds secrets.
- RBAC enforced in module application services, not only in UI or proxy.
- Server Actions and Route Handlers validate all input with Zod.
- `poweredByHeader` disabled; CSP and security headers are added with the first authenticated HTTP routes.
- No payment card data touches our servers; hosted/redirect gateways only.

## Rendering

Cache Components is enabled. Pages are statically prerendered per locale
where possible (`/fa`, `/en` today). Request-specific data (cart, session)
will stream in dynamic holes wrapped in `<Suspense>`.
