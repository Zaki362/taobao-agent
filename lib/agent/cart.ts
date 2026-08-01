import { getExecutionBackend } from "@/lib/mcp/client";
import { executeMcpTool } from "@/lib/mcp/executor";
import { queueAddToCartTask } from "@/lib/mcp/hosted";
import { summarizeLogText, summarizeLogValue } from "@/lib/mcp/logging";
import { ProductCandidate, SelectedItem, SessionState } from "@/lib/session/types";
import { enqueueAddToCartJob } from "@/lib/runtime/jobs";
import { allowDemoCartFallback } from "@/lib/runtime/product-mode";
import { refreshBundleAdoptionProgress } from "@/lib/session/bundle-adoption";

function normalizeProductDetailUrl(productId: string, rawUrl?: string) {
  const sourceUrl = rawUrl ?? "";

  if (sourceUrl) {
    return sourceUrl;
  }

  return `https://item.taobao.com/item.htm?id=${productId}`;
}

function buildSelectedItem(
  state: SessionState,
  product: ProductCandidate,
  options?: {
    selectedSpec?: string;
    cartSource?: "taobao" | "demo";
    cartNote?: string;
  }
): SelectedItem {
  return {
    product_id: product.product_id,
    module_id: product.module_id,
    title: product.title,
    price: product.price,
    image_url: product.image_url,
    detail_url: product.detail_url,
    shop_name: product.shop_name,
    module_name: state.shopping_plan.modules.find((module) => module.module_id === product.module_id)?.module_name,
    selected_spec: options?.selectedSpec || "默认可选规格（以淘宝购物车页为准）",
    cart_source: options?.cartSource ?? "taobao",
    cart_note: options?.cartNote,
    added_at: new Date().toISOString()
  };
}

export async function runCartExecutor(state: SessionState, productId: string) {
  const product = Object.values(state.module_candidates)
    .flat()
    .find((item) => item.product_id === productId);

  if (!product) {
    throw new Error("product not found");
  }

  const backend = getExecutionBackend();
  if (backend === "local_executor") {
    const moduleName = state.shopping_plan.modules.find((module) => module.module_id === product.module_id)?.module_name;
    const job = await enqueueAddToCartJob(state, {
      productId: product.product_id,
      moduleId: product.module_id,
      moduleName,
      title: product.title
    });
    refreshBundleAdoptionProgress(state);
    return {
      success: true,
      message: "已提交本地执行器后台加购",
      product_id: product.product_id,
      task_id: job.id
    };
  }

  if (backend === "codex_hosted") {
    const task = queueAddToCartTask(state, {
      product_id: product.product_id,
      module_id: product.module_id,
      module_name: state.shopping_plan.modules.find((module) => module.module_id === product.module_id)?.module_name,
      product_title: product.title,
      detail_url: normalizeProductDetailUrl(product.product_id, product.detail_url)
    });
    refreshBundleAdoptionProgress(state);
    return task;
  }

  const result = await executeMcpTool(state, "add_to_cart", {
    product_id: productId,
    title: product.title,
    detail_url: normalizeProductDetailUrl(product.product_id, product.detail_url),
    quantity: 1,
    confirmed: true
  }, {
    module_id: product.module_id,
    module_name: state.shopping_plan.modules.find((module) => module.module_id === product.module_id)?.module_name
  }).catch((error) => {
    if (!allowDemoCartFallback()) {
      throw error;
    }
    const fallbackItem = buildSelectedItem(state, product, {
      selectedSpec: "演示购物车默认规格",
      cartSource: "demo",
      cartNote: error instanceof Error ? summarizeLogText(error.message, 220) : "真实加购失败，已回退到演示购物车"
    });
    state.selected_items = [...state.selected_items.filter((item) => item.product_id !== productId), fallbackItem];
    refreshBundleAdoptionProgress(state);
    state.tool_logs.unshift({
      id: `demo-cart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      tool_name: "demo_cart_fallback",
      module_id: product.module_id,
      module_name: state.shopping_plan.modules.find((module) => module.module_id === product.module_id)?.module_name,
      input_summary: summarizeLogValue({ product_id: product.product_id, title: product.title }, 180),
      output_summary: error instanceof Error
        ? summarizeLogText(`真实加购失败，已回退到演示购物车：${error.message}`, 220)
        : "真实加购失败，已回退到演示购物车",
      status: "blocked",
      duration_ms: 0,
      mode: state.execution_mode
    });

    return {
      success: true,
      message: "真实加购失败，已加入产品内演示购物车",
      product_id: product.product_id,
      selected_spec: fallbackItem.selected_spec,
      demo_fallback: true
    };
  });

  if (result.success && !(result as { demo_fallback?: boolean }).demo_fallback) {
    const selected = buildSelectedItem(state, product, {
      selectedSpec: result.selected_spec || "默认可选规格（以淘宝购物车页为准）",
      cartSource: "taobao"
    });
    state.selected_items = [...state.selected_items.filter((item) => item.product_id !== productId), selected];
    refreshBundleAdoptionProgress(state);
  }

  return result;
}
