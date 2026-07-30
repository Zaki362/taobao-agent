import { NextRequest } from "next/server";
import { ensureSession } from "@/lib/agent/orchestrator";
import { apiOk, apiRouteError, badRequest, conflict, notFound, requireString } from "@/lib/api/responses";
import { getExecutionBackend } from "@/lib/mcp/client";
import { executeMcpTool } from "@/lib/mcp/executor";
import { getMcpToolDefinition, isMcpToolName, validateMcpToolInput } from "@/lib/mcp/schema";
import { saveSession } from "@/lib/session/store";

export async function POST(request: NextRequest) {
  try {
    if (getExecutionBackend() === "codex_hosted") {
      return conflict("当前为 Codex 宿主执行模式。请通过 hosted task queue 提交与回填执行结果，而不是直接从 Next.js 进程调用 MCP。");
    }

    const body = await request.json().catch(() => ({}));
    const sessionId = requireString(body.session_id, "session_id");
    const state = await ensureSession(sessionId);
    if (!state) {
      return notFound("session not found");
    }
    const toolName = typeof body.tool_name === "string" ? body.tool_name : "";
    if (!isMcpToolName(toolName)) {
      return conflict("未知 MCP 工具，已阻止执行。");
    }

    const definition = getMcpToolDefinition(toolName);
    let input;
    try {
      input = validateMcpToolInput(toolName, body.input ?? {});
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : "invalid MCP input");
    }
    if (definition?.requires_confirmation) {
      const inputConfirmed = "confirmed" in input && input.confirmed === true;
      if (body.confirm_high_risk !== true || !inputConfirmed) {
        return conflict("该 MCP 工具属于高风险动作，需要 confirm_high_risk=true 且 input.confirmed=true。");
      }
    }

    const output = await executeMcpTool(state, toolName, input);
    saveSession(state);
    return apiOk({
      output,
      tool_logs: state.tool_logs
    });
  } catch (error) {
    return apiRouteError(error, "mcp run failed");
  }
}
