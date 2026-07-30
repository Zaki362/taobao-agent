import { describe, expect, it } from "vitest";
import { reviewPlanWithAgent } from "@/lib/agent/plan-reviewer";
import { runDeepSeekPlanner } from "@/lib/agent/planner";
import { runSceneParser } from "@/lib/agent/scene";

const liveEvaluation = process.env.AGENT_EVAL_LIVE === "true";

const scenarios = [
  {
    name: "新能源提车实用首购",
    input: "刚提新能源车，预算1500，希望优先买最实用的新车用品，不考虑装饰类。",
    budget: 1500,
    expectedPriority: "实用优先",
    expectedVehicle: "新能源"
  },
  {
    name: "新手司机安全与整洁",
    input: "新手司机开轿车，预算2000，优先安全，也希望车内保持整洁。",
    budget: 2000,
    expectedPriority: "安全优先",
    expectedVehicle: "轿车"
  },
  {
    name: "第一阶段性价比必需品",
    input: "SUV刚提车，预算1000，只补齐第一阶段必需品，全部优先性价比，不买装饰。",
    budget: 1000,
    expectedPriority: "性价比优先",
    expectedVehicle: "SUV"
  }
];

describe(`new-car Agent quality gate (${liveEvaluation ? "live DeepSeek" : "deterministic fallback"})`, () => {
  it.each(scenarios)("keeps planning constraints for $name", async (scenario) => {
    const parsed = await runSceneParser(scenario.input, "new-car");
    const planned = await runDeepSeekPlanner(parsed.data);
    const reviewed = await reviewPlanWithAgent(parsed.data, planned.data);
    const modules = planned.data.modules;
    const keywords = modules.map((module) => module.search_strategy?.primary_keyword || module.search_keyword);
    const priorities = new Set(modules.map((module) => module.priority));
    const allocatedBudget = modules.reduce((sum, module) => sum + module.budget_allocation, 0);

    expect(parsed.data.budget).toBe(scenario.budget);
    expect(parsed.data.vehicle_type).toContain(scenario.expectedVehicle);
    expect(parsed.data.priority_style).toBe(scenario.expectedPriority);
    expect(modules.length).toBeGreaterThanOrEqual(3);
    expect(priorities.size).toBeGreaterThanOrEqual(2);
    expect(allocatedBudget).toBe(parsed.data.budget);
    expect(new Set(keywords).size).toBe(keywords.length);
    expect(keywords.every((keyword) => typeof keyword === "string" && keyword.trim().length >= 4)).toBe(true);
    expect(planned.data.execution_strategy.module_sequence).toEqual(modules.map((module) => module.module_id));
    expect(planned.data.agent_directives.safety_boundaries.some((item) => /确认|加购|支付/.test(item))).toBe(true);
    expect(reviewed.data.summary.trim().length).toBeGreaterThan(0);
    expect(
      reviewed.data.strengths.length +
      reviewed.data.risks.length +
      reviewed.data.improvement_suggestions.length
    ).toBeGreaterThan(0);

    if (liveEvaluation) {
      expect(parsed.mode === "connected" || planned.mode === "connected" || reviewed.mode === "connected").toBe(true);
    }
  });
});
