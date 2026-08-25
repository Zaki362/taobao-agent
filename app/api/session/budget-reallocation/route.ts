import { NextRequest } from "next/server";
import {
  BudgetReallocationConflictError
} from "@/lib/agent/market-feedback";
import { applyMarketBudgetSuggestion } from "@/lib/agent/orchestrator";
import { ApiRouteError, apiOk, apiRouteError, requireString } from "@/lib/api/responses";
import { getRequestIdentity } from "@/lib/auth/request";
import { enforceWorkflowMutationRateLimit } from "@/lib/security/rate-limit";
import { readJsonObject } from "@/lib/api/validation";

export async function POST(request: NextRequest) {
  try {
    const identity = await getRequestIdentity();
    await enforceWorkflowMutationRateLimit(request, identity.userId);
    const body = await readJsonObject(request);
    if (body.confirmed !== true) {
      throw new ApiRouteError("必须由用户显式确认预算调配。", 400, "confirmation_required");
    }

    const result = await applyMarketBudgetSuggestion(
      requireString(body.session_id, "session_id"),
      requireString(body.from_module_id, "from_module_id"),
      requireString(body.to_module_id, "to_module_id"),
      identity.userId
    );

    return apiOk({
      session_id: result.state.session_id,
      state: result.state,
      applied_suggestion: result.suggestion,
      previous_budgets: result.previous_budgets,
      updated_budgets: result.updated_budgets,
      impacted_modules: result.impacted_modules,
      refinement_impact: result.refinement_impact
    });
  } catch (error) {
    if (error instanceof BudgetReallocationConflictError) {
      return apiRouteError(
        new ApiRouteError(error.message, 409, "budget_suggestion_conflict"),
        "budget reallocation failed"
      );
    }
    return apiRouteError(error, "budget reallocation failed");
  }
}
