# Product integration

Each product is represented by one Account Hub application. The product stores two values on its server:

```dotenv
ACCOUNT_HUB_URL=https://accounts.example.com
ACCOUNT_HUB_API_KEY=ahk_...
```

Never send `ACCOUNT_HUB_API_KEY` to the browser.

## User entry

Send users to the application-specific account center:

```text
https://accounts.example.com/portal?app=your-application-slug
```

The portal provides registration, login, balance, plans, order history, and recharge. A product may replace this UI later while keeping the same APIs.

## Product sign-in

Account Hub uses a short-lived, single-use authorization code so products on different domains do not need to share cookies.

1. Register the product callback URL in the application's access settings.
2. Redirect the browser to `/connect?app=your-slug&redirect_uri=...&state=...`.
3. The user logs in and approves access in Account Hub.
4. Verify `state` when the browser returns to the product callback.
5. Exchange `code` from the product server with `exchangeAuthorizationCode(code, redirectUri)`.
6. Create a product-local session after the exchange succeeds.

Authorization codes expire after five minutes and cannot be replayed. Callback URLs require an exact whitelist match.

## Task billing

```ts
import { AccountHubClient } from "@account-hub/sdk";

const billing = new AccountHubClient({
  baseUrl: process.env.ACCOUNT_HUB_URL!,
  apiKey: process.env.ACCOUNT_HUB_API_KEY!,
});

const identity = await billing.exchangeAuthorizationCode(code, callbackUrl);

const reservation = await billing.reserveUsage({
  userId,
  amount: 100,
  idempotencyKey: taskId,
  externalReference: taskId,
});

try {
  const result = await runBusinessTask();
  await billing.captureUsage(reservation.id);
  return result;
} catch (error) {
  await billing.releaseUsage(reservation.id);
  throw error;
}
```

Use the business task ID as the idempotency key. A timeout can be retried with the same key.

## Relevant endpoints

```text
POST /api/v1/auth/register
POST /api/v1/auth/login
GET  /api/v1/auth/me
GET  /api/v1/connect/context
POST /api/v1/connect/authorize

POST /api/sdk/v1/auth/exchange
GET  /api/sdk/v1/users/:userId/wallet
POST /api/sdk/v1/usage/reservations
POST /api/sdk/v1/usage/reservations/:id/capture
POST /api/sdk/v1/usage/reservations/:id/release
```

Administrative and portal endpoints are versioned under `/api/v1/`. Product billing endpoints are versioned under `/api/sdk/v1/`.
