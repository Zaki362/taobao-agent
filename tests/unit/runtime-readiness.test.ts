import { afterEach, describe, expect, it } from "vitest";
import { inspectRuntimeReadiness } from "@/lib/runtime/readiness";

const originalProductMode = process.env.SCENECART_PRODUCT_MODE;
const originalBackend = process.env.TAOBAO_EXECUTION_BACKEND;

afterEach(() => {
  if (originalProductMode === undefined) delete process.env.SCENECART_PRODUCT_MODE;
  else process.env.SCENECART_PRODUCT_MODE = originalProductMode;
  if (originalBackend === undefined) delete process.env.TAOBAO_EXECUTION_BACKEND;
  else process.env.TAOBAO_EXECUTION_BACKEND = originalBackend;
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
});
