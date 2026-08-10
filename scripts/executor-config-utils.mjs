const MANAGED_KEYS = [
  "TAOBAO_EXECUTION_BACKEND",
  "SCENECART_API_URL",
  "SCENECART_DEVICE_TOKEN"
];

function envKey(line) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  return match?.[1];
}

function decodeEnvValue(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function encodeEnvValue(value) {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

export function readEnvValue(content, key) {
  for (const line of content.split(/\r?\n/)) {
    if (envKey(line) !== key) continue;
    return decodeEnvValue(line.slice(line.indexOf("=") + 1));
  }
  return "";
}

export function normalizeExecutorApiUrl(value) {
  const candidate = value.trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("SceneCart API 地址不是有效 URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("SceneCart API 地址只支持 http 或 https");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("SceneCart API 地址不能包含账号、查询参数或锚点");
  }
  return candidate;
}

export function preferredExecutorApiUrl(content, environmentValue = "") {
  return normalizeExecutorApiUrl(
    environmentValue.trim() ||
    readEnvValue(content, "SCENECART_API_URL") ||
    "http://127.0.0.1:3000"
  );
}

function isLocalExecutorUrl(value) {
  const parsed = new URL(value);
  return parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
}

async function isSceneCartApi(value, fetchImpl, timeoutMs) {
  try {
    const response = await fetchImpl(`${value}/api/runtime/health`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return false;
    const payload = await response.json().catch(() => ({}));
    return payload.status === "healthy" && typeof payload.executor_protocol_version === "string";
  } catch {
    return false;
  }
}

export async function discoverExecutorApiUrl(
  preferredUrl,
  { fetchImpl = fetch, firstPort = 3000, lastPort = 3019, timeoutMs = 800 } = {}
) {
  const preferred = normalizeExecutorApiUrl(preferredUrl);
  if (!isLocalExecutorUrl(preferred) || await isSceneCartApi(preferred, fetchImpl, timeoutMs)) {
    return preferred;
  }

  const candidates = [];
  for (let port = firstPort; port <= lastPort; port += 1) {
    const candidate = `http://127.0.0.1:${port}`;
    if (candidate !== preferred) candidates.push(candidate);
  }
  const checks = await Promise.all(
    candidates.map(async (candidate) => ({
      candidate,
      available: await isSceneCartApi(candidate, fetchImpl, timeoutMs)
    }))
  );
  return checks.find((check) => check.available)?.candidate ?? preferred;
}

export function validateExecutorDeviceToken(value) {
  const candidate = value.trim();
  if (candidate.length < 32 || candidate.length > 256) {
    throw new Error("设备令牌长度不正确，请从执行器设置页重新复制");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(candidate)) {
    throw new Error("设备令牌包含无效字符，请确认没有复制空格或引号");
  }
  return candidate;
}

export function updateExecutorEnv(content, values) {
  const updates = {
    TAOBAO_EXECUTION_BACKEND: "local_executor",
    SCENECART_API_URL: normalizeExecutorApiUrl(values.apiUrl),
    SCENECART_DEVICE_TOKEN: validateExecutorDeviceToken(values.deviceToken)
  };

  const seen = new Set();
  const lines = content.split(/\r?\n/).filter((line, index, source) => {
    if (index === source.length - 1 && line === "") return false;
    const key = envKey(line);
    if (!key || !MANAGED_KEYS.includes(key)) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((line) => {
    const key = envKey(line);
    if (!key || !(key in updates)) return line;
    return `${key}=${encodeEnvValue(updates[key])}`;
  });

  const missing = MANAGED_KEYS.filter((key) => !seen.has(key));
  if (missing.length > 0) {
    if (lines.length > 0 && lines.at(-1)?.trim()) lines.push("");
    lines.push("# SceneCart local executor");
    for (const key of missing) {
      lines.push(`${key}=${encodeEnvValue(updates[key])}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
