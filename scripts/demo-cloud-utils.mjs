const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

export function resolveNodeProxyEnvironment(environment = {}) {
  if (environment.NODE_USE_ENV_PROXY !== undefined) return {};
  const proxyConfigured = [
    environment.HTTPS_PROXY,
    environment.HTTP_PROXY,
    environment.ALL_PROXY,
    environment.https_proxy,
    environment.http_proxy,
    environment.all_proxy
  ].some((value) => Boolean(String(value ?? "").trim()));
  return proxyConfigured ? { NODE_USE_ENV_PROXY: "1" } : {};
}

export function parseCloudDemoArgs(args = []) {
  const options = {
    checkOnly: false,
    skipRecovery: false,
    url: ""
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--check") options.checkOnly = true;
    else if (argument === "--skip-recovery") options.skipRecovery = true;
    else if (argument === "--url") options.url = args[++index] ?? "";
    else if (argument.startsWith("--url=")) options.url = argument.slice("--url=".length);
    else if (argument === "--help") options.help = true;
    else throw new Error(`未知参数：${argument}`);
  }

  return options;
}

export function normalizeCloudDemoUrl(value) {
  const candidate = String(value ?? "").trim();
  if (!candidate) {
    throw new Error(
      "未配置云端地址；请设置 SCENECART_DEMO_CLOUD_URL，或使用 --url https://你的域名"
    );
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("云端地址不是有效 URL");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("云端演示只接受 HTTPS 地址");
  }
  if (LOCAL_HOSTNAMES.has(parsed.hostname)) {
    throw new Error("demo:cloud 不能连接本地地址；本地开发请使用 npm run dev");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("云端地址不能包含账号、查询参数或锚点");
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error("云端地址必须是站点根地址，不能包含路径");
  }

  return parsed.origin;
}

export function validateCloudRuntime(payload, protocolVersion) {
  const failures = [];
  if (payload?.status !== "healthy") failures.push("服务健康检查未通过");
  if (payload?.product_mode !== "production") failures.push("SCENECART_PRODUCT_MODE 不是 production");
  if (payload?.demo_cart_fallback !== false) failures.push("演示购物车回退没有关闭");
  if (payload?.runtime_store !== "postgres") failures.push("RUNTIME_STORE 不是 postgres");
  if (payload?.configured_executor_backend !== "local_executor") {
    failures.push("TAOBAO_EXECUTION_BACKEND 不是 local_executor");
  }
  if (payload?.effective_executor_backend !== "local_executor") {
    failures.push("实际执行后端不是 local_executor");
  }
  if (payload?.executor_protocol_version !== protocolVersion) {
    failures.push(
      `执行器协议不一致（本机 ${protocolVersion} / 云端 ${payload?.executor_protocol_version ?? "未知"}）`
    );
  }
  return failures;
}

export function sanitizeCloudDemoMessage(value) {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [redacted]")
    .replace(/postgres(?:ql)?:\/\/[^\s'"`]+/gi, "[redacted-database-url]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted-secret]")
    .replace(/\s+/g, " ")
    .trim();
}
