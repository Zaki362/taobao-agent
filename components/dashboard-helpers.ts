import { isTaobaoMcpSearchEvidence } from "@/lib/session/guards";
import type { SessionState } from "@/lib/session/types";
import { MpcStatus } from "@/components/dashboard-types";

const TAOBAO_AUTHENTICATION_PATTERN =
  /(?:淘宝[^。\n]*(?:未登录|登录态失效|请先登录|登录页面)|未登录[^。\n]*淘宝|已打开登录页面|auth_required|login\.taobao\.com)/i;

export function buildSceneInputFromBrief(scene: SessionState["scene_brief"]) {
  const parts = [
    scene.vehicle_type,
    `预算 ${scene.budget}`,
    scene.priority_style,
    scene.user_stage
  ];
  if (scene.already_have.length > 0) {
    parts.push(`已有：${scene.already_have.join("、")}`);
  }
  if (scene.avoid_items.length > 0) {
    parts.push(`不考虑：${scene.avoid_items.join("、")}`);
  }
  if (scene.optional_notes) {
    parts.push(scene.optional_notes);
  }
  return parts.join("，");
}

export function isHostedMode(status: MpcStatus | null) {
  return status?.mode === "codex_hosted";
}

export function isQueuedExecutionMode(status: MpcStatus | null) {
  return status?.mode === "codex_hosted" || status?.mode === "local_executor";
}

export function getExecutionModeLabel(status: MpcStatus | null) {
  if (status?.mode === "qoder_cli") {
    return "Qoder CLI 直连执行";
  }
  if (status?.mode === "codex_hosted") {
    return "Codex 宿主代理执行";
  }
  if (status?.mode === "local_executor") {
    return "本地执行器后台执行";
  }
  return "实验性本地桥接";
}

export function hasRealDetailUrl(detailUrl?: string) {
  return Boolean(detailUrl && detailUrl.trim() && detailUrl !== "https://www.taobao.com/");
}

function isCurrentWorkflowModuleTask(
  session: SessionState,
  task: SessionState["hosted_tasks"][number]
) {
  const currentModuleId = session.agent_runtime.current_module_id;
  if (!currentModuleId || task.module_id !== currentModuleId) return false;
  const currentWorkflowRunId = session.agent_runtime.workflow_run_id;
  const taskWorkflowRunId = typeof task.payload.workflow_run_id === "string"
    ? task.payload.workflow_run_id
    : undefined;
  return currentWorkflowRunId
    ? taskWorkflowRunId === currentWorkflowRunId
    : taskWorkflowRunId === undefined;
}

export function findTaobaoAuthenticationFailedTask(session: SessionState) {
  if (session.agent_runtime.workflow_status !== "paused") return undefined;

  const failedTasks = session.hosted_tasks.filter(
    (task) =>
      task.executor === "local_executor" &&
      task.task_type === "module_search" &&
      task.status === "failed" &&
      isCurrentWorkflowModuleTask(session, task)
  );
  const taskWithAuthenticationError = failedTasks.find((task) =>
    TAOBAO_AUTHENTICATION_PATTERN.test(`${task.error_message ?? ""} ${task.result_summary ?? ""}`)
  );
  if (taskWithAuthenticationError) return taskWithAuthenticationError;

  if (TAOBAO_AUTHENTICATION_PATTERN.test(session.agent_runtime.workflow_message)) {
    return failedTasks.find((task) => task.module_id === session.agent_runtime.current_module_id) ?? failedTasks[0];
  }
  return undefined;
}

export function isTaobaoAuthenticationPause(session: SessionState) {
  if (session.agent_runtime.workflow_status !== "paused") return false;
  return Boolean(findTaobaoAuthenticationFailedTask(session));
}

export function findTaobaoAuthenticationFailedCartTask(
  session: SessionState,
  productId?: string
) {
  const latestByProduct = new Map<string, SessionState["hosted_tasks"][number]>();
  for (const task of session.hosted_tasks) {
    if (
      task.executor !== "local_executor" ||
      task.task_type !== "add_to_cart" ||
      !task.product_id ||
      (productId && task.product_id !== productId)
    ) {
      continue;
    }
    const current = latestByProduct.get(task.product_id);
    const taskTime = Date.parse(task.updated_at || task.created_at);
    const currentTime = current ? Date.parse(current.updated_at || current.created_at) : Number.NEGATIVE_INFINITY;
    const comparableTaskTime = Number.isFinite(taskTime) ? taskTime : Number.NEGATIVE_INFINITY;
    const comparableCurrentTime = Number.isFinite(currentTime) ? currentTime : Number.NEGATIVE_INFINITY;
    if (!current || comparableTaskTime >= comparableCurrentTime) {
      latestByProduct.set(task.product_id, task);
    }
  }

  return [...latestByProduct.values()]
    .filter((task) =>
      task.status === "failed" &&
      TAOBAO_AUTHENTICATION_PATTERN.test(`${task.error_message ?? ""} ${task.result_summary ?? ""}`)
    )
    .sort((left, right) => {
      const rightTime = Date.parse(right.updated_at || right.created_at);
      const leftTime = Date.parse(left.updated_at || left.created_at);
      return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
    })[0];
}

export function isTaobaoCartAuthenticationPause(
  session: SessionState,
  status: MpcStatus | null,
  productId?: string
) {
  const authenticationRequired = (status?.executor_devices?.authentication_required ?? 0) > 0;
  if (authenticationRequired) return true;

  const cartExecutorAvailable = status?.executor_devices?.capabilities.add_to_cart.available === true;
  return !cartExecutorAvailable && Boolean(findTaobaoAuthenticationFailedCartTask(session, productId));
}

export function findCurrentTaobaoMcpEvidence(session: SessionState, moduleId: string) {
  const workflowRunId = session.agent_runtime.workflow_run_id ?? "manual";
  for (const task of session.hosted_tasks) {
    if (
      task.executor !== "local_executor" ||
      task.task_type !== "module_search" ||
      task.status !== "completed" ||
      task.module_id !== moduleId
    ) {
      continue;
    }
    const evidence = task.payload.taobao_mcp_evidence;
    if (!isTaobaoMcpSearchEvidence(evidence)) continue;
    if (
      task.runtime_job_id !== evidence.job_id ||
      task.task_id !== evidence.job_id ||
      evidence.module_id !== moduleId ||
      evidence.workflow_run_id !== workflowRunId ||
      task.payload.workflow_run_id !== evidence.workflow_run_id ||
      task.payload.keyword !== evidence.keyword
    ) {
      continue;
    }
    return evidence;
  }
  return undefined;
}
