import { NextRequest } from "next/server";
import { updateModuleSearchStrategy } from "@/lib/agent/orchestrator";
import { apiOk, apiRouteError, requireString } from "@/lib/api/responses";
import { getRequestIdentity } from "@/lib/auth/request";
import { enforceWorkflowMutationRateLimit } from "@/lib/security/rate-limit";
import { API_INPUT_LIMITS, boundedStringArray, readJsonObject } from "@/lib/api/validation";

function field(source: unknown, key: string) {
  if (!source || typeof source !== "object") {
    return undefined;
  }
  return (source as Record<string, unknown>)[key];
}

function stringList(value: unknown) {
  return boundedStringArray(value, "alternate_keywords", {
    maxItems: API_INPUT_LIMITS.alternateKeywords,
    maxItemLength: API_INPUT_LIMITS.keywordLength
  });
}

export async function POST(request: NextRequest) {
  try {
    const identity = await getRequestIdentity();
    await enforceWorkflowMutationRateLimit(request, identity.userId);
    const body = await readJsonObject(request);
    const sessionId = requireString(field(body, "session_id"), "session_id");
    const moduleId = requireString(field(body, "module_id"), "module_id");
    const primaryKeyword = requireString(
      field(body, "primary_keyword"),
      "primary_keyword",
      API_INPUT_LIMITS.keywordLength
    );
    const alternateKeywords = stringList(field(body, "alternate_keywords"));

    const result = await updateModuleSearchStrategy(sessionId, moduleId, {
      primaryKeyword,
      alternateKeywords
    }, identity.userId);

    return apiOk({
      state: result.state,
      module: result.module
    });
  } catch (error) {
    return apiRouteError(error, "failed to update module search strategy");
  }
}
