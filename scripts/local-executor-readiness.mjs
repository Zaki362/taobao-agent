const MCP_READINESS_ERROR = /(?:mcp_unavailable|fetch failed|ECONNREFUSED|ECONNRESET|EPIPE|ENOTFOUND|socket hang up|Tool 执行层未就绪|应用已加载完成|连接失败|cli-rpc\.sock|MCP.*请求失败|会话\s*ID|session expired|HTTP 404|timed out|timeout)/i;

export function requiredTaobaoTools() {
  // Search is the minimum viable capability. Missing optional cart tools must
  // not prevent this device from serving real search jobs.
  return ["search_products", "get_current_tab"];
}

export function missingTaobaoTools(tools, capabilities = []) {
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

export function isMcpReadinessError(error) {
  const candidate = error && typeof error === "object" ? error : {};
  const output = [candidate.name, candidate.code, candidate.message, String(error ?? "")]
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n");
  return MCP_READINESS_ERROR.test(output);
}

export function mcpReadinessBackoffMs(attempt, options = {}) {
  const baseMs = Math.max(Number(options.baseMs ?? 2000), 250);
  const maxMs = Math.max(Number(options.maxMs ?? 30000), baseMs);
  const exponent = Math.max(Math.floor(Number(attempt) || 0), 0);
  return Math.min(baseMs * (2 ** Math.min(exponent, 20)), maxMs);
}
