import { beforeEach, describe, expect, it } from "vitest";
import { reviewPlanWithAgent } from "@/lib/agent/plan-reviewer";
import { reviewModuleCandidatesWithAgent } from "@/lib/agent/candidate-reviewer";
import { runDeepSeekPlanner } from "@/lib/agent/planner";
import { decideNextAgentActionV2 } from "@/lib/agent/runtime-v2";
import { runSceneParser } from "@/lib/agent/scene";
import {
  getLlmTelemetrySnapshot,
  resetLlmTelemetryForTests
} from "@/lib/llm/telemetry";
import { createSessionFixture } from "@/tests/fixtures/session";
import { buildPolicyPurchaseBundle } from "@/lib/agent/purchase-bundle";

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
  beforeEach(() => {
    resetLlmTelemetryForTests();
    if (liveEvaluation && !process.env.DEEPSEEK_API_KEY) {
      throw new Error("在线 Agent 评测缺少 DEEPSEEK_API_KEY，未执行真实模型调用");
    }
  });

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
      const telemetry = getLlmTelemetrySnapshot();
      const diagnostics = `DeepSeek 降级详情：${JSON.stringify(telemetry.tasks)}`;
      expect(parsed.mode, diagnostics).toBe("connected");
      expect(planned.mode, diagnostics).toBe("connected");
      expect(reviewed.mode, diagnostics).toBe("connected");
    }
  });

  it("keeps the final suggested bundle inside hard purchase guardrails", () => {
    const state = createSessionFixture();
    for (const [moduleIndex, module] of state.shopping_plan.modules.entries()) {
      state.module_candidates[module.module_id] = (["稳妥推荐", "性价比推荐", "升级推荐"] as const).map(
        (recommendationType, candidateIndex) => ({
          product_id: `${module.module_id}-${candidateIndex}`,
          title: `${module.module_name}评测候选${candidateIndex + 1}`,
          price: 80 + moduleIndex * 10 + candidateIndex * 40,
          source: "evaluation",
          shop_name: "评测旗舰店",
          image_url: "https://example.com/bundle.jpg",
          detail_url: `https://item.taobao.com/item.htm?id=${module.module_id}-${candidateIndex}`,
          shop_badges: ["旗舰店"],
          highlights: ["规格明确"],
          risk_notes: ["需确认适配"],
          fit_reason: "候选与模块目标和当前预算匹配。",
          recommendation_type: recommendationType,
          module_id: module.module_id
        })
      );
    }

    const bundle = buildPolicyPurchaseBundle(state);
    const knownIds = new Set(Object.values(state.module_candidates).flat().map((item) => item.product_id));

    expect(bundle.estimated_total).toBeLessThanOrEqual(state.scene_brief.budget);
    expect(new Set(bundle.items.map((item) => item.module_id)).size).toBe(bundle.items.length);
    expect(new Set(bundle.items.map((item) => item.product_id)).size).toBe(bundle.items.length);
    expect(bundle.items.every((item) => knownIds.has(item.product_id))).toBe(true);
    expect(bundle.critical_selected_module_ids.length).toBe(bundle.critical_module_ids.length);
  });

  it.runIf(liveEvaluation)("uses DeepSeek chat for a routine guarded runtime decision", async () => {
    const state = createSessionFixture();
    state.shopping_plan.agent_directives.autonomy_level = "探索执行";
    const decision = await decideNextAgentActionV2(state);
    const telemetry = getLlmTelemetrySnapshot();

    expect(decision.source, `Runtime 决策降级：${JSON.stringify(telemetry.tasks)}`).toBe("deepseek_runtime");
    expect(decision.action).toBe("search_module");
    expect(state.shopping_plan.modules.some((module) => module.module_id === decision.module_id)).toBe(true);
    expect(state.agent_runtime.model_decisions).toBe(1);
    expect(state.agent_runtime.model_rejections).toBe(0);
    expect(telemetry.tasks.find((task) => task.task === "decide_next_action")?.model).toBe("deepseek-chat");
  });

  it.runIf(liveEvaluation)("uses DeepSeek reasoner when candidate evidence requires recovery", async () => {
    const state = createSessionFixture();
    const module = state.shopping_plan.modules[0];
    const primaryKeyword = module.search_strategy?.primary_keyword ?? module.search_keyword ?? module.module_name;
    state.shopping_plan.agent_directives.autonomy_level = "探索执行";
    state.shopping_plan.agent_directives.search_depth = "标准搜索";
    state.module_candidates[module.module_id] = [{
      product_id: "recovery-candidate",
      title: `${module.module_name} 候选`,
      price: module.budget_allocation,
      source: "evaluation",
      shop_name: "评测店铺",
      image_url: "https://example.com/product.jpg",
      detail_url: "https://item.taobao.com/item.htm?id=recovery-candidate",
      shop_badges: ["旗舰店"],
      highlights: ["基础功能"],
      risk_notes: ["候选数量不足"],
      fit_reason: "符合模块基础意图",
      recommendation_type: "稳妥推荐",
      module_id: module.module_id
    }];
    state.module_reviews[module.module_id] = {
      module_id: module.module_id,
      status: "thin",
      source: "deepseek",
      summary: "当前只有一条候选，覆盖不足。",
      strengths: ["模块相关"],
      caveats: ["缺少价格档位"],
      next_action: "使用更具体的功能词补搜。",
      suggested_keyword: `${primaryKeyword} 夜视 停车监控`,
      generated_at: new Date().toISOString()
    };
    state.module_search_traces[module.module_id] = {
      module_id: module.module_id,
      module_name: module.module_name,
      status: "thin",
      primary_keyword: primaryKeyword,
      searched_keywords: [primaryKeyword],
      attempts: [],
      result_count: 1,
      candidate_count: 1,
      review_status: "thin",
      review_summary: "当前只有一条候选，覆盖不足。",
      ai_decision_summary: "候选池需要恢复搜索。",
      next_action: "补搜",
      generated_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const decision = await decideNextAgentActionV2(state);
    const telemetry = getLlmTelemetrySnapshot();

    expect(decision.source, `Runtime 恢复决策降级：${JSON.stringify(telemetry.tasks)}`).toBe("deepseek_runtime");
    expect(decision.action).toBe("retry_module");
    expect(decision.module_id).toBe(module.module_id);
    expect(decision.keyword_override).not.toBe(primaryKeyword);
    expect(telemetry.tasks.find((task) => task.task === "decide_next_action")?.model).toBe("deepseek-reasoner");
  });

  it.runIf(liveEvaluation)("generates bounded product-specific reasons in one candidate review call", async () => {
    const state = createSessionFixture();
    const module = state.shopping_plan.modules[0];
    const fallbackReason = "评测占位规则理由";
    const candidates = [
      {
        product_id: "eval-stable",
        title: "新能源车高清夜视行车记录仪",
        price: 199,
        source: "evaluation",
        shop_name: "品牌旗舰店",
        image_url: "https://example.com/stable.jpg",
        detail_url: "https://item.taobao.com/item.htm?id=eval-stable",
        shop_badges: ["旗舰店"],
        highlights: ["高清夜视", "安装便捷"],
        risk_notes: ["需确认车型和安装方式"],
        fit_reason: fallbackReason,
        recommendation_type: "稳妥推荐" as const,
        module_id: module.module_id
      },
      {
        product_id: "eval-value",
        title: "入门级高清行车记录仪",
        price: 129,
        source: "evaluation",
        shop_name: "车品专营店",
        image_url: "https://example.com/value.jpg",
        detail_url: "https://item.taobao.com/item.htm?id=eval-value",
        shop_badges: ["精选"],
        highlights: ["基础录像", "价格较低"],
        risk_notes: ["需确认夜视效果"],
        fit_reason: fallbackReason,
        recommendation_type: "性价比推荐" as const,
        module_id: module.module_id
      },
      {
        product_id: "eval-upgrade",
        title: "前后双录停车监控行车记录仪",
        price: 399,
        source: "evaluation",
        shop_name: "官方旗舰店",
        image_url: "https://example.com/upgrade.jpg",
        detail_url: "https://item.taobao.com/item.htm?id=eval-upgrade",
        shop_badges: ["官方", "旗舰店"],
        highlights: ["前后双录", "停车监控"],
        risk_notes: ["需确认取电与安装成本"],
        fit_reason: fallbackReason,
        recommendation_type: "升级推荐" as const,
        module_id: module.module_id
      }
    ];

    const assessment = await reviewModuleCandidatesWithAgent(state, module, candidates);
    const telemetry = getLlmTelemetrySnapshot();
    const diagnostics = `DeepSeek 候选复盘降级详情：${JSON.stringify(telemetry.tasks)}`;

    expect(assessment.mode, diagnostics).toBe("connected");
    expect(assessment.review.source).toBe("deepseek");
    expect(assessment.candidates).toHaveLength(candidates.length);
    expect(assessment.candidates.every((candidate) => candidate.fit_reason !== fallbackReason)).toBe(true);
    expect(new Set(assessment.candidates.map((candidate) => candidate.product_id))).toEqual(
      new Set(candidates.map((candidate) => candidate.product_id))
    );
    expect(telemetry.tasks.find((task) => task.task === "review_candidates")?.model).toBe("deepseek-chat");
  });

  it.runIf(liveEvaluation)("adds a bounded adaptive module for an explicit child travel need", async () => {
    const parsed = await runSceneParser(
      "刚提新能源 SUV，预算 3000，经常带 3 岁孩子长途出行，已有行车记录仪，希望优先准备儿童乘车安全用品。",
      "new-car"
    );
    const planned = await runDeepSeekPlanner(parsed.data);
    const adaptiveModules = planned.data.modules.filter((module) => module.origin === "ai_adaptive");
    const allocatedBudget = planned.data.modules.reduce((sum, module) => sum + module.budget_allocation, 0);
    const telemetry = getLlmTelemetrySnapshot();
    const diagnostics = `DeepSeek 自适应模块降级详情：${JSON.stringify(telemetry.tasks)}`;

    expect(parsed.mode, diagnostics).toBe("connected");
    expect(planned.mode, diagnostics).toBe("connected");
    expect(adaptiveModules.length).toBeGreaterThanOrEqual(1);
    expect(adaptiveModules.length).toBeLessThanOrEqual(2);
    expect(adaptiveModules.every((module) => module.module_id.startsWith("adaptive-") && module.optional === true)).toBe(true);
    expect(adaptiveModules.some((module) => /儿童|安全座椅|增高垫/.test(`${module.module_name}${module.typical_item_types.join(" ")}`))).toBe(true);
    expect(allocatedBudget).toBe(parsed.data.budget);
  });
});
