export type SceneCartVercelEnvironment = "preview" | "production";
export type SceneCartOuterProtectionScope = "preview" | "all_deployments";

const MAX_PROTECTION_VERIFICATION_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export interface OuterProtectionInspection {
  environment: SceneCartVercelEnvironment | null;
  scope: SceneCartOuterProtectionScope | null;
  verifiedAt: string | null;
  valid: boolean;
  issues: string[];
}

function normalizedHttpsOrigin(value: string | undefined) {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function configuredAppOrigins() {
  return (process.env.APP_ORIGIN ?? "")
    .split(",")
    .map((origin) => normalizedHttpsOrigin(origin))
    .filter((origin): origin is string => Boolean(origin));
}

function validVerificationTimestamp(value: string | undefined, nowMs: number) {
  if (!value?.trim()) return null;
  const parsed = Date.parse(value.trim());
  if (!Number.isFinite(parsed)) return null;
  if (parsed > nowMs + MAX_CLOCK_SKEW_MS) return null;
  if (nowMs - parsed > MAX_PROTECTION_VERIFICATION_AGE_MS) return null;
  return new Date(parsed).toISOString();
}

/**
 * Validates the server-only declaration that Vercel Deployment Protection was
 * inspected by a human. This prevents a lone access-mode flag from opening the
 * fixed owner to the public internet. A release still needs an independent live
 * verification receipt; this runtime check is necessary, not sufficient.
 */
export function inspectOuterProtectionConfiguration(
  nowMs = Date.now()
): OuterProtectionInspection {
  const issues: string[] = [];
  const rawEnvironment = process.env.VERCEL_ENV?.trim();
  const environment = rawEnvironment === "preview" || rawEnvironment === "production"
    ? rawEnvironment
    : null;
  if (!environment) issues.push("VERCEL_ENV 必须是 preview 或 production");

  if (process.env.SCENECART_OUTER_PROTECTION_VERIFIED !== "true") {
    issues.push("缺少人工核验声明");
  }

  const rawScope = process.env.SCENECART_OUTER_PROTECTION_SCOPE?.trim();
  const scope = rawScope === "preview" || rawScope === "all_deployments"
    ? rawScope
    : null;
  if (!scope) {
    issues.push("外层保护范围无效");
  } else if (environment === "production" && scope !== "all_deployments") {
    issues.push("Production 必须保护所有部署");
  }

  const verifiedAt = validVerificationTimestamp(
    process.env.SCENECART_OUTER_PROTECTION_VERIFIED_AT,
    nowMs
  );
  if (!verifiedAt) issues.push("人工核验时间缺失、无效或已超过 30 天");

  const declaredProjectId = process.env.SCENECART_OUTER_PROTECTION_PROJECT_ID?.trim() ?? "";
  const runtimeProjectId = process.env.VERCEL_PROJECT_ID?.trim() ?? "";
  if (!declaredProjectId || !runtimeProjectId || declaredProjectId !== runtimeProjectId) {
    issues.push("外层保护项目 ID 与当前 Vercel 项目不一致");
  }

  const declaredOrigin = normalizedHttpsOrigin(
    process.env.SCENECART_OUTER_PROTECTION_ORIGIN
  );
  const appOrigins = configuredAppOrigins();
  if (!declaredOrigin || appOrigins.length !== 1 || appOrigins[0] !== declaredOrigin) {
    issues.push("外层保护正式 origin 与 APP_ORIGIN 不一致");
  }

  const productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() ?? "";
  const runtimeProductionOrigin = productionHost
    ? normalizedHttpsOrigin(`https://${productionHost}`)
    : null;
  if (!runtimeProductionOrigin || !declaredOrigin || runtimeProductionOrigin !== declaredOrigin) {
    issues.push("外层保护正式 origin 与当前 Vercel Production 域名不一致");
  }

  if (environment === "production" && process.env.SCENECART_PRODUCT_MODE !== "production") {
    issues.push("Vercel Production 必须使用正式产品模式");
  }

  return {
    environment,
    scope,
    verifiedAt,
    valid: issues.length === 0,
    issues
  };
}

export function isLocalSingleUserDevelopment() {
  const vercelEnvironment = process.env.VERCEL_ENV?.trim();
  if (vercelEnvironment && vercelEnvironment !== "development") return false;

  const configuredOrigins = (process.env.APP_ORIGIN ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (configuredOrigins.length !== 1) return false;

  try {
    const origin = new URL(configuredOrigins[0]);
    const loopbackHost = origin.hostname === "localhost" ||
      origin.hostname === "127.0.0.1" ||
      origin.hostname === "[::1]";
    return loopbackHost && !origin.username && !origin.password;
  } catch {
    return false;
  }
}
