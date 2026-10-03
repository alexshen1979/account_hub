import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDatabase, type Database } from "../src/database.js";
import { signEpay, verifyEpaySignature } from "../src/payment.js";

let app: FastifyInstance;
let db: Database;
let cookie = "";
let applicationId = "";
let apiKey = "";
let userId = "";
let walletId = "";
let planId = "";
let portalCookie = "";
let epayOrderId = "";
let epayOrderNo = "";
const merchantId = "merchant-1001";
const merchantKey = "epay-test-secret";
const providerTradeNo = "EPAY-TRADE-0001";

before(async () => {
  process.env.NODE_ENV = "test";
  db = await openDatabase({ path: ":memory:", adminEmail: "admin@local.test", adminPassword: "Admin123!" });
  app = await buildApp({ database: db, serveAdmin: false });
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: "admin@local.test", password: "Admin123!" },
  });
  assert.equal(response.statusCode, 200);
  cookie = response.headers["set-cookie"]!.split(";")[0]!;
});

after(async () => {
  await app.close();
  await db.close();
});

test("reports cross-platform server status to administrators only", async () => {
  const unauthorized = await app.inject({ method: "GET", url: "/api/v1/admin/server-status" });
  assert.equal(unauthorized.statusCode, 401);

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/admin/server-status",
    headers: { cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  const server = response.json();
  assert.match(server.state, /^(healthy|warning|critical|unknown)$/);
  assert.equal(typeof server.hostname, "string");
  assert.equal(typeof server.platform, "string");
  assert.equal(typeof server.cpu.usagePercent, "number");
  assert.ok(server.memory.totalBytes > 0);
  assert.equal(typeof server.disk.usagePercent, "number");
  assert.ok(server.hostUptimeSeconds >= 0);
  assert.match(server.nodeVersion, /^v\d+/);
});

test("creates an isolated application, user, and plan", async () => {
  const application = await app.inject({
    method: "POST",
    url: "/api/v1/admin/applications",
    headers: { cookie },
    payload: { name: "Test Product", slug: "test-product" },
  });
  assert.equal(application.statusCode, 201, application.body);
  applicationId = application.json().id;
  apiKey = application.json().apiKey;
  assert.match(apiKey, /^ahk_/);

  const user = await app.inject({
    method: "POST",
    url: "/api/v1/admin/users",
    headers: { cookie },
    payload: {
      applicationId,
      displayName: "测试用户",
      email: "member@example.test",
      password: "Member123!",
      initialCredits: 500,
    },
  });
  assert.equal(user.statusCode, 201, user.body);
  userId = user.json().id;
  walletId = user.json().walletId;

  const plan = await app.inject({
    method: "POST",
    url: "/api/v1/admin/plans",
    headers: { cookie },
    payload: {
      applicationId,
      name: "1000 点充值包",
      code: "credits-1000",
      priceCents: 990,
      currency: "CNY",
      includedCredits: 1000,
      validityDays: 0,
    },
  });
  assert.equal(plan.statusCode, 201, plan.body);
  planId = plan.json().id;
});

test("processes an idempotent mock payment", async () => {
  const order = await app.inject({
    method: "POST",
    url: "/api/v1/admin/orders",
    headers: { cookie },
    payload: { applicationId, userId, planId },
  });
  assert.equal(order.statusCode, 201, order.body);
  const orderId = order.json().id;

  const paid = await app.inject({ method: "POST", url: `/api/v1/admin/orders/${orderId}/mock-pay`, headers: { cookie } });
  assert.equal(paid.statusCode, 200, paid.body);
  assert.equal(paid.json().balance.available, 1500);

  const duplicate = await app.inject({ method: "POST", url: `/api/v1/admin/orders/${orderId}/mock-pay`, headers: { cookie } });
  assert.equal(duplicate.statusCode, 200, duplicate.body);
  assert.equal(duplicate.json().alreadyPaid, true);
});

test("exchanges a one-time application authorization code", async () => {
  const redirectUri = "http://localhost:8787/api/auth/callback";
  const configured = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/applications/${applicationId}`,
    headers: { cookie },
    payload: { redirectUris: [redirectUri], allowRegistration: true },
  });
  assert.equal(configured.statusCode, 200, configured.body);

  const registration = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      applicationSlug: "test-product",
      displayName: "授权用户",
      email: "connect@example.test",
      password: "Connect123!",
    },
  });
  assert.equal(registration.statusCode, 201, registration.body);
  const connectCookie = registration.headers["set-cookie"]!.split(";")[0]!;
  const state = "state-1234567890-abcdef";
  const authorize = await app.inject({
    method: "POST",
    url: "/api/v1/connect/authorize",
    headers: { cookie: connectCookie },
    payload: { app: "test-product", redirectUri, state },
  });
  assert.equal(authorize.statusCode, 200, authorize.body);
  const destination = new URL(authorize.json().redirectUrl);
  assert.equal(destination.origin + destination.pathname, redirectUri);
  assert.equal(destination.searchParams.get("state"), state);
  const code = destination.searchParams.get("code")!;

  const exchange = await app.inject({
    method: "POST",
    url: "/api/sdk/v1/auth/exchange",
    headers: { authorization: `Bearer ${apiKey}` },
    payload: { code, redirectUri },
  });
  assert.equal(exchange.statusCode, 200, exchange.body);
  assert.equal(exchange.json().user.email, "connect@example.test");

  const replay = await app.inject({
    method: "POST",
    url: "/api/sdk/v1/auth/exchange",
    headers: { authorization: `Bearer ${apiKey}` },
    payload: { code, redirectUri },
  });
  assert.equal(replay.statusCode, 400, replay.body);
});

test("reserves and captures usage through the application SDK API", async () => {
  const reserved = await app.inject({
    method: "POST",
    url: "/api/sdk/v1/usage/reservations",
    headers: { authorization: `Bearer ${apiKey}` },
    payload: { userId, amount: 120, idempotencyKey: "analysis-task-00000001", externalReference: "AT-TEST-001" },
  });
  assert.equal(reserved.statusCode, 201, reserved.body);
  assert.equal(reserved.json().balance.available, 1380);
  assert.equal(reserved.json().balance.frozen, 120);

  const captured = await app.inject({
    method: "POST",
    url: `/api/sdk/v1/usage/reservations/${reserved.json().id}/capture`,
    headers: { authorization: `Bearer ${apiKey}` },
  });
  assert.equal(captured.statusCode, 200, captured.body);
  assert.equal(captured.json().balance.available, 1380);
  assert.equal(captured.json().balance.frozen, 0);

  const wallet = await app.inject({
    method: "GET",
    url: `/api/sdk/v1/users/${userId}/wallet`,
    headers: { authorization: `Bearer ${apiKey}` },
  });
  assert.equal(wallet.statusCode, 200, wallet.body);
  assert.equal(Number(wallet.json().available), 1380);
});

test("keeps every ledger transaction balanced", async () => {
  const result = await db.query<{ transaction_id: string; total: string }>(
    `SELECT transaction_id, SUM(amount) AS total FROM ledger_entries
     GROUP BY transaction_id HAVING SUM(amount) <> 0`,
  );
  assert.deepEqual(result.rows, []);
  const wallet = await db.query<{ available: string }>("SELECT available FROM wallets WHERE id = $1", [walletId]);
  assert.equal(Number(wallet.rows[0]!.available), 1380);
});

test("supports the user registration and self-service recharge portal", async () => {
  const registration = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      applicationSlug: "test-product",
      displayName: "门户用户",
      email: "portal@example.test",
      password: "Portal123!",
    },
  });
  assert.equal(registration.statusCode, 201, registration.body);
  portalCookie = registration.headers["set-cookie"]!.split(";")[0]!;

  const account = await app.inject({
    method: "GET",
    url: "/api/v1/portal/test-product/account",
    headers: { cookie: portalCookie },
  });
  assert.equal(account.statusCode, 200, account.body);
  assert.equal(Number(account.json().account.available), 0);

  const order = await app.inject({
    method: "POST",
    url: "/api/v1/portal/test-product/orders",
    headers: { cookie: portalCookie },
    payload: { planId },
  });
  assert.equal(order.statusCode, 201, order.body);

  const paid = await app.inject({
    method: "POST",
    url: `/api/v1/portal/test-product/orders/${order.json().id}/mock-pay`,
    headers: { cookie: portalCookie },
  });
  assert.equal(paid.statusCode, 200, paid.body);
  assert.equal(paid.json().balance.available, 1000);
});

test("signs ePay parameters deterministically and ignores signature fields", () => {
  const parameters = {
    money: "9.90",
    pid: merchantId,
    out_trade_no: "AH-TEST",
    sign_type: "MD5",
  };
  const signature = signEpay(parameters, merchantKey);
  assert.equal(signature.length, 32);
  assert.equal(verifyEpaySignature({ ...parameters, sign: signature }, merchantKey), true);
  assert.equal(verifyEpaySignature({ ...parameters, sign: "0".repeat(32) }, merchantKey), false);
});

test("configures ePay without exposing secrets and creates a signed checkout", async () => {
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/admin/payment-providers",
    headers: { cookie },
    payload: {
      applicationId,
      name: "支付宝收款",
      gatewayUrl: "https://pay.example.test/api",
      merchantId,
      merchantKey,
      paymentType: "alipay",
      status: "active",
    },
  });
  assert.equal(created.statusCode, 201, created.body);

  const providers = await app.inject({
    method: "GET",
    url: `/api/v1/admin/payment-providers?applicationId=${applicationId}`,
    headers: { cookie },
  });
  assert.equal(providers.statusCode, 200, providers.body);
  assert.equal(providers.body.includes(merchantKey), false);
  assert.equal(providers.body.includes(merchantId), false);
  assert.match(providers.json()[0].config.merchantIdMasked, /^me\*+01$/);

  const order = await app.inject({
    method: "POST",
    url: "/api/v1/portal/test-product/orders",
    headers: { cookie: portalCookie },
    payload: { planId },
  });
  assert.equal(order.statusCode, 201, order.body);
  epayOrderId = order.json().id;
  epayOrderNo = order.json().orderNo;
  assert.equal(order.json().provider, "epay");
  const checkout = new URL(order.json().checkoutUrl);
  assert.equal(checkout.origin, "https://pay.example.test");
  assert.equal(checkout.pathname, "/api/submit.php");
  assert.equal(checkout.searchParams.get("out_trade_no"), epayOrderNo);
  assert.equal(checkout.searchParams.get("notify_url"), "http://127.0.0.1:8790/api/v1/payments/epay/notify");
  assert.equal(verifyEpaySignature(Object.fromEntries(checkout.searchParams), merchantKey), true);
});

test("rejects forged and amount-mismatched ePay notifications", async () => {
  const callback = {
    pid: merchantId,
    trade_no: providerTradeNo,
    out_trade_no: epayOrderNo,
    type: "alipay",
    name: "1000 点充值包",
    money: "9.90",
    trade_status: "TRADE_SUCCESS",
    sign_type: "MD5",
  };
  const forged = await app.inject({
    method: "POST",
    url: "/api/v1/payments/epay/notify",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ ...callback, sign: "0".repeat(32) }).toString(),
  });
  assert.equal(forged.statusCode, 200);
  assert.equal(forged.body, "fail");

  const wrongAmount = { ...callback, money: "0.01" };
  const mismatched = await app.inject({
    method: "POST",
    url: "/api/v1/payments/epay/notify",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ ...wrongAmount, sign: signEpay(wrongAmount, merchantKey) }).toString(),
  });
  assert.equal(mismatched.statusCode, 200);
  assert.equal(mismatched.body, "fail");
  const wallet = await db.query<{ available: string }>("SELECT available FROM wallets WHERE application_id = $1 AND user_id = (SELECT id FROM users WHERE email = 'portal@example.test')", [applicationId]);
  assert.equal(Number(wallet.rows[0]!.available), 1000);
});

test("credits a valid ePay notification once and accepts an exact retry", async () => {
  const callback = {
    pid: merchantId,
    trade_no: providerTradeNo,
    out_trade_no: epayOrderNo,
    type: "alipay",
    name: "1000 点充值包",
    money: "9.90",
    trade_status: "TRADE_SUCCESS",
    sign_type: "MD5",
  };
  const signed = { ...callback, sign: signEpay(callback, merchantKey) };
  const paid = await app.inject({
    method: "POST",
    url: "/api/v1/payments/epay/notify",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(signed).toString(),
  });
  assert.equal(paid.statusCode, 200);
  assert.equal(paid.body, "success");

  const retried = await app.inject({
    method: "GET",
    url: `/api/v1/payments/epay/notify?${new URLSearchParams(signed).toString()}`,
  });
  assert.equal(retried.statusCode, 200);
  assert.equal(retried.body, "success");

  const order = await db.query<{ status: string; provider_trade_no: string }>("SELECT status, provider_trade_no FROM recharge_orders WHERE id = $1", [epayOrderId]);
  assert.equal(order.rows[0]!.status, "paid");
  assert.equal(order.rows[0]!.provider_trade_no, providerTradeNo);
  const wallet = await db.query<{ available: string }>("SELECT available FROM wallets WHERE application_id = $1 AND user_id = (SELECT id FROM users WHERE email = 'portal@example.test')", [applicationId]);
  assert.equal(Number(wallet.rows[0]!.available), 2000);
  const events = await db.query<{ count: string }>("SELECT COUNT(*) AS count FROM webhook_events WHERE provider = 'epay'");
  assert.equal(Number(events.rows[0]!.count), 1);
  const ledger = await db.query<{ count: string }>("SELECT COUNT(*) AS count FROM ledger_transactions WHERE idempotency_key = $1", [`order:paid:${epayOrderId}`]);
  assert.equal(Number(ledger.rows[0]!.count), 1);
});
