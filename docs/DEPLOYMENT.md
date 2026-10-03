# Deployment

## Local source mode

```powershell
npm install
npm run dev
```

Local mode uses PGlite under `data/` and requires no separate database process.

## Docker with PostgreSQL

Create a `.env` next to `compose.yaml`:

```dotenv
POSTGRES_PASSWORD=replace-with-a-long-database-password
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=replace-with-a-long-admin-password
APP_ORIGIN=https://accounts.example.com
PUBLIC_URL=https://accounts.example.com
MASTER_ENCRYPTION_KEY=replace-with-at-least-32-random-characters
COOKIE_SECURE=true
```

Then run:

```powershell
docker compose up -d --build
```

Terminate TLS at a reverse proxy and forward traffic to port `8790`. `APP_ORIGIN` must exactly match the browser origin. `PUBLIC_URL` is used to build payment notification and return URLs and must be reachable by the payment platform. Keep `COOKIE_SECURE=true` behind HTTPS.

`MASTER_ENCRYPTION_KEY` encrypts merchant credentials. Use at least 32 random characters, keep the same value across deployments, and include it in the secret backup. Losing or changing it makes existing payment channel configuration and pending order snapshots unreadable.

## First setup

1. Sign in with `ADMIN_EMAIL` and `ADMIN_PASSWORD`.
2. Create an application in the Applications page.
3. Store the displayed API key in the product server's secret configuration.
4. Copy the user portal URL from the application row.
5. Create one or more recharge plans.
6. Create an EasyPay-compatible channel on the Payment Channels page and copy the displayed asynchronous notification URL into the provider console.

Optional `SEED_APP_NAME`, `SEED_APP_SLUG`, and `SEED_APP_API_KEY` variables can provision the first application non-interactively.

## Backup

For PostgreSQL deployments, back up the database with standard `pg_dump` tooling. Local PGlite data is intended for development only and must not be used as the sole production copy.
