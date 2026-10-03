import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "./database.js";
import { randomToken, sha256 } from "./security.js";

const sessionCookie = "account_hub_session";

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  systemRole: "admin" | "user";
  status: "active" | "disabled";
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  system_role: "admin" | "user";
  status: "active" | "disabled";
}

export async function createSession(db: Database, userId: string, reply: FastifyReply): Promise<void> {
  const rawToken = randomToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await db.query(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [randomUUID(), userId, sha256(rawToken), expiresAt.toISOString()],
  );
  reply.setCookie(sessionCookie, rawToken, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE
      ? process.env.COOKIE_SECURE.toLowerCase() !== "false"
      : process.env.NODE_ENV === "production",
    expires: expiresAt,
  });
}

export async function destroySession(db: Database, request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies[sessionCookie];
  if (token) await db.query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
  reply.clearCookie(sessionCookie, { path: "/" });
}

export async function getSessionUser(db: Database, request: FastifyRequest): Promise<SessionUser | null> {
  const token = request.cookies[sessionCookie];
  if (!token) return null;
  const result = await db.query<UserRow>(
    `SELECT u.id, u.email, u.display_name, u.system_role, u.status
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
    [sha256(token)],
  );
  const row = result.rows[0];
  if (!row || row.status !== "active") return null;
  await db.query("UPDATE sessions SET last_seen_at = NOW() WHERE token_hash = $1", [sha256(token)]);
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    systemRole: row.system_role,
    status: row.status,
  };
}

export async function requireAdmin(
  db: Database,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<SessionUser | null> {
  const user = await getSessionUser(db, request);
  if (!user) {
    reply.code(401).send({ error: "请先登录" });
    return null;
  }
  if (user.systemRole !== "admin") {
    reply.code(403).send({ error: "需要管理员权限" });
    return null;
  }
  return user;
}
