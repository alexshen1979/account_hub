# Architecture

Account Hub is an independent identity and billing service. Business products consume it through HTTP APIs or the TypeScript SDK; they do not share its database.

```text
Product A ─┐
Product B ─┼─ application API key ─> Account Hub API ─> PostgreSQL
Product C ─┘                              │
                                         ├─ Admin UI
                                         └─ User portal
```

## Boundaries

- `apps/api`: authentication, multi-application tenancy, wallet, ledger, orders, usage settlement, and audit APIs.
- `apps/admin`: reusable operations console and per-application user portal.
- `packages/sdk`: server-side client used by business products.
- `data`: local PGlite database only. It is excluded from source packages.

Users are global identities. `app_memberships` controls which applications a user can access, while wallets, plans, orders, and API keys are application-scoped.

## Ledger rules

Wallet balances are cached projections. The durable source of truth is the immutable ledger:

- Recharge: user available credit increases; issuance account decreases.
- Reserve: available credit decreases; frozen credit increases.
- Capture: frozen credit decreases; consumed account increases.
- Release: frozen credit decreases; available credit increases.
- Administrative debit: available credit decreases; issuance account increases.

Every transaction must sum to zero. Business requests use an application-scoped idempotency key so retries cannot charge twice.

## Trust boundaries

- Browser sessions use a random opaque cookie; only its SHA-256 digest is stored.
- Product servers authenticate with an application API key. API keys must never be exposed in browser code.
- Payment confirmation must come from a verified provider webhook. Browser redirects are not proof of payment.
- Merchant credentials and per-order configuration snapshots are encrypted with AES-256-GCM before storage.
- EasyPay notifications validate the signature, merchant, payment type, order number, exact amount, and success state before one transactional settlement.
- The built-in mock provider is disabled when `NODE_ENV=production`.
