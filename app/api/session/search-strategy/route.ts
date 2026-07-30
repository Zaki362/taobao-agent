import { NextRequest } from "next/server";
import { updateModuleSearchStrategy } from "@/lib/agent/orchestrator";
import { apiOk, apiRouteError, requireString } from "@/lib/api/responses";

function field(source: unknown, key: string) {
  if (!source || typeof source !== "object") {
    return undefined;
  }
  return (source as Record<string, unknown>)[key];
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const sessionId = requireString(field(body, "session_id"), "session_id");
    const moduleId = requireString(field(body, "module_id"), "module_id");
    const primaryKeyword = requireString(field(body, "primary_keyword"), "primary_keyword");
    const alternateKeywords = stringList(field(body, "alternate_keywords"));

    const result = await updateModuleSearchStrategy(sessionId, moduleId, {
      primaryKeyword,
      alternateKeywords
    });

    return apiOk({
      state: result.state,
      module: result.module
    });
  } catch (error) {
    return apiRouteError(error, "failed to update module search strategy");
  }
}
