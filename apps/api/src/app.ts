import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { createSession, destroySession, getSessionUser, requireAdmin } from "./auth.js";
import { openDatabase, type Database, type Queryable } from "./database.js";
import { ensureWallet, postLedgerMutation, postLedgerMutationInTransaction } from "./ledger.js";
import { buildEpayCheckoutUrl, parseMoneyToCents, type EpayConfig, verifyEpaySignature } from "./payment.js";
import { decryptSecretJson, encryptSecretJson } from "./secrets.js";
import { hashPassword, randomToken, sha256, verifyPassword } from "./security.js";
import { getServerStatus } from "./server-status.js";

const sourceDir = dirname(fileURLToPath(import.meta.url));
const adminDist = resolve(sourceDir, "../../admin/dist");

const LoginSchema = z.object({
  email: z.email().transform((value) => value.toLowerCase()),
  password: z.string().min(8).max(128),
});
const RegisterSchema = LoginSchema.extend({
  applicationSlug: z.string().min(2).max(64),
  displayName: z.string().trim().min(1).max(80),
});
const ApplicationSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/),
  redirectUris: z.array(z.url().refine((value) => value.startsWith("http://") || value.startsWith("https://"))).max(10).default([]),
});
const ApplicationUpdateSchema = z.object({
  redirectUris: z.array(z.url().refine((value) => value.startsWith("http://") || value.startsWith("https://"))).max(10),
  allowRegistration: z.boolean().default(true),
});
const UserSchema = LoginSchema.extend({
  applicationId: z.string().min(1),
  displayName: z.string().trim().min(1).max(80),
  initialCredits: z.number().int().min(0).max(100_000_000).default(0),
});
const PlanSchema = z.object({
  applicationId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  code: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{1,48}$/),
  priceCents: z.number().int().min(0).max(100_000_000),
  currency: z.string().length(3).transform((value) => value.toUpperCase()),
  includedCredits: z.number().int().positive().max(100_000_000),
  validityDays: z.number().int().min(0).max(3650),
});
const AdjustmentSchema = z.object({
  delta: z.number().int().refine((value) => value !== 0 && Math.abs(value) <= 100_000_000),
  note: z.string().trim().min(2).max(200),
});
const OrderSchema = z.object({
  applicationId: z.string().min(1),
  userId: z.string().min(1),
  planId: z.string().min(1),
});
const UsageSchema = z.object({
  userId: z.string().min(1),
  amount: z.number().int().positive().max(100_000_000),
  idempotencyKey: z.string().min(8).max(160),
  externalReference: z.string().max(160).optional(),
});
const HttpUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (url.protocol === "http:" || url.protocol === "https:")
    && !url.username && !url.password && !url.search && !url.hash;
}, "必须是无凭据、查询参数和片段的 HTTP(S) 地址");
const PaymentProviderCreateSchema = z.object({
  applicationId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  gatewayUrl: HttpUrlSchema,
  merchantId: z.string().trim().min(1).max(128),
  merchantKey: z.string().min(1).max(256),
  paymentType: z.enum(["alipay", "wxpay"]),
  status: z.enum(["active", "disabled"]).default("active"),
});
const PaymentProviderUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  gatewayUrl: HttpUrlSchema.optional(),
  merchantId: z.string().trim().min(1).max(128).optional(),
  merchantKey: z.string().min(1).max(256).optional(),
  paymentType: z.enum(["alipay", "wxpay"]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
}).refine((value) => Object.keys(value).length > 0, "至少提交一项配置");
const EpayCallbackSchema = z.object({
  pid: z.string().min(1),
  trade_no: z.string().min(1).max(160),
  out_trade_no: z.string().min(1).max(160),
  type: z.string().min(1),
  money: z.string().min(1),
  trade_status: z.string().min(1),
  sign: z.string().length(32),
  sign_type: z.string().optional(),
});

interface BuildOptions {
  database?: Database;
  databasePath?: string;
  seed?: boolean;
  serveAdmin?: boolean;
  logger?: boolean;
}

function failValidation(reply: FastifyReply, result: z.ZodError): FastifyReply {
  return reply.code(400).send({ error: "提交的数据不完整", issues: result.issues });
}

function numeric(value: unknown): number {
  return Number(value ?? 0);
}

function redirectUris(application: { redirect_uris: string }): string[] {
  try {
    const parsed = JSON.parse(application.redirect_uris);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function isAllowedRedirect(application: { redirect_uris: string }, redirectUri: string): boolean {
  return redirectUris(application).includes(redirectUri);
}

async function audit(
  db: Queryable,
  actorUserId: string | null,
  action: string,
  targetType: string,
  targetId: string,
  applicationId?: string | null,
  metadata?: unknown,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (id, actor_user_id, application_id, action, target_type, target_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), actorUserId, applicationId ?? null, action, targetType, targetId, metadata ? JSON.stringify(metadata) : null],
  );
}

function maskMerchantId(value: string): string {
  if (value.length <= 4) return "*".repeat(value.length);
  return `${value.slice(0, 2)}${"*".repeat(Math.min(8, value.length - 4))}${value.slice(-2)}`;
}

function paymentConfigSummary(config: EpayConfig): string {
  return JSON.stringify({
    gatewayUrl: config.gatewayUrl,
    merchantIdMasked: maskMerchantId(config.merchantId),
    paymentType: config.paymentType,
  });
}

function publicBaseUrl(): string {
  return (process.env.PUBLIC_URL ?? process.env.APP_ORIGIN ?? "http://127.0.0.1:8790").replace(/\/+$/, "");
}

function paymentUrls(applicationSlug: string, orderNo: string): { notifyUrl: string; returnUrl: string } {
  const baseUrl = publicBaseUrl();
  const returnUrl = new URL("/portal", `${baseUrl}/`);
  returnUrl.searchParams.set("app", applicationSlug);
  returnUrl.searchParams.set("payment", "returned");
  returnUrl.searchParams.set("order", orderNo);
  return {
    notifyUrl: new URL("/api/v1/payments/epay/notify", `${baseUrl}/`).toString(),
    returnUrl: returnUrl.toString(),
  };
}

function requestParameters(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => typeof item === "string" || typeof item === "number"),
  );
}

async function requireApiApplication(db: Database, request: FastifyRequest, reply: FastifyReply) {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    reply.code(401).send({ error: "缺少应用密钥" });
    return null;
  }
  const keyHash = sha256(authorization.slice(7));
  const result = await db.query<{ id: string; name: string; slug: string }>(
    `SELECT a.id, a.name, a.slug
     FROM application_api_keys k JOIN applications a ON a.id = k.application_id
     WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND a.status = 'active'`,
    [keyHash],
  );
  if (!result.rows[0]) {
    reply.code(401).send({ error: "应用密钥无效" });
    return null;
  }
  await db.query("UPDATE application_api_keys SET last_used_at = NOW() WHERE key_hash = $1", [keyHash]);
  return result.rows[0];
}

export async function buildApp(options: BuildOptions = {}): Promise<FastifyInstance> {
  const ownsDatabase = !options.database;
  const db = options.database ?? await openDatabase({ path: options.databasePath, seed: options.seed });
  const app = Fastify({ logger: options.logger ?? false });

  await app.register(cookie);
  await app.register(formbody);
  await app.register(cors, {
    origin: process.env.NODE_ENV === "production" ? (process.env.APP_ORIGIN ?? false) : true,
    credentials: true,
  });
  await app.register(rateLimit, { global: false });

  app.get("/api/health", async () => ({ status: "ok", service: "account-hub", time: new Date().toISOString() }));

  app.post("/api/v1/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsed = LoginSchema.safeParse(request.body);
    if (!parsed.success) return failValidation(reply, parsed.error);
    const result = await db.query<{
      id: string;
      password_hash: string;
      status: string;
    }>("SELECT id, password_hash, status FROM users WHERE email = $1", [parsed.data.email]);
    const user = result.rows[0];
    if (!user || !await verifyPassword(parsed.data.password, user.password_hash)) {
      return reply.code(401).send({ error: "邮箱或密码错误" });
    }
    if (user.status !== "active") return reply.code(403).send({ error: "账号已停用" });
    await createSession(db, user.id, reply);
    await audit(db, user.id, "auth.login", "user", user.id);
    return { ok: true };
  });

  app.post("/api/v1/auth/register", { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } }, async (request, reply) => {
    const parsed = RegisterSchema.safeParse(request.body);
    if (!parsed.success) return failValidation(reply, parsed.error);
    const application = await db.query<{ id: string }>(
      "SELECT id FROM applications WHERE slug = $1 AND status = 'active'",
      [parsed.data.applicationSlug],
    );
    if (!application.rows[0]) return reply.code(404).send({ error: "应用不存在" });
    const exists = await db.query("SELECT id FROM users WHERE email = $1", [parsed.data.email]);
    if (exists.rows[0]) return reply.code(409).send({ error: "该邮箱已注册" });
    const userId = randomUUID();
    const passwordHash = await hashPassword(parsed.data.password);
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO users (id, email, password_hash, display_name)
         VALUES ($1, $2, $3, $4)`,
        [userId, parsed.data.email, passwordHash, parsed.data.displayName],
      );
      await tx.query(
        `INSERT INTO app_memberships (id, application_id, user_id)
         VALUES ($1, $2, $3)`,
        [randomUUID(), application.rows[0]!.id, userId],
      );
      await ensureWallet(tx, application.rows[0]!.id, userId);
    });
    await createSession(db, userId, reply);
    await audit(db, userId, "auth.register", "user", userId, application.rows[0].id);
    return reply.code(201).send({ id: userId });
  });

  app.get("/api/v1/auth/me", async (request, reply) => {
    const user = await getSessionUser(db, request);
    if (!user) return reply.code(401).send({ error: "请先登录" });
    const memberships = await db.query(
      `SELECT a.id AS application_id, a.name AS application_name, a.slug, m.role,
              COALESCE(w.available, 0) AS available, COALESCE(w.frozen, 0) AS frozen
       FROM app_memberships m
       JOIN applications a ON a.id = m.application_id
       LEFT JOIN wallets w ON w.application_id = a.id AND w.user_id = m.user_id
       WHERE m.user_id = $1 ORDER BY a.created_at`,
      [user.id],
    );
    return { user, memberships: memberships.rows };
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    await destroySession(db, request, reply);
    return { ok: true };
  });

  app.get("/api/v1/connect/context", async (request, reply) => {
    const query = z.object({ app: z.string().min(1), redirect_uri: z.url() }).safeParse(request.query);
    if (!query.success) return failValidation(reply, query.error);
    const result = await db.query<{
      id: string;
      name: string;
      slug: string;
      redirect_uris: string;
      allow_registration: boolean;
    }>("SELECT id, name, slug, redirect_uris, allow_registration FROM applications WHERE slug = $1 AND status = 'active'", [query.data.app]);
    const application = result.rows[0];
    if (!application || !isAllowedRedirect(application, query.data.redirect_uri)) {
      return reply.code(400).send({ error: "应用或回调地址无效" });
    }
    const user = await getSessionUser(db, request);
    let membership = false;
    if (user) {
      const member = await db.query(
        "SELECT id FROM app_memberships WHERE application_id = $1 AND user_id = $2",
        [application.id, user.id],
      );
      membership = Boolean(member.rows[0]);
    }
    return {
      application: { id: application.id, name: application.name, slug: application.slug, allowRegistration: application.allow_registration },
      user,
      membership,
    };
  });

  app.post("/api/v1/connect/authorize", async (request, reply) => {
    const user = await getSessionUser(db, request);
    if (!user) return reply.code(401).send({ error: "请先登录" });
    const body = z.object({
      app: z.string().min(1),
      redirectUri: z.url(),
      state: z.string().min(16).max(256),
    }).safeParse(request.body);
    if (!body.success) return failValidation(reply, body.error);
    const result = await db.query<{
      id: string;
      name: string;
      slug: string;
      redirect_uris: string;
      allow_registration: boolean;
    }>("SELECT id, name, slug, redirect_uris, allow_registration FROM applications WHERE slug = $1 AND status = 'active'", [body.data.app]);
    const application = result.rows[0];
    if (!application || !isAllowedRedirect(application, body.data.redirectUri)) {
      return reply.code(400).send({ error: "应用或回调地址无效" });
    }
    const member = await db.query(
      "SELECT id FROM app_memberships WHERE application_id = $1 AND user_id = $2",
      [application.id, user.id],
    );
    if (!member.rows[0]) {
      if (!application.allow_registration && user.systemRole !== "admin") {
        return reply.code(403).send({ error: "该应用不允许自主加入" });
      }
      await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO app_memberships (id, application_id, user_id, role)
           VALUES ($1, $2, $3, $4) ON CONFLICT (application_id, user_id) DO NOTHING`,
          [randomUUID(), application.id, user.id, user.systemRole === "admin" ? "owner" : "member"],
        );
        await ensureWallet(tx, application.id, user.id);
      });
    }
    const rawCode = randomToken(32);
    const codeId = randomUUID();
    await db.query(
      `INSERT INTO authorization_codes
       (id, application_id, user_id, code_hash, redirect_uri, expires_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '5 minutes')`,
      [codeId, application.id, user.id, sha256(rawCode), body.data.redirectUri],
    );
    const destination = new URL(body.data.redirectUri);
    destination.searchParams.set("code", rawCode);
    destination.searchParams.set("state", body.data.state);
    await audit(db, user.id, "connect.authorize", "application", application.id, application.id);
    return { redirectUrl: destination.toString() };
  });

  app.get("/api/v1/portal/:slug/context", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const application = await db.query<{ id: string; name: string; slug: string }>(
      "SELECT id, name, slug FROM applications WHERE slug = $1 AND status = 'active'",
      [slug],
    );
    if (!application.rows[0]) return reply.code(404).send({ error: "应用不存在" });
    const plans = await db.query(
      `SELECT id, name, code, price_cents, currency, included_credits, validity_days
       FROM plans WHERE application_id = $1 AND status = 'active' ORDER BY price_cents`,
      [application.rows[0].id],
    );
    return { application: application.rows[0], plans: plans.rows };
  });

  app.get("/api/v1/portal/:slug/account", async (request, reply) => {
    const user = await getSessionUser(db, request);
    if (!user) return reply.code(401).send({ error: "请先登录" });
    const { slug } = request.params as { slug: string };
    const membership = await db.query<{
      application_id: string;
      application_name: string;
      wallet_id: string;
      available: string | number;
      frozen: string | number;
    }>(
      `SELECT a.id AS application_id, a.name AS application_name, w.id AS wallet_id, w.available, w.frozen
       FROM app_memberships m
       JOIN applications a ON a.id = m.application_id
       JOIN wallets w ON w.application_id = a.id AND w.user_id = m.user_id
       WHERE m.user_id = $1 AND a.slug = $2 AND a.status = 'active'`,
      [user.id, slug],
    );
    if (!membership.rows[0]) return reply.code(403).send({ error: "账号未加入该应用" });
    const orders = await db.query(
      `SELECT o.id, o.order_no, o.provider, o.amount_cents, o.currency, o.credits, o.status, o.created_at, p.name AS plan_name
       FROM recharge_orders o LEFT JOIN plans p ON p.id = o.plan_id
       WHERE o.application_id = $1 AND o.user_id = $2 ORDER BY o.created_at DESC LIMIT 50`,
      [membership.rows[0].application_id, user.id],
    );
    return { user, account: membership.rows[0], orders: orders.rows };
  });

  app.post("/api/v1/portal/:slug/orders", async (request, reply) => {
    const user = await getSessionUser(db, request);
    if (!user) return reply.code(401).send({ error: "请先登录" });
    const { slug } = request.params as { slug: string };
    const body = z.object({ planId: z.string().min(1) }).safeParse(request.body);
    if (!body.success) return failValidation(reply, body.error);
    const application = await db.query<{ id: string }>(
      `SELECT a.id FROM applications a JOIN app_memberships m ON m.application_id = a.id
       WHERE a.slug = $1 AND a.status = 'active' AND m.user_id = $2`,
      [slug, user.id],
    );
    if (!application.rows[0]) return reply.code(403).send({ error: "账号未加入该应用" });
    const plan = await db.query<{ price_cents: number; currency: string; included_credits: string | number; name: string }>(
      "SELECT price_cents, currency, included_credits, name FROM plans WHERE id = $1 AND application_id = $2 AND status = 'active'",
      [body.data.planId, application.rows[0].id],
    );
    if (!plan.rows[0]) return reply.code(404).send({ error: "套餐不存在" });
    const providerResult = await db.query<{ id: string; encrypted_config: string }>(
      `SELECT id, encrypted_config FROM payment_provider_instances
       WHERE application_id = $1 AND status = 'active' ORDER BY updated_at DESC LIMIT 1`,
      [application.rows[0].id],
    );
    const provider = providerResult.rows[0];
    if (!provider && process.env.NODE_ENV === "production") {
      return reply.code(503).send({ error: "该应用尚未配置可用支付渠道" });
    }
    if (provider && (plan.rows[0].currency !== "CNY" || plan.rows[0].price_cents <= 0)) {
      return reply.code(400).send({ error: "易支付仅支持金额大于 0 的人民币套餐" });
    }
    const id = randomUUID();
    const orderNo = `AH${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}${randomToken(4).toUpperCase()}`;
    let checkoutUrl: string | undefined;
    if (provider) {
      const config = await decryptSecretJson<EpayConfig>(provider.encrypted_config);
      checkoutUrl = buildEpayCheckoutUrl(config, {
        orderNo,
        amountCents: plan.rows[0].price_cents,
        name: plan.rows[0].name,
      }, paymentUrls(slug, orderNo));
    }
    await db.query(
      `INSERT INTO recharge_orders
       (id, order_no, application_id, user_id, plan_id, provider_instance_id, provider_config_snapshot,
        provider, amount_cents, currency, credits)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        orderNo,
        application.rows[0].id,
        user.id,
        body.data.planId,
        provider?.id ?? null,
        provider?.encrypted_config ?? null,
        provider ? "epay" : "mock",
        plan.rows[0].price_cents,
        plan.rows[0].currency,
        plan.rows[0].included_credits,
      ],
    );
    await audit(db, user.id, "portal.order.create", "recharge_order", id, application.rows[0].id);
    return reply.code(201).send({ id, orderNo, provider: provider ? "epay" : "mock", checkoutUrl });
  });

  app.post("/api/v1/portal/:slug/orders/:id/checkout", async (request, reply) => {
    const user = await getSessionUser(db, request);
    if (!user) return reply.code(401).send({ error: "请先登录" });
    const { slug, id } = request.params as { slug: string; id: string };
    const result = await db.query<{
      order_no: string;
      provider: string;
      status: string;
      amount_cents: number;
      currency: string;
      plan_name: string;
      encrypted_config: string | null;
    }>(
      `SELECT o.order_no, o.provider, o.status, o.amount_cents, o.currency,
              COALESCE(p.name, '账户额度充值') AS plan_name,
              COALESCE(o.provider_config_snapshot, i.encrypted_config) AS encrypted_config
       FROM recharge_orders o
       JOIN applications a ON a.id = o.application_id
       LEFT JOIN plans p ON p.id = o.plan_id
       LEFT JOIN payment_provider_instances i ON i.id = o.provider_instance_id
       WHERE o.id = $1 AND o.user_id = $2 AND a.slug = $3`,
      [id, user.id, slug],
    );
    const order = result.rows[0];
    if (!order) return reply.code(404).send({ error: "订单不存在" });
    if (order.status !== "pending") return reply.code(409).send({ error: "当前订单不能继续支付" });
    if (order.provider !== "epay" || !order.encrypted_config) {
      return reply.code(409).send({ error: "该订单不是在线支付订单" });
    }
    const config = await decryptSecretJson<EpayConfig>(order.encrypted_config);
    return {
      checkoutUrl: buildEpayCheckoutUrl(config, {
        orderNo: order.order_no,
        amountCents: order.amount_cents,
        name: order.plan_name,
      }, paymentUrls(slug, order.order_no)),
    };
  });

  app.post("/api/v1/portal/:slug/orders/:id/mock-pay", async (request, reply) => {
    const user = await getSessionUser(db, request);
    if (!user) return reply.code(401).send({ error: "请先登录" });
    if (process.env.NODE_ENV === "production") return reply.code(403).send({ error: "生产环境禁用模拟支付" });
    const { slug, id } = request.params as { slug: string; id: string };
    const result = await db.query<{
      status: string;
      application_id: string;
      user_id: string;
      credits: string | number;
    }>(
      `SELECT o.status, o.application_id, o.user_id, o.credits
       FROM recharge_orders o JOIN applications a ON a.id = o.application_id
       WHERE o.id = $1 AND o.user_id = $2 AND a.slug = $3 AND o.provider = 'mock'`,
      [id, user.id, slug],
    );
    const order = result.rows[0];
    if (!order) return reply.code(404).send({ error: "订单不存在" });
    if (order.status === "paid") return { ok: true, alreadyPaid: true };
    if (order.status !== "pending") return reply.code(409).send({ error: "当前订单不能支付" });
    const balance = await postLedgerMutation(db, {
      applicationId: order.application_id,
      userId: user.id,
      type: "credit",
      amount: Number(order.credits),
      idempotencyKey: `order:paid:${id}`,
      referenceType: "recharge_order",
      referenceId: id,
      note: "充值到账",
    });
    await db.query("UPDATE recharge_orders SET status = 'paid', paid_at = NOW(), updated_at = NOW() WHERE id = $1", [id]);
    await db.query(
      `INSERT INTO webhook_events (id, provider, external_event_id, payload, status, processed_at)
       VALUES ($1, 'mock', $2, $3, 'processed', NOW()) ON CONFLICT (provider, external_event_id) DO NOTHING`,
      [randomUUID(), `mock:${id}`, JSON.stringify({ orderId: id, actor: user.id })],
    );
    await audit(db, user.id, "portal.order.mock_paid", "recharge_order", id, order.application_id);
    return { ok: true, balance };
  });

  async function handleEpayNotification(request: FastifyRequest, reply: FastifyReply) {
    const parameters = requestParameters(request.method === "GET" ? request.query : request.body);
    const callback = EpayCallbackSchema.safeParse(parameters);
    const fail = () => reply.type("text/plain; charset=utf-8").send("fail");
    if (!callback.success) return fail();
    if (callback.data.sign_type && callback.data.sign_type.toUpperCase() !== "MD5") return fail();

    const result = await db.query<{
      id: string;
      provider_instance_id: string;
      application_id: string;
      user_id: string;
      amount_cents: number;
      credits: string | number;
      status: string;
      encrypted_config: string;
    }>(
      `SELECT o.id, o.provider_instance_id, o.application_id, o.user_id, o.amount_cents,
              o.credits, o.status, COALESCE(o.provider_config_snapshot, i.encrypted_config) AS encrypted_config
       FROM recharge_orders o
       JOIN payment_provider_instances i ON i.id = o.provider_instance_id
       WHERE o.order_no = $1 AND o.provider = 'epay'`,
      [callback.data.out_trade_no],
    );
    const order = result.rows[0];
    if (!order) return fail();

    try {
      const config = await decryptSecretJson<EpayConfig>(order.encrypted_config);
      const receivedCents = parseMoneyToCents(callback.data.money);
      if (
        callback.data.pid !== config.merchantId
        || callback.data.type !== config.paymentType
        || callback.data.trade_status !== "TRADE_SUCCESS"
        || receivedCents !== Number(order.amount_cents)
        || !verifyEpaySignature(parameters, config.merchantKey)
      ) {
        return fail();
      }

      const processed = await db.transaction(async (tx) => {
        const locked = await tx.query<{
          status: string;
          provider_trade_no: string | null;
          application_id: string;
          user_id: string;
          credits: string | number;
        }>("SELECT status, provider_trade_no, application_id, user_id, credits FROM recharge_orders WHERE id = $1 FOR UPDATE", [order.id]);
        const current = locked.rows[0];
        if (!current) return false;
        const eventId = `${order.provider_instance_id}:${callback.data.trade_no}`;
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO webhook_events (id, provider, external_event_id, payload, status)
           VALUES ($1, 'epay', $2, $3, 'received')
           ON CONFLICT (provider, external_event_id) DO NOTHING RETURNING id`,
          [randomUUID(), eventId, JSON.stringify(parameters)],
        );
        if (!inserted.rows[0]) {
          return current.status === "paid" && current.provider_trade_no === callback.data.trade_no;
        }
        if (current.status === "paid") {
          return current.provider_trade_no === callback.data.trade_no;
        }
        if (current.status !== "pending") return false;

        await postLedgerMutationInTransaction(tx, {
          applicationId: current.application_id,
          userId: current.user_id,
          type: "credit",
          amount: Number(current.credits),
          idempotencyKey: `order:paid:${order.id}`,
          referenceType: "recharge_order",
          referenceId: order.id,
          note: "易支付充值到账",
        });
        await tx.query(
          `UPDATE recharge_orders SET status = 'paid', provider_trade_no = $1,
           paid_at = NOW(), updated_at = NOW() WHERE id = $2`,
          [callback.data.trade_no, order.id],
        );
        await tx.query(
          "UPDATE webhook_events SET status = 'processed', processed_at = NOW() WHERE provider = 'epay' AND external_event_id = $1",
          [eventId],
        );
        await audit(tx, null, "payment.epay.paid", "recharge_order", order.id, current.application_id, {
          providerTradeNo: callback.data.trade_no,
        });
        return true;
      });
      return reply.type("text/plain; charset=utf-8").send(processed ? "success" : "fail");
    } catch (error) {
      request.log.warn({ err: error, orderId: order.id }, "Failed to process ePay notification");
      return fail();
    }
  }

  app.get("/api/v1/payments/epay/notify", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, handleEpayNotification);
  app.post("/api/v1/payments/epay/notify", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, handleEpayNotification);

  app.get("/api/v1/admin/overview", async (request, reply) => {
    if (!await requireAdmin(db, request, reply)) return;
    const result = await db.query<Record<string, unknown>>(`
      SELECT
        (SELECT COUNT(*) FROM applications WHERE status = 'active') AS applications,
        (SELECT COUNT(*) FROM users WHERE system_role = 'user') AS users,
        (SELECT COALESCE(SUM(available), 0) FROM wallets) AS available_credits,
        (SELECT COALESCE(SUM(frozen), 0) FROM wallets) AS frozen_credits,
        (SELECT COUNT(*) FROM recharge_orders WHERE status = 'paid') AS paid_orders,
        (SELECT COALESCE(SUM(amount_cents), 0) FROM recharge_orders WHERE status = 'paid') AS revenue_cents
    `);
    const row = result.rows[0]!;
    return {
      applications: numeric(row.applications),
      users: numeric(row.users),
      availableCredits: numeric(row.available_credits),
      frozenCredits: numeric(row.frozen_credits),
      paidOrders: numeric(row.paid_orders),
      revenueCents: numeric(row.revenue_cents),
    };
  });

  app.get("/api/v1/admin/server-status", async (request, reply) => {
    if (!await requireAdmin(db, request, reply)) return;
    return getServerStatus();
  });

  app.get("/api/v1/admin/applications", async (request, reply) => {
    if (!await requireAdmin(db, request, reply)) return;
    const result = await db.query(`
      SELECT a.id, a.name, a.slug, a.status, a.redirect_uris, a.allow_registration, a.created_at,
             COUNT(DISTINCT m.user_id) AS user_count,
             COUNT(DISTINCT k.id) FILTER (WHERE k.revoked_at IS NULL) AS active_key_count
      FROM applications a
      LEFT JOIN app_memberships m ON m.application_id = a.id
      LEFT JOIN application_api_keys k ON k.application_id = a.id
      GROUP BY a.id ORDER BY a.created_at DESC
    `);
    return result.rows;
  });

  app.post("/api/v1/admin/applications", async (request, reply) => {
    const admin = await requireAdmin(db, request, reply);
    if (!admin) return;
    const parsed = ApplicationSchema.safeParse(request.body);
    if (!parsed.success) return failValidation(reply, parsed.error);
    const applicationId = randomUUID();
    const rawKey = `ahk_${randomToken(24)}`;
    try {
      await db.transaction(async (tx) => {
        await tx.query("INSERT INTO applications (id, name, slug, redirect_uris) VALUES ($1, $2, $3, $4)", [applicationId, parsed.data.name, parsed.data.slug, JSON.stringify(parsed.data.redirectUris)]);
        await tx.query(
          `INSERT INTO application_api_keys (id, application_id, name, key_prefix, key_hash)
           VALUES ($1, $2, '默认密钥', $3, $4)`,
          [randomUUID(), applicationId, rawKey.slice(0, 10), sha256(rawKey)],
        );
        await tx.query(
          `INSERT INTO ledger_accounts (id, application_id, code, name)
           VALUES ($1, $2, 'system:issuance', '额度发行'), ($3, $2, 'system:consumed', '已消费额度')`,
          [randomUUID(), applicationId, randomUUID()],
        );
      });
    } catch (error) {
      if (String(error).includes("unique")) return reply.code(409).send({ error: "应用标识已存在" });
      throw error;
    }
    await audit(db, admin.id, "application.create", "application", applicationId, applicationId);
    return reply.code(201).send({ id: applicationId, apiKey: rawKey });
  });

  app.patch("/api/v1/admin/applications/:id", async (request, reply) => {
    const admin = await requireAdmin(db, request, reply);
    if (!admin) return;
    const parsed = ApplicationUpdateSchema.safeParse(request.body);
    if (!parsed.success) return failValidation(reply, parsed.error);
    const { id } = request.params as { id: string };
    const result = await db.query(
      `UPDATE applications SET redirect_uris = $1, allow_registration = $2
       WHERE id = $3 RETURNING id`,
      [JSON.stringify(parsed.data.redirectUris), parsed.data.allowRegistration, id],
    );
    if (!result.rows[0]) return reply.code(404).send({ error: "应用不存在" });
    await audit(db, admin.id, "application.update", "application", id, id, parsed.data);
    return { ok: true };
  });

  app.post("/api/v1/admin/applications/:id/keys", async (request, reply) => {
    const admin = await requireAdmin(db, request, reply);
    if (!admin) return;
    const { id } = request.params as { id: string };
    const exists = await db.query("SELECT id FROM applications WHERE id = $1", [id]);
    if (!exists.rows[0]) return reply.code(404).send({ error: "应用不存在" });
    const rawKey = `ahk_${randomToken(24)}`;
    await db.query(
      `INSERT INTO application_api_keys (id, application_id, name, key_prefix, key_hash)
       VALUES ($1, $2, '新建密钥', $3, $4)`,
      [randomUUID(), id, rawKey.slice(0, 10), sha256(rawKey)],
    );
    await audit(db, admin.id, "application.key.create", "application", id, id);
    return reply.code(201).send({ apiKey: rawKey });
  });

  app.get("/api/v1/admin/payment-providers", async (request, reply) => {
    if (!await requireAdmin(db, request, reply)) return;
    const { applicationId } = request.query as { applicationId?: string };
    const result = await db.query<{
      id: string;
      application_id: string;
      provider: string;
      name: string;
      status: string;
      config_summary: string;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, application_id, provider, name, status, config_summary, created_at, updated_at
       FROM payment_provider_instances
       WHERE ($1::TEXT IS NULL OR application_id = $1)
       ORDER BY updated_at DESC`,
      [applicationId ?? null],
    );
    return result.rows.map(({ config_summary: summary, ...row }) => {
      try {
        return { ...row, config: JSON.parse(summary) as unknown };
      } catch {
        return { ...row, config: {} };
      }
    });
  });

  app.post("/api/v1/admin/payment-providers", async (request, reply) => {
    const admin = await requireAdmin(db, request, reply);
    if (!admin) return;
    const parsed = PaymentProviderCreateSchema.safeParse(request.body);
    if (!parsed.success) return failValidation(reply, parsed.error);
    const application = await db.query("SELECT id FROM applications WHERE id = $1", [parsed.data.applicationId]);
    if (!application.rows[0]) return reply.code(404).send({ error: "应用不存在" });
    const id = randomUUID();
    const config: EpayConfig = {
      gatewayUrl: parsed.data.gatewayUrl,
      merchantId: parsed.data.merchantId,
      merchantKey: parsed.data.merchantKey,
      paymentType: parsed.data.paymentType,
    };
    const encryptedConfig = await encryptSecretJson(config);
    await db.transaction(async (tx) => {
      if (parsed.data.status === "active") {
        await tx.query(
          "UPDATE payment_provider_instances SET status = 'disabled', updated_at = NOW() WHERE application_id = $1 AND status = 'active'",
          [parsed.data.applicationId],
        );
      }
      await tx.query(
        `INSERT INTO payment_provider_instances
         (id, application_id, provider, name, status, encrypted_config, config_summary)
         VALUES ($1, $2, 'epay', $3, $4, $5, $6)`,
        [id, parsed.data.applicationId, parsed.data.name, parsed.data.status, encryptedConfig, paymentConfigSummary(config)],
      );
    });
    await audit(db, admin.id, "payment_provider.create", "payment_provider", id, parsed.data.applicationId, {
      provider: "epay",
      name: parsed.data.name,
      status: parsed.data.status,
    });
    return reply.code(201).send({ id });
  });

  app.patch("/api/v1/admin/payment-providers/:id", async (request, reply) => {
    const admin = await requireAdmin(db, request, reply);
    if (!admin) return;
    const parsed = PaymentProviderUpdateSchema.safeParse(request.body);
    if (!parsed.success) return failValidation(reply, parsed.error);
    const { id } = request.params as { id: string };
    const result = await db.query<{
      application_id: string;
      name: string;
      status: "active" | "disabled";
      encrypted_config: string;
    }>("SELECT application_id, name, status, encrypted_config FROM payment_provider_instances WHERE id = $1", [id]);
    const current = result.rows[0];
    if (!current) return reply.code(404).send({ error: "支付渠道不存在" });
    const currentConfig = await decryptSecretJson<EpayConfig>(current.encrypted_config);
    const config: EpayConfig = {
      gatewayUrl: parsed.data.gatewayUrl ?? currentConfig.gatewayUrl,
      merchantId: parsed.data.merchantId ?? currentConfig.merchantId,
      merchantKey: parsed.data.merchantKey ?? currentConfig.merchantKey,
      paymentType: parsed.data.paymentType ?? currentConfig.paymentType,
    };
    const name = parsed.data.name ?? current.name;
    const status = parsed.data.status ?? current.status;
    const encryptedConfig = await encryptSecretJson(config);
    await db.transaction(async (tx) => {
      if (status === "active") {
        await tx.query(
          "UPDATE payment_provider_instances SET status = 'disabled', updated_at = NOW() WHERE application_id = $1 AND id <> $2 AND status = 'active'",
          [current.application_id, id],
        );
      }
      await tx.query(
        `UPDATE payment_provider_instances SET name = $1, status = $2, encrypted_config = $3,
         config_summary = $4, updated_at = NOW() WHERE id = $5`,
        [name, status, encryptedConfig, paymentConfigSummary(config), id],
      );
    });
    await audit(db, admin.id, "payment_provider.update", "payment_provider", id, current.application_id, {
      name,
      status,
    });
    return { ok: true };
  });

  app.get("/api/v1/admin/users", async (request, reply) => {
    if (!await requireAdmin(db, request, reply)) return;
    const { applicationId } = request.query as { applicationId?: string };
    const result = await db.query(
      `SELECT u.id, u.email, u.display_name, u.status, u.created_at,
              m.application_id, m.role, w.id AS wallet_id,
              COALESCE(w.available, 0) AS available, COALESCE(w.frozen, 0) AS frozen
       FROM app_memberships m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN wallets w ON w.application_id = m.application_id AND w.user_id = u.id
       WHERE ($1::TEXT IS NULL OR m.application_id = $1)
       ORDER BY u.created_at DESC`,
      [applicationId ?? null],
    );
    return result.rows;
  });

  app.post("/api/v1/admin/users", async (request, reply) => {
    const admin = await requireAdmin(db, request, reply);
    if (!admin) return;
    const parsed = UserSchema.safeParse(request.body);
    if (!parsed.success) return failValidation(reply, parsed.error);
    const application = await db.query("SELECT id FROM applications WHERE id = $1", [parsed.data.applicationId]);
    if (!application.rows[0]) return reply.code(404).send({ error: "应用不存在" });
    const exists = await db.query("SELECT id FROM users WHERE email = $1", [parsed.data.email]);
    if (exists.rows[0]) return reply.code(409).send({ error: "该邮箱已注册" });
    const userId = randomUUID();
    const passwordHash = await hashPassword(parsed.data.password);
    let walletId = "";
    await db.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, $3, $4)",
        [userId, parsed.data.email, passwordHash, parsed.data.displayName],
      );
      await tx.query(
        "INSERT INTO app_memberships (id, application_id, user_id) VALUES ($1, $2, $3)",
        [randomUUID(), parsed.data.applicationId, userId],
      );
      walletId = (await ensureWallet(tx, parsed.data.applicationId, userId)).id;
    });
    if (parsed.data.initialCredits > 0) {
      await postLedgerMutation(db, {
        applicationId: parsed.data.applicationId,
        userId,
        type: "credit",
        amount: parsed.data.initialCredits,
        idempotencyKey: `admin:user:create:${userId}`,
        referenceType: "admin_adjustment",
        referenceId: userId,
        note: "开户赠送",
      });
    }
    await audit(db, admin.id, "user.create", "user", userId, parsed.data.applicationId, { walletId });
    return reply.code(201).send({ id: userId, walletId });
  });

  app.post("/api/v1/admin/wallets/:id/adjust", async (request, reply) => {
    const admin = await requireAdmin(db, request, reply);
    if (!admin) return;
    const parsed = AdjustmentSchema.safeParse(request.body);
    if (!parsed.success) return failValidation(reply, parsed.error);
    const { id } = request.params as { id: string };
    const wallet = await db.query<{ application_id: string; user_id: string }>("SELECT application_id, user_id FROM wallets WHERE id = $1", [id]);
    if (!wallet.rows[0]) return reply.code(404).send({ error: "钱包不存在" });
    try {
      const balance = await postLedgerMutation(db, {
        applicationId: wallet.rows[0].application_id,
        userId: wallet.rows[0].user_id,
        type: parsed.data.delta > 0 ? "credit" : "debit",
        amount: Math.abs(parsed.data.delta),
        idempotencyKey: `admin:adjust:${randomUUID()}`,
        referenceType: "admin_adjustment",
        referenceId: admin.id,
        note: parsed.data.note,
      });
      await audit(db, admin.id, "wallet.adjust", "wallet", id, wallet.rows[0].application_id, parsed.data);
      return balance;
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "额度调整失败" });
    }
  });

  app.get("/api/v1/admin/plans", async (request, reply) => {
    if (!await requireAdmin(db, request, reply)) return;
    const { applicationId } = request.query as { applicationId?: string };
    const result = await db.query(
      `SELECT * FROM plans WHERE ($1::TEXT IS NULL OR application_id = $1) ORDER BY created_at DESC`,
      [applicationId ?? null],
    );
    return result.rows;
  });

  app.post("/api/v1/admin/plans", async (request, reply) => {
    const admin = await requireAdmin(db, request, reply);
    if (!admin) return;
    const parsed = PlanSchema.safeParse(request.body);
    if (!parsed.success) return failValidation(reply, parsed.error);
    const id = randomUUID();
    try {
      await db.query(
        `INSERT INTO plans
         (id, application_id, name, code, price_cents, currency, included_credits, validity_days)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, parsed.data.applicationId, parsed.data.name, parsed.data.code, parsed.data.priceCents, parsed.data.currency, parsed.data.includedCredits, parsed.data.validityDays],
      );
    } catch (error) {
      if (String(error).includes("unique")) return reply.code(409).send({ error: "套餐代码已存在" });
      throw error;
    }
    await audit(db, admin.id, "plan.create", "plan", id, parsed.data.applicationId);
    return reply.code(201).send({ id });
  });

  app.get("/api/v1/admin/orders", async (request, reply) => {
    if (!await requireAdmin(db, request, reply)) return;
    const { applicationId } = request.query as { applicationId?: string };
    const result = await db.query(
      `SELECT o.*, u.email, u.display_name, p.name AS plan_name
       FROM recharge_orders o
       JOIN users u ON u.id = o.user_id
       LEFT JOIN plans p ON p.id = o.plan_id
       WHERE ($1::TEXT IS NULL OR o.application_id = $1)
       ORDER BY o.created_at DESC`,
      [applicationId ?? null],
    );
    return result.rows;
  });

  app.post("/api/v1/admin/orders", async (request, reply) => {
    const admin = await requireAdmin(db, request, reply);
    if (!admin) return;
    const parsed = OrderSchema.safeParse(request.body);
    if (!parsed.success) return failValidation(reply, parsed.error);
    const plan = await db.query<{ price_cents: number; currency: string; included_credits: string | number }>(
      "SELECT price_cents, currency, included_credits FROM plans WHERE id = $1 AND application_id = $2 AND status = 'active'",
      [parsed.data.planId, parsed.data.applicationId],
    );
    if (!plan.rows[0]) return reply.code(404).send({ error: "套餐不存在" });
    const member = await db.query(
      "SELECT id FROM app_memberships WHERE application_id = $1 AND user_id = $2",
      [parsed.data.applicationId, parsed.data.userId],
    );
    if (!member.rows[0]) return reply.code(404).send({ error: "用户不属于该应用" });
    const id = randomUUID();
    const orderNo = `AH${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}${randomToken(4).toUpperCase()}`;
    await db.query(
      `INSERT INTO recharge_orders
       (id, order_no, application_id, user_id, plan_id, provider, amount_cents, currency, credits)
       VALUES ($1, $2, $3, $4, $5, 'mock', $6, $7, $8)`,
      [id, orderNo, parsed.data.applicationId, parsed.data.userId, parsed.data.planId, plan.rows[0].price_cents, plan.rows[0].currency, plan.rows[0].included_credits],
    );
    await audit(db, admin.id, "order.create", "recharge_order", id, parsed.data.applicationId);
    return reply.code(201).send({ id, orderNo });
  });

  app.post("/api/v1/admin/orders/:id/mock-pay", async (request, reply) => {
    const admin = await requireAdmin(db, request, reply);
    if (!admin) return;
    if (process.env.NODE_ENV === "production") return reply.code(403).send({ error: "生产环境禁用模拟支付" });
    const { id } = request.params as { id: string };
    const result = await db.query<{
      id: string;
      status: string;
      application_id: string;
      user_id: string;
      credits: string | number;
    }>("SELECT id, status, application_id, user_id, credits FROM recharge_orders WHERE id = $1", [id]);
    const order = result.rows[0];
    if (!order) return reply.code(404).send({ error: "订单不存在" });
    if (order.status === "paid") return { ok: true, alreadyPaid: true };
    if (order.status !== "pending") return reply.code(409).send({ error: "当前订单不能支付" });
    const eventId = `mock:${id}`;
    await db.query(
      `INSERT INTO webhook_events (id, provider, external_event_id, payload, status)
       VALUES ($1, 'mock', $2, $3, 'received') ON CONFLICT (provider, external_event_id) DO NOTHING`,
      [randomUUID(), eventId, JSON.stringify({ orderId: id })],
    );
    const balance = await postLedgerMutation(db, {
      applicationId: order.application_id,
      userId: order.user_id,
      type: "credit",
      amount: Number(order.credits),
      idempotencyKey: `order:paid:${id}`,
      referenceType: "recharge_order",
      referenceId: id,
      note: "充值到账",
    });
    await db.query("UPDATE recharge_orders SET status = 'paid', paid_at = NOW(), updated_at = NOW() WHERE id = $1", [id]);
    await db.query("UPDATE webhook_events SET status = 'processed', processed_at = NOW() WHERE provider = 'mock' AND external_event_id = $1", [eventId]);
    await audit(db, admin.id, "order.mock_paid", "recharge_order", id, order.application_id);
    return { ok: true, balance };
  });

  app.get("/api/v1/admin/ledger", async (request, reply) => {
    if (!await requireAdmin(db, request, reply)) return;
    const { applicationId } = request.query as { applicationId?: string };
    const result = await db.query(
      `SELECT t.id, t.application_id, t.user_id, t.type, t.reference_type, t.reference_id,
              t.note, t.created_at, u.email, u.display_name,
              COALESCE(SUM(e.amount) FILTER (WHERE a.wallet_id IS NOT NULL), 0) AS wallet_delta,
              COALESCE(SUM(e.amount), 0) AS balance_check
       FROM ledger_transactions t
       LEFT JOIN users u ON u.id = t.user_id
       JOIN ledger_entries e ON e.transaction_id = t.id
       JOIN ledger_accounts a ON a.id = e.account_id
       WHERE ($1::TEXT IS NULL OR t.application_id = $1)
       GROUP BY t.id, u.email, u.display_name
       ORDER BY t.created_at DESC LIMIT 200`,
      [applicationId ?? null],
    );
    return result.rows;
  });

  app.get("/api/v1/admin/audit-logs", async (request, reply) => {
    if (!await requireAdmin(db, request, reply)) return;
    const result = await db.query(
      `SELECT l.*, u.email AS actor_email FROM audit_logs l
       LEFT JOIN users u ON u.id = l.actor_user_id
       ORDER BY l.created_at DESC LIMIT 200`,
    );
    return result.rows;
  });

  app.get("/api/sdk/v1/users/:userId/wallet", async (request, reply) => {
    const application = await requireApiApplication(db, request, reply);
    if (!application) return;
    const { userId } = request.params as { userId: string };
    const result = await db.query(
      "SELECT id, available, frozen, updated_at FROM wallets WHERE application_id = $1 AND user_id = $2",
      [application.id, userId],
    );
    if (!result.rows[0]) return reply.code(404).send({ error: "钱包不存在" });
    return result.rows[0];
  });

  app.post("/api/sdk/v1/auth/exchange", async (request, reply) => {
    const application = await requireApiApplication(db, request, reply);
    if (!application) return;
    const body = z.object({ code: z.string().min(20), redirectUri: z.url() }).safeParse(request.body);
    if (!body.success) return failValidation(reply, body.error);
    const codeHash = sha256(body.data.code);
    try {
      const identity = await db.transaction(async (tx) => {
        const result = await tx.query<{
          id: string;
          user_id: string;
          redirect_uri: string;
          email: string;
          display_name: string;
          system_role: string;
          available: string | number;
          frozen: string | number;
        }>(
          `SELECT c.id, c.user_id, c.redirect_uri, u.email, u.display_name, u.system_role,
                  w.available, w.frozen
           FROM authorization_codes c
           JOIN users u ON u.id = c.user_id
           JOIN wallets w ON w.application_id = c.application_id AND w.user_id = c.user_id
           WHERE c.code_hash = $1 AND c.application_id = $2
             AND c.consumed_at IS NULL AND c.expires_at > NOW()
           FOR UPDATE`,
          [codeHash, application.id],
        );
        const row = result.rows[0];
        if (!row || row.redirect_uri !== body.data.redirectUri) return null;
        await tx.query("UPDATE authorization_codes SET consumed_at = NOW() WHERE id = $1", [row.id]);
        return row;
      });
      if (!identity) return reply.code(400).send({ error: "授权码无效或已过期" });
      return {
        user: {
          id: identity.user_id,
          email: identity.email,
          displayName: identity.display_name,
          systemRole: identity.system_role,
        },
        wallet: { available: numeric(identity.available), frozen: numeric(identity.frozen) },
      };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "授权码交换失败" });
    }
  });

  app.post("/api/sdk/v1/usage/reservations", async (request, reply) => {
    const application = await requireApiApplication(db, request, reply);
    if (!application) return;
    const parsed = UsageSchema.safeParse(request.body);
    if (!parsed.success) return failValidation(reply, parsed.error);
    const member = await db.query(
      "SELECT id FROM app_memberships WHERE application_id = $1 AND user_id = $2",
      [application.id, parsed.data.userId],
    );
    if (!member.rows[0]) return reply.code(404).send({ error: "用户不属于该应用" });
    const duplicate = await db.query<{ id: string; status: string }>(
      "SELECT id, status FROM usage_reservations WHERE application_id = $1 AND idempotency_key = $2",
      [application.id, parsed.data.idempotencyKey],
    );
    if (duplicate.rows[0]) return duplicate.rows[0];
    const id = randomUUID();
    try {
      const balance = await postLedgerMutation(db, {
        applicationId: application.id,
        userId: parsed.data.userId,
        type: "reserve",
        amount: parsed.data.amount,
        idempotencyKey: `usage:reserve:${parsed.data.idempotencyKey}`,
        referenceType: "usage_reservation",
        referenceId: id,
        note: parsed.data.externalReference,
      });
      await db.query(
        `INSERT INTO usage_reservations
         (id, application_id, user_id, amount, idempotency_key, external_reference)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, application.id, parsed.data.userId, parsed.data.amount, parsed.data.idempotencyKey, parsed.data.externalReference ?? null],
      );
      return reply.code(201).send({ id, status: "reserved", balance });
    } catch (error) {
      if (String(error).toLowerCase().includes("unique")) {
        const raced = await db.query<{ id: string; status: string }>(
          "SELECT id, status FROM usage_reservations WHERE application_id = $1 AND idempotency_key = $2",
          [application.id, parsed.data.idempotencyKey],
        );
        if (raced.rows[0]) return raced.rows[0];
      }
      return reply.code(409).send({ error: error instanceof Error ? error.message : "额度冻结失败" });
    }
  });

  async function finishReservation(request: FastifyRequest, reply: FastifyReply, target: "captured" | "released") {
    const application = await requireApiApplication(db, request, reply);
    if (!application) return;
    const { id } = request.params as { id: string };
    const result = await db.query<{
      id: string;
      application_id: string;
      user_id: string;
      amount: string | number;
      status: "reserved" | "captured" | "released";
    }>("SELECT * FROM usage_reservations WHERE id = $1 AND application_id = $2", [id, application.id]);
    const reservation = result.rows[0];
    if (!reservation) return reply.code(404).send({ error: "预扣记录不存在" });
    if (reservation.status === target) return { id, status: target, idempotent: true };
    if (reservation.status !== "reserved") return reply.code(409).send({ error: "预扣记录已完成，不能重复变更" });
    try {
      const balance = await postLedgerMutation(db, {
        applicationId: application.id,
        userId: reservation.user_id,
        type: target === "captured" ? "capture" : "release",
        amount: Number(reservation.amount),
        idempotencyKey: `usage:${target}:${id}`,
        referenceType: "usage_reservation",
        referenceId: id,
      });
      await db.query("UPDATE usage_reservations SET status = $1, updated_at = NOW() WHERE id = $2", [target, id]);
      return { id, status: target, balance };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "预扣记录处理失败" });
    }
  }

  app.post("/api/sdk/v1/usage/reservations/:id/capture", (request, reply) => finishReservation(request, reply, "captured"));
  app.post("/api/sdk/v1/usage/reservations/:id/release", (request, reply) => finishReservation(request, reply, "released"));

  if (options.serveAdmin !== false && existsSync(adminDist)) {
    await app.register(fastifyStatic, { root: adminDist, prefix: "/" });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "接口不存在" });
      return reply.sendFile("index.html");
    });
  }

  if (ownsDatabase) {
    app.addHook("onClose", async () => db.close());
  }
  return app;
}
