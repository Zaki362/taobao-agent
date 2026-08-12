import { beforeEach, describe, expect, it } from "vitest";
import {
  downgradeLastLlmCall,
  getLlmTelemetrySnapshot,
  recordLlmCall,
  resetLlmTelemetryForTests,
  summarizeLlmRuntimeStatus
} from "@/lib/llm/telemetry";

describe("LLM telemetry", () => {
  beforeEach(() => resetLlmTelemetryForTests());

  it("records only operational metadata and aggregates fallback latency", () => {
    recordLlmCall({ task: "parse_scene", model: "deepseek-chat", mode: "connected", durationMs: 120 });
    recordLlmCall({ task: "parse_scene", model: "deepseek-chat", mode: "mock", durationMs: 300, reason: "timeout" });
    const snapshot = getLlmTelemetrySnapshot();
    expect(snapshot.calls).toBe(2);
    expect(snapshot.connected).toBe(1);
    expect(snapshot.fallback).toBe(1);
    expect(snapshot.tasks[0]).toMatchObject({
      task: "parse_scene",
      average_duration_ms: 210,
      last_reason: "timeout"
    });
    expect(JSON.stringify(snapshot)).not.toContain("Scene Brief");
  });

  it("counts schema-invalid connected responses as fallback", () => {
    recordLlmCall({ task: "personalize_template", model: "deepseek-chat", mode: "connected", durationMs: 80 });
    downgradeLastLlmCall("personalize_template", "schema_validation_failed:missing_modules");
    const snapshot = getLlmTelemetrySnapshot();
    expect(snapshot).toMatchObject({ calls: 1, connected: 0, fallback: 1 });
    expect(snapshot.tasks[0].last_reason).toBe("schema_validation_failed:missing_modules");
  });

  it("distinguishes configured-but-unverified, connected and degraded runtime evidence", () => {
    expect(summarizeLlmRuntimeStatus()).toMatchObject({ state: "unverified", calls: 0 });

    recordLlmCall({ task: "parse_scene", model: "deepseek-chat", mode: "connected", durationMs: 120 });
    expect(summarizeLlmRuntimeStatus()).toMatchObject({
      state: "connected",
      calls: 1,
      connected: 1,
      last_task: "parse_scene",
      last_model: "deepseek-chat"
    });

    recordLlmCall({ task: "review_plan", model: "deepseek-chat", mode: "mock", durationMs: 300, reason: "timeout" });
    expect(summarizeLlmRuntimeStatus()).toMatchObject({
      state: "degraded",
      calls: 2,
      connected: 1,
      fallback: 1,
      last_task: "review_plan",
      last_reason: "timeout"
    });
  });

  it("reports unavailable when every real model attempt falls back", () => {
    recordLlmCall({ task: "parse_scene", model: "deepseek-chat", mode: "mock", durationMs: 40, reason: "http_401" });
    expect(summarizeLlmRuntimeStatus()).toMatchObject({
      state: "unavailable",
      calls: 1,
      connected: 0,
      fallback: 1,
      last_reason: "http_401"
    });
  });
});
