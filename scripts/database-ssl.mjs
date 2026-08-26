export function databaseSslConfig(environment = process.env) {
  const formalRuntime = environment.SCENECART_PRODUCT_MODE === "production" || environment.NODE_ENV === "production";
  if (environment.DATABASE_SSL !== "true") {
    if (formalRuntime) {
      throw new Error(
        "正式运行要求 PostgreSQL 全程使用 TLS；请配置 DATABASE_SSL=true。"
      );
    }
    return undefined;
  }

  const rejectUnauthorized = environment.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false";
  if (!rejectUnauthorized && formalRuntime) {
    throw new Error(
      "正式运行时禁止关闭 PostgreSQL 证书校验；请移除 DATABASE_SSL_REJECT_UNAUTHORIZED=false。"
    );
  }

  const certificate = environment.DATABASE_SSL_CA?.trim();
  return {
    rejectUnauthorized,
    ...(certificate ? { ca: certificate.replace(/\\n/g, "\n") } : {})
  };
}
