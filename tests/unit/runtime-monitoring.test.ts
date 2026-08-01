import { describe, expect, it } from "vitest";
import { evaluateRuntimeHealth } from "@/lib/runtime/monitoring";
import { createSessionFixture } from "@/tests/fixtures/session";

function input(): Parameters<typeof evaluateRuntimeHealth>[0] {
  return {
    jobs: {
      pending: 0,
      active: 0,
      completed: 0,
      failed: 0,
      oldest_pending_ms: 0,
      pending_by_type: { module_search: 0, add_to_cart: 0 }
    },
    devices: {
      online: 0,
      capabilities: {
        module_search: { online: 0 },
        add_to_cart: { online: 0 }
      }
    },
    llm: { calls: 0, connected: 0, fallback: 0 },
    agentRuntime: createSessionFixture().agent_runtime
  };
}

describe("runtime monitoring", () => {
  it("does not alert when an idle system has no executor", () => {
    const health = evaluateRuntimeHealth(input());
    expect(health.status).toBe("healthy");
    expect(health.incidents).toHaveLength(0);
  });

  it("raises a critical incident when queued work has no executor", () => {
    const state = input();
    state.jobs.pending = 2;
    state.jobs.oldest_pending_ms = 190_000;

    const health = evaluateRuntimeHealth(state);
    expect(health.status).toBe("critical");
    expect(health.incidents.map((item) => item.code)).toEqual(
      expect.arrayContaining(["executor_offline_with_work", "queue_stalled"])
    );
  });

  it("reports an online executor that cannot claim the queued job type", () => {
    const state = input();
    state.devices.online = 1;
    state.devices.capabilities!.module_search.online = 1;
    state.jobs.pending = 1;
    state.jobs.pending_by_type!.add_to_cart = 1;

    const health = evaluateRuntimeHealth(state);
    expect(health.status).toBe("critical");
    expect(health.incidents.map((item) => item.code)).toContain("cart_capability_unavailable");
    expect(health.incidents.map((item) => item.code)).not.toContain("executor_offline_with_work");
  });

  it("waits for enough samples before reporting failure and fallback rates", () => {
    const smallSample = input();
    smallSample.jobs.failed = 1;
    smallSample.llm = { calls: 1, connected: 0, fallback: 1 };
    expect(evaluateRuntimeHealth(smallSample).status).toBe("healthy");

    const meaningfulSample = input();
    meaningfulSample.jobs.completed = 3;
    meaningfulSample.jobs.failed = 1;
    meaningfulSample.llm = { calls: 5, connected: 3, fallback: 2 };
    const health = evaluateRuntimeHealth(meaningfulSample);
    expect(health.status).toBe("warning");
    expect(health.incidents.map((item) => item.code)).toEqual(
      expect.arrayContaining(["job_failure_rate_warning", "llm_fallback_warning"])
    );
  });

  it("reports repeated model proposal rejections", () => {
    const state = input();
    state.agentRuntime.model_proposals = 4;
    state.agentRuntime.model_rejections = 3;

    const health = evaluateRuntimeHealth(state);
    expect(health.status).toBe("warning");
    expect(health.incidents[0]?.code).toBe("agent_guardrail_rejections");
  });

  it("alerts when a configured workflow recovery scheduler is stale", () => {
    const state = input();
    state.workflowRecovery = {
      configured: true,
      state: "stale",
      last_heartbeat_at: "2026-01-01T00:00:00.000Z"
    };

    const health = evaluateRuntimeHealth(state);
    expect(health.status).toBe("critical");
    expect(health.incidents[0]?.code).toBe("workflow_recovery_offline");
  });

  it("treats a degraded recovery scan as an isolated warning", () => {
    const state = input();
    state.workflowRecovery = {
      configured: true,
      state: "degraded",
      last_heartbeat_at: new Date().toISOString()
    };

    const health = evaluateRuntimeHealth(state);
    expect(health.status).toBe("warning");
    expect(health.incidents[0]?.code).toBe("workflow_recovery_degraded");
  });
});
