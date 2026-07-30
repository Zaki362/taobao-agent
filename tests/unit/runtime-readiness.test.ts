import { describe, expect, it } from "vitest";
import { inspectRuntimeReadiness } from "@/lib/runtime/readiness";

describe("production readiness", () => {
  it("fails closed when the application still uses development runtime settings", async () => {
    const readiness = await inspectRuntimeReadiness();
    const checks = new Map(readiness.checks.map((item) => [item.id, item]));

    expect(readiness.ready_for_production).toBe(false);
    expect(checks.get("runtime_store")?.status).toBe("fail");
    expect(checks.get("authentication")?.status).toBe("fail");
    expect(checks.get("executor_backend")?.status).toBe("pass");
    expect(checks.get("executor_online")?.status).toBe("warn");
  });
});
