import { describe, expect, it } from "vitest";
import {
  buildDashboardPersistenceSnapshot,
  restoreDashboardSnapshot,
  toRestorableStage
} from "@/components/dashboard-workflow";

describe("new-car workflow persistence", () => {
  it("restores interrupted execution to review rather than restarting", () => {
    expect(toRestorableStage({
      stage: "searching",
      hasSession: true,
      hasParsedScene: true,
      hasScenario: true
    })).toBe("review_results");
  });

  it("persists and restores the active new-car session", () => {
    const snapshot = buildDashboardPersistenceSnapshot({
      stage: "confirm_plan",
      selectedScenario: "new-car",
      sceneInput: "刚提新能源车，预算 1500",
      parsedScene: null,
      parseDeepSeekMode: "mock",
      sessionId: "session-persisted",
      selectedModuleId: "safety-essential",
      expandedLogs: false,
      expandedModel: false,
      statusMessage: "规划待确认",
      searchSummary: []
    });
    const restored = restoreDashboardSnapshot(JSON.stringify(snapshot), "fallback");
    expect(restored?.sessionId).toBe("session-persisted");
    expect(restored?.stage).toBe("confirm_plan");
    expect(restored?.selectedScenario).toBe("new-car");
  });
});
