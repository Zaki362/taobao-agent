import { describe, expect, it } from "vitest";
import {
  consumeAgentDecision,
  decideNextAgentAction,
  recordAgentDecision
} from "@/lib/agent/decision-engine";
import { decideNextAgentActionV2, validateModelProposal } from "@/lib/agent/runtime-v2";
import { createSessionFixture } from "@/tests/fixtures/session";

describe("Agent Runtime 2.0", () => {
  it("selects the first planned module and records tool consumption", () => {
    const state = createSessionFixture();
    const decision = decideNextAgentAction(state);
    expect(decision.action).toBe("search_module");
    expect(decision.module_id).toBe(state.shopping_plan.execution_strategy.module_sequence[0]);

    recordAgentDecision(state, decision);
    expect(consumeAgentDecision(state, decision.module_id!)).toBe(true);
    expect(state.agent_runtime.used_tool_calls).toBe(1);
    expect(state.agent_decisions[0].consumed_at).toBeTruthy();
  });

  it("deduplicates an identical unconsumed decision", () => {
    const state = createSessionFixture();
    const first = decideNextAgentAction(state);
    const recorded = recordAgentDecision(state, first);
    const duplicate = recordAgentDecision(state, { ...first, decision_id: "another-id" });
    expect(duplicate.decision_id).toBe(recorded.decision_id);
    expect(state.agent_decisions).toHaveLength(1);
  });

  it("stops safely when the runtime tool budget is exhausted", async () => {
    const state = createSessionFixture();
    state.agent_runtime.used_tool_calls = state.agent_runtime.max_tool_calls;
    const decision = await decideNextAgentActionV2(state);
    expect(decision.action).toBe("complete_workflow");
    expect(decision.guardrail_notes).toContain("tool_budget_exhausted");
    expect(state.agent_runtime.last_decision_mode).toBe("policy");
  });

  it("waits rather than duplicating work when every pending module is already queued", () => {
    const state = createSessionFixture();
    const now = new Date().toISOString();
    state.hosted_tasks = state.shopping_plan.modules.map((module) => ({
      task_id: `task-${module.module_id}`,
      task_type: "module_search",
      session_id: state.session_id,
      status: "pending",
      title: `搜索${module.module_name}`,
      description: "queued",
      module_id: module.module_id,
      module_name: module.module_name,
      created_at: now,
      updated_at: now,
      payload: {}
    }));
    expect(decideNextAgentAction(state).action).toBe("wait_for_tools");
  });

  it("rejects model proposals outside the planned module whitelist", () => {
    const state = createSessionFixture();
    const validation = validateModelProposal(state, {
      action: "search_module",
      confidence: "high",
      module_id: "unknown-module",
      reason: "search something unrelated",
      evidence: [],
      expected_gain: "unknown",
      tool_cost: 1
    });
    expect(validation.valid).toBe(false);
    expect(validation.notes).toContain("模型选择了规划外模块");
  });
});
