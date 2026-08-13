import type {
  AgentPurchaseBundleItem,
  HostedExecutionTask,
  ProductCandidate,
  SelectedItem
} from "@/lib/session/types";

export type MpcStatus = {
  mode: "codex_hosted" | "experimental_local" | "qoder_cli" | "local_executor";
  configured_mode?: "codex_hosted" | "experimental_local" | "qoder_cli" | "local_executor";
  product_mode?: "development" | "production";
  demo_cart_fallback?: boolean;
  search_available: boolean;
  cart_available: boolean;
  available: boolean;
  message: string;
  permissions_scope: string[];
  executor_devices?: {
    online: number;
    registered: number;
    mcp_unavailable: number;
    authentication_required: number;
    capabilities: {
      module_search: { registered: number; online: number; available: boolean };
      add_to_cart: { registered: number; online: number; available: boolean };
    };
  };
};

export type HostedWorkerStatus = {
  online: boolean;
  updated_at: string | null;
  started_at: string | null;
  state: string;
  mode: string | null;
  interval_ms: number | null;
  pid: number | null;
  api_base_url: string | null;
  last_task_id: string | null;
  last_task_type: string | null;
  last_result: string | null;
  last_error: string | null;
};

export type CartReviewItem = {
  product_id: string;
  module_id: string;
  title: string;
  price: number;
  image_url?: string;
  detail_url?: string;
  shop_name?: string;
  module_name?: string;
  selected_spec?: string;
  cart_source?: "taobao" | "demo";
  cart_note?: string;
};

export type ShoppingListItemStatus =
  | "suggested"
  | "awaiting_confirmation"
  | "queued"
  | "added"
  | "failed";

export type ShoppingListItemOrigin = "bundle" | "manual";

export type DashboardShoppingListItem = CartReviewItem & {
  origin: ShoppingListItemOrigin;
  status: ShoppingListItemStatus;
  candidate?: ProductCandidate;
  bundleItem?: AgentPurchaseBundleItem;
  task?: HostedExecutionTask;
  selectedItem?: SelectedItem;
};

export type DashboardShoppingListView = {
  bundleItems: DashboardShoppingListItem[];
  listItems: DashboardShoppingListItem[];
  bundleAdopted: boolean;
  addedCount: number;
  realAddedCount: number;
  demoAddedCount: number;
  queuedCount: number;
  failedCount: number;
  awaitingCount: number;
  bundleTotal: number;
  addedTotal: number;
  realAddedTotal: number;
};
