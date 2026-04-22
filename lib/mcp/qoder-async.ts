import { executeMcpTool } from "@/lib/mcp/executor";
import { queueAddToCartTask, resolveHostedAddToCartTask } from "@/lib/mcp/hosted";
import { getSession, saveSession } from "@/lib/session/store";
import { SelectedItem, SessionState } from "@/lib/session/types";

declare global {
  // eslint-disable-next-line no-var
  var __AUTOPREP_QODER_ADD_TO_CART_RUNNING__: Set<string> | undefined;
}

const runningTasks = globalThis.__AUTOPREP_QODER_ADD_TO_CART_RUNNING__ ?? new Set<string>();
globalThis.__AUTOPREP_QODER_ADD_TO_CART_RUNNING__ = runningTasks;

function markSelectedItem(state: SessionState, productId: string) {
  const product = Object.values(state.module_candidates)
    .flat()
    .find((item) => item.product_id === productId);

  if (!product) {
    return;
  }

  const selected: SelectedItem = {
    product_id: product.product_id,
    module_id: product.module_id,
    title: product.title,
    price: product.price,
    image_url: product.image_url,
    detail_url: product.detail_url,
    shop_name: product.shop_name,
    module_name: state.shopping_plan.modules.find((module) => module.module_id === product.module_id)?.module_name,
    selected_spec: "默认可选规格（以淘宝购物车页为准）",
    added_at: new Date().toISOString()
  };
  state.selected_items = [...state.selected_items.filter((item) => item.product_id !== productId), selected];
}

export function queueQoderAddToCartTask(
  state: SessionState,
  input: {
    product_id: string;
    module_id: string;
    module_name?: string;
    product_title: string;
    detail_url: string;
  }
) {
  const task = queueAddToCartTask(state, input, {
    executor: "qoder"
  });
  saveSession(state);
  runQoderAddToCartInBackground(state.session_id, task.task_id);
  return task;
}

function runQoderAddToCartInBackground(sessionId: string, taskId: string) {
  if (runningTasks.has(taskId)) {
    return;
  }
  runningTasks.add(taskId);

  setTimeout(async () => {
    try {
      const state = getSession(sessionId);
      if (!state) {
        return;
      }

      const task = state.hosted_tasks.find((entry) => entry.task_id === taskId && entry.task_type === "add_to_cart");
      if (!task || task.status === "completed" || task.status === "failed") {
        return;
      }

      task.status = "running";
      task.updated_at = new Date().toISOString();
      saveSession(state);

      const payload = task.payload as {
        product_id?: string;
        product_title?: string;
        detail_url?: string;
      };

      const productId = String(payload.product_id ?? task.product_id ?? "");
      if (!productId) {
        throw new Error("缺少商品 ID，无法执行加购");
      }

      const result = await executeMcpTool(
        state,
        "add_to_cart",
        {
          product_id: productId,
          title: typeof payload.product_title === "string" ? payload.product_title : undefined,
          detail_url: typeof payload.detail_url === "string" ? payload.detail_url : undefined,
          quantity: 1,
          confirmed: true
        },
        {
          module_id: task.module_id,
          module_name: task.module_name
        }
      );

      if (!result.success) {
        throw new Error(result.message || "加入购物车失败");
      }

      markSelectedItem(state, productId);
      resolveHostedAddToCartTask(state, {
        task_id: taskId,
        status: "completed",
        result_summary: result.message || "Qoder 后端已完成加入购物车。"
      });
      saveSession(state);
    } catch (error) {
      const state = getSession(sessionId);
      if (state) {
        resolveHostedAddToCartTask(state, {
          task_id: taskId,
          status: "failed",
          error_message: error instanceof Error ? error.message : "Qoder 后端加购失败"
        });
        saveSession(state);
      }
    } finally {
      runningTasks.delete(taskId);
    }
  }, 0);
}
