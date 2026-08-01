import { describe, expect, it } from "vitest";
import { buildAgentCompletionReport } from "@/lib/agent/completion-review";
import {
  acceptCurrentPurchaseBundle,
  invalidateAgentCompletionArtifacts,
  PurchaseBundleAdoptionError,
  refreshBundleAdoptionProgress
} from "@/lib/session/bundle-adoption";
import { isRenderableSessionState } from "@/lib/session/guards";
import { normalizeSessionState } from "@/lib/session/store";
import { resolveHostedAddToCartTask } from "@/lib/mcp/hosted";
import type { ProductCandidate, SelectedItem, SessionState } from "@/lib/session/types";
import { createSessionFixture } from "@/tests/fixtures/session";

function candidate(moduleId: string, productId: string, price: number): ProductCandidate {
  return {
    product_id: productId,
    module_id: moduleId,
    title: `${moduleId} 测试商品`,
    price,
    source: "淘宝",
    shop_name: "测试旗舰店",
    image_url: "https://example.com/item.jpg",
    detail_url: `https://item.taobao.com/item.htm?id=${productId}`,
    shop_badges: ["旗舰店"],
    highlights: ["规格明确"],
    risk_notes: ["需确认适配"],
    fit_reason: "符合当前模块与预算。",
    recommendation_type: "稳妥推荐"
  };
}

function stateWithBundle() {
  const state = createSessionFixture();
  for (const [index, module] of state.shopping_plan.modules.entries()) {
    state.module_candidates[module.module_id] = [
      candidate(module.module_id, `${module.module_id}-product`, 60 + index * 10)
    ];
  }
  state.completion_report = buildAgentCompletionReport(state);
  return state;
}

function selectedItem(state: SessionState, productId: string): SelectedItem {
  const product = Object.values(state.module_candidates)
    .flat()
    .find((item) => item.product_id === productId)!;
  return {
    product_id: product.product_id,
    module_id: product.module_id,
    title: product.title,
    price: product.price,
    added_at: new Date().toISOString()
  };
}

describe("Agent purchase bundle adoption", () => {
  it("accepts only the current server-owned bundle and creates a pending shortlist", () => {
    const state = stateWithBundle();
    const bundle = state.completion_report!.purchase_bundle!;

    const adoption = acceptCurrentPurchaseBundle(state, bundle.generated_at);

    expect(adoption.status).toBe("accepted");
    expect(adoption.product_ids).toEqual(bundle.items.map((item) => item.product_id));
    expect(adoption.pending_product_ids).toEqual(adoption.product_ids);
    expect(adoption.added_product_ids).toEqual([]);
    expect(isRenderableSessionState(state)).toBe(true);
  });

  it("rejects stale timestamps and candidates changed after bundle generation", () => {
    const staleState = stateWithBundle();
    expect(() => acceptCurrentPurchaseBundle(staleState, "2020-01-01T00:00:00.000Z"))
      .toThrow(PurchaseBundleAdoptionError);

    const changedState = stateWithBundle();
    const bundle = changedState.completion_report!.purchase_bundle!;
    const first = bundle.items[0];
    changedState.module_candidates[first.module_id][0].price += 1;
    expect(() => acceptCurrentPurchaseBundle(changedState, bundle.generated_at))
      .toThrow("候选商品已经变化");
  });

  it("derives in-progress and completed status from successful cart selections", () => {
    const state = stateWithBundle();
    const bundle = state.completion_report!.purchase_bundle!;
    const adoption = acceptCurrentPurchaseBundle(state, bundle.generated_at);

    state.selected_items = [selectedItem(state, adoption.product_ids[0])];
    expect(refreshBundleAdoptionProgress(state)).toMatchObject({
      status: adoption.product_ids.length === 1 ? "completed" : "in_progress",
      added_product_ids: [adoption.product_ids[0]]
    });

    state.selected_items = adoption.product_ids.map((productId) => selectedItem(state, productId));
    expect(refreshBundleAdoptionProgress(state)).toMatchObject({
      status: "completed",
      pending_product_ids: []
    });
  });

  it("marks an accepted shortlist in progress while an asynchronous cart task is active", () => {
    const state = stateWithBundle();
    const bundle = state.completion_report!.purchase_bundle!;
    const adoption = acceptCurrentPurchaseBundle(state, bundle.generated_at);
    state.hosted_tasks.push({
      task_id: "cart-task",
      task_type: "add_to_cart",
      session_id: state.session_id,
      status: "pending",
      title: "加入购物车",
      description: "等待本地执行器",
      product_id: adoption.product_ids[0],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      payload: {}
    });

    expect(refreshBundleAdoptionProgress(state)?.status).toBe("in_progress");
    expect(state.bundle_adoption?.added_product_ids).toEqual([]);
  });

  it("updates shortlist progress when an asynchronous executor result is written back", () => {
    const state = stateWithBundle();
    const bundle = state.completion_report!.purchase_bundle!;
    const adoption = acceptCurrentPurchaseBundle(state, bundle.generated_at);
    const productId = adoption.product_ids[0];
    const product = Object.values(state.module_candidates).flat().find((item) => item.product_id === productId)!;
    state.hosted_tasks.push({
      task_id: "resolved-cart-task",
      task_type: "add_to_cart",
      session_id: state.session_id,
      status: "running",
      title: "加入购物车",
      description: "本地执行器处理中",
      product_id: productId,
      module_id: product.module_id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      payload: {}
    });

    resolveHostedAddToCartTask(state, {
      task_id: "resolved-cart-task",
      status: "completed",
      result_summary: "真实淘宝加购成功"
    });

    expect(state.selected_items.map((item) => item.product_id)).toContain(productId);
    expect(state.bundle_adoption?.added_product_ids).toContain(productId);
    expect(state.bundle_adoption?.pending_product_ids).not.toContain(productId);
  });

  it("drops orphaned persisted adoption state and invalidates both artifacts on replanning", () => {
    const state = stateWithBundle();
    const bundle = state.completion_report!.purchase_bundle!;
    acceptCurrentPurchaseBundle(state, bundle.generated_at);
    state.bundle_adoption!.bundle_generated_at = "stale";

    const normalized = normalizeSessionState(state);
    expect(normalized.bundle_adoption).toBeUndefined();

    acceptCurrentPurchaseBundle(state, bundle.generated_at);
    invalidateAgentCompletionArtifacts(state);
    expect(state.completion_report).toBeUndefined();
    expect(state.bundle_adoption).toBeUndefined();
  });
});
