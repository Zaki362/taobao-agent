import { describe, expect, it } from "vitest";
import { evaluateRuntimeHealth } from "@/lib/runtime/monitoring";
import { createSessionFixture } from "@/tests/fixtures/session";

function input() {
  return {
    jobs: {
      pending: 0,
      active: 0,
      completed: 0,
      failed: 0,
      oldest_pending_ms: 0
    },
    devices: { online: 0 },
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
});
