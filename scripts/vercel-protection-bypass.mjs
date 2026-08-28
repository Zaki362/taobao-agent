import process from "node:process";

export const DEFAULT_SCENECART_PROTECTED_ORIGIN = "https://scenecart-ai.vercel.app";
export const VERCEL_PROTECTION_BYPASS_HEADER = "x-vercel-protection-bypass";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);
const SECRET_ENV_KEYS = [
  "SCENECART_DEVICE_TOKEN",
  "SCENECART_VERCEL_PROTECTION_BYPASS_SECRET",
  "SCENECART_CRON_SECRET"
];

export class VercelProtectionError extends Error {
  constructor(message, { status = 0, code = "vercel_protection_failed" } = {}) {
    super(message);
    this.name = "VercelProtectionError";
    this.status = status;
    this.code = code;
  }
}

export class VercelProtectionConfigurationError extends VercelProtectionError {
  constructor(message) {
    super(message, { code: "vercel_protection_bypass_not_configured" });
    this.name = "VercelProtectionConfigurationError";
  }
}

function requestUrl(input) {
  return new URL(input instanceof Request ? input.url : String(input));
}

export function normalizeProtectedOrigin(value = DEFAULT_SCENECART_PROTECTED_ORIGIN) {
  let parsed;
  try {
    parsed = new URL(String(value || DEFAULT_SCENECART_PROTECTED_ORIGIN).trim());
  } catch {
    throw new VercelProtectionConfigurationError(
      "SCENECART_VERCEL_PROTECTED_ORIGIN 不是有效的 HTTPS origin"
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new VercelProtectionConfigurationError(
      "SCENECART_VERCEL_PROTECTED_ORIGIN 必须是无路径、无凭据的 HTTPS origin"
    );
  }
  return parsed.origin;
}

export function protectedOrigin(environment = process.env) {
  return normalizeProtectedOrigin(
    environment.SCENECART_VERCEL_PROTECTED_ORIGIN || DEFAULT_SCENECART_PROTECTED_ORIGIN
  );
}

export function isLocalSceneCartUrl(input) {
  const parsed = requestUrl(input);
  return LOCAL_HOSTNAMES.has(parsed.hostname);
}

export function isProtectedVercelOrigin(input, environment = process.env) {
  const parsed = requestUrl(input);
  if (LOCAL_HOSTNAMES.has(parsed.hostname)) return false;
  return parsed.origin === protectedOrigin(environment);
}

export function vercelProtectionBypassHeaders(input, environment = process.env) {
  if (!isProtectedVercelOrigin(input, environment)) return {};
  const secret = environment.SCENECART_VERCEL_PROTECTION_BYPASS_SECRET?.trim() ?? "";
  if (!secret) {
    throw new VercelProtectionConfigurationError(
      "受保护的 SceneCart origin 缺少本机 SCENECART_VERCEL_PROTECTION_BYPASS_SECRET；请求已在发送前停止"
    );
  }
  return { [VERCEL_PROTECTION_BYPASS_HEADER]: secret };
}

export function protectedRequestHeaders(input, headers = {}, environment = process.env) {
  const result = new Headers(headers);
  for (const [key, value] of Object.entries(vercelProtectionBypassHeaders(input, environment))) {
    result.set(key, value);
  }
  return result;
}

export function isVercelProtectionChallenge(
  response,
  { input, body = "", environment = process.env } = {}
) {
  if (!input || !isProtectedVercelOrigin(input, environment)) return false;
  const location = response.headers.get("location") ?? "";
  if (
    [301, 302, 303, 307, 308].includes(response.status) &&
    /vercel|sso|authentication|login/i.test(location)
  ) {
    return true;
  }
  if (![401, 403].includes(response.status)) return false;
  return response.headers.has("x-vercel-challenge-token") ||
    /vercel|deployment protection|authentication required/i.test(String(body));
}

export async function throwIfVercelProtectionFailed(
  response,
  { input, environment = process.env } = {}
) {
  if (!input || !isProtectedVercelOrigin(input, environment)) return;
  if (![301, 302, 303, 307, 308, 401, 403].includes(response.status)) return;
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    throw new VercelProtectionError(
      "受保护的 SceneCart 机器请求返回重定向；为防止凭据跨 origin 泄露，请求已停止",
      { status: response.status, code: "vercel_protection_redirect_blocked" }
    );
  }
  const body = await response.clone().text().catch(() => "");
  if (!isVercelProtectionChallenge(response, { input, body, environment })) return;
  throw new VercelProtectionError(
    "Vercel 外层访问保护拒绝了机器请求；请核对精确 origin 与本机 Automation Bypass Secret",
    { status: response.status }
  );
}

export async function vercelProtectedFetch(
  input,
  init = {},
  { environment = process.env, fetchImpl = fetch } = {}
) {
  const protectedRequest = isProtectedVercelOrigin(input, environment);
  const response = await fetchImpl(input, {
    ...init,
    ...(protectedRequest ? { redirect: "manual" } : {}),
    headers: protectedRequestHeaders(input, init.headers, environment)
  });
  await throwIfVercelProtectionFailed(response, { input, environment });
  return response;
}

export function isVercelProtectionError(error) {
  return error instanceof VercelProtectionError;
}

export function redactSceneCartSecrets(value, environment = process.env) {
  let output = String(value ?? "");
  for (const key of SECRET_ENV_KEYS) {
    const secret = environment[key]?.trim() ?? "";
    if (secret) output = output.replaceAll(secret, "[redacted-secret]");
  }
  return output
    .replace(/(x-vercel-protection-bypass\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/postgres(?:ql)?:\/\/[^\s'"`]+/gi, "[redacted-database-url]")
    .replace(/\b(?:sk|ds)-[A-Za-z0-9_-]{12,}\b/gi, "[redacted-api-key]");
}

export function safeMachineErrorMessage(error, environment = process.env) {
  return redactSceneCartSecrets(error instanceof Error ? error.message : String(error), environment);
}
