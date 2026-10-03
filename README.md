# Account Hub

Reusable identity, wallet, billing, and administration service for multiple products. It is a standalone service and does not depend on any product repository.

Repository: https://github.com/alexshen1979/account_hub

This standalone repository was extracted from the local Account Hub v0.3.2 source on 2026-10-03. It includes the API, admin UI, user portals, TypeScript SDK, tests, and deployment configuration. Runtime databases, local secrets, dependencies, and generated releases are excluded.

Version 0.3 adds reusable EasyPay/ZPay-compatible payment channels, encrypted merchant configuration, signed checkout, and idempotent webhook settlement.

Version 0.3.1 adds an administrator-only cross-platform server health snapshot for Windows, Linux, and macOS.

Version 0.3.2 adds a live CPU, memory, and disk usage chart to the administrator overview.

## Local development

```powershell
npm ci
npm run dev
```

- Admin UI: `http://localhost:8791`
- API: `http://localhost:8790`
- Default local admin: `admin@local.test` / `Admin123!`

The local database uses embedded PostgreSQL-compatible PGlite and is stored under `data/`. Set `DATABASE_URL` to a PostgreSQL connection string for a server deployment. Create the first application in the admin UI, then copy its user portal URL and API key.

## Production build

```powershell
npm run build
npm start
```

The API serves both the admin UI and application-specific user portals from the same process.

Before deployment, set `ADMIN_PASSWORD`, `APP_ORIGIN`, `PUBLIC_URL`, `MASTER_ENCRYPTION_KEY`, and `DATABASE_URL`. The default password and mock payment endpoint are development-only; mock payment is disabled when `NODE_ENV=production`.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Product integration](docs/INTEGRATION.md)
- [Payment providers](docs/PAYMENTS.md)
- [Server monitoring](docs/MONITORING.md)

## Application SDK

```ts
import { AccountHubClient } from "@account-hub/sdk";

const accountHub = new AccountHubClient({
  baseUrl: "http://localhost:8790",
  apiKey: process.env.ACCOUNT_HUB_API_KEY!,
});

const reservation = await accountHub.reserveUsage({
  userId,
  amount: 100,
  idempotencyKey: taskId,
  externalReference: taskId,
});

try {
  await runTask();
  await accountHub.captureUsage(reservation.id);
} catch (error) {
  await accountHub.releaseUsage(reservation.id);
  throw error;
}
```

All credit changes are recorded as immutable balanced ledger entries. Usage billing follows reserve, capture, and release semantics.
