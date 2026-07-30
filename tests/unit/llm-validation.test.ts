import { describe, expect, it } from "vitest";
import { normalizeAgentDirectives, normalizeSceneBrief, normalizeShoppingPlan } from "@/lib/llm/deepseek";
import { validateShoppingPlanOutput } from "@/lib/llm/validation";
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
});
