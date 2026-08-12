import { describe, expect, it } from "vitest";
import { summarizeShoppingSession, summarizeShoppingSessions } from "@/lib/session/summaries";
import { createSessionFixture } from "@/tests/fixtures/session";

describe("shopping session summaries", () => {
  it("keeps the landing payload compact and resumes an untouched plan at confirmation", () => {
    const summary = summarizeShoppingSession(createSessionFixture({
      session_id: "session-1735689600000",
      raw_input: "刚提新能源车，预算 1500，实用优先"
    }));

    expect(summary).toMatchObject({
      requirement: "刚提新能源车，预算 1500，实用优先",
      budget: 1500,
      covered_module_count: 0,
      candidate_count: 0,
      status_label: "规划待确认",
      resume_stage: "confirm_plan",
      created_at: "2025-01-01T00:00:00.000Z"
    });
    expect(summary).not.toHaveProperty("tool_logs");
    expect(summary).not.toHaveProperty("module_candidates");
    expect(summary).not.toHaveProperty("llm_calls");
  });

  it("resumes active execution at the progress page and completed work at results", () => {
    const waiting = summarizeShoppingSession(createSessionFixture({
      agent_runtime: {
        ...createSessionFixture().agent_runtime,
        workflow_status: "waiting_for_tools",
        workflow_message: "等待本地执行器搜索安全必需"
      }
    }));
    const completed = summarizeShoppingSession(createSessionFixture({
      agent_runtime: {
        ...createSessionFixture().agent_runtime,
        workflow_status: "completed",
        workflow_message: "搜索完成"
      }
    }));

    expect(waiting).toMatchObject({ status_label: "等待本地执行器", resume_stage: "searching" });
    expect(completed).toMatchObject({ status_label: "推荐已生成", resume_stage: "review_results" });
  });

  it("resumes a refined idle plan at confirmation even when reusable candidates remain", () => {
    const state = createSessionFixture();
    const module = state.shopping_plan.modules[0];
    state.module_candidates[module.module_id] = [{
      product_id: "reusable-candidate",
      module_id: module.module_id,
      title: "可复用候选",
      price: 99,
      source: "淘宝",
      shop_name: "测试店铺",
      image_url: "https://img.alicdn.com/reusable.jpg",
      detail_url: "https://item.taobao.com/item.htm?id=reusable-candidate",
      shop_badges: [],
      highlights: [],
      risk_notes: [],
      fit_reason: "保留未受影响模块",
      recommendation_type: "稳妥推荐"
    }];
    state.agent_runtime.workflow_status = "idle";
    state.last_refinement = {
      quick_action: "应用市场预算建议",
      summary: "等待确认新规划",
      impacted_modules: state.shopping_plan.modules.slice(0, 2).map((item) => item.module_id),
      reusable_modules: [module.module_id],
      removed_modules: [],
      module_decisions: [],
      generated_at: "2026-08-12T00:00:00.000Z"
    };

    expect(summarizeShoppingSession(state).resume_stage).toBe("confirm_plan");
  });

  it("orders tasks by real activity and enforces the response limit", () => {
    const older = createSessionFixture({
      session_id: "session-1735689600000",
      agent_runtime: {
        ...createSessionFixture().agent_runtime,
        last_transition_at: "2025-01-01T01:00:00.000Z"
      }
    });
    const newer = createSessionFixture({
      session_id: "session-1735689700000",
      agent_runtime: {
        ...createSessionFixture().agent_runtime,
        last_transition_at: "2025-01-02T01:00:00.000Z"
      }
    });

    const summaries = summarizeShoppingSessions([older, newer], 1);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].session_id).toBe(newer.session_id);
  });

  it("marks archived sessions without exposing additional context", () => {
    const archivedAt = "2099-01-03T08:00:00.000Z";
    const summary = summarizeShoppingSession(createSessionFixture({ archived_at: archivedAt }));

    expect(summary).toMatchObject({
      archived_at: archivedAt,
      status_label: "已归档",
      last_activity_at: archivedAt
    });
    expect(summary).not.toHaveProperty("hosted_tasks");
  });
});
