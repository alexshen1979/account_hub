import { randomUUID } from "node:crypto";
import type { Database, Queryable } from "./database.js";

interface WalletRow {
  id: string;
  application_id: string;
  user_id: string;
  available: string | number;
  frozen: string | number;
}

export interface WalletBalance {
  walletId: string;
  available: number;
  frozen: number;
}

export interface LedgerMutation {
  applicationId: string;
  userId: string;
  type: "credit" | "debit" | "reserve" | "capture" | "release";
  amount: number;
  idempotencyKey: string;
  referenceType?: string;
  referenceId?: string;
  note?: string;
}

async function accountId(db: Queryable, applicationId: string, walletId: string | null, code: string, name: string): Promise<string> {
  const existing = await db.query<{ id: string }>(
    "SELECT id FROM ledger_accounts WHERE application_id = $1 AND code = $2",
    [applicationId, code],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const id = randomUUID();
  await db.query(
    `INSERT INTO ledger_accounts (id, application_id, wallet_id, code, name)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (application_id, code) DO NOTHING`,
    [id, applicationId, walletId, code, name],
  );
  const created = await db.query<{ id: string }>(
    "SELECT id FROM ledger_accounts WHERE application_id = $1 AND code = $2",
    [applicationId, code],
  );
  return created.rows[0]!.id;
}

export async function ensureWallet(db: Queryable, applicationId: string, userId: string): Promise<WalletRow> {
  const existing = await db.query<WalletRow>(
    "SELECT * FROM wallets WHERE application_id = $1 AND user_id = $2",
    [applicationId, userId],
  );
  if (existing.rows[0]) return existing.rows[0];
  const walletId = randomUUID();
  await db.query(
    `INSERT INTO wallets (id, application_id, user_id)
     VALUES ($1, $2, $3) ON CONFLICT (application_id, user_id) DO NOTHING`,
    [walletId, applicationId, userId],
  );
  const wallet = await db.query<WalletRow>(
    "SELECT * FROM wallets WHERE application_id = $1 AND user_id = $2",
    [applicationId, userId],
  );
  return wallet.rows[0]!;
}

export async function postLedgerMutationInTransaction(db: Queryable, mutation: LedgerMutation): Promise<WalletBalance> {
  if (!Number.isSafeInteger(mutation.amount) || mutation.amount <= 0) {
    throw new Error("额度必须是正整数");
  }

  const duplicate = await db.query<{ id: string }>(
      "SELECT id FROM ledger_transactions WHERE application_id = $1 AND idempotency_key = $2",
      [mutation.applicationId, mutation.idempotencyKey],
    );
  const wallet = await ensureWallet(db, mutation.applicationId, mutation.userId);
  if (duplicate.rows[0]) {
    return {
      walletId: wallet.id,
      available: Number(wallet.available),
      frozen: Number(wallet.frozen),
    };
  }

  const current = await db.query<WalletRow>("SELECT * FROM wallets WHERE id = $1 FOR UPDATE", [wallet.id]);
  const available = Number(current.rows[0]!.available);
  const frozen = Number(current.rows[0]!.frozen);
  let availableDelta = 0;
  let frozenDelta = 0;
  let counterpartyCode = "system:issuance";
  let counterpartyName = "额度发行";

  if (mutation.type === "credit") availableDelta = mutation.amount;
  if (mutation.type === "debit") availableDelta = -mutation.amount;
  if (mutation.type === "reserve") {
    availableDelta = -mutation.amount;
    frozenDelta = mutation.amount;
  }
  if (mutation.type === "capture") {
    frozenDelta = -mutation.amount;
    counterpartyCode = "system:consumed";
    counterpartyName = "已消费额度";
  }
  if (mutation.type === "release") {
    availableDelta = mutation.amount;
    frozenDelta = -mutation.amount;
  }

  if (available + availableDelta < 0) throw new Error("可用额度不足");
  if (frozen + frozenDelta < 0) throw new Error("冻结额度不足");

  const availableAccount = await accountId(
    db,
    mutation.applicationId,
    wallet.id,
    `wallet:${wallet.id}:available`,
    "用户可用额度",
  );
  const frozenAccount = await accountId(
    db,
    mutation.applicationId,
    wallet.id,
    `wallet:${wallet.id}:frozen`,
    "用户冻结额度",
  );
  const counterparty = await accountId(db, mutation.applicationId, null, counterpartyCode, counterpartyName);
  const transactionId = randomUUID();
  await db.query(
    `INSERT INTO ledger_transactions
     (id, application_id, user_id, type, idempotency_key, reference_type, reference_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      transactionId,
      mutation.applicationId,
      mutation.userId,
      mutation.type,
      mutation.idempotencyKey,
      mutation.referenceType ?? null,
      mutation.referenceId ?? null,
      mutation.note ?? null,
    ],
  );

  const entries: Array<[string, number]> = [];
  if (availableDelta !== 0) entries.push([availableAccount, availableDelta]);
  if (frozenDelta !== 0) entries.push([frozenAccount, frozenDelta]);
  const totalWalletDelta = availableDelta + frozenDelta;
  if (totalWalletDelta !== 0) entries.push([counterparty, -totalWalletDelta]);
  for (const [entryAccountId, amount] of entries) {
    await db.query(
      "INSERT INTO ledger_entries (id, transaction_id, account_id, amount) VALUES ($1, $2, $3, $4)",
      [randomUUID(), transactionId, entryAccountId, amount],
    );
  }
  const balanceCheck = entries.reduce((sum, [, amount]) => sum + amount, 0);
  if (balanceCheck !== 0) throw new Error("账本分录不平衡");

  const nextAvailable = available + availableDelta;
  const nextFrozen = frozen + frozenDelta;
  await db.query(
    "UPDATE wallets SET available = $1, frozen = $2, updated_at = NOW() WHERE id = $3",
    [nextAvailable, nextFrozen, wallet.id],
  );
  return { walletId: wallet.id, available: nextAvailable, frozen: nextFrozen };
}

export async function postLedgerMutation(db: Database, mutation: LedgerMutation): Promise<WalletBalance> {
  return db.transaction((tx) => postLedgerMutationInTransaction(tx, mutation));
}
