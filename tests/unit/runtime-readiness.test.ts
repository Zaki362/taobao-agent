import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectRuntimeReadiness } from "@/lib/runtime/readiness";
import { localRuntimeRepository, resetLocalRuntimeForTests } from "@/lib/runtime/local-repository";
import { recordLlmCall, resetLlmTelemetryForTests } from "@/lib/llm/telemetry";

const originalProductMode = process.env.SCENECART_PRODUCT_MODE;
const originalBackend = process.env.TAOBAO_EXECUTION_BACKEND;
const originalRecoverySecret = process.env.SCENECART_CRON_SECRET;
const originalRecoveryStaleMs = process.env.SCENECART_RECOVERY_STALE_MS;
const originalMcpDebug = process.env.SCENECART_ENABLE_MCP_DEBUG;
const originalRuntimeStore = process.env.RUNTIME_STORE;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalAuthRequired = process.env.AUTH_REQUIRED;
const originalAccessMode = process.env.SCENECART_ACCESS_MODE;
const originalSingleUserId = process.env.SCENECART_SINGLE_USER_ID;
const originalVercelEnvironment = process.env.VERCEL_ENV;
const originalAuthCookieSecure = process.env.AUTH_COOKIE_SECURE;
const originalAppOrigin = process.env.APP_ORIGIN;

beforeEach(() => {
  resetLocalRuntimeForTests();
  resetLlmTelemetryForTests();
  delete process.env.SCENECART_CRON_SECRET;
  delete process.env.SCENECART_RECOVERY_STALE_MS;
  delete process.env.SCENECART_ENABLE_MCP_DEBUG;
  delete process.env.SCENECART_ACCESS_MODE;
  delete process.env.SCENECART_SINGLE_USER_ID;
  delete process.env.VERCEL_ENV;
});

afterEach(() => {
  if (originalProductMode === undefined) delete process.env.SCENECART_PRODUCT_MODE;
  else process.env.SCENECART_PRODUCT_MODE = originalProductMode;
  if (originalBackend === undefined) delete process.env.TAOBAO_EXECUTION_BACKEND;
  else process.env.TAOBAO_EXECUTION_BACKEND = originalBackend;
  if (originalRecoverySecret === undefined) delete process.env.SCENECART_CRON_SECRET;
  else process.env.SCENECART_CRON_SECRET = originalRecoverySecret;
  if (originalRecoveryStaleMs === undefined) delete process.env.SCENECART_RECOVERY_STALE_MS;
  else process.env.SCENECART_RECOVERY_STALE_MS = originalRecoveryStaleMs;
  if (originalMcpDebug === undefined) delete process.env.SCENECART_ENABLE_MCP_DEBUG;
  else process.env.SCENECART_ENABLE_MCP_DEBUG = originalMcpDebug;
  if (originalRuntimeStore === undefined) delete process.env.RUNTIME_STORE;
  else process.env.RUNTIME_STORE = originalRuntimeStore;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalAuthRequired === undefined) delete process.env.AUTH_REQUIRED;
  else process.env.AUTH_REQUIRED = originalAuthRequired;
  if (originalAccessMode === undefined) delete process.env.SCENECART_ACCESS_MODE;
  else process.env.SCENECART_ACCESS_MODE = originalAccessMode;
  if (originalSingleUserId === undefined) delete process.env.SCENECART_SINGLE_USER_ID;
  else process.env.SCENECART_SINGLE_USER_ID = originalSingleUserId;
  if (originalVercelEnvironment === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = originalVercelEnvironment;
  if (originalAuthCookieSecure === undefined) delete process.env.AUTH_COOKIE_SECURE;
  else process.env.AUTH_COOKIE_SECURE = originalAuthCookieSecure;
  if (originalAppOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = originalAppOrigin;
});

describe("production readiness", () => {
  it("recognizes a fixed Preview owner without marking the build production-ready", async () => {
    const ownerId = "11111111-1111-4111-8111-111111111111";
    const now = new Date().toISOString();
    await localRuntimeRepository.createUser({
      id: ownerId,
      email: "owner@example.com",
      password_hash: "unused",
      created_at: now,
      updated_at: now
    });
    process.env.SCENECART_ACCESS_MODE = "single_user";
    process.env.SCENECART_SINGLE_USER_ID = ownerId;
    process.env.VERCEL_ENV = "preview";

    const readiness = await inspectRuntimeReadiness(ownerId);
    const accessCheck = readiness.checks.find((item) => item.id === "authentication");

    expect(readiness.access_mode).toBe("single_user");
    expect(readiness.ready_for_production).toBe(false);
    expect(accessCheck).toMatchObject({
      status: "pass",
      detail: expect.stringContaining("固定 owner")
    });
  });

  it("fails closed when the application still uses development runtime settings", async () => {
    const readiness = await inspectRuntimeReadiness();
    const checks = new Map(readiness.checks.map((item) => [item.id, item]));

    expect(readiness.ready_for_production).toBe(false);
    expect(readiness.product_mode).toBe("development");
    expect(readiness.demo_cart_fallback).toBe(true);
    expect(checks.get("product_mode")?.status).toBe("fail");
    expect(checks.get("demo_cart_fallback")?.status).toBe("fail");
    expect(checks.get("runtime_store")?.status).toBe("fail");
    expect(checks.get("authentication")?.status).toBe("fail");
    expect(checks.get("workflow_recovery")?.status).toBe("fail");
    expect(checks.get("executor_backend")?.status).toBe("pass");
    expect(checks.has("search_provider")).toBe(false);
    expect(checks.get("mcp_debug_endpoint")?.status).toBe("pass");
    expect(checks.get("executor_online")?.status).toBe("warn");
    expect("operational_for_search" in readiness).toBe(false);
  });

  it("fails readiness when the manual MCP debug endpoint is configured", async () => {
    process.env.SCENECART_ENABLE_MCP_DEBUG = "true";

    const readiness = await inspectRuntimeReadiness();
    const debugCheck = readiness.checks.find((item) => item.id === "mcp_debug_endpoint");

    expect(debugCheck?.status).toBe("fail");
    expect(readiness.mcp_debug_enabled).toBe(true);
  });

  it("reports a blocked legacy backend without granting it formal execution rights", async () => {
    process.env.SCENECART_PRODUCT_MODE = "production";
    process.env.TAOBAO_EXECUTION_BACKEND = "qoder_cli";

    const readiness = await inspectRuntimeReadiness();
    const checks = new Map(readiness.checks.map((item) => [item.id, item]));

    expect(readiness.configured_executor_backend).toBe("qoder_cli");
    expect(readiness.effective_executor_backend).toBe("local_executor");
    expect(checks.get("executor_backend")?.status).toBe("fail");
    expect(checks.get("executor_backend")?.detail).toContain("已阻断已退役或当前模式不允许的 backend=qoder_cli");
  });

  it("does not mistake production safety overrides for valid deployment configuration", async () => {
    process.env.SCENECART_PRODUCT_MODE = "production";
    process.env.RUNTIME_STORE = "local";
    delete process.env.DATABASE_URL;
    process.env.AUTH_REQUIRED = "false";
    process.env.AUTH_COOKIE_SECURE = "false";
    process.env.APP_ORIGIN = "https://scenecart.example.com";

    const readiness = await inspectRuntimeReadiness("misconfigured-production-user");
    const checks = new Map(readiness.checks.map((item) => [item.id, item]));

    expect(readiness.ready_for_production).toBe(false);
    expect(checks.get("runtime_store")?.status).toBe("fail");
    expect(checks.get("authentication")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("已强制账号隔离")
    });
    expect(checks.get("secure_cookie")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("已强制使用 Secure Cookie")
    });
    expect(checks.get("executor_online")?.detail).toContain("正式运行时配置未通过");
  });

  it("does not report full shopping operations when only search capability is online", async () => {
    const now = new Date().toISOString();
    await localRuntimeRepository.createDevice({
      id: "search-only-device",
      user_id: "capability-user",
      name: "search only",
      token_hash: "search-only-token",
      capabilities: ["module_search"],
      status: "online",
      last_heartbeat_at: now,
      created_at: now,
      updated_at: now
    });

    const readiness = await inspectRuntimeReadiness("capability-user");
    const checks = new Map(readiness.checks.map((item) => [item.id, item]));
    expect(checks.get("executor_online")?.status).toBe("pass");
    expect(checks.get("executor_search_capability")?.status).toBe("pass");
    expect(checks.get("executor_cart_capability")?.status).toBe("warn");
    expect(readiness.executor_capabilities.capabilities.module_search.available).toBe(true);
    expect(readiness.executor_capabilities.capabilities.add_to_cart.available).toBe(false);
    expect(readiness.operational_for_shopping).toBe(false);
  });

  it("reports a responsive MCP reconnect without advertising local search readiness", async () => {
    const now = new Date().toISOString();
    await localRuntimeRepository.createDevice({
      id: "mcp-reconnecting-device",
      user_id: "mcp-reconnecting-user",
      name: "MCP reconnecting",
      token_hash: "mcp-reconnecting-token",
      capabilities: ["module_search", "add_to_cart"],
      status: "mcp_unavailable",
      last_heartbeat_at: now,
      created_at: now,
      updated_at: now
    });

    const readiness = await inspectRuntimeReadiness("mcp-reconnecting-user");
    const checks = new Map(readiness.checks.map((item) => [item.id, item]));

    expect(readiness.executor_capabilities.mcp_unavailable).toBe(1);
    expect(readiness.executor_capabilities.capabilities.module_search.available).toBe(false);
    expect(checks.get("executor_online")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("等待淘宝桌面版工具恢复"),
      remediation: expect.stringContaining("executor:doctor")
    });
    expect(checks.get("executor_search_capability")?.status).toBe("warn");
    expect(readiness.operational_for_shopping).toBe(false);
  });

  it("requires evidence that the configured recovery scheduler is actually running", async () => {
    process.env.SCENECART_CRON_SECRET = "readiness-recovery-secret-with-at-least-32-characters";

    const missing = await inspectRuntimeReadiness();
    expect(missing.checks.find((item) => item.id === "workflow_recovery")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("尚未收到")
    });

    await localRuntimeRepository.recordServiceHeartbeat({
      service_name: "workflow_recovery",
      status: "healthy",
      metadata: { scanned: 0, recovered: 0, failed: 0 },
      checked_at: new Date().toISOString()
    });
    const healthy = await inspectRuntimeReadiness();
    expect(healthy.checks.find((item) => item.id === "workflow_recovery")?.status).toBe("pass");
    expect(healthy.workflow_recovery.state).toBe("healthy");
  });

  it("fails readiness when the recovery scheduler heartbeat is stale", async () => {
    process.env.SCENECART_CRON_SECRET = "readiness-recovery-secret-with-at-least-32-characters";
    process.env.SCENECART_RECOVERY_STALE_MS = "60000";
    await localRuntimeRepository.recordServiceHeartbeat({
      service_name: "workflow_recovery",
      status: "healthy",
      metadata: {},
      checked_at: new Date(Date.now() - 120_000).toISOString()
    });

    const readiness = await inspectRuntimeReadiness();
    expect(readiness.checks.find((item) => item.id === "workflow_recovery")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("已过期")
    });
    expect(readiness.workflow_recovery.state).toBe("stale");
  });

  it("does not confuse a configured DeepSeek key with verified model execution", async () => {
    const originalKey = process.env.DEEPSEEK_API_KEY;
    const originalDisabled = process.env.DEEPSEEK_DISABLED;
    process.env.DEEPSEEK_API_KEY = "test-key-never-sent";
    delete process.env.DEEPSEEK_DISABLED;
    try {
      const unverified = await inspectRuntimeReadiness();
      expect(unverified.checks.find((item) => item.id === "deepseek_runtime")).toMatchObject({
        status: "warn",
        detail: expect.stringContaining("尚未产生真实调用证据")
      });
      expect(unverified.llm_runtime.state).toBe("unverified");

      recordLlmCall({
        task: "parse_scene",
        model: "deepseek-chat",
        mode: "connected",
        durationMs: 100
      });
      const connected = await inspectRuntimeReadiness();
      expect(connected.checks.find((item) => item.id === "deepseek_runtime")?.status).toBe("pass");
      expect(connected.llm_runtime.state).toBe("connected");
    } finally {
      if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = originalKey;
      if (originalDisabled === undefined) delete process.env.DEEPSEEK_DISABLED;
      else process.env.DEEPSEEK_DISABLED = originalDisabled;
    }
  });
});
