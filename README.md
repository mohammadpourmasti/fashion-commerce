# fashion-commerce

Premium fashion e-commerce platform — online and in-store sales from one
inventory, Persian (RTL) and English (LTR), multi-currency, AI styling.

```bash
npm install
npm run dev      # http://localhost:3000
npm test         # unit tests (Vitest)
npm run check    # lint + typecheck + unit tests + production build
npm run build && npm run test:e2e   # end-to-end tests (Playwright)
docker compose up -d                # local PostgreSQL (needs Docker)
npm run test:db                     # DB integration tests (needs TEST_DATABASE_URL)
```

Documentation:

- [Project plan](docs/PROJECT_PLAN.md) — phases and status
- [Architecture](docs/ARCHITECTURE.md) — modules, boundaries, i18n, money
- [Decisions](docs/DECISIONS.md) — architecture decision records
- [Development guide](docs/DEVELOPMENT_GUIDE.md) — conventions and design system
