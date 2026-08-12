import { describe, expect, it } from "vitest";
import {
  buildPolicyPurchaseBundle,
  buildPolicyRefinementSuggestions,
  materializePurchaseBundleProposal
} from "@/lib/agent/purchase-bundle";
import type { ProductCandidate, SessionState } from "@/lib/session/types";
import { createSessionFixture } from "@/tests/fixtures/session";

function candidate(
  moduleId: string,
  productId: string,
  price: number,
  title = `${moduleId} 实用商品`
): ProductCandidate {
  return {
    product_id: productId,
    title,
    price,
    source: "测试",
    shop_name: "测试旗舰店",
    image_url: "https://example.com/item.jpg",
    detail_url: `https://item.taobao.com/item.htm?id=${productId}`,
    shop_badges: ["旗舰店"],
    highlights: ["规格清楚"],
    risk_notes: ["需确认适配"],
    fit_reason: "符合当前模块和预算约束。",
    recommendation_type: "稳妥推荐",
    module_id: moduleId
  };
}

function stateWithPools(price = 100) {
  const state = createSessionFixture();
  for (const module of state.shopping_plan.modules) {
    state.module_candidates[module.module_id] = [
      candidate(module.module_id, `${module.module_id}-safe`, price),
      candidate(module.module_id, `${module.module_id}-upgrade`, price + 300)
    ];
  }
  return state;
}

function total(items: Array<{ price: number }>) {
  return Math.round(items.reduce((sum, item) => sum + item.price, 0) * 100) / 100;
}

describe("Agent purchase bundle", () => {
  it("forms a deterministic one-item-per-module bundle inside the total budget", () => {
    const state = stateWithPools(100);
    const firstModule = state.shopping_plan.modules[0];
    state.scene_brief.already_have = ["行车记录仪"];
    state.module_candidates[firstModule.module_id].unshift(
      candidate(firstModule.module_id, "already-owned", 20, "高清行车记录仪")
    );

    const bundle = buildPolicyPurchaseBundle(state);

    expect(bundle.estimated_total).toBeLessThanOrEqual(state.scene_brief.budget);
    expect(bundle.estimated_total).toBe(total(bundle.items));
    expect(new Set(bundle.items.map((item) => item.module_id)).size).toBe(bundle.items.length);
    expect(bundle.items.map((item) => item.product_id)).not.toContain("already-owned");
    expect(bundle.critical_selected_module_ids).toHaveLength(bundle.critical_module_ids.length);
    expect(bundle.guardrails.join(" ")).toContain("不会自动加入购物车");
    expect(bundle.refinement_suggestions?.length).toBeGreaterThan(0);
    expect(bundle.refinement_suggestions?.every((item) => item.action !== "我已有行车记录仪")).toBe(true);
  });

  it("returns a partial bundle when the budget cannot cover every required module", () => {
    const state = stateWithPools(100);
    state.scene_brief.budget = 100;

    const bundle = buildPolicyPurchaseBundle(state);

    expect(bundle.status).toBe("partial");
    expect(bundle.estimated_total).toBeLessThanOrEqual(100);
    expect(bundle.critical_selected_module_ids.length).toBeLessThan(bundle.critical_module_ids.length);
    expect(bundle.caveats.join(" ")).toContain("暂未纳入必需模块");
  });

  it("materializes a valid model proposal with canonical product data", () => {
    const state = stateWithPools(100);
    const fallback = buildPolicyPurchaseBundle(state);
    const proposal = {
      selected_product_ids: fallback.items.map((item) => item.product_id),
      summary: "优先覆盖必需模块，并在总预算内保留后续余量。",
      tradeoffs: ["装饰与低频升级暂时后置。"],
      reasons: fallback.items.map((item) => ({
        product_id: item.product_id,
        fit_reason: `模型建议保留${item.module_name}，用于覆盖当前阶段的高频需求。`
      })),
      suggested_refinements: [{
        action: "换一批推荐",
        reason: "当前组合已覆盖必需模块，如不满意可以只刷新候选商品。",
        target_module_ids: [state.shopping_plan.modules[0].module_id]
      }]
    };

    const bundle = materializePurchaseBundleProposal(state, proposal, fallback);

    expect(bundle).not.toBeNull();
    if (!bundle) throw new Error("expected a valid model bundle");
    expect(bundle?.source).toBe("deepseek");
    expect(bundle?.summary).toBe(proposal.summary);
    expect(bundle?.estimated_total).toBe(fallback.estimated_total);
    expect(bundle.refinement_suggestions).toEqual(proposal.suggested_refinements);
    expect(bundle?.items[0].title).toBe(
      state.module_candidates[bundle.items[0].module_id].find(
        (item) => item.product_id === bundle.items[0].product_id
      )?.title
    );
  });

  it("rejects unknown, duplicate-module, over-budget and lower-critical-coverage proposals", () => {
    const state = stateWithPools(100);
    const fallback = buildPolicyPurchaseBundle(state);
    const baseReasons = (ids: string[]) => ids.map((productId) => ({
      product_id: productId,
      fit_reason: "这是一个满足测试长度要求的安全推荐理由。"
    }));
    const firstModule = state.shopping_plan.modules[0];
    const firstPool = state.module_candidates[firstModule.module_id];
    const suggestedRefinements = fallback.refinement_suggestions ?? [];

    expect(materializePurchaseBundleProposal(state, {
      selected_product_ids: ["unknown"],
      summary: "未知商品。",
      tradeoffs: [],
      reasons: baseReasons(["unknown"]),
      suggested_refinements: suggestedRefinements
    }, fallback)).toBeNull();

    const duplicateModuleIds = firstPool.map((item) => item.product_id);
    expect(materializePurchaseBundleProposal(state, {
      selected_product_ids: duplicateModuleIds,
      summary: "同一模块重复。",
      tradeoffs: [],
      reasons: baseReasons(duplicateModuleIds),
      suggested_refinements: suggestedRefinements
    }, fallback)).toBeNull();

    const expensiveIds = state.shopping_plan.modules.map((module) => `${module.module_id}-upgrade`);
    expect(materializePurchaseBundleProposal(state, {
      selected_product_ids: expensiveIds,
      summary: "超出预算。",
      tradeoffs: [],
      reasons: baseReasons(expensiveIds),
      suggested_refinements: suggestedRefinements
    }, fallback)).toBeNull();

    const oneRequiredId = fallback.items.find((item) => !item.optional)!.product_id;
    expect(materializePurchaseBundleProposal(state, {
      selected_product_ids: [oneRequiredId],
      summary: "降低了必需模块覆盖。",
      tradeoffs: [],
      reasons: baseReasons([oneRequiredId]),
      suggested_refinements: suggestedRefinements
    }, fallback)).toBeNull();
  });

  it("does not trust candidates stored under the wrong module", () => {
    const state: SessionState = stateWithPools(100);
    const module = state.shopping_plan.modules[0];
    state.module_candidates[module.module_id] = [
      candidate("wrong-module", "cross-module", 1)
    ];

    const bundle = buildPolicyPurchaseBundle(state);

    expect(bundle.items.map((item) => item.product_id)).not.toContain("cross-module");
  });

  it("never counts the same product as purchases for two different modules", () => {
    const state = stateWithPools(100);
    const [first, second] = state.shopping_plan.modules;
    state.module_candidates[first.module_id] = [candidate(first.module_id, "shared-product", 10)];
    state.module_candidates[second.module_id] = [candidate(second.module_id, "shared-product", 10)];

    const bundle = buildPolicyPurchaseBundle(state);
    const suggestedRefinements = buildPolicyRefinementSuggestions(state);

    expect(bundle.items.filter((item) => item.product_id === "shared-product")).toHaveLength(1);
    expect(materializePurchaseBundleProposal(state, {
      selected_product_ids: ["shared-product"],
      summary: "商品归属模块存在歧义。",
      tradeoffs: [],
      reasons: [{ product_id: "shared-product", fit_reason: "该商品不应被模型跨模块绑定。" }],
      suggested_refinements: suggestedRefinements
    }, bundle)).toBeNull();
  });
});
