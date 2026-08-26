const MCP_READINESS_ERROR = /(?:mcp_unavailable|fetch failed|ECONNREFUSED|ECONNRESET|EPIPE|ENOTFOUND|socket hang up|Tool 执行层未就绪|应用已加载完成|连接失败|cli-rpc\.sock|MCP.*请求失败|会话\s*ID|session expired|HTTP 404|timed out|timeout)/i;
const TAOBAO_LIMITED_BETA_ERROR = /(?:taobao_limited_beta|内测期间仅开放部分用户使用)/i;

// EX_TEMPFAIL makes the one-shot Doctor useful to supervisors without
// weakening its normal non-zero failure contract. Only a Taobao MCP readiness
// failure may use this code; cloud/API/token/protocol failures remain fatal.
export const MCP_READINESS_EXIT_CODE = 75;

export function requiredTaobaoTools() {
  // Search is the minimum viable capability. Missing optional cart tools must
  // not prevent this device from serving real search jobs.
  return ["search_products", "get_current_tab"];
}

export function missingTaobaoTools(tools, _capabilities = []) {
  const available = new Set(
    (Array.isArray(tools) ? tools : [])
      .map((tool) => tool?.name)
      .filter((name) => typeof name === "string")
  );
  return requiredTaobaoTools().filter((name) => !available.has(name));
}

export function missingTaobaoCartTools(tools) {
  const available = new Set(
    (Array.isArray(tools) ? tools : [])
      .map((tool) => tool?.name)
      .filter((name) => typeof name === "string")
  );
  return ["get_product_skus", "add_to_cart"].filter((name) => !available.has(name));
}

export function missingTaobaoDetailTools(tools) {
  const available = new Set(
    (Array.isArray(tools) ? tools : [])
      .map((tool) => tool?.name)
      .filter((name) => typeof name === "string")
  );
  return ["navigate_to_url", "read_page_content"].filter((name) => !available.has(name));
}

export function isMcpReadinessError(error) {
  const candidate = error && typeof error === "object" ? error : {};
  const output = [candidate.name, candidate.code, candidate.message, String(error ?? "")]
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n");
  return MCP_READINESS_ERROR.test(output);
}

export function isTaobaoLimitedBetaError(error) {
  const candidate = error && typeof error === "object" ? error : {};
  const output = [candidate.name, candidate.code, candidate.message, String(error ?? "")]
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n");
  return TAOBAO_LIMITED_BETA_ERROR.test(output);
}

export function shouldFallbackToTaobaoNativeCli(error) {
  // Search is read-only, so repeating it through the official CLI is safe even
  // when the Streamable HTTP response was lost. Mutating tools never use this
  // fallback and retain their strict non-replay boundary.
  return isMcpReadinessError(error) || isTaobaoLimitedBetaError(error);
}

export function mcpReadinessBackoffMs(attempt, options = {}) {
  const baseMs = Math.max(Number(options.baseMs ?? 2000), 250);
  const maxMs = Math.max(Number(options.maxMs ?? 30000), baseMs);
  const exponent = Math.max(Math.floor(Number(attempt) || 0), 0);
  return Math.min(baseMs * (2 ** Math.min(exponent, 20)), maxMs);
}

export function executorDoctorExitCode(checks) {
  const failedChecks = (Array.isArray(checks) ? checks : [])
    .filter((item) => item?.status === "fail")
    .map((item) => item?.name);
  if (failedChecks.length === 0) return 0;
  return failedChecks.every((name) => name === "taobao_mcp")
    ? MCP_READINESS_EXIT_CODE
    : 1;
}
