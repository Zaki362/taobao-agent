import { describe, expect, it } from "vitest";
import { normalizeAgentDirectives } from "@/lib/llm/deepseek";
import { validateShoppingPlanOutput } from "@/lib/llm/validation";
import { mockParseScene, mockPersonalizeTemplate } from "@/lib/llm/mock";
import { NEW_CAR_SETUP_TEMPLATE } from "@/lib/templates/new-car-template";

function modelPlan() {
  return structuredClone(mockPersonalizeTemplate(
    mockParseScene("新能源车预算 1500，实用优先"),
    NEW_CAR_SETUP_TEMPLATE
  )) as unknown as Record<string, unknown>;
}

describe("DeepSeek shopping plan validation", () => {
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
});
