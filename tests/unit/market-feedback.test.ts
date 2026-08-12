import { describe, expect, it } from "vitest";
import { decideNextAgentAction } from "@/lib/agent/decision-engine";
import {
  applyBudgetReallocationSuggestion,
  buildMarketFeedback,
  refreshMarketFeedback
} from "@/lib/agent/market-feedback";
import { reviewModuleCandidates } from "@/lib/agent/candidate-reviewer";
import type { ProductCandidate, ShoppingPlanModule } from "@/lib/session/types";
import { createSessionFixture } from "@/tests/fixtures/session";

function candidate(
  module: ShoppingPlanModule,
  productId: string,
  price: number,
  recommendationType: ProductCandidate["recommendation_type"]
): ProductCandidate {
  return {
    product_id: productId,
    title: `${module.module_name} ${productId}`,
    price,
    source: "淘宝",
    shop_name: "测试旗舰店",
    image_url: `https://example.com/${productId}.jpg`,
    detail_url: `https://item.taobao.com/item.htm?id=${productId}`,
    shop_badges: ["旗舰店"],
    highlights: module.search_strategy?.must_have_signals.slice(0, 2) ?? [module.module_name],
    risk_notes: ["测试候选"],
    fit_reason: "符合当前模块意图",
    recommendation_type: recommendationType,
    module_id: module.module_id
  };
}

function pricedPool(module: ShoppingPlanModule, ratios: number[]) {
  const types: ProductCandidate["recommendation_type"][] = ["稳妥推荐", "性价比推荐", "升级推荐"];
  return ratios.map((ratio, index) => candidate(
    module,
    `${module.module_id}-${index}`,
    Math.round(module.budget_allocation * ratio * 100) / 100,
    types[index % types.length]
  ));
}

describe("cross-module market feedback", () => {
  it("detects budget pressure and produces a bounded, confirmation-only reallocation suggestion", () => {
    const state = createSessionFixture();
    const donor = state.shopping_plan.modules[0];
    const receiver = state.shopping_plan.modules[1];
    const donorBudget = donor.budget_allocation;
    const receiverBudget = receiver.budget_allocation;
    state.module_candidates[donor.module_id] = pricedPool(donor, [0.25, 0.35, 0.45]);
    state.module_candidates[receiver.module_id] = pricedPool(receiver, [1.2, 1.35, 1.5]);

    const feedback = buildMarketFeedback(state);
    const suggestion = feedback.reallocation_suggestions[0];

    expect(feedback.status).toBe("under_pressure");
    expect(feedback.opportunity_modules).toContain(donor.module_id);
    expect(feedback.pressure_modules).toContain(receiver.module_id);
    expect(feedback.user_confirmation_required).toBe(true);
    expect(suggestion.from_module_id).toBe(donor.module_id);
    expect(suggestion.to_module_id).toBe(receiver.module_id);
    expect(suggestion.amount).toBeGreaterThan(0);
    expect(suggestion.amount).toBeLessThanOrEqual(Math.min(
      donor.budget_allocation,
      receiver.budget_allocation
    ) * 0.15);
    expect(state.shopping_plan.modules[0].budget_allocation).toBe(donorBudget);
    expect(state.shopping_plan.modules[1].budget_allocation).toBe(receiverBudget);
  });

  it("does not treat missing or zero prices as market evidence", () => {
    const state = createSessionFixture();
    const module = state.shopping_plan.modules[0];
    state.module_candidates[module.module_id] = pricedPool(module, [0, 0, 0]);

    const feedback = buildMarketFeedback(state);

    expect(feedback.status).toBe("insufficient_data");
    expect(feedback.observed_modules).toBe(0);
    expect(feedback.module_signals[module.module_id].pressure).toBe("unobserved");
    expect(feedback.reallocation_suggestions).toEqual([]);
  });

  it("applies one current suggestion without changing the total budget or unrelated module results", () => {
    const state = createSessionFixture();
    const [donor, receiver, reusable] = state.shopping_plan.modules;
    state.module_candidates[donor.module_id] = pricedPool(donor, [0.25, 0.35, 0.45]);
    state.module_candidates[receiver.module_id] = pricedPool(receiver, [1.2, 1.35, 1.5]);
    state.module_candidates[reusable.module_id] = pricedPool(reusable, [0.7, 0.8, 0.9]);
    state.module_reviews[donor.module_id] = reviewModuleCandidates(
      state,
      donor,
      state.module_candidates[donor.module_id]
    );
    state.module_reviews[receiver.module_id] = reviewModuleCandidates(
      state,
      receiver,
      state.module_candidates[receiver.module_id]
    );
    refreshMarketFeedback(state);
    const suggestion = state.market_feedback.reallocation_suggestions[0];
    const previousTotal = state.shopping_plan.modules.reduce(
      (total, module) => total + module.budget_allocation,
      0
    );
    const previousDonorBudget = donor.budget_allocation;
    const previousReceiverBudget = receiver.budget_allocation;
    const reusableCandidates = state.module_candidates[reusable.module_id];

    const applied = applyBudgetReallocationSuggestion(state, {
      fromModuleId: suggestion.from_module_id,
      toModuleId: suggestion.to_module_id
    });

    expect(donor.budget_allocation).toBe(previousDonorBudget - suggestion.amount);
    expect(receiver.budget_allocation).toBe(previousReceiverBudget + suggestion.amount);
    expect(state.shopping_plan.modules.reduce(
      (total, module) => total + module.budget_allocation,
      0
    )).toBe(previousTotal);
    expect(state.module_candidates[donor.module_id]).toBeUndefined();
    expect(state.module_candidates[receiver.module_id]).toBeUndefined();
    expect(state.module_reviews[donor.module_id]).toBeUndefined();
    expect(state.module_reviews[receiver.module_id]).toBeUndefined();
    expect(state.module_candidates[reusable.module_id]).toEqual(reusableCandidates);
    expect(applied.impacted_modules).toEqual([donor.module_id, receiver.module_id]);
    expect(state.last_refinement?.quick_action).toBe("应用市场预算建议");
    expect(state.agent_runtime.workflow_status).toBe("idle");
    expect(state.agent_runtime.auto_continue).toBe(false);
    expect(state.market_feedback.reallocation_suggestions).toEqual([]);
  });

  it("rejects stale or forged suggestions and active searches without mutating budgets", () => {
    const state = createSessionFixture();
    const [donor, receiver] = state.shopping_plan.modules;
    state.module_candidates[donor.module_id] = pricedPool(donor, [0.25, 0.35, 0.45]);
    state.module_candidates[receiver.module_id] = pricedPool(receiver, [1.2, 1.35, 1.5]);
    refreshMarketFeedback(state);
    const suggestion = state.market_feedback.reallocation_suggestions[0];
    const budgets = state.shopping_plan.modules.map((module) => module.budget_allocation);

    expect(() => applyBudgetReallocationSuggestion(state, {
      fromModuleId: "forged-module",
      toModuleId: suggestion.to_module_id
    })).toThrow("预算建议已失效");
    expect(state.shopping_plan.modules.map((module) => module.budget_allocation)).toEqual(budgets);

    state.agent_runtime.workflow_status = "waiting_for_tools";
    expect(() => applyBudgetReallocationSuggestion(state, {
      fromModuleId: suggestion.from_module_id,
      toModuleId: suggestion.to_module_id
    })).toThrow("搜索任务仍在执行");
    expect(state.shopping_plan.modules.map((module) => module.budget_allocation)).toEqual(budgets);
  });

  it("uses an untried value keyword for one guarded retry when real candidates all exceed budget", () => {
    const state = createSessionFixture();
    const module = state.shopping_plan.modules[0];
    const candidates = pricedPool(module, [1.2, 1.35, 1.5]);
    state.shopping_plan.agent_directives.autonomy_level = "探索执行";
    state.shopping_plan.agent_directives.search_depth = "标准搜索";
    state.module_candidates[module.module_id] = candidates;
    state.module_reviews[module.module_id] = reviewModuleCandidates(state, module, candidates);
    const primaryKeyword = module.search_strategy?.primary_keyword || module.search_keyword || module.module_name;
    state.module_search_traces[module.module_id] = {
      module_id: module.module_id,
      module_name: module.module_name,
      status: "thin",
      primary_keyword: primaryKeyword,
      searched_keywords: [primaryKeyword],
      attempts: [{
        keyword: primaryKeyword,
        reason: "首轮搜索",
        result_count: candidates.length,
        status: "success",
        created_at: new Date().toISOString()
      }],
      result_count: candidates.length,
      candidate_count: candidates.length,
      review_status: state.module_reviews[module.module_id].status,
      review_summary: state.module_reviews[module.module_id].summary,
      ai_decision_summary: "首轮候选已返回",
      next_action: "检查预算",
      generated_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    refreshMarketFeedback(state);

    const decision = decideNextAgentAction(state);

    expect(decision.action).toBe("retry_module");
    expect(decision.source).toBe("market_feedback");
    expect(decision.module_id).toBe(module.module_id);
    expect(decision.keyword_override).toContain("高性价比");
    expect(decision.guardrail_notes).toContain("预算只用于搜索约束，未自动重分配");
  });
});
