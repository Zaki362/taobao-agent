import type { AgentBundleAdoption, SessionState } from "@/lib/session/types";

export class PurchaseBundleAdoptionError extends Error {
  constructor(
    message: string,
    public readonly code: "bundle_unavailable" | "bundle_stale" | "bundle_invalid"
  ) {
    super(message);
    this.name = "PurchaseBundleAdoptionError";
  }
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function activeCartProductIds(state: SessionState) {
  return new Set(
    state.hosted_tasks
      .filter((task) =>
        task.task_type === "add_to_cart" &&
        Boolean(task.product_id) &&
        (task.status === "pending" || task.status === "running")
      )
      .map((task) => task.product_id!)
  );
}

function canonicalBundleProductIds(state: SessionState, bundleGeneratedAt: string) {
  const bundle = state.completion_report?.purchase_bundle;
  if (!bundle || bundle.items.length === 0) {
    throw new PurchaseBundleAdoptionError("当前没有可采纳的 Agent 购买组合。", "bundle_unavailable");
  }
  if (bundle.generated_at !== bundleGeneratedAt) {
    throw new PurchaseBundleAdoptionError("购买组合已经更新，请刷新页面后重新确认。", "bundle_stale");
  }

  const productIds: string[] = [];
  for (const item of bundle.items) {
    const candidate = (state.module_candidates[item.module_id] ?? []).find(
      (product) => product.product_id === item.product_id && product.module_id === item.module_id
    );
    if (
      !candidate ||
      candidate.title !== item.title ||
      Math.abs(candidate.price - item.price) > 0.01
    ) {
      throw new PurchaseBundleAdoptionError(
        `「${item.module_name}」的候选商品已经变化，请重新生成购买组合。`,
        "bundle_invalid"
      );
    }
    productIds.push(item.product_id);
  }

  if (unique(productIds).length !== productIds.length) {
    throw new PurchaseBundleAdoptionError("购买组合包含重复商品，不能采纳。", "bundle_invalid");
  }
  return productIds;
}

export function refreshBundleAdoptionProgress(state: SessionState) {
  const adoption = state.bundle_adoption;
  if (!adoption) return undefined;

  const selectedIds = new Set(state.selected_items.map((item) => item.product_id));
  const activeIds = activeCartProductIds(state);
  const addedProductIds = adoption.product_ids.filter((productId) => selectedIds.has(productId));
  const pendingProductIds = adoption.product_ids.filter((productId) => !selectedIds.has(productId));
  const status: AgentBundleAdoption["status"] = pendingProductIds.length === 0
    ? "completed"
    : addedProductIds.length > 0 || pendingProductIds.some((productId) => activeIds.has(productId))
      ? "in_progress"
      : "accepted";

  state.bundle_adoption = {
    ...adoption,
    added_product_ids: addedProductIds,
    pending_product_ids: pendingProductIds,
    status,
    updated_at: new Date().toISOString()
  };
  return state.bundle_adoption;
}

export function acceptCurrentPurchaseBundle(state: SessionState, bundleGeneratedAt: string) {
  const productIds = canonicalBundleProductIds(state, bundleGeneratedAt);
  const now = new Date().toISOString();
  const previous = state.bundle_adoption?.bundle_generated_at === bundleGeneratedAt
    ? state.bundle_adoption
    : undefined;

  state.bundle_adoption = {
    bundle_generated_at: bundleGeneratedAt,
    product_ids: productIds,
    added_product_ids: [],
    pending_product_ids: productIds,
    status: "accepted",
    accepted_at: previous?.accepted_at ?? now,
    updated_at: now
  };
  return refreshBundleAdoptionProgress(state)!;
}

export function invalidateAgentCompletionArtifacts(state: SessionState) {
  state.completion_report = undefined;
  state.bundle_adoption = undefined;
}
