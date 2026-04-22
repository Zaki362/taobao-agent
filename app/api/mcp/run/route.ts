import { NextRequest, NextResponse } from "next/server";
import { ensureSession } from "@/lib/agent/orchestrator";
import { getExecutionBackend } from "@/lib/mcp/client";
import { executeMcpTool } from "@/lib/mcp/executor";
import { MCPToolName } from "@/lib/mcp/types";
import { saveSession } from "@/lib/session/store";

export async function POST(request: NextRequest) {
  if (getExecutionBackend() === "codex_hosted") {
    return NextResponse.json(
      {
        error: "当前为 Codex 宿主执行模式。请通过 hosted task queue 提交与回填执行结果，而不是直接从 Next.js 进程调用 MCP。"
      },
      { status: 409 }
    );
  }

  const body = await request.json();
  const state = await ensureSession(body.session_id as string | undefined);
  if (!state) {
    return NextResponse.json(
      {
        error: "session not found"
      },
      { status: 404 }
    );
  }
  const output = await executeMcpTool(state, body.tool_name as MCPToolName, body.input ?? {});
  saveSession(state);
  return NextResponse.json({
    output,
    tool_logs: state.tool_logs
  });
}
