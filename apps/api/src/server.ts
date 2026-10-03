import { buildApp } from "./app.js";

if (process.env.NODE_ENV === "production") {
  const required = ["DATABASE_URL", "ADMIN_PASSWORD", "APP_ORIGIN", "PUBLIC_URL", "MASTER_ENCRYPTION_KEY"].filter((name) => !process.env[name]);
  if (required.length > 0) {
    throw new Error(`生产环境缺少必要配置：${required.join(", ")}`);
  }
  for (const name of ["APP_ORIGIN", "PUBLIC_URL"]) {
    const url = new URL(process.env[name]!);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${name} 必须是 HTTP(S) 地址`);
  }
  if (process.env.MASTER_ENCRYPTION_KEY!.length < 32) {
    throw new Error("MASTER_ENCRYPTION_KEY 至少需要 32 个字符");
  }
}

const port = Number(process.env.PORT ?? 8790);
const host = process.env.HOST ?? "127.0.0.1";
const app = await buildApp({ logger: true });

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
