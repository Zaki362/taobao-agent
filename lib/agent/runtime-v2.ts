import {
  createAgentDecision,
  decideNextAgentAction,
  isTaskFromCurrentWorkflowRun
} from "@/lib/agent/decision-engine";
import { decideAgentNextAction } from "@/lib/llm/deepseek";
import { normalizeModelSearchKeyword } from "@/lib/agent/search-strategy";
import { appendSessionLlmCalls, markSessionLlmCallFallback } from "@/lib/llm/session-evidence";
import { downgradeLastLlmCall } from "@/lib/llm/telemetry";
import type {
  AgentDecision,
  AgentDecisionProposal,
  SessionLlmCall,
  SessionState,
  ShoppingPlanModule
} from "@/lib/session/types";

export type AgentModelDecider = (
  state: SessionState,
  fallback: AgentDecisionProposal
) => Promise<{
  data: AgentDecisionProposal;
  mode: "connected" | "mock";
  call?: SessionLlmCall;
}>;

function proposalFromPolicy(decision: AgentDecision): AgentDecisionProposal {
  return {
    action: decision.action,
    confidence: decision.confidence,
    module_id: decision.module_id,
    keyword_override: decision.keyword_override,
    reason: decision.reason,
    evidence: decision.evidence,
    expected_gain:
      decision.action === "search_module" || decision.action === "retry_module"
        ? "形成更贴合当前模块和预算的候选商品池"
        : decision.action === "wait_for_tools"
          ? "避免重复提交工具任务"
          : "保持工作流可恢复并控制无效工具消耗",
    tool_cost: decision.action === "search_module" || decision.action === "retry_module" ? 1 : 0
  };
}

function activeModuleTask(state: SessionState, moduleId?: string) {
  return state.hosted_tasks.some(
    (task) =>
      (!moduleId || task.module_id === moduleId) &&
      (task.status === "pending" || task.status === "running")
  );
}

function moduleById(state: SessionState, moduleId?: string) {
  return state.shopping_plan.modules.find((module) => module.module_id === moduleId);
}

function isSettled(state: SessionState, module: ShoppingPlanModule) {
  const hasCandidates = (state.module_candidates[module.module_id]?.length ?? 0) > 0;
  const skipped = state.agent_decisions.some(
    (decision) => decision.action === "skip_module" && decision.module_id === module.module_id
  );
  return hasCandidates || skipped;
}

export function validateModelProposal(
  state: SessionState,
  proposal: AgentDecisionProposal
): {
  valid: boolean;
  notes: string[];
  normalized_keyword_override?: string;
  normalization_notes: string[];
} {
  const notes: string[] = [];
  const normalizationNotes: string[] = [];
  const module = moduleById(state, proposal.module_id);
  const budgetRemaining = state.agent_runtime.max_tool_calls - state.agent_runtime.used_tool_calls;
  let normalizedKeywordOverride: string | undefined;

  if (proposal.confidence === "low") notes.push("模型置信度过低，使用规则兜底");
  if (proposal.tool_cost > budgetRemaining) notes.push("模型动作超过本轮工具预算");

  if (proposal.action === "search_module" || proposal.action === "retry_module") {
    if (!module) notes.push("模型选择了规划外模块");
    if (activeModuleTask(state, proposal.module_id)) notes.push("该模块已有执行中任务");
    if (module && proposal.action === "search_module" && (state.module_candidates[module.module_id]?.length ?? 0) > 0) {
      notes.push("已有候选池时不能重复执行首轮搜索");
    }
    if (
      module &&
      proposal.action === "search_module" &&
      state.hosted_tasks.some(
        (task) =>
          task.task_type === "module_search" &&
          task.module_id === module.module_id &&
          isTaskFromCurrentWorkflowRun(state, task) &&
          (task.status === "completed" || task.status === "failed" || task.status === "cancelled")
      )
    ) {
      notes.push("该模块已结束首轮搜索，不能重复调用工具");
    }
    if (module && proposal.action === "retry_module") {
      const searched = state.module_search_traces[module.module_id]?.searched_keywords ?? [];
      if (searched.length === 0) {
        notes.push("补搜前必须已有首轮搜索记录");
      }
      if (!proposal.keyword_override) {
        notes.push("补搜必须提供未尝试过的新关键词");
      }
    }
    if (module && proposal.keyword_override) {
      const keywordValidation = normalizeModelSearchKeyword(module, proposal.keyword_override);
      normalizedKeywordOverride = keywordValidation.normalized;
      notes.push(...keywordValidation.notes);
      normalizationNotes.push(...keywordValidation.repair_notes);
      const searched = state.module_search_traces[module.module_id]?.searched_keywords
        .map((keyword) => keyword.replace(/\s+/g, " ").trim()) ?? [];
      if (proposal.action === "retry_module" && searched.includes(keywordValidation.normalized)) {
        notes.push("补搜必须提供未尝试过的新关键词");
      }
    }
  }

  if (proposal.action === "skip_module") {
    if (!module) {
      notes.push("跳过动作缺少合法模块");
    } else {
      const failed = state.module_search_traces[module.module_id]?.status === "failed";
      if (!module.optional && !failed) notes.push("非可选模块只有执行失败后才能跳过");
    }
  }

  if (proposal.action === "wait_for_tools" && !activeModuleTask(state)) {
    notes.push("当前没有活跃任务，不应等待工具");
  }

  if (proposal.action === "complete_workflow") {
    const allSettled = state.shopping_plan.modules.every((item) => isSettled(state, item));
    if (!allSettled && budgetRemaining > 0) notes.push("仍有未处理模块且工具预算未耗尽");
  }

  const uniqueNotes = [...new Set(notes)];
  return {
    valid: uniqueNotes.length === 0,
    notes: uniqueNotes,
    normalized_keyword_override: normalizedKeywordOverride,
    normalization_notes: normalizationNotes
  };
}

function materializeModelDecision(
  state: SessionState,
  proposal: AgentDecisionProposal,
  guardrailNotes: string[],
  decisionLatencyMs: number
) {
  const module = moduleById(state, proposal.module_id);
  return createAgentDecision({
    action: proposal.action,
    source: "deepseek_runtime",
    confidence: proposal.confidence,
    module_id: module?.module_id,
    module_name: module?.module_name,
    keyword_override: proposal.keyword_override,
    reason: proposal.reason,
    evidence: proposal.evidence,
    expected_gain: proposal.expected_gain,
    tool_cost: proposal.tool_cost,
    guardrail_notes: guardrailNotes,
    decision_latency_ms: decisionLatencyMs
  });
}

export async function decideNextAgentActionV2(
  state: SessionState,
  modelDecider: AgentModelDecider = decideAgentNextAction
) {
  const policyDecision = decideNextAgentAction(state);
  const policyProposal = proposalFromPolicy(policyDecision);
  const budgetRemaining = state.agent_runtime.max_tool_calls - state.agent_runtime.used_tool_calls;
  const userConfirmedRetry =
    policyDecision.action === "retry_module" &&
    Boolean(policyDecision.module_id) &&
    state.module_reviews[policyDecision.module_id!]?.user_confirmed_retry === true;
  const hardPolicyAction =
    policyDecision.action === "wait_for_tools" ||
    policyDecision.action === "skip_module" ||
    userConfirmedRetry ||
    (budgetRemaining <= 0 && policyDecision.action !== "complete_workflow") ||
    state.shopping_plan.agent_directives.autonomy_level === "保守执行";

  if (budgetRemaining <= 0 && policyDecision.action !== "complete_workflow") {
    state.agent_runtime.policy_decisions += 1;
    state.agent_runtime.last_decision_mode = "policy";
    state.agent_runtime.last_fallback_reason = "tool_budget_exhausted";
    state.agent_runtime.last_decision_at = new Date().toISOString();
    return createAgentDecision({
      action: "complete_workflow",
      source: "policy_fallback",
      confidence: "high",
      reason: "本轮 Agent 工具预算已经耗尽，停止继续搜索并保留当前结果。",
      evidence: [`工具预算：${state.agent_runtime.used_tool_calls}/${state.agent_runtime.max_tool_calls}`],
      expected_gain: "避免无上限工具调用",
      tool_cost: 0,
      guardrail_notes: ["tool_budget_exhausted"]
    });
  }

  if (hardPolicyAction) {
    state.agent_runtime.policy_decisions += 1;
    state.agent_runtime.last_decision_mode = "policy";
    state.agent_runtime.last_fallback_reason = policyDecision.action === "wait_for_tools"
      ? "active_tool_task"
      : userConfirmedRetry
        ? "user_confirmed_retry"
        : "conservative_execution_policy";
    state.agent_runtime.last_decision_at = new Date().toISOString();
    return policyDecision;
  }

  const startedAt = Date.now();
  state.agent_runtime.model_proposals += 1;
  const modeled = await modelDecider(state, policyProposal);
  appendSessionLlmCalls(state, modeled.call);
  const decisionLatencyMs = Date.now() - startedAt;
  state.agent_runtime.total_decision_latency_ms += decisionLatencyMs;
  state.agent_runtime.last_decision_at = new Date().toISOString();
  if (modeled.mode === "connected") {
    const validation = validateModelProposal(state, modeled.data);
    if (validation.valid) {
      state.agent_runtime.model_decisions += 1;
      state.agent_runtime.last_decision_mode = "deepseek";
      state.agent_runtime.last_fallback_reason = undefined;
      return materializeModelDecision(
        state,
        {
          ...modeled.data,
          keyword_override: validation.normalized_keyword_override ?? modeled.data.keyword_override
        },
        [
          "动作白名单校验通过",
          "工具预算校验通过",
          ...validation.normalization_notes,
          ...(modeled.data.keyword_override ? ["搜索词语义与指令安全校验通过"] : [])
        ],
        decisionLatencyMs
      );
    }
    state.agent_runtime.model_rejections += 1;
    const guardrailReason = `guardrail_rejected:${validation.notes.slice(0, 3).join("；")}`;
    markSessionLlmCallFallback(state, modeled.call?.id, guardrailReason);
    if (modeled.call?.task === "decide_next_action") {
      downgradeLastLlmCall("decide_next_action", guardrailReason);
    }
    policyDecision.guardrail_notes = validation.notes;
    policyDecision.decision_latency_ms = decisionLatencyMs;
    state.agent_runtime.last_fallback_reason = validation.notes.join("；");
  } else {
    state.agent_runtime.model_failures += 1;
    policyDecision.guardrail_notes = ["模型未返回有效结构化决策，已使用规则策略"];
    policyDecision.decision_latency_ms = decisionLatencyMs;
    state.agent_runtime.last_fallback_reason = "model_unavailable_or_invalid_json";
  }

  state.agent_runtime.policy_decisions += 1;
  state.agent_runtime.last_decision_mode = "policy";
  return policyDecision;
}
