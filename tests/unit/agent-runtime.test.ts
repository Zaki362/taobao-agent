import { describe, expect, it } from "vitest";
import {
  consumeAgentDecision,
  decideNextAgentAction,
  recordAgentDecision
} from "@/lib/agent/decision-engine";
import { decideNextAgentActionV2, validateModelProposal } from "@/lib/agent/runtime-v2";
import { applyAgentDirectiveProfile } from "@/lib/agent/directives";
import { reviewModuleCandidates } from "@/lib/agent/candidate-reviewer";
import { createSessionFixture } from "@/tests/fixtures/session";

describe("Agent Runtime 2.0", () => {
  it("expands the tool budget only when the user selects exploratory autonomy", () => {
    const conservative = createSessionFixture();
    const exploratory = createSessionFixture();
    applyAgentDirectiveProfile(conservative, "conservative");
    applyAgentDirectiveProfile(exploratory, "exploratory");
    expect(conservative.agent_runtime.max_tool_calls).toBeGreaterThanOrEqual(conservative.shopping_plan.modules.length);
    expect(exploratory.agent_runtime.max_tool_calls).toBeGreaterThan(conservative.agent_runtime.max_tool_calls);
    expect(exploratory.shopping_plan.agent_directives.safety_boundaries).toContain("不自动下单或支付");
  });

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

  it("skips a terminal empty module instead of searching it again", () => {
    const state = createSessionFixture();
    const module = state.shopping_plan.modules[0];
    const now = new Date().toISOString();
    state.hosted_tasks = [{
      task_id: "terminal-empty-search",
      task_type: "module_search",
      session_id: state.session_id,
      status: "completed",
      title: `搜索${module.module_name}`,
      description: "真实搜索完成但结果为空",
      module_id: module.module_id,
      module_name: module.module_name,
      result_summary: "淘宝真实搜索未返回候选",
      created_at: now,
      updated_at: now,
      payload: {}
    }];

    const decision = decideNextAgentAction(state);
    expect(decision).toMatchObject({
      action: "skip_module",
      module_id: module.module_id
    });
  });

  it("rejects a model request to repeat a terminal module search", () => {
    const state = createSessionFixture();
    const module = state.shopping_plan.modules[0];
    const now = new Date().toISOString();
    state.hosted_tasks = [{
      task_id: "terminal-model-search",
      task_type: "module_search",
      session_id: state.session_id,
      status: "completed",
      title: `搜索${module.module_name}`,
      description: "首轮搜索已结束",
      module_id: module.module_id,
      module_name: module.module_name,
      created_at: now,
      updated_at: now,
      payload: {}
    }];

    const validation = validateModelProposal(state, {
      action: "search_module",
      confidence: "high",
      module_id: module.module_id,
      reason: "模型希望重复首轮搜索",
      evidence: [],
      expected_gain: "未知",
      tool_cost: 1
    });

    expect(validation.valid).toBe(false);
    expect(validation.notes).toContain("该模块已结束首轮搜索，不能重复调用工具");
  });

  it("allows an explicitly new workflow run to search past a prior run's terminal task", () => {
    const state = createSessionFixture();
    const module = state.shopping_plan.modules[0];
    const now = new Date().toISOString();
    state.agent_runtime.workflow_run_id = "recovery-run";
    state.hosted_tasks = [{
      task_id: "prior-run-terminal-search",
      task_type: "module_search",
      session_id: state.session_id,
      status: "failed",
      title: `搜索${module.module_name}`,
      description: "上一运行搜索失败",
      module_id: module.module_id,
      module_name: module.module_name,
      created_at: now,
      updated_at: now,
      payload: { workflow_run_id: "prior-run" }
    }];

    expect(decideNextAgentAction(state)).toMatchObject({
      action: "search_module",
      module_id: module.module_id
    });
    const validation = validateModelProposal(state, {
      action: "search_module",
      confidence: "high",
      module_id: module.module_id,
      reason: "用户已确认新的缺口恢复运行",
      evidence: ["新 workflow run"],
      expected_gain: "补齐未覆盖模块",
      tool_cost: 1
    });
    expect(validation.valid).toBe(true);
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

  it("rejects an autonomous search keyword that leaves the selected module", () => {
    const state = createSessionFixture();
    const module = state.shopping_plan.modules[0];
    const validation = validateModelProposal(state, {
      action: "search_module",
      confidence: "high",
      module_id: module.module_id,
      keyword_override: "双人露营帐篷 户外过夜",
      reason: "尝试扩大搜索范围",
      evidence: ["用户预算充足"],
      expected_gain: "增加候选",
      tool_cost: 1
    });

    expect(validation.valid).toBe(false);
    expect(validation.notes).toContain(`自主搜索词必须保留「${module.module_name}」的至少一个品类锚点`);
  });

  it("rejects tool instructions embedded in an autonomous search keyword", () => {
    const state = createSessionFixture();
    const module = state.shopping_plan.modules[0];
    const anchor = module.typical_item_types[0];
    const validation = validateModelProposal(state, {
      action: "search_module",
      confidence: "high",
      module_id: module.module_id,
      keyword_override: `${anchor} https://example.com --yolo taobao-native`,
      reason: "使用外部地址执行搜索",
      evidence: [],
      expected_gain: "未知",
      tool_cost: 1
    });

    expect(validation.valid).toBe(false);
    expect(validation.notes).toContain("自主搜索词不能包含 URL");
    expect(validation.notes).toContain("自主搜索词不能包含工具调用指令");
    expect(validation.notes).toContain("自主搜索词不能包含命令行参数");
  });

  it("requires a completed first search before an autonomous retry", () => {
    const state = createSessionFixture();
    const module = state.shopping_plan.modules[0];
    const validation = validateModelProposal(state, {
      action: "retry_module",
      confidence: "high",
      module_id: module.module_id,
      keyword_override: `${module.typical_item_types[0]} 官方旗舰`,
      reason: "补充店铺可信度更高的候选",
      evidence: ["首轮候选质量不足"],
      expected_gain: "提高候选可信度",
      tool_cost: 1
    });

    expect(validation.valid).toBe(false);
    expect(validation.notes).toContain("补搜前必须已有首轮搜索记录");
  });

  it("ignores an unrelated candidate-review retry keyword", () => {
    const state = createSessionFixture();
    const module = state.shopping_plan.modules[0];
    state.shopping_plan.agent_directives.autonomy_level = "探索执行";
    state.shopping_plan.agent_directives.search_depth = "深度搜索";
    state.module_candidates[module.module_id] = [{
      product_id: "candidate-1",
      title: `${module.module_name} 候选`,
      price: 99,
      source: "淘宝",
      shop_name: "测试旗舰店",
      image_url: "https://example.com/item.jpg",
      detail_url: "https://item.taobao.com/item.htm?id=candidate-1",
      shop_badges: ["旗舰店"],
      highlights: [module.module_name],
      risk_notes: ["仅用于测试"],
      fit_reason: "符合当前模块",
      recommendation_type: "稳妥推荐",
      module_id: module.module_id
    }];
    state.module_reviews[module.module_id] = {
      module_id: module.module_id,
      status: "thin",
      source: "deepseek",
      summary: "候选偏薄",
      strengths: [],
      caveats: ["候选不足"],
      next_action: "建议补搜",
      suggested_keyword: "双人露营帐篷 户外过夜",
      generated_at: new Date().toISOString()
    };

    const decision = decideNextAgentAction(state);

    expect(decision).not.toMatchObject({
      action: "retry_module",
      module_id: module.module_id
    });
  });

  it("accepts and normalizes a semantically aligned autonomous retry", async () => {
    const state = createSessionFixture();
    const module = state.shopping_plan.modules[0];
    const primaryKeyword = module.search_strategy?.primary_keyword || module.search_keyword || module.module_name;
    const retryKeyword = `  ${module.typical_item_types[0]}   官方旗舰  夜视  `;
    const now = new Date().toISOString();
    state.shopping_plan.agent_directives.autonomy_level = "探索执行";
    state.module_search_traces[module.module_id] = {
      module_id: module.module_id,
      module_name: module.module_name,
      status: "thin",
      primary_keyword: primaryKeyword,
      searched_keywords: [primaryKeyword],
      attempts: [],
      result_count: 1,
      candidate_count: 1,
      review_status: "thin",
      ai_decision_summary: "首轮候选偏薄",
      next_action: "建议补搜",
      generated_at: now,
      updated_at: now
    };

    const decision = await decideNextAgentActionV2(state, async () => ({
      mode: "connected",
      data: {
        action: "retry_module",
        confidence: "high",
        module_id: module.module_id,
        keyword_override: retryKeyword,
        reason: "保留模块品类并增加店铺和夜视筛选方向",
        evidence: ["首轮候选偏少", "仍有工具预算"],
        expected_gain: "补充更可信的候选",
        tool_cost: 1
      }
    }));

    expect(decision.source).toBe("deepseek_runtime");
    expect(decision.action).toBe("retry_module");
    expect(decision.keyword_override).toBe(`${module.typical_item_types[0]} 官方旗舰 夜视`);
    expect(decision.guardrail_notes).toContain("搜索词语义与指令安全校验通过");
  });

  it("repairs a grounded modifier-only model search proposal", async () => {
    const state = createSessionFixture();
    const module = state.shopping_plan.modules[0];
    const groundedSignal = module.search_strategy?.ranking_focus[0] ?? "适配当前阶段";
    state.shopping_plan.agent_directives.autonomy_level = "探索执行";

    const decision = await decideNextAgentActionV2(state, async () => ({
      mode: "connected",
      data: {
        action: "search_module",
        confidence: "high",
        module_id: module.module_id,
        keyword_override: `官方旗舰 ${groundedSignal} 高性价比`,
        reason: "保留模型给出的店铺和功能筛选方向",
        evidence: ["当前模块尚未搜索"],
        expected_gain: "形成更可信的首轮候选",
        tool_cost: 1
      }
    }));

    expect(decision.source).toBe("deepseek_runtime");
    expect(decision.keyword_override).toContain(module.typical_item_types[0]);
    expect(decision.guardrail_notes).toContain(
      `模型筛选意图已由后端补齐品类锚点「${module.typical_item_types[0]}」`
    );
  });

  it("accepts a valid model proposal in exploration mode", async () => {
    const state = createSessionFixture();
    state.shopping_plan.agent_directives.autonomy_level = "探索执行";
    const target = state.shopping_plan.modules[1];
    const decision = await decideNextAgentActionV2(state, async () => ({
      mode: "connected",
      data: {
        action: "search_module",
        confidence: "high",
        module_id: target.module_id,
        reason: "该模块预期使用频率更高，先建立候选池",
        evidence: ["预算充足", "当前没有活跃任务"],
        expected_gain: "提高首轮方案覆盖率",
        tool_cost: 1
      }
    }));
    expect(decision.source).toBe("deepseek_runtime");
    expect(decision.module_id).toBe(target.module_id);
    expect(state.agent_runtime.model_proposals).toBe(1);
    expect(state.agent_runtime.model_decisions).toBe(1);
    expect(state.agent_runtime.model_rejections).toBe(0);
  });

  it("persists privacy-safe model evidence for the current session", async () => {
    const state = createSessionFixture();
    state.shopping_plan.agent_directives.autonomy_level = "探索执行";
    const target = state.shopping_plan.modules[0];
    const now = new Date().toISOString();
    await decideNextAgentActionV2(state, async () => ({
      mode: "connected",
      data: {
        action: "search_module",
        confidence: "high",
        module_id: target.module_id,
        reason: "优先完成高频模块",
        evidence: ["预算和顺序允许"],
        expected_gain: "形成候选池",
        tool_cost: 1
      },
      call: {
        id: "runtime-call-1",
        task: "decide_next_action",
        model: "deepseek-chat",
        mode: "connected",
        duration_ms: 90,
        created_at: now
      }
    }));

    expect(state.llm_calls).toEqual([
      expect.objectContaining({
        id: "runtime-call-1",
        task: "decide_next_action",
        mode: "connected"
      })
    ]);
  });

  it("rejects a low-confidence model proposal and records the fallback", async () => {
    const state = createSessionFixture();
    state.shopping_plan.agent_directives.autonomy_level = "平衡执行";
    const target = state.shopping_plan.modules[0];
    const decision = await decideNextAgentActionV2(state, async () => ({
      mode: "connected",
      data: {
        action: "search_module",
        confidence: "low",
        module_id: target.module_id,
        reason: "不确定是否应先搜索",
        evidence: [],
        expected_gain: "未知",
        tool_cost: 1
      },
      call: {
        id: "runtime-rejected-call",
        task: "decide_next_action",
        model: "deepseek-chat",
        mode: "connected",
        duration_ms: 40,
        created_at: new Date().toISOString()
      }
    }));
    expect(decision.source).not.toBe("deepseek_runtime");
    expect(decision.guardrail_notes).toContain("模型置信度过低，使用规则兜底");
    expect(state.agent_runtime.model_rejections).toBe(1);
    expect(state.agent_runtime.last_fallback_reason).toContain("模型置信度过低");
    expect(state.llm_calls).toEqual([
      expect.objectContaining({
        id: "runtime-rejected-call",
        mode: "fallback",
        reason: expect.stringContaining("guardrail_rejected")
      })
    ]);
  });

  it("records structured model fallback without interrupting the workflow", async () => {
    const state = createSessionFixture();
    state.shopping_plan.agent_directives.autonomy_level = "探索执行";
    const decision = await decideNextAgentActionV2(state, async (_state, fallback) => ({
      mode: "mock",
      data: fallback
    }));
    expect(decision.action).toBe("search_module");
    expect(state.agent_runtime.model_failures).toBe(1);
    expect(state.agent_runtime.last_decision_mode).toBe("policy");
  });

  it("honors a one-time user-confirmed retry before asking the model for another action", async () => {
    const state = createSessionFixture();
    const module = state.shopping_plan.modules[0];
    const primaryKeyword = module.search_strategy?.primary_keyword || module.search_keyword || module.module_name;
    const candidate = {
      product_id: "confirmed-retry-candidate",
      title: `${module.module_name} 首轮候选`,
      price: 99,
      source: "淘宝",
      shop_name: "测试旗舰店",
      image_url: "https://example.com/item.jpg",
      detail_url: "https://item.taobao.com/item.htm?id=confirmed-retry-candidate",
      shop_badges: ["旗舰店"],
      highlights: [module.module_name],
      risk_notes: ["测试摘要"],
      fit_reason: "符合当前模块",
      recommendation_type: "稳妥推荐" as const,
      module_id: module.module_id
    };
    state.module_candidates[module.module_id] = [candidate];
    state.module_reviews[module.module_id] = {
      ...reviewModuleCandidates(state, module, [candidate]),
      suggested_keyword: `${primaryKeyword} 官方旗舰`,
      user_confirmed_retry: true
    };
    state.module_search_traces[module.module_id] = {
      module_id: module.module_id,
      module_name: module.module_name,
      status: "thin",
      primary_keyword: primaryKeyword,
      searched_keywords: [primaryKeyword],
      attempts: [],
      result_count: 1,
      candidate_count: 1,
      review_status: "thin",
      ai_decision_summary: "候选偏薄",
      next_action: "用户已确认补搜",
      generated_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    state.shopping_plan.agent_directives.autonomy_level = "平衡执行";
    state.shopping_plan.agent_directives.search_depth = "轻量搜索";
    let modelCalled = false;

    const decision = await decideNextAgentActionV2(state, async (_state, fallback) => {
      modelCalled = true;
      return {
        mode: "connected",
        data: { ...fallback, action: "complete_workflow", module_id: undefined, keyword_override: undefined }
      };
    });

    expect(modelCalled).toBe(false);
    expect(decision).toMatchObject({
      action: "retry_module",
      module_id: module.module_id,
      keyword_override: `${primaryKeyword} 官方旗舰`
    });
    expect(state.agent_runtime.last_fallback_reason).toBe("user_confirmed_retry");
  });
});
