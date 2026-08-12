import { describe, expect, it } from "vitest";
import {
  buildDashboardPersistenceSnapshot,
  resolveHydratedSessionStage,
  restoreDashboardSnapshot,
  toRestorableStage
} from "@/components/dashboard-workflow";
import { createSessionFixture } from "@/tests/fixtures/session";

describe("shopping workflow persistence", () => {
  it("restores interrupted execution to review rather than restarting", () => {
    expect(toRestorableStage({
      stage: "searching",
      hasSession: true,
      hasParsedScene: true,
      hasScenario: true
    })).toBe("searching");
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

  it("persists a non-car scenario selection before a session is created", () => {
    const snapshot = buildDashboardPersistenceSnapshot({
      stage: "input_requirement",
      selectedScenario: "camping",
      sceneInput: "双人露营，预算 2000",
      parsedScene: null,
      parseDeepSeekMode: null,
      sessionId: null,
      selectedModuleId: "",
      expandedLogs: false,
      expandedModel: false,
      statusMessage: "等待提交",
      searchSummary: []
    });
    const restored = restoreDashboardSnapshot(JSON.stringify(snapshot), "fallback");

    expect(restored?.selectedScenario).toBe("camping");
    expect(restored?.stage).toBe("input_requirement");
    expect(restored?.sceneInput).toContain("双人露营");
  });

  it("overrides a stale cart snapshot when the hydrated plan needs confirmation", () => {
    const state = createSessionFixture();
    state.agent_runtime.workflow_status = "idle";
    state.module_candidates[state.shopping_plan.modules[0].module_id] = [];
    state.last_refinement = {
      quick_action: "应用市场预算建议",
      summary: "两个模块需按新预算重新搜索",
      impacted_modules: state.shopping_plan.modules.slice(0, 2).map((module) => module.module_id),
      reusable_modules: [],
      removed_modules: [],
      module_decisions: [],
      generated_at: "2026-08-12T00:00:00.000Z"
    };

    expect(resolveHydratedSessionStage("cart_review", state)).toBe("confirm_plan");
  });

  it("keeps the completed search summary visible when it finished in the background", () => {
    const state = createSessionFixture();
    state.agent_runtime.workflow_status = "completed";

    expect(resolveHydratedSessionStage("searching", state)).toBe("searching");
  });
});
