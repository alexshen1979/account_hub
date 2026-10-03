import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(sourceDir, "../../..");
const localKeyPath = resolve(projectRoot, "data/.master-key");
let cachedKey: Buffer | null = null;

async function masterKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;
  const configured = process.env.MASTER_ENCRYPTION_KEY;
  if (configured) {
    cachedKey = createHash("sha256").update(configured).digest();
    return cachedKey;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("生产环境缺少 MASTER_ENCRYPTION_KEY");
  }
  let raw: string;
  try {
    raw = (await readFile(localKeyPath, "utf8")).trim();
  } catch {
    raw = randomBytes(32).toString("hex");
    await mkdir(dirname(localKeyPath), { recursive: true });
    await writeFile(localKeyPath, raw, { encoding: "utf8", mode: 0o600 });
  }
  cachedKey = createHash("sha256").update(raw).digest();
  return cachedKey;
}

export async function encryptSecretJson(value: unknown): Promise<string> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await masterKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export async function decryptSecretJson<T>(encoded: string): Promise<T> {
  const [version, ivText, tagText, encryptedText] = encoded.split(".");
  if (version !== "v1" || !ivText || !tagText || !encryptedText) throw new Error("支付配置格式无效");
  const decipher = createDecipheriv("aes-256-gcm", await masterKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64url")), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8")) as T;
}
