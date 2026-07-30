import { beforeEach, describe, expect, it } from "vitest";
import {
  getLlmTelemetrySnapshot,
  recordLlmCall,
  resetLlmTelemetryForTests
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
});
