import type {
  DashboardShoppingListItem,
  DashboardShoppingListView,
  ShoppingListItemStatus
} from "@/components/dashboard-types";
import type {
  AgentPurchaseBundleItem,
  HostedExecutionTask,
  ProductCandidate,
  SelectedItem,
  SessionState
} from "@/lib/session/types";

function timeValue(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function isNewerTask(candidate: HostedExecutionTask, current: HostedExecutionTask) {
  const updatedDifference = timeValue(candidate.updated_at) - timeValue(current.updated_at);
  if (updatedDifference !== 0) return updatedDifference > 0;

  return timeValue(candidate.created_at) > timeValue(current.created_at);
}

function latestCartTasksByProduct(tasks: HostedExecutionTask[]) {
  const latestTasks = new Map<string, HostedExecutionTask>();

  for (const task of tasks) {
    if (task.task_type !== "add_to_cart" || !task.product_id) continue;
    const current = latestTasks.get(task.product_id);
    if (!current || isNewerTask(task, current)) {
      latestTasks.set(task.product_id, task);
    }
  }

  return latestTasks;
}

function candidatesByProduct(session: SessionState) {
  const candidates = new Map<string, ProductCandidate>();
  for (const moduleCandidates of Object.values(session.module_candidates)) {
    for (const candidate of moduleCandidates) {
      if (!candidates.has(candidate.product_id)) {
        candidates.set(candidate.product_id, candidate);
      }
    }
  }
  return candidates;
}

function selectedItemsByProduct(items: SelectedItem[]) {
  return new Map(items.map((item) => [item.product_id, item]));
}

function itemStatus({
  selectedItem,
  task,
  awaitingConfirmation
}: {
  selectedItem?: SelectedItem;
  task?: HostedExecutionTask;
  awaitingConfirmation: boolean;
}): ShoppingListItemStatus {
  // A persisted selected item is the only proof that a cart operation succeeded.
  // A completed task without that item must never be presented as a real add.
  if (selectedItem) return "added";
  if (task?.status === "pending" || task?.status === "running") return "queued";
  if (task?.status === "failed" || task?.status === "cancelled") return "failed";
  return awaitingConfirmation ? "awaiting_confirmation" : "suggested";
}

function moduleNameForCandidate(session: SessionState, moduleId: string) {
  return session.shopping_plan.modules.find((module) => module.module_id === moduleId)?.module_name;
}

function bundleRow(
  session: SessionState,
  bundleItem: AgentPurchaseBundleItem,
  bundleAdopted: boolean,
  candidates: Map<string, ProductCandidate>,
  selectedItems: Map<string, SelectedItem>,
  latestTasks: Map<string, HostedExecutionTask>
): DashboardShoppingListItem {
  const candidate = candidates.get(bundleItem.product_id);
  const selectedItem = selectedItems.get(bundleItem.product_id);
  const task = latestTasks.get(bundleItem.product_id);

  return {
    product_id: bundleItem.product_id,
    module_id: bundleItem.module_id,
    title: selectedItem?.title ?? candidate?.title ?? bundleItem.title,
    price: selectedItem?.price ?? candidate?.price ?? bundleItem.price,
    image_url: selectedItem?.image_url ?? candidate?.image_url,
    detail_url: selectedItem?.detail_url ?? candidate?.detail_url,
    shop_name: selectedItem?.shop_name ?? candidate?.shop_name,
    module_name: selectedItem?.module_name ?? bundleItem.module_name,
    selected_spec: selectedItem?.selected_spec,
    cart_source: selectedItem?.cart_source,
    cart_note: selectedItem?.cart_note,
    origin: "bundle",
    status: itemStatus({ selectedItem, task, awaitingConfirmation: bundleAdopted }),
    candidate,
    bundleItem,
    task,
    selectedItem
  };
}

function manualRow(
  session: SessionState,
  productId: string,
  candidates: Map<string, ProductCandidate>,
  selectedItems: Map<string, SelectedItem>,
  latestTasks: Map<string, HostedExecutionTask>
): DashboardShoppingListItem | undefined {
  const candidate = candidates.get(productId);
  const selectedItem = selectedItems.get(productId);
  const task = latestTasks.get(productId);
  if (!candidate && !selectedItem) return undefined;

  const moduleId = selectedItem?.module_id ?? candidate?.module_id ?? task?.module_id;
  if (!moduleId) return undefined;

  return {
    product_id: productId,
    module_id: moduleId,
    title: selectedItem?.title ?? candidate?.title ?? String(task?.payload.product_title ?? "待处理商品"),
    price: selectedItem?.price ?? candidate?.price ?? 0,
    image_url: selectedItem?.image_url ?? candidate?.image_url,
    detail_url: selectedItem?.detail_url ?? candidate?.detail_url,
    shop_name: selectedItem?.shop_name ?? candidate?.shop_name,
    module_name:
      selectedItem?.module_name ??
      task?.module_name ??
      moduleNameForCandidate(session, moduleId),
    selected_spec: selectedItem?.selected_spec,
    cart_source: selectedItem?.cart_source,
    cart_note: selectedItem?.cart_note,
    origin: "manual",
    status: itemStatus({ selectedItem, task, awaitingConfirmation: true }),
    candidate,
    task,
    selectedItem
  };
}

export function deriveShoppingListView(session: SessionState): DashboardShoppingListView {
  const purchaseBundle = session.completion_report?.purchase_bundle;
  const bundleAdopted = Boolean(
    purchaseBundle &&
    session.bundle_adoption?.bundle_generated_at === purchaseBundle.generated_at
  );
  const candidates = candidatesByProduct(session);
  const selectedItems = selectedItemsByProduct(session.selected_items);
  const latestTasks = latestCartTasksByProduct(session.hosted_tasks);
  const bundleItems = (purchaseBundle?.items ?? []).map((item) =>
    bundleRow(session, item, bundleAdopted, candidates, selectedItems, latestTasks)
  );
  const bundleProductIds = new Set(bundleItems.map((item) => item.product_id));

  const manualProductIds: string[] = [];
  const seenManualProductIds = new Set<string>();
  const appendManualProductId = (productId: string) => {
    if (bundleProductIds.has(productId) || seenManualProductIds.has(productId)) return;
    seenManualProductIds.add(productId);
    manualProductIds.push(productId);
  };

  for (const selectedItem of session.selected_items) {
    appendManualProductId(selectedItem.product_id);
  }
  for (const [productId, task] of latestTasks) {
    if (task.status === "pending" || task.status === "running" || task.status === "failed" || task.status === "cancelled") {
      appendManualProductId(productId);
    }
  }

  const manualItems = manualProductIds
    .map((productId) => manualRow(session, productId, candidates, selectedItems, latestTasks))
    .filter((item): item is DashboardShoppingListItem => Boolean(item));
  const visibleBundleItems = bundleAdopted
    ? bundleItems
    : bundleItems.filter((item) => item.status !== "suggested");
  const listItems = [...visibleBundleItems, ...manualItems];
  const addedItems = listItems.filter((item) => item.status === "added");
  const realAddedItems = addedItems.filter((item) => item.cart_source !== "demo");
  const demoAddedItems = addedItems.filter((item) => item.cart_source === "demo");

  return {
    bundleItems,
    listItems,
    bundleAdopted,
    addedCount: addedItems.length,
    realAddedCount: realAddedItems.length,
    demoAddedCount: demoAddedItems.length,
    queuedCount: listItems.filter((item) => item.status === "queued").length,
    failedCount: listItems.filter((item) => item.status === "failed").length,
    awaitingCount: listItems.filter((item) => item.status === "awaiting_confirmation").length,
    bundleTotal: purchaseBundle?.estimated_total ?? 0,
    addedTotal: session.selected_items.reduce((total, item) => total + item.price, 0),
    realAddedTotal: session.selected_items
      .filter((item) => item.cart_source !== "demo")
      .reduce((total, item) => total + item.price, 0)
  };
}
