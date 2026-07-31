import { mockParseScene, mockPersonalizeTemplate, mockReviewShoppingPlan } from "@/lib/llm/mock";
import { NEW_CAR_SETUP_TEMPLATE } from "@/lib/templates/new-car-template";
import { buildMarketFeedback } from "@/lib/agent/market-feedback";
import type { SessionState } from "@/lib/session/types";

export function createSessionFixture(overrides: Partial<SessionState> = {}): SessionState {
  const scene = mockParseScene(
    "刚提新能源车，预算 1500，希望优先买最实用的新车用品，不考虑装饰类。"
  );
  const plan = mockPersonalizeTemplate(scene, NEW_CAR_SETUP_TEMPLATE);

  return {
    session_id: "session-test",
    owner_id: "user-test",
    raw_input: scene.optional_notes,
    scene_brief: scene,
    base_template: NEW_CAR_SETUP_TEMPLATE,
    shopping_plan: plan,
    plan_review: mockReviewShoppingPlan(scene, plan),
    module_candidates: {},
    module_reviews: {},
    module_search_traces: {},
    market_feedback: buildMarketFeedback({
      scene_brief: scene,
      shopping_plan: plan,
      module_candidates: {}
    }),
    agent_decisions: [],
    agent_runtime: {
      max_tool_calls: 12,
      used_tool_calls: 0,
      model_decisions: 0,
      policy_decisions: 0,
      model_proposals: 0,
      model_rejections: 0,
      model_failures: 0,
      total_decision_latency_ms: 0,
      last_decision_mode: "none",
      initialized_at: new Date().toISOString()
    },
    selected_items: [],
    tool_logs: [],
    hosted_tasks: [],
    execution_mode: "local_executor",
    permissions_scope: ["搜索商品", "浏览商品详情", "加入购物车需显式确认"],
    deepseek_status: "mock",
    mcp_status: "hosted",
    current_scene_label: "新车选购",
    ...overrides
  };
}
