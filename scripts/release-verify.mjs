import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_DETAIL_LENGTH = 360;

function loadEnvFile(relativePath) {
  const target = path.join(ROOT, relativePath);
  if (!fs.existsSync(target)) return;
  for (const rawLine of fs.readFileSync(target, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function sanitizeReleaseDetail(value) {
  const normalized = String(value ?? "")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted-api-key]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [redacted]")
    .replace(/postgres(?:ql)?:\/\/[^\s'"`]+/gi, "[redacted-database-url]")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length <= MAX_DETAIL_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_DETAIL_LENGTH)}...`;
}

function result(id, label, status, detail, remediation, required = true) {
  return {
    id,
    label,
    status,
    required,
    detail: sanitizeReleaseDetail(detail),
    remediation: status === "pass" ? undefined : remediation
  };
}

export function normalizeReleaseUrl(value) {
  const first = String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .find(Boolean);
  if (!first) return null;
  let parsed;
  try {
    parsed = new URL(first);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return null;
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

export function isProductionReleaseUrl(value) {
  const normalized = normalizeReleaseUrl(value);
  if (!normalized) return false;
  const parsed = new URL(normalized);
  return parsed.protocol === "https:" &&
    !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
}

export function parseReleaseVerifyArgs(args = []) {
  const options = {
    json: false,
    staticOnly: false,
    url: undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--static") options.staticOnly = true;
    else if (argument === "--url") options.url = args[++index];
    else if (argument.startsWith("--url=")) options.url = argument.slice(6);
    else if (argument === "--timeout-ms") options.timeoutMs = Number(args[++index]);
    else if (argument.startsWith("--timeout-ms=")) options.timeoutMs = Number(argument.slice(13));
    else throw new Error(`未知参数：${argument}`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 120_000) {
    throw new Error("--timeout-ms 必须在 1000 到 120000 之间");
  }
  return options;
}

function runCommand(command, args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => {
      clearTimeout(timeout);
      resolve({ code: null, stdout, stderr, error, timedOut });
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr, error: null, timedOut });
    });
  });
}

async function runStaticAudit() {
  const execution = await runCommand(process.execPath, [path.join(ROOT, "scripts/release-audit.mjs"), "--json"]);
  let audit;
  try {
    audit = JSON.parse(execution.stdout);
  } catch {
    return {
      check: result(
        "static_configuration",
        "静态发布配置",
        "fail",
        execution.timedOut ? "静态发布审计超时" : execution.stderr || "无法解析 release:audit 输出",
        "先运行 npm run release:audit 查看配置缺口"
      ),
      audit: null
    };
  }
  const failures = Array.isArray(audit.checks)
    ? audit.checks.filter((item) => item.status !== "pass")
    : [];
  return {
    check: result(
      "static_configuration",
      "静态发布配置",
      audit.ready_for_release && execution.code === 0 ? "pass" : "fail",
      failures.length === 0
        ? "正式环境变量满足发布基线"
        : `${failures.length} 项未通过：${failures.map((item) => item.label).join("、")}`,
      "运行 npm run release:audit，按提示补齐正式环境变量"
    ),
    audit
  };
}

async function runDatabaseCheck() {
  if (!process.env.DATABASE_URL?.trim()) {
    return result(
      "database_schema",
      "数据库结构",
      "fail",
      "DATABASE_URL 未配置，无法验证正式数据库",
      "通过部署平台 Secret 配置 DATABASE_URL，先显式执行 npm run db:migrate"
    );
  }
  const execution = await runCommand(process.execPath, [path.join(ROOT, "scripts/db-check.mjs")], {
    timeoutMs: 30_000
  });
  return result(
    "database_schema",
    "数据库结构",
    execution.code === 0 ? "pass" : "fail",
    execution.code === 0
      ? execution.stdout || "数据库连接、migration checksum 与运行表检查通过"
      : execution.timedOut
        ? "数据库检查超时"
        : execution.stderr || execution.stdout || "数据库检查失败",
    "检查数据库网络与 migration；需要迁移时单独运行 npm run db:migrate"
  );
}

async function fetchJson(url, { timeoutMs, authorization, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      cache: "no-store",
      headers: authorization ? { Authorization: authorization } : undefined,
      signal: controller.signal
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // The summarized text below is enough to diagnose a non-JSON proxy response.
    }
    return { ok: response.ok, status: response.status, payload, text };
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyRuntime(baseUrl, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  secret = "",
  fetchImpl = fetch
} = {}) {
  const checks = [];
  try {
    const health = await fetchJson(`${baseUrl}/api/runtime/health`, { timeoutMs, fetchImpl });
    const healthy = health.ok && health.payload?.status === "healthy";
    checks.push(result(
      "runtime_health",
      "线上健康检查",
      healthy ? "pass" : "fail",
      healthy
        ? `服务在线，运行时=${health.payload.runtime_store ?? "未知"}`
        : `HTTP ${health.status}: ${health.payload?.error ?? health.text ?? "未返回健康状态"}`,
      "检查部署日志、数据库连接和反向代理，再访问 /api/runtime/health"
    ));
    const runtimeContract = healthy &&
      health.payload.product_mode === "production" &&
      health.payload.demo_cart_fallback === false &&
      health.payload.runtime_store === "postgres" &&
      health.payload.configured_executor_backend === "local_executor" &&
      health.payload.effective_executor_backend === "local_executor";
    checks.push(result(
      "runtime_contract",
      "线上运行契约",
      runtimeContract ? "pass" : "fail",
      runtimeContract
        ? "正式模式、PostgreSQL、真实执行器和禁止演示加购均已生效"
        : "线上进程未完整应用正式运行配置",
      "确认部署平台环境变量已注入最新实例，并重新部署"
    ));
  } catch (error) {
    checks.push(result(
      "runtime_health",
      "线上健康检查",
      "fail",
      error?.name === "AbortError" ? "健康检查超时" : error?.message ?? error,
      "检查发布 URL、TLS、网络和部署实例状态"
    ));
    checks.push(result(
      "runtime_contract",
      "线上运行契约",
      "fail",
      "健康检查不可用，无法验证线上运行配置",
      "先恢复 /api/runtime/health"
    ));
  }

  if (secret.trim().length < 32) {
    checks.push(result(
      "runtime_readiness",
      "线上发布就绪",
      "fail",
      "SCENECART_CRON_SECRET 未配置或长度不足，无法调用只读内部探针",
      "在当前验证进程中注入与线上一致的 SCENECART_CRON_SECRET"
    ));
    return { checks, readiness: null };
  }

  try {
    const readiness = await fetchJson(`${baseUrl}/api/internal/runtime-readiness`, {
      timeoutMs,
      authorization: `Bearer ${secret.trim()}`,
      fetchImpl
    });
    const failedRequired = Array.isArray(readiness.payload?.checks)
      ? readiness.payload.checks.filter((item) => item.required && item.status !== "pass")
      : [];
    const ready = readiness.ok && readiness.payload?.ready_for_production === true;
    checks.push(result(
      "runtime_readiness",
      "线上发布就绪",
      ready ? "pass" : "fail",
      ready
        ? "数据库、认证、恢复心跳、HTTPS、模型和执行架构均满足正式要求"
        : readiness.ok
          ? `${failedRequired.length} 项必需检查未通过：${failedRequired.map((item) => item.label).join("、") || "返回状态不完整"}`
          : `HTTP ${readiness.status}: ${readiness.payload?.error ?? readiness.text ?? "内部探针失败"}`,
      "查看内部 readiness 返回的 remediation，修复后重新验证"
    ));
    return { checks, readiness: readiness.payload };
  } catch (error) {
    checks.push(result(
      "runtime_readiness",
      "线上发布就绪",
      "fail",
      error?.name === "AbortError" ? "内部 readiness 检查超时" : error?.message ?? error,
      "检查内部密钥、部署版本、恢复 Worker 和运行日志"
    ));
    return { checks, readiness: null };
  }
}

export async function buildReleaseVerification(options = {}) {
  const staticAudit = await runStaticAudit();
  const checks = [staticAudit.check];
  let runtime = null;

  if (!options.staticOnly) {
    const database = await runDatabaseCheck();
    checks.push(database);
    const baseUrl = normalizeReleaseUrl(
      options.url ?? process.env.SCENECART_RELEASE_VERIFY_URL ?? process.env.APP_ORIGIN
    );
    if (!baseUrl) {
      checks.push(result(
        "release_url",
        "正式发布地址",
        "fail",
        "未提供有效的 SCENECART_RELEASE_VERIFY_URL 或 APP_ORIGIN",
        "设置 SCENECART_RELEASE_VERIFY_URL=https://正式域名"
      ));
    } else {
      checks.push(result(
        "release_url",
        "正式发布地址",
        isProductionReleaseUrl(baseUrl) ? "pass" : "fail",
        isProductionReleaseUrl(baseUrl)
          ? `正在验证 ${baseUrl}`
          : "完整发布验证只接受非本地 HTTPS 地址",
        "设置 SCENECART_RELEASE_VERIFY_URL=https://正式域名"
      ));
      runtime = await verifyRuntime(baseUrl, {
        timeoutMs: options.timeoutMs,
        secret: process.env.SCENECART_CRON_SECRET ?? ""
      });
      checks.push(...runtime.checks);
    }
  }

  const ready = checks.every((item) => !item.required || item.status === "pass");
  return {
    ready_for_release: ready,
    scope: options.staticOnly ? "static" : "full",
    target_origin: normalizeReleaseUrl(
      options.url ?? process.env.SCENECART_RELEASE_VERIFY_URL ?? process.env.APP_ORIGIN
    ),
    checks,
    static_audit: staticAudit.audit,
    runtime_readiness: runtime?.readiness ?? null,
    generated_at: new Date().toISOString()
  };
}

function printReport(report) {
  process.stdout.write(`SceneCart AI release verification (${report.scope})\n\n`);
  for (const item of report.checks) {
    process.stdout.write(`${item.status === "pass" ? "PASS" : "FAIL"}  ${item.label}: ${item.detail}\n`);
    if (item.remediation) process.stdout.write(`      下一步：${item.remediation}\n`);
  }
  process.stdout.write(`\n${report.ready_for_release ? "READY" : "NOT READY"}: ${
    report.ready_for_release ? "发布验证全部通过" : "仍有发布条件未满足"
  }\n`);
}

export async function main(args = process.argv.slice(2)) {
  loadEnvFile(".env");
  loadEnvFile(".env.local");
  const options = parseReleaseVerifyArgs(args);
  const report = await buildReleaseVerification(options);
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printReport(report);
  if (!report.ready_for_release) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`[release:verify] ${sanitizeReleaseDetail(error?.message ?? error)}\n`);
    process.exitCode = 1;
  });
}
