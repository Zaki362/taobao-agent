import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectRuntimeReadiness } from "@/lib/runtime/readiness";
import { localRuntimeRepository, resetLocalRuntimeForTests } from "@/lib/runtime/local-repository";

const originalProductMode = process.env.SCENECART_PRODUCT_MODE;
const originalBackend = process.env.TAOBAO_EXECUTION_BACKEND;
const originalRecoverySecret = process.env.SCENECART_CRON_SECRET;
const originalRecoveryStaleMs = process.env.SCENECART_RECOVERY_STALE_MS;

beforeEach(() => {
  resetLocalRuntimeForTests();
  delete process.env.SCENECART_CRON_SECRET;
  delete process.env.SCENECART_RECOVERY_STALE_MS;
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
});

describe("production readiness", () => {
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
    expect(checks.get("executor_online")?.status).toBe("warn");
  });

  it("reports a blocked legacy backend without granting it formal execution rights", async () => {
    process.env.SCENECART_PRODUCT_MODE = "production";
    process.env.TAOBAO_EXECUTION_BACKEND = "qoder_cli";

    const readiness = await inspectRuntimeReadiness();
    const checks = new Map(readiness.checks.map((item) => [item.id, item]));

    expect(readiness.configured_executor_backend).toBe("qoder_cli");
    expect(readiness.effective_executor_backend).toBe("local_executor");
    expect(checks.get("executor_backend")?.status).toBe("fail");
    expect(checks.get("executor_backend")?.detail).toContain("已阻断配置的 backend=qoder_cli");
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
});
