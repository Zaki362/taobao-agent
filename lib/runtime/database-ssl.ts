import type { PoolConfig } from "pg";
import { isFormalProductMode } from "@/lib/runtime/product-mode";

type DatabaseEnvironment = Partial<Record<string, string | undefined>>;

function normalizeCertificate(value: string | undefined) {
  const certificate = value?.trim();
  return certificate ? certificate.replace(/\\n/g, "\n") : undefined;
}

export function databaseSslConfig(environment: DatabaseEnvironment = process.env): PoolConfig["ssl"] {
  if (environment.DATABASE_SSL !== "true") return undefined;

  const rejectUnauthorized = environment.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false";
  if (!rejectUnauthorized && (isFormalProductMode() || environment.NODE_ENV === "production")) {
    throw new Error(
      "正式运行时禁止关闭 PostgreSQL 证书校验；请移除 DATABASE_SSL_REJECT_UNAUTHORIZED=false，或配置 DATABASE_SSL_CA。"
    );
  }

  const ca = normalizeCertificate(environment.DATABASE_SSL_CA);
  return {
    rejectUnauthorized,
    ...(ca ? { ca } : {})
  };
}
