import { describe, expect, it } from "vitest";
import { normalizeAgentDirectives, normalizeSceneBrief, normalizeShoppingPlan } from "@/lib/llm/deepseek";
import { validateCandidateReviewOutput, validateShoppingPlanOutput } from "@/lib/llm/validation";
import { mockParseScene, mockPersonalizeTemplate } from "@/lib/llm/mock";
import { NEW_CAR_SETUP_TEMPLATE } from "@/lib/templates/new-car-template";
import { newCarScenario } from "@/lib/scenarios/new-car";

function modelPlan() {
  return structuredClone(mockPersonalizeTemplate(
    mockParseScene("新能源车预算 1500，实用优先"),
    NEW_CAR_SETUP_TEMPLATE
  )) as unknown as Record<string, unknown>;
}

function adaptiveModule(id = "adaptive-child-safety") {
  return {
    module_id: id,
    module_name: "儿童安全出行",
    description: "为三岁儿童补充乘车约束与后排防护用品。",
    default_priority: 88,
    default_budget_ratio: 0.15,
    typical_item_types: ["儿童安全座椅", "儿童增高垫", "后排遮阳帘"],
    optional: true,
    priority: 2,
    budget_allocation: 300,
    rationale: "用户明确说明会长期携带三岁儿童。",
    recommendation_strategy: "优先核对年龄体重范围、接口类型和认证信息。",
    search_keyword: "新能源车 儿童安全座椅 ISOFIX 3岁",
    search_strategy: {
      primary_keyword: "新能源车 儿童安全座椅 ISOFIX 3岁",
      alternate_keywords: ["3岁 儿童安全座椅 汽车", "ISOFIX 儿童座椅"],
      include_terms: ["儿童安全座椅", "ISOFIX"],
      exclude_terms: [],
      ranking_focus: ["适龄范围", "接口适配", "认证信息"],
      must_have_signals: ["适用年龄", "安装接口"],
      reject_signals: ["规格不明"],
      quality_checks: ["规格明确", "店铺信息明确"],
      price_band: "300-800 元",
      reasoning: "先核对年龄和车辆接口，再比较价格。",
      failure_recovery: "改用年龄和接口组合词补搜。"
    },
    status: "ready"
  };
}

function adaptiveOptions() {
  const policy = newCarScenario.adaptive_module_policy!;
  return {
    maxAdaptiveModules: policy.max_modules,
    adaptiveIdPrefix: policy.id_prefix,
    prohibitedTerms: policy.prohibited_terms
  };
}

describe("DeepSeek shopping plan validation", () => {
  it("preserves the user's original context when model notes omit a special need", () => {
    const fallback = mockParseScene("新能源 SUV，预算 3000，经常带 3 岁孩子长途出行");
    const normalized = normalizeSceneBrief({
      ...fallback,
      optional_notes: "无额外说明"
    }, fallback);

    expect(normalized.optional_notes).toContain("3 岁孩子长途出行");
  });

  it("accepts recoverable list variations that normalization can safely fill", () => {
    const plan = modelPlan();
    const modules = plan.modules as Array<Record<string, unknown>>;
    const strategy = modules[0].search_strategy as Record<string, unknown>;
    strategy.alternate_keywords = "新能源车 行车记录仪 夜视，新能源车 记录仪 停车监控";
    delete strategy.quality_checks;

    expect(validateShoppingPlanOutput(plan, NEW_CAR_SETUP_TEMPLATE)).toEqual({ valid: true });
  });

  it("accepts a compact model strategy delta and fills mechanical fields from the template plan", () => {
    const fallback = mockPersonalizeTemplate(
      mockParseScene("新能源车预算 1500，实用优先"),
      NEW_CAR_SETUP_TEMPLATE
    );
    const compactPlan = {
      overall_rationale: "优先补齐高频实用品。",
      personalization_summary: "已按预算调整模块。",
      execution_strategy: {
        module_sequence: fallback.modules.map((module) => module.module_id),
        budget_guardrails: ["总额不超过预算"],
        tradeoffs: ["装饰后置"],
        search_notes: ["按模块分别检索"],
        stop_rules: ["三档候选齐备即停止"]
      },
      agent_directives: fallback.agent_directives,
      modules: fallback.modules.map((module) => ({
        module_id: module.module_id,
        priority: module.priority,
        budget_allocation: module.budget_allocation,
        rationale: module.rationale,
        recommendation_strategy: module.recommendation_strategy,
        search_strategy: {
          primary_keyword: module.search_strategy?.primary_keyword,
          alternate_keywords: module.search_strategy?.alternate_keywords.slice(0, 2),
          ranking_focus: module.search_strategy?.ranking_focus.slice(0, 2),
          must_have_signals: module.search_strategy?.must_have_signals.slice(0, 2),
          reject_signals: module.search_strategy?.reject_signals.slice(0, 2),
          reasoning: module.search_strategy?.reasoning
        }
      }))
    };

    expect(validateShoppingPlanOutput(compactPlan, NEW_CAR_SETUP_TEMPLATE)).toEqual({ valid: true });
    const normalized = normalizeShoppingPlan(compactPlan, fallback, NEW_CAR_SETUP_TEMPLATE);
    expect(normalized.modules[0].module_name).toBe(fallback.modules[0].module_name);
    expect(normalized.modules[0].search_strategy?.include_terms.length).toBeGreaterThan(0);
    expect(normalized.modules[0].search_strategy?.quality_checks.length).toBeGreaterThan(0);
    expect(normalized.modules[0].search_strategy?.failure_recovery).toBeTruthy();
  });

  it("still rejects modules outside the scenario template", () => {
    const plan = modelPlan();
    const modules = plan.modules as Array<Record<string, unknown>>;
    modules[0].module_id = "untrusted-external-module";

    expect(validateShoppingPlanOutput(plan, NEW_CAR_SETUP_TEMPLATE)).toMatchObject({
      valid: false
    });
  });

  it("accepts model safety lists only when they are structurally usable", () => {
    const plan = modelPlan();
    const directives = plan.agent_directives as Record<string, unknown>;
    directives.safety_boundaries = "不读取账号隐私，不自动付款";
    directives.user_confirmation_points = "加入购物车前确认";

    expect(validateShoppingPlanOutput(plan, NEW_CAR_SETUP_TEMPLATE)).toEqual({ valid: true });
  });

  it("never lets model directives remove mandatory confirmation boundaries", () => {
    const plan = modelPlan();
    const fallback = plan.agent_directives as Parameters<typeof normalizeAgentDirectives>[1];
    const normalized = normalizeAgentDirectives({
      safety_boundaries: ["新增：不要读取浏览历史"],
      user_confirmation_points: ["新增：打开外部页面前确认"]
    }, fallback);

    expect(normalized.safety_boundaries).toContain("新增：不要读取浏览历史");
    expect(normalized.safety_boundaries.some((item) => /支付|下单/.test(item))).toBe(true);
    expect(normalized.user_confirmation_points.some((item) => /加购|购物车/.test(item))).toBe(true);
  });

  it("accepts and normalizes a bounded AI adaptive module", () => {
    const fallback = mockPersonalizeTemplate(
      mockParseScene("新能源车预算 2000，实用优先"),
      NEW_CAR_SETUP_TEMPLATE
    );
    const plan = structuredClone(fallback) as unknown as Record<string, unknown>;
    const modules = plan.modules as Array<Record<string, unknown>>;
    modules.push(adaptiveModule());
    const execution = plan.execution_strategy as Record<string, unknown>;
    (execution.module_sequence as string[]).push("adaptive-child-safety");

    expect(validateShoppingPlanOutput(plan, NEW_CAR_SETUP_TEMPLATE, adaptiveOptions())).toEqual({ valid: true });
    const normalized = normalizeShoppingPlan(plan, fallback, NEW_CAR_SETUP_TEMPLATE);
    expect(normalized.modules.at(-1)).toMatchObject({
      module_id: "adaptive-child-safety",
      origin: "ai_adaptive",
      optional: true
    });
    expect(normalized.execution_strategy.module_sequence).toContain("adaptive-child-safety");
  });

  it("normalizes a recoverable percentage-style adaptive budget ratio", () => {
    const fallback = mockPersonalizeTemplate(
      mockParseScene("新能源车预算 2000，带孩子出行"),
      NEW_CAR_SETUP_TEMPLATE
    );
    const plan = modelPlan();
    const modules = plan.modules as Array<Record<string, unknown>>;
    modules.push({ ...adaptiveModule(), default_budget_ratio: "15%" });
    const execution = plan.execution_strategy as Record<string, unknown>;
    (execution.module_sequence as string[]).push("adaptive-child-safety");

    expect(validateShoppingPlanOutput(plan, NEW_CAR_SETUP_TEMPLATE, adaptiveOptions())).toEqual({ valid: true });
    const normalized = normalizeShoppingPlan(plan, fallback, NEW_CAR_SETUP_TEMPLATE);
    expect(normalized.modules.find((module) => module.module_id === "adaptive-child-safety")?.default_budget_ratio).toBe(0.15);
  });

  it("clamps an oversized but recoverable adaptive budget ratio to the safety ceiling", () => {
    const fallback = mockPersonalizeTemplate(
      mockParseScene("新能源车预算 2000，带孩子出行"),
      NEW_CAR_SETUP_TEMPLATE
    );
    const plan = modelPlan();
    const modules = plan.modules as Array<Record<string, unknown>>;
    modules.push({ ...adaptiveModule(), default_budget_ratio: "35%" });
    const execution = plan.execution_strategy as Record<string, unknown>;
    (execution.module_sequence as string[]).push("adaptive-child-safety");

    expect(validateShoppingPlanOutput(plan, NEW_CAR_SETUP_TEMPLATE, adaptiveOptions())).toEqual({ valid: true });
    const normalized = normalizeShoppingPlan(plan, fallback, NEW_CAR_SETUP_TEMPLATE);
    expect(normalized.modules.find((module) => module.module_id === "adaptive-child-safety")?.default_budget_ratio).toBe(0.3);
  });

  it("forces an adaptive module to remain optional even when the model omits the flag", () => {
    const fallback = mockPersonalizeTemplate(
      mockParseScene("新能源车预算 2000，带孩子出行"),
      NEW_CAR_SETUP_TEMPLATE
    );
    const plan = modelPlan();
    const modules = plan.modules as Array<Record<string, unknown>>;
    const moduleWithoutOptional = adaptiveModule();
    delete (moduleWithoutOptional as Record<string, unknown>).optional;
    modules.push(moduleWithoutOptional);
    const execution = plan.execution_strategy as Record<string, unknown>;
    (execution.module_sequence as string[]).push("adaptive-child-safety");

    expect(validateShoppingPlanOutput(plan, NEW_CAR_SETUP_TEMPLATE, adaptiveOptions())).toEqual({ valid: true });
    const normalized = normalizeShoppingPlan(plan, fallback, NEW_CAR_SETUP_TEMPLATE);
    expect(normalized.modules.find((module) => module.module_id === "adaptive-child-safety")?.optional).toBe(true);
  });

  it("rejects adaptive modules in prohibited domains", () => {
    const plan = modelPlan();
    const modules = plan.modules as Array<Record<string, unknown>>;
    modules.push({ ...adaptiveModule("adaptive-insurance"), module_name: "新车保险代办" });

    expect(validateShoppingPlanOutput(plan, NEW_CAR_SETUP_TEMPLATE, adaptiveOptions())).toMatchObject({
      valid: false,
      reason: expect.stringContaining("禁止领域")
    });
  });

  it("rejects adaptive modules above the scenario limit", () => {
    const plan = modelPlan();
    const modules = plan.modules as Array<Record<string, unknown>>;
    modules.push(adaptiveModule("adaptive-child-safety"));
    modules.push({ ...adaptiveModule("adaptive-pet-safety"), module_name: "宠物安全出行" });
    modules.push({ ...adaptiveModule("adaptive-cycling-load"), module_name: "骑行装载保护" });

    expect(validateShoppingPlanOutput(plan, NEW_CAR_SETUP_TEMPLATE, adaptiveOptions())).toMatchObject({
      valid: false,
      reason: expect.stringContaining("数量超过上限")
    });
  });

  it("preserves explicit child needs in deterministic fallback mode", () => {
    const scene = mockParseScene("新能源 SUV，预算 3000，经常带 3 岁孩子长途出行");
    const fallback = mockPersonalizeTemplate(scene, NEW_CAR_SETUP_TEMPLATE);
    const adaptive = fallback.modules.filter((module) => module.origin === "ai_adaptive");

    expect(adaptive).toHaveLength(1);
    expect(adaptive[0].module_id).toBe("adaptive-child-safety");
    expect(fallback.modules.reduce((sum, module) => sum + module.budget_allocation, 0)).toBe(scene.budget);
    expect(fallback.modules.every((module) => module.budget_allocation >= 0)).toBe(true);
  });

  it("backfills an explicit adaptive need when a connected plan only returns template modules", () => {
    const scene = mockParseScene("新能源 SUV，预算 3000，经常带 3 岁孩子长途出行");
    const fallback = mockPersonalizeTemplate(scene, NEW_CAR_SETUP_TEMPLATE);
    const modelOutput = structuredClone(fallback);
    modelOutput.modules = modelOutput.modules.filter((module) => module.origin !== "ai_adaptive");
    modelOutput.execution_strategy.module_sequence = modelOutput.modules.map((module) => module.module_id);

    const normalized = normalizeShoppingPlan(modelOutput, fallback, NEW_CAR_SETUP_TEMPLATE);
    const adaptive = normalized.modules.filter((module) => module.origin === "ai_adaptive");

    expect(adaptive).toHaveLength(1);
    expect(adaptive[0].module_id).toBe("adaptive-child-safety");
    expect(normalized.execution_strategy.module_sequence).toContain("adaptive-child-safety");
  });

  it("recovers omitted static fields for a known safe adaptive module before validation", () => {
    const scene = mockParseScene("新能源 SUV，预算 3000，经常带 3 岁孩子长途出行");
    const fallback = mockPersonalizeTemplate(scene, NEW_CAR_SETUP_TEMPLATE);
    const modelOutput = structuredClone(fallback) as unknown as Record<string, unknown>;
    const modules = modelOutput.modules as Array<Record<string, unknown>>;
    const adaptive = modules.find((module) => module.module_id === "adaptive-child-safety")!;
    delete adaptive.module_name;
    delete adaptive.description;

    const normalized = normalizeShoppingPlan(modelOutput, fallback, NEW_CAR_SETUP_TEMPLATE);
    expect(validateShoppingPlanOutput(normalized, NEW_CAR_SETUP_TEMPLATE, adaptiveOptions())).toEqual({ valid: true });
    expect(normalized.modules.find((module) => module.module_id === "adaptive-child-safety")).toMatchObject({
      module_name: "儿童安全出行",
      optional: true,
      origin: "ai_adaptive"
    });
  });
});

describe("DeepSeek candidate fit reason validation", () => {
  const review = {
    module_id: "safety-essential",
    status: "ready",
    summary: "候选池可用于下一步确认。",
    strengths: ["覆盖两个价格档位"],
    caveats: ["仍需确认规格"],
    next_action: "查看商品详情。",
    suggested_keyword: "",
    fit_reasons: [
      { product_id: "p-1", fit_reason: "预算匹配且包含旗舰店信号，适合优先核验。" },
      { product_id: "p-2", fit_reason: "卖点贴合模块策略，适合作为升级候选比较。" }
    ]
  };

  it("requires exactly one fit reason for every known candidate", () => {
    expect(validateCandidateReviewOutput(review, ["p-1", "p-2"])).toBe(true);
    expect(validateCandidateReviewOutput({
      ...review,
      fit_reasons: review.fit_reasons.slice(0, 1)
    }, ["p-1", "p-2"])).toBe(false);
  });

  it("rejects duplicate and unknown product ids", () => {
    expect(validateCandidateReviewOutput({
      ...review,
      fit_reasons: [review.fit_reasons[0], { ...review.fit_reasons[1], product_id: "p-1" }]
    }, ["p-1", "p-2"])).toBe(false);
    expect(validateCandidateReviewOutput({
      ...review,
      fit_reasons: [review.fit_reasons[0], { ...review.fit_reasons[1], product_id: "invented" }]
    }, ["p-1", "p-2"])).toBe(false);
  });

  it("rejects empty or unbounded fit reason text", () => {
    expect(validateCandidateReviewOutput({
      ...review,
      fit_reasons: [review.fit_reasons[0], { product_id: "p-2", fit_reason: "短" }]
    }, ["p-1", "p-2"])).toBe(false);
    expect(validateCandidateReviewOutput({
      ...review,
      fit_reasons: [review.fit_reasons[0], { product_id: "p-2", fit_reason: "很".repeat(141) }]
    }, ["p-1", "p-2"])).toBe(false);
  });
});
