import { ProductCandidate, SelectedItem, SessionState } from "@/lib/session/types";

let hostedTaskSequence = 0;

function createTaskId(type: string) {
  hostedTaskSequence += 1;
  return `${type}-${Date.now()}-${hostedTaskSequence}`;
}

function createTaskLog(
  state: SessionState,
  title: string,
  outputSummary: string,
  moduleId?: string,
  moduleName?: string,
  mode: SessionState["execution_mode"] = "codex_hosted"
) {
  state.tool_logs.unshift({
    id: `hosted-log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    tool_name: mode === "qoder_cli" ? "qoder_async_executor" : "codex_hosted_executor",
    module_id: moduleId,
    module_name: moduleName,
    input_summary: title,
    output_summary: outputSummary,
    status: "blocked",
    duration_ms: 0,
    mode
  });
}

export function queueModuleSearchTask(
  state: SessionState,
  input: {
    module_id: string;
    module_name: string;
    search_intent: string;
  }
) {
  const existing = state.hosted_tasks.find(
    (task) =>
      task.task_type === "module_search" &&
      task.module_id === input.module_id &&
      (task.status === "pending" || task.status === "running")
  );

  if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  const task = {
    task_id: createTaskId("module-search"),
    task_type: "module_search" as const,
    session_id: state.session_id,
    status: "pending" as const,
    title: `为「${input.module_name}」执行淘宝搜索`,
    description: `Codex 宿主需要围绕「${input.search_intent}」完成淘宝搜索、详情提取和候选商品整理。`,
    module_id: input.module_id,
    module_name: input.module_name,
    created_at: now,
    updated_at: now,
    payload: {
      scene_brief: state.scene_brief,
      module_id: input.module_id,
      module_name: input.module_name,
      search_intent: input.search_intent,
      recommendation_goal: ["稳妥推荐", "性价比推荐", "升级推荐"]
    }
  };

  state.hosted_tasks.unshift(task);
  state.execution_mode = "codex_hosted";
  state.mcp_status = "hosted";
  createTaskLog(
    state,
    task.title,
    `已提交给 Codex 宿主，等待执行。搜索意图：${input.search_intent}`,
    input.module_id,
    input.module_name
  );
  return task;
}

export function queueAddToCartTask(
  state: SessionState,
  input: {
    product_id: string;
    module_id: string;
    module_name?: string;
    product_title: string;
    detail_url: string;
  },
  options?: {
    executor?: "codex" | "qoder";
  }
) {
  const existing = state.hosted_tasks.find(
    (task) =>
      task.task_type === "add_to_cart" &&
      task.product_id === input.product_id &&
      (task.status === "pending" || task.status === "running")
  );

  if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  const executor = options?.executor ?? "codex";
  const task = {
    task_id: createTaskId("add-to-cart"),
    task_type: "add_to_cart" as const,
    session_id: state.session_id,
    status: "pending" as const,
    title: `将「${input.product_title}」加入购物车`,
    description:
      executor === "codex"
        ? "Codex 宿主需要使用淘宝能力完成加购，并回填执行结果。"
        : "Qoder 后端任务将继续执行加购，并在完成后回填结果。",
    module_id: input.module_id,
    module_name: input.module_name,
    product_id: input.product_id,
    created_at: now,
    updated_at: now,
    payload: {
      product_id: input.product_id,
      product_title: input.product_title,
      detail_url: input.detail_url,
      require_confirmation: true
    }
  };

  state.hosted_tasks.unshift(task);
  if (executor === "codex") {
    state.execution_mode = "codex_hosted";
    state.mcp_status = "hosted";
  }
  createTaskLog(
    state,
    task.title,
    executor === "codex"
      ? "已提交给 Codex 宿主，等待用户确认并执行加购。"
      : "已提交给 Qoder 后端任务，正在后台继续执行加购。",
    input.module_id,
    input.module_name,
    executor === "codex" ? "codex_hosted" : "qoder_cli"
  );
  return task;
}

export function listPendingHostedTasks(state: SessionState) {
  return state.hosted_tasks.filter((task) => task.status === "pending" || task.status === "running");
}

export function resolveHostedModuleSearchTask(
  state: SessionState,
  input: {
    task_id: string;
    status: "completed" | "failed";
    candidates?: ProductCandidate[];
    result_summary?: string;
    error_message?: string;
  }
) {
  const task = state.hosted_tasks.find((entry) => entry.task_id === input.task_id);
  if (!task || task.task_type !== "module_search") {
    throw new Error("hosted module search task not found");
  }

  task.status = input.status;
  task.updated_at = new Date().toISOString();
  task.result_summary = input.result_summary;
  task.error_message = input.error_message;

  if (input.status === "completed") {
    state.module_candidates[task.module_id ?? ""] = input.candidates ?? [];
    createTaskLog(
      state,
      task.title,
      input.result_summary ?? `Codex 宿主已完成搜索，返回 ${(input.candidates ?? []).length} 个候选商品。`,
      task.module_id,
      task.module_name
    );
    return task;
  }

  createTaskLog(
    state,
    task.title,
    input.error_message ?? "Codex 宿主执行失败。",
    task.module_id,
    task.module_name
  );
  return task;
}

export function resolveHostedAddToCartTask(
  state: SessionState,
  input: {
    task_id: string;
    status: "completed" | "failed";
    result_summary?: string;
    error_message?: string;
  }
) {
  const task = state.hosted_tasks.find((entry) => entry.task_id === input.task_id);
  if (!task || task.task_type !== "add_to_cart") {
    throw new Error("hosted add-to-cart task not found");
  }

  task.status = input.status;
  task.updated_at = new Date().toISOString();
  task.result_summary = input.result_summary;
  task.error_message = input.error_message;

  if (input.status === "completed") {
    const product = Object.values(state.module_candidates)
      .flat()
      .find((item) => item.product_id === task.product_id);
    if (product) {
      const selected: SelectedItem = {
        product_id: product.product_id,
        module_id: product.module_id,
        title: product.title,
        price: product.price,
        image_url: product.image_url,
        detail_url: product.detail_url,
        shop_name: product.shop_name,
        module_name: task.module_name,
        selected_spec: "默认可选规格（以淘宝购物车页为准）",
        added_at: new Date().toISOString()
      };
      state.selected_items = [...state.selected_items.filter((item) => item.product_id !== product.product_id), selected];
    }
    createTaskLog(
      state,
      task.title,
      input.result_summary ?? "Codex 宿主已完成加购。",
      task.module_id,
      task.module_name
    );
    return task;
  }

  createTaskLog(
    state,
    task.title,
    input.error_message ?? "Codex 宿主加购失败。",
    task.module_id,
    task.module_name
  );
  return task;
}
