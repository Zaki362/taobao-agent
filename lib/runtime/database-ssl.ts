import type { PoolConfig } from "pg";

type DatabaseEnvironment = Partial<Record<string, string | undefined>>;

function normalizeCertificate(value: string | undefined) {
  const certificate = value?.trim();
  return certificate ? certificate.replace(/\\n/g, "\n") : undefined;
}

function isFormalDatabaseEnvironment(environment: DatabaseEnvironment) {
  return environment.SCENECART_PRODUCT_MODE === "production"
    || environment.NODE_ENV === "production";
}

export function databaseSslConfig(environment: DatabaseEnvironment = process.env): PoolConfig["ssl"] {
  const formalEnvironment = isFormalDatabaseEnvironment(environment);
  if (environment.DATABASE_SSL !== "true") {
    if (formalEnvironment) {
      throw new Error(
        "正式运行要求 PostgreSQL 全程使用 TLS；请配置 DATABASE_SSL=true。"
      );
    }
    return undefined;
  }

  const rejectUnauthorized = environment.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false";
  if (!rejectUnauthorized && formalEnvironment) {
    throw new Error(
      "正式运行时禁止关闭 PostgreSQL 证书校验；请移除 DATABASE_SSL_REJECT_UNAUTHORIZED=false。"
    );
  }

  const ca = normalizeCertificate(environment.DATABASE_SSL_CA);
  return {
    rejectUnauthorized,
    ...(ca ? { ca } : {})
  };
}
