import { afterEach, describe, expect, it, vi } from "vitest";
import { parseScene } from "@/lib/llm/deepseek";
import {
  appendSessionLlmCalls,
  markSessionLlmCallFallback,
  sessionLlmSummary,
  sessionLlmTelemetrySnapshot
} from "@/lib/llm/session-evidence";
import { normalizeSessionState } from "@/lib/session/store";
import type { SessionLlmCall } from "@/lib/session/types";
import { createSessionFixture } from "@/tests/fixtures/session";

function call(overrides: Partial<SessionLlmCall> = {}): SessionLlmCall {
  return {
    id: "llm-call-1",
    task: "personalize_template",
    model: "deepseek-chat",
    mode: "connected",
    duration_ms: 120,
    created_at: new Date().toISOString(),
    ...overrides
  };
}

describe("session LLM evidence", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns privacy-safe fallback evidence without prompt or user content", async () => {
    vi.stubEnv("DEEPSEEK_DISABLED", "true");
    const sensitiveInput = "预算1500，不考虑装饰类，测试隐私原文";
    const result = await parseScene(sensitiveInput, "new-car");

    expect(result.mode).toBe("mock");
    expect(result.call).toMatchObject({
      task: "parse_scene",
      mode: "fallback",
      reason: "explicitly_disabled"
    });
    expect(JSON.stringify(result.call)).not.toContain(sensitiveInput);
    expect(Object.keys(result.call).sort()).toEqual([
      "created_at",
      "duration_ms",
      "id",
      "mode",
      "model",
      "reason",
      "task"
    ]);
  });

  it("derives durable metrics from only the supplied session calls", () => {
    const first = call({ task: "parse_scene", mode: "connected", duration_ms: 100 });
    const fallback = {
      ...call({ task: "parse_scene", mode: "fallback" }),
      id: "fallback-call",
      duration_ms: 900,
      reason: "timeout",
      created_at: "2026-08-19T00:00:00.000Z"
    };
    const review = {
      ...call({ task: "review_candidates", mode: "connected" }),
      id: "review-call",
      duration_ms: 300,
      created_at: "2026-08-19T00:00:01.000Z"
    };

    expect(sessionLlmTelemetrySnapshot([first, fallback, review])).toMatchObject({
      calls: 3,
      connected: 2,
      fallback: 1,
      tasks: expect.arrayContaining([
        expect.objectContaining({
          task: "parse_scene",
          calls: 2,
          connected: 1,
          fallback: 1,
          p95_duration_ms: 900,
          last_reason: "timeout"
        }),
        expect.objectContaining({ task: "review_candidates", calls: 1, connected: 1 })
      ])
    });
    expect(sessionLlmTelemetrySnapshot([])).toEqual({
      calls: 0,
      connected: 0,
      fallback: 0,
      tasks: []
    });
  });

  it("deduplicates evidence and upgrades the session status only on a real call", () => {
    const state = createSessionFixture();
    const fallback = call({ mode: "fallback", reason: "timeout" });
    appendSessionLlmCalls(state, fallback, fallback);
    expect(state.llm_calls).toHaveLength(1);
    expect(state.deepseek_status).toBe("mock");

    appendSessionLlmCalls(state, call({ id: "llm-call-2", task: "review_plan" }));
    expect(state.llm_calls).toHaveLength(2);
    expect(state.deepseek_status).toBe("connected");
    expect(sessionLlmSummary(state.llm_calls)).toMatchObject({
      calls: 2,
      connected: 1,
      fallback: 1
    });
  });

  it("filters malformed persisted evidence while restoring a session", () => {
    const state = createSessionFixture();
    state.llm_calls = [call(), { id: "bad" } as SessionLlmCall];

    const normalized = normalizeSessionState(state);

    expect(normalized.llm_calls).toEqual([expect.objectContaining({ id: "llm-call-1" })]);
  });

  it("marks a connected proposal as fallback when a later guardrail rejects it", () => {
    const state = createSessionFixture();
    appendSessionLlmCalls(state, call());

    expect(markSessionLlmCallFallback(state, "llm-call-1", "guardrail_rejected:low_confidence")).toBe(true);
    expect(state.llm_calls[0]).toMatchObject({
      mode: "fallback",
      reason: "guardrail_rejected:low_confidence"
    });
    expect(state.deepseek_status).toBe("mock");
  });
});
