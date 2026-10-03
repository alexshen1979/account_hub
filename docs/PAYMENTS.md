# Payment providers

Version 0.3 includes a development-only mock provider and a production EasyPay/ZPay-compatible provider using the common MD5 signing protocol.

## EasyPay setup

1. Set `PUBLIC_URL` to the externally reachable Account Hub origin.
2. Set a stable `MASTER_ENCRYPTION_KEY` with at least 32 random characters.
3. Open Payment Channels in the admin UI, select the application, and create a channel.
4. Enter the provider gateway base URL, merchant ID, merchant key, and payment type.
5. Copy the asynchronous notification URL shown in the UI to the provider console if the provider requires it there.

The gateway URL can be either its base path or the full `submit.php` URL. Account Hub signs `pid`, `type`, `out_trade_no`, `notify_url`, `return_url`, `name`, and `money`, then sends the browser to the provider checkout.

Merchant keys are encrypted with AES-256-GCM and are never returned by an API. The merchant ID is masked in the admin response. Each order stores an encrypted configuration snapshot so rotating channel credentials does not invalidate pending orders.

## Payment confirmation

EasyPay notifications may use `GET` or `application/x-www-form-urlencoded` `POST` at:

```text
/api/v1/payments/epay/notify
```

Before crediting a wallet, Account Hub validates the MD5 signature, merchant ID, payment type, local order number, exact amount, and `TRADE_SUCCESS` state. It then locks the order and commits the webhook event, balanced ledger transaction, provider trade number, and paid order status in one database transaction.

The provider trade number and local order ID provide two idempotency layers. An exact repeated notification returns `success` without crediting the wallet again. A reused provider trade number for another order is rejected.

The browser return URL only reloads order state. It never changes wallet balances. In production, creating a recharge order fails when the application has no active payment channel.

## Mock payments

When no channel is active outside production, portal orders use the mock provider. Mock endpoints are disabled when `NODE_ENV=production` and must not be exposed as a production payment mechanism.
