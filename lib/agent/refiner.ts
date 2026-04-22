import { refinePlan } from "@/lib/llm/deepseek";
import { runDeepSeekPlanner } from "@/lib/agent/planner";
import { QuickAction, SessionState } from "@/lib/session/types";

export async function runRefiner(state: SessionState, action: QuickAction) {
  const refined = await refinePlan(state.scene_brief, action);
  state.scene_brief = refined.data;
  state.deepseek_status = refined.mode;
  const plan = await runDeepSeekPlanner(state.scene_brief);
  state.shopping_plan = plan.data;
  state.base_template = state.base_template;
  state.last_action = action;

  const impactedModules =
    action === "换一批推荐"
      ? state.shopping_plan.modules.slice(0, 3).map((module) => module.module_id)
      : state.shopping_plan.modules
          .filter((module) => module.status === "ready" || module.status === "refined")
          .map((module) => module.module_id);

  for (const moduleId of impactedModules) {
    delete state.module_candidates[moduleId];
  }

  return {
    state,
    impactedModules,
    mode: refined.mode
  };
}
