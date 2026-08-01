import { describe, expect, it } from "vitest";
import { buildAgentCompletionReport } from "@/lib/agent/completion-review";
import { createAgentDecision } from "@/lib/agent/decision-engine";
import { refreshMarketFeedback } from "@/lib/agent/market-feedback";
import type { ProductCandidate, SessionState } from "@/lib/session/types";
import { normalizeSessionState } from "@/lib/session/store";
import { createSessionFixture } from "@/tests/fixtures/session";

function candidateSet(state: SessionState, moduleId: string): ProductCandidate[] {
  const module = state.shopping_plan.modules.find((item) => item.module_id === moduleId)!;
  return (["稳妥推荐", "性价比推荐", "升级推荐"] as const).map((recommendationType, index) => ({
    product_id: `${moduleId}-${index}`,
    title: `${module.module_name} 候选 ${index + 1}`,
    price: Math.max(1, Math.round(module.budget_allocation * (0.72 + index * 0.08))),
    source: "测试",
    shop_name: "测试旗舰店",
    image_url: "https://example.com/product.jpg",
    detail_url: `https://item.taobao.com/item.htm?id=${moduleId}-${index}`,
    shop_badges: ["旗舰店"],
    highlights: [module.module_name],
    risk_notes: ["需确认规格"],
    fit_reason: "符合当前模块",
    recommendation_type: recommendationType,
    module_id: moduleId
  }));
}

function fullyCoveredState() {
  const state = createSessionFixture();
  for (const module of state.shopping_plan.modules) {
    state.module_candidates[module.module_id] = candidateSet(state, module.module_id);
    state.module_reviews[module.module_id] = {
      module_id: module.module_id,
      status: "ready",
      source: "heuristic",
      summary: "候选数量和价格档位完整。",
      strengths: ["覆盖三档"],
      caveats: [],
      next_action: "进入商品对比。",
      generated_at: new Date().toISOString()
    };
  }
  refreshMarketFeedback(state);
  return state;
}

describe("Agent completion review", () => {
  it("marks a fully covered plan as ready", () => {
    const state = fullyCoveredState();
    const report = buildAgentCompletionReport(state);

    expect(report.status).toBe("ready");
    expect(report.covered_module_ids).toHaveLength(state.shopping_plan.modules.length);
    expect(report.critical_coverage_ratio).toBe(1);
    expect(report.total_candidates).toBe(state.shopping_plan.modules.length * 3);
    expect(report.caveats).toHaveLength(0);
  });

  it("keeps thin candidate evidence visible as a partial result", () => {
    const state = fullyCoveredState();
    const module = state.shopping_plan.modules[0];
    state.module_reviews[module.module_id].status = "thin";

    const report = buildAgentCompletionReport(state);

    expect(report.status).toBe("partial");
    expect(report.thin_module_ids).toContain(module.module_id);
    expect(report.next_steps.join(" ")).toContain("局部补搜");
  });

  it("does not present a skipped required module as a complete plan", () => {
    const state = fullyCoveredState();
    const module = state.shopping_plan.modules.find((item) => !item.optional)!;
    delete state.module_candidates[module.module_id];
    delete state.module_reviews[module.module_id];
    refreshMarketFeedback(state);
    state.agent_decisions.push(createAgentDecision({
      action: "skip_module",
      source: "policy_fallback",
      confidence: "high",
      module_id: module.module_id,
      module_name: module.module_name,
      reason: "工具终态失败",
      evidence: ["没有可用候选"]
    }));

    const report = buildAgentCompletionReport(state);

    expect(report.status).toBe("needs_attention");
    expect(report.skipped_module_ids).toContain(module.module_id);
    expect(report.critical_coverage_ratio).toBeLessThan(1);
    expect(report.summary).toContain("不应视为完整");
  });

  it("flags an uncovered required module even without an explicit skip decision", () => {
    const state = fullyCoveredState();
    const module = state.shopping_plan.modules.find((item) => !item.optional)!;
    delete state.module_candidates[module.module_id];
    delete state.module_reviews[module.module_id];
    refreshMarketFeedback(state);

    const report = buildAgentCompletionReport(state);

    expect(report.status).toBe("needs_attention");
    expect(report.uncovered_module_ids).toContain(module.module_id);
    expect(report.skipped_module_ids).not.toContain(module.module_id);
    expect(report.caveats.join(" ")).toContain("尚未形成候选覆盖");
  });

  it("marks an uncovered optional module as partial rather than ready", () => {
    const state = fullyCoveredState();
    const module = state.shopping_plan.modules.find((item) => item.optional)!;
    delete state.module_candidates[module.module_id];
    delete state.module_reviews[module.module_id];
    refreshMarketFeedback(state);

    const report = buildAgentCompletionReport(state);

    expect(report.status).toBe("partial");
    expect(report.critical_coverage_ratio).toBe(1);
    expect(report.uncovered_module_ids).toContain(module.module_id);
  });

  it("retains the final DeepSeek stop decision as auditable evidence", () => {
    const state = fullyCoveredState();
    const decision = createAgentDecision({
      action: "complete_workflow",
      source: "deepseek_runtime",
      confidence: "high",
      reason: "必需模块均已覆盖，继续扩搜的边际收益较低。",
      evidence: ["候选覆盖完整"],
      expected_gain: "停止无效工具消耗",
      tool_cost: 0
    });

    const report = buildAgentCompletionReport(state, decision);

    expect(report.source).toBe("deepseek_runtime");
    expect(report.decision_id).toBe(decision.decision_id);
    expect(report.stop_reason).toBe(decision.reason);
  });

  it("preserves a valid report across session normalization", () => {
    const state = fullyCoveredState();
    state.completion_report = buildAgentCompletionReport(state);

    const normalized = normalizeSessionState(state);

    expect(normalized.completion_report).toEqual(state.completion_report);
  });
});
