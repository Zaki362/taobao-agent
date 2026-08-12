import { NextRequest } from "next/server";
import { ensureSession } from "@/lib/agent/orchestrator";
import { ApiRouteError, apiOk, apiRouteError, badRequest, conflict, notFound, requireString } from "@/lib/api/responses";
import { getExecutionBackend } from "@/lib/mcp/client";
import { executeMcpTool } from "@/lib/mcp/executor";
import { getMcpToolDefinition, isMcpToolName, validateMcpToolInput } from "@/lib/mcp/schema";
import { persistSession } from "@/lib/session/repository";
import { getRequestIdentity } from "@/lib/auth/request";
import { isMcpDebugEnabled } from "@/lib/runtime/product-mode";

export async function POST(request: NextRequest) {
  try {
    if (!isMcpDebugEnabled()) {
      throw new ApiRouteError("MCP 手动调试端点未启用。", 404, "not_found");
    }
    const identity = await getRequestIdentity();
    const backend = getExecutionBackend();
    if (backend === "codex_hosted" || backend === "local_executor") {
      return conflict("当前为持久队列执行模式，不能从 Next.js 请求进程直接调用 MCP 工具。");
    }

    const body = await request.json().catch(() => ({}));
    const sessionId = requireString(body.session_id, "session_id");
    const state = await ensureSession(sessionId, identity.userId);
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
    await persistSession(state);
    return apiOk({
      output,
      tool_logs: state.tool_logs
    });
  } catch (error) {
    return apiRouteError(error, "mcp run failed");
  }
}
