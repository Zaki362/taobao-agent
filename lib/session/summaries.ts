import type { SessionState } from "@/lib/session/types";

export type SessionResumeStage = "confirm_plan" | "searching" | "review_results";

export interface ShoppingSessionSummary {
  session_id: string;
  archived_at?: string;
  requirement: string;
  scene_label: string;
  budget: number;
  priority_style: string;
  module_count: number;
  covered_module_count: number;
  candidate_count: number;
  selected_item_count: number;
  workflow_status: SessionState["agent_runtime"]["workflow_status"];
  workflow_message: string;
  status_label: string;
  resume_stage: SessionResumeStage;
  created_at: string;
  last_activity_at: string;
}

function timestampFromSessionId(sessionId: string) {
  const match = sessionId.match(/^session-(\d{10,})/);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  const timestamp = value < 10_000_000_000 ? value * 1_000 : value;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function latestIso(values: Array<string | undefined>, fallback: string) {
  let latest = Date.parse(fallback);
  let selected = fallback;

  for (const value of values) {
    if (!value) continue;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp) && timestamp >= latest) {
      latest = timestamp;
      selected = new Date(timestamp).toISOString();
    }
  }

  return selected;
}

function statusLabel(state: SessionState, coveredModuleCount: number) {
  if (state.archived_at) return "已归档";
  const status = state.agent_runtime.workflow_status;
  if (status === "running") return "Agent 执行中";
  if (status === "waiting_for_tools") return "等待本地执行器";
  if (status === "paused") return "已暂停，可继续";
  if (status === "error") return "需要处理";
  if (status === "completed" || state.completion_report) return "推荐已生成";
  if (coveredModuleCount > 0) return "已有部分推荐";
  return "规划待确认";
}

function resumeStage(state: SessionState, coveredModuleCount: number): SessionResumeStage {
  const status = state.agent_runtime.workflow_status;
  if (status === "running" || status === "waiting_for_tools" || status === "paused" || status === "error") {
    return "searching";
  }
  if (status === "completed" || state.completion_report || coveredModuleCount > 0) {
    return "review_results";
  }
  return "confirm_plan";
}

export function summarizeShoppingSession(state: SessionState): ShoppingSessionSummary {
  const modules = state.shopping_plan.modules;
  const candidateLists = modules.map((module) => state.module_candidates[module.module_id] ?? []);
  const coveredModuleCount = candidateLists.filter((candidates) => candidates.length > 0).length;
  const createdAt =
    timestampFromSessionId(state.session_id) ??
    state.agent_runtime.initialized_at ??
    new Date(0).toISOString();
  const lastActivityAt = latestIso(
    [
      state.archived_at,
      state.agent_runtime.last_transition_at,
      state.agent_runtime.last_decision_at,
      state.completion_report?.generated_at,
      state.bundle_adoption?.updated_at,
      ...Object.values(state.module_search_traces).map((trace) => trace.updated_at),
      ...state.selected_items.map((item) => item.added_at),
      ...state.tool_logs.map((log) => log.timestamp),
      ...state.hosted_tasks.map((task) => task.updated_at)
    ],
    createdAt
  );

  return {
    session_id: state.session_id,
    archived_at: state.archived_at,
    requirement: state.raw_input.trim() || state.scene_brief.optional_notes || "未命名购物任务",
    scene_label: state.current_scene_label || state.scene_brief.scene_type,
    budget: state.scene_brief.budget,
    priority_style: state.scene_brief.priority_style,
    module_count: modules.length,
    covered_module_count: coveredModuleCount,
    candidate_count: candidateLists.reduce((total, candidates) => total + candidates.length, 0),
    selected_item_count: state.selected_items.length,
    workflow_status: state.agent_runtime.workflow_status,
    workflow_message: state.agent_runtime.workflow_message,
    status_label: statusLabel(state, coveredModuleCount),
    resume_stage: resumeStage(state, coveredModuleCount),
    created_at: createdAt,
    last_activity_at: lastActivityAt
  };
}

export function summarizeShoppingSessions(states: SessionState[], limit = 6) {
  const boundedLimit = Math.min(Math.max(Math.round(limit) || 6, 1), 20);
  return states
    .map(summarizeShoppingSession)
    .sort((left, right) => Date.parse(right.last_activity_at) - Date.parse(left.last_activity_at))
    .slice(0, boundedLimit);
}
