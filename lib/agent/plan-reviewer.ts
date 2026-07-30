import { reviewShoppingPlan } from "@/lib/llm/deepseek";
import { PlanQualityReview, SceneBrief, ShoppingPlan } from "@/lib/session/types";

export async function reviewPlanWithAgent(
  scene: SceneBrief,
  plan: ShoppingPlan
): Promise<{ data: PlanQualityReview; mode: "connected" | "mock" }> {
  return reviewShoppingPlan(scene, plan);
}
