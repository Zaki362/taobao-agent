import { reviewShoppingPlan, type StructuredLlmResult } from "@/lib/llm/deepseek";
import { PlanQualityReview, SceneBrief, ShoppingPlan } from "@/lib/session/types";

export async function reviewPlanWithAgent(
  scene: SceneBrief,
  plan: ShoppingPlan
): Promise<StructuredLlmResult<PlanQualityReview>> {
  return reviewShoppingPlan(scene, plan);
}
