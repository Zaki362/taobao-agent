import { describe, expect, it } from "vitest";
import { deriveShoppingListView } from "@/components/dashboard-shopping-list";
import { buildAgentCompletionReport } from "@/lib/agent/completion-review";
import { acceptCurrentPurchaseBundle } from "@/lib/session/bundle-adoption";
import type {
  HostedExecutionTask,
  ProductCandidate,
  SelectedItem,
  SessionState
} from "@/lib/session/types";
import { createSessionFixture } from "@/tests/fixtures/session";

function candidate(moduleId: string, productId: string, price: number): ProductCandidate {
  return {
    product_id: productId,
    module_id: moduleId,
    title: `${moduleId} 商品 ${productId}`,
    price,
    source: "淘宝",
    shop_name: "测试旗舰店",
    image_url: `https://example.com/${productId}.jpg`,
    detail_url: `https://item.taobao.com/item.htm?id=${productId}`,
    shop_badges: ["旗舰店"],
    highlights: ["规格明确"],
    risk_notes: ["需确认规格"],
    fit_reason: "符合模块需求与预算。",
    recommendation_type: "稳妥推荐"
  };
}

function stateWithBundle() {
  const state = createSessionFixture();
  for (const [index, module] of state.shopping_plan.modules.entries()) {
    state.module_candidates[module.module_id] = [
      candidate(module.module_id, `${module.module_id}-primary`, 40 + index * 10),
      candidate(module.module_id, `${module.module_id}-alternate`, 140 + index * 10)
    ];
  }
  state.completion_report = buildAgentCompletionReport(state);
  if (!state.completion_report.purchase_bundle) {
    throw new Error("test fixture must produce a purchase bundle");
  }
  return state;
}

function selectedItem(product: ProductCandidate, addedAt = "2026-08-12T01:00:00.000Z"): SelectedItem {
  return {
    product_id: product.product_id,
    module_id: product.module_id,
    title: product.title,
    price: product.price,
    image_url: product.image_url,
    detail_url: product.detail_url,
    shop_name: product.shop_name,
    selected_spec: "默认规格",
    cart_source: "taobao",
    added_at: addedAt
  };
}

function cartTask(
  state: SessionState,
  product: ProductCandidate,
  status: HostedExecutionTask["status"],
  updatedAt: string,
  taskId: string
): HostedExecutionTask {
  return {
    task_id: taskId,
    task_type: "add_to_cart",
    session_id: state.session_id,
    status,
    title: `将「${product.title}」加入淘宝购物车`,
    description: "测试加购任务",
    module_id: product.module_id,
    module_name: state.shopping_plan.modules.find((module) => module.module_id === product.module_id)?.module_name,
    product_id: product.product_id,
    created_at: updatedAt,
    updated_at: updatedAt,
    payload: { product_id: product.product_id, product_title: product.title }
  };
}

function candidateForBundleItem(state: SessionState, productId: string) {
  const product = Object.values(state.module_candidates)
    .flat()
    .find((item) => item.product_id === productId);
  if (!product) throw new Error(`candidate ${productId} not found`);
  return product;
}

describe("dashboard shopping list selector", () => {
  it("keeps an unadopted Agent bundle as suggestions and out of the shopping list", () => {
    const state = stateWithBundle();
    const bundle = state.completion_report!.purchase_bundle!;
    const stateBeforeSelection = structuredClone(state);

    const view = deriveShoppingListView(state);

    expect(state).toEqual(stateBeforeSelection);
    expect(view.bundleAdopted).toBe(false);
    expect(view.bundleItems.map((item) => item.product_id)).toEqual(
      bundle.items.map((item) => item.product_id)
    );
    expect(view.bundleItems.every((item) => item.origin === "bundle" && item.status === "suggested")).toBe(true);
    expect(view.listItems).toEqual([]);
    expect(view.bundleTotal).toBe(bundle.estimated_total);
    expect(view).toMatchObject({
      addedCount: 0,
      queuedCount: 0,
      failedCount: 0,
      awaitingCount: 0,
      addedTotal: 0
    });
  });

  it("turns an adopted bundle into awaiting rows without pretending they were added", () => {
    const state = stateWithBundle();
    const bundle = state.completion_report!.purchase_bundle!;
    acceptCurrentPurchaseBundle(state, bundle.generated_at);

    const view = deriveShoppingListView(state);

    expect(state.selected_items).toEqual([]);
    expect(view.bundleAdopted).toBe(true);
    expect(view.listItems).toHaveLength(bundle.items.length);
    expect(view.listItems.every((item) => item.status === "awaiting_confirmation")).toBe(true);
    expect(view.awaitingCount).toBe(bundle.items.length);
    expect(view.addedCount).toBe(0);
    expect(view.addedTotal).toBe(0);
  });

  it("uses selected items as the only added proof and the newest cart task for other statuses", () => {
    const state = stateWithBundle();
    const bundle = state.completion_report!.purchase_bundle!;
    const adoption = acceptCurrentPurchaseBundle(state, bundle.generated_at);
    const [addedId, queuedId, failedId, completedWithoutSelectionId] = adoption.product_ids;
    const addedProduct = candidateForBundleItem(state, addedId);
    const queuedProduct = candidateForBundleItem(state, queuedId);
    const failedProduct = candidateForBundleItem(state, failedId);
    const completedWithoutSelectionProduct = candidateForBundleItem(state, completedWithoutSelectionId);

    state.selected_items = [selectedItem(addedProduct)];
    state.hosted_tasks = [
      cartTask(state, queuedProduct, "failed", "2026-08-12T01:01:00.000Z", "queued-old-failure"),
      cartTask(state, queuedProduct, "running", "2026-08-12T01:03:00.000Z", "queued-new-running"),
      cartTask(state, failedProduct, "failed", "2026-08-12T01:02:00.000Z", "failed-latest"),
      cartTask(state, completedWithoutSelectionProduct, "completed", "2026-08-12T01:04:00.000Z", "completed-no-item")
    ];

    const view = deriveShoppingListView(state);
    const rows = new Map(view.listItems.map((item) => [item.product_id, item]));

    expect(rows.get(addedId)).toMatchObject({ status: "added", selectedItem: { product_id: addedId } });
    expect(rows.get(queuedId)).toMatchObject({ status: "queued", task: { task_id: "queued-new-running" } });
    expect(rows.get(failedId)).toMatchObject({ status: "failed", task: { task_id: "failed-latest" } });
    expect(rows.get(completedWithoutSelectionId)?.status).toBe("awaiting_confirmation");
    expect(view.addedCount).toBe(1);
    expect(view.realAddedCount).toBe(1);
    expect(view.demoAddedCount).toBe(0);
    expect(view.queuedCount).toBe(1);
    expect(view.failedCount).toBe(1);
    expect(view.awaitingCount).toBe(bundle.items.length - 3);
    expect(view.addedTotal).toBe(addedProduct.price);
    expect(view.realAddedTotal).toBe(addedProduct.price);
  });

  it("appends non-bundle manual additions and active attempts without duplicating bundle rows", () => {
    const state = stateWithBundle();
    const bundle = state.completion_report!.purchase_bundle!;
    acceptCurrentPurchaseBundle(state, bundle.generated_at);
    const bundleIds = new Set(bundle.items.map((item) => item.product_id));
    const nonBundleCandidates = Object.values(state.module_candidates)
      .flat()
      .filter((item) => !bundleIds.has(item.product_id));
    const [manuallyAdded, manuallyQueued] = nonBundleCandidates;
    if (!manuallyAdded || !manuallyQueued) throw new Error("fixture needs two non-bundle candidates");

    state.selected_items = [selectedItem(manuallyAdded)];
    state.hosted_tasks = [
      cartTask(state, manuallyQueued, "pending", "2026-08-12T02:00:00.000Z", "manual-pending")
    ];

    const view = deriveShoppingListView(state);
    const manualRows = view.listItems.filter((item) => item.origin === "manual");

    expect(view.listItems.slice(0, bundle.items.length).map((item) => item.product_id)).toEqual(
      bundle.items.map((item) => item.product_id)
    );
    expect(manualRows).toHaveLength(2);
    expect(manualRows.map((item) => [item.product_id, item.status])).toEqual([
      [manuallyAdded.product_id, "added"],
      [manuallyQueued.product_id, "queued"]
    ]);
    expect(new Set(view.listItems.map((item) => item.product_id)).size).toBe(view.listItems.length);
    expect(view.addedCount).toBe(1);
    expect(view.realAddedCount).toBe(1);
    expect(view.demoAddedCount).toBe(0);
    expect(view.queuedCount).toBe(1);
    expect(view.awaitingCount).toBe(bundle.items.length);
    expect(view.addedTotal).toBe(manuallyAdded.price);
    expect(view.realAddedTotal).toBe(manuallyAdded.price);
  });

  it("keeps demo fallback items distinct from real Taobao additions", () => {
    const state = stateWithBundle();
    const bundle = state.completion_report!.purchase_bundle!;
    acceptCurrentPurchaseBundle(state, bundle.generated_at);
    const demoProduct = candidateForBundleItem(state, bundle.items[0].product_id);
    state.selected_items = [{
      ...selectedItem(demoProduct),
      cart_source: "demo",
      cart_note: "产品内演示清单"
    }];

    const view = deriveShoppingListView(state);

    expect(view.addedCount).toBe(1);
    expect(view.realAddedCount).toBe(0);
    expect(view.demoAddedCount).toBe(1);
    expect(view.addedTotal).toBe(demoProduct.price);
    expect(view.realAddedTotal).toBe(0);
    expect(view.bundleItems[0]).toMatchObject({ status: "added", cart_source: "demo" });
  });

  it("ignores a stale adoption record instead of exposing the new bundle as accepted", () => {
    const state = stateWithBundle();
    const bundle = state.completion_report!.purchase_bundle!;
    acceptCurrentPurchaseBundle(state, bundle.generated_at);
    state.bundle_adoption!.bundle_generated_at = "2020-01-01T00:00:00.000Z";

    const view = deriveShoppingListView(state);

    expect(view.bundleAdopted).toBe(false);
    expect(view.bundleItems.every((item) => item.status === "suggested")).toBe(true);
    expect(view.listItems).toEqual([]);
  });
});
