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
});
