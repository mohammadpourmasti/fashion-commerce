<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project rules

- Read `docs/ARCHITECTURE.md` and `docs/DEVELOPMENT_GUIDE.md` before changing code.
- Business logic belongs in `src/modules/<name>`; import modules only via `@/modules/<name>`.
- No hard-coded UI strings: add to both dictionaries in `src/shared/i18n/dictionaries`.
- Use logical CSS utilities (`ms-`, `pe-`, `start-`) so RTL works; no `ml-`/`pr-`/`left-`.
- Money is integer minor units (`@/shared/money/money`); never floats.
- Run `npm run check` before declaring work done. Never claim tests passed unless run.
