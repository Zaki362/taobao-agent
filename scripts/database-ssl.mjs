export function databaseSslConfig(environment = process.env) {
  if (environment.DATABASE_SSL !== "true") return undefined;

  const rejectUnauthorized = environment.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false";
  const formalRuntime = environment.SCENECART_PRODUCT_MODE === "production" || environment.NODE_ENV === "production";
  if (!rejectUnauthorized && formalRuntime) {
    throw new Error(
      "正式运行时禁止关闭 PostgreSQL 证书校验；请移除 DATABASE_SSL_REJECT_UNAUTHORIZED=false，或配置 DATABASE_SSL_CA。"
    );
  }

  const certificate = environment.DATABASE_SSL_CA?.trim();
  return {
    rejectUnauthorized,
    ...(certificate ? { ca: certificate.replace(/\\n/g, "\n") } : {})
  };
}
