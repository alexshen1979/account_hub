import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { Pool, type PoolClient } from "pg";
import { hashPassword, sha256 } from "./security.js";

export interface QueryResult<T> {
  rows: T[];
}

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Database extends Queryable {
  exec(sql: string): Promise<void>;
  transaction<T>(callback: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

class PGliteDatabase implements Database {
  constructor(private readonly client: PGlite) {}

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    const result = await this.client.query<T>(sql, params);
    return { rows: result.rows };
  }

  async transaction<T>(callback: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.client.transaction(async (tx) => callback({
      query: async <R = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const result = await tx.query<R>(sql, params);
        return { rows: result.rows };
      },
    }));
  }

  async exec(sql: string): Promise<void> {
    await this.client.exec(sql);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

class PostgresDatabase implements Database {
  constructor(private readonly pool: Pool) {}

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    const result = await this.pool.query(sql, params);
    return { rows: result.rows as T[] };
  }

  async transaction<T>(callback: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(this.wrapClient(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  private wrapClient(client: PoolClient): Queryable {
    return {
      query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const result = await client.query(sql, params);
        return { rows: result.rows as T[] };
      },
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

const apiDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(apiDir, "../../..");

export interface DatabaseOptions {
  path?: string;
  seed?: boolean;
  adminEmail?: string;
  adminPassword?: string;
}

export async function openDatabase(options: DatabaseOptions = {}): Promise<Database> {
  let database: Database;
  if (process.env.DATABASE_URL) {
    database = new PostgresDatabase(new Pool({ connectionString: process.env.DATABASE_URL }));
  } else if (options.path === ":memory:" || options.path === undefined && process.env.NODE_ENV === "test") {
    database = new PGliteDatabase(new PGlite());
  } else {
    const configuredPath = options.path ?? process.env.DATABASE_PATH ?? "./data/account-hub";
    const dataPath = resolve(projectRoot, configuredPath);
    await mkdir(dirname(dataPath), { recursive: true });
    database = new PGliteDatabase(new PGlite(dataPath));
  }
  await migrate(database);
  if (options.seed !== false) {
    await seedDatabase(database, options);
  }
  return database;
}

async function migrate(db: Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      redirect_uris TEXT NOT NULL DEFAULT '[]',
      allow_registration BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE applications ADD COLUMN IF NOT EXISTS redirect_uris TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE applications ADD COLUMN IF NOT EXISTS allow_registration BOOLEAN NOT NULL DEFAULT TRUE;

    CREATE TABLE IF NOT EXISTS application_api_keys (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      system_role TEXT NOT NULL DEFAULT 'user' CHECK (system_role IN ('admin', 'user')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS auth_identities (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      provider_subject TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(provider, provider_subject)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS authorization_codes (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL UNIQUE,
      redirect_uri TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS app_memberships (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(application_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      code TEXT NOT NULL,
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      currency TEXT NOT NULL DEFAULT 'CNY',
      included_credits BIGINT NOT NULL CHECK (included_credits >= 0),
      validity_days INTEGER NOT NULL DEFAULT 0 CHECK (validity_days >= 0),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(application_id, code)
    );

    CREATE TABLE IF NOT EXISTS payment_provider_instances (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (provider IN ('epay')),
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      encrypted_config TEXT NOT NULL,
      config_summary TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS wallets (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      available BIGINT NOT NULL DEFAULT 0 CHECK (available >= 0),
      frozen BIGINT NOT NULL DEFAULT 0 CHECK (frozen >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(application_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS ledger_accounts (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      wallet_id TEXT REFERENCES wallets(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(application_id, code)
    );

    CREATE TABLE IF NOT EXISTS ledger_transactions (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      idempotency_key TEXT,
      reference_type TEXT,
      reference_id TEXT,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(application_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS ledger_entries (
      id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
      account_id TEXT NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
      amount BIGINT NOT NULL CHECK (amount <> 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS recharge_orders (
      id TEXT PRIMARY KEY,
      order_no TEXT NOT NULL UNIQUE,
      application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      plan_id TEXT REFERENCES plans(id) ON DELETE SET NULL,
      provider_instance_id TEXT REFERENCES payment_provider_instances(id) ON DELETE SET NULL,
      provider TEXT NOT NULL,
      provider_config_snapshot TEXT,
      provider_trade_no TEXT,
      amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
      currency TEXT NOT NULL,
      credits BIGINT NOT NULL CHECK (credits > 0),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled', 'refunded')),
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE recharge_orders ADD COLUMN IF NOT EXISTS provider_instance_id TEXT REFERENCES payment_provider_instances(id) ON DELETE SET NULL;
    ALTER TABLE recharge_orders ADD COLUMN IF NOT EXISTS provider_config_snapshot TEXT;
    ALTER TABLE recharge_orders ADD COLUMN IF NOT EXISTS provider_trade_no TEXT;

    CREATE TABLE IF NOT EXISTS webhook_events (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      external_event_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      processed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(provider, external_event_id)
    );

    CREATE TABLE IF NOT EXISTS usage_reservations (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      amount BIGINT NOT NULL CHECK (amount > 0),
      idempotency_key TEXT NOT NULL,
      external_reference TEXT,
      status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'captured', 'released')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(application_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS redeem_codes (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL UNIQUE,
      credits BIGINT NOT NULL CHECK (credits > 0),
      max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses > 0),
      used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
      expires_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      application_id TEXT REFERENCES applications(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      metadata TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_memberships_app ON app_memberships(application_id);
    CREATE INDEX IF NOT EXISTS idx_authorization_codes_expiry ON authorization_codes(expires_at);
    CREATE INDEX IF NOT EXISTS idx_wallets_app ON wallets(application_id);
    CREATE INDEX IF NOT EXISTS idx_payment_providers_app ON payment_provider_instances(application_id);
    CREATE INDEX IF NOT EXISTS idx_ledger_transactions_created ON ledger_transactions(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_created ON recharge_orders(created_at DESC);
  `);
}

async function seedDatabase(db: Database, options: DatabaseOptions): Promise<void> {
  const adminEmail = (options.adminEmail ?? process.env.ADMIN_EMAIL ?? "admin@local.test").toLowerCase();
  const adminPassword = options.adminPassword ?? process.env.ADMIN_PASSWORD ?? "Admin123!";
  const adminId = "usr_local_admin";

  const existingAdmin = await db.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [adminEmail]);
  if (existingAdmin.rows.length === 0) {
    const passwordHash = await hashPassword(adminPassword);
    await db.query(
      `INSERT INTO users (id, email, password_hash, display_name, system_role)
       VALUES ($1, $2, $3, '系统管理员', 'admin')`,
      [adminId, adminEmail, passwordHash],
    );
  }

  const seedAppSlug = process.env.SEED_APP_SLUG?.trim().toLowerCase();
  if (!seedAppSlug) return;

  const seedAppName = process.env.SEED_APP_NAME?.trim() || "Demo Application";
  const seedAppId = `app_seed_${sha256(seedAppSlug).slice(0, 16)}`;
  await db.query(
    `INSERT INTO applications (id, name, slug)
     VALUES ($1, $2, $3) ON CONFLICT (slug) DO NOTHING`,
    [seedAppId, seedAppName, seedAppSlug],
  );
  await db.query(
    `INSERT INTO ledger_accounts (id, application_id, code, name)
     VALUES ($1, $2, 'system:issuance', '额度发行'),
            ($3, $2, 'system:consumed', '已消费额度')
     ON CONFLICT (application_id, code) DO NOTHING`,
    [`lac_${sha256(`${seedAppSlug}:issuance`).slice(0, 20)}`, seedAppId, `lac_${sha256(`${seedAppSlug}:consumed`).slice(0, 20)}`],
  );

  const seedApiKey = process.env.SEED_APP_API_KEY?.trim();
  if (seedApiKey) {
    await db.query(
      `INSERT INTO application_api_keys (id, application_id, name, key_prefix, key_hash)
       VALUES ($1, $2, '初始应用密钥', $3, $4) ON CONFLICT (key_hash) DO NOTHING`,
      [`key_${sha256(seedApiKey).slice(0, 20)}`, seedAppId, seedApiKey.slice(0, 10), sha256(seedApiKey)],
    );
  }
}
