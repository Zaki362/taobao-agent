import { getMcpClient } from "@/lib/mcp/client";
import { MCPToolName, MCPToolRequestMap, MCPToolResponseMap } from "@/lib/mcp/types";
import { SessionState } from "@/lib/session/types";

let logSequence = 0;

interface MCPExecutionContext {
  module_id?: string;
  module_name?: string;
}

function summarizeInput(value: unknown) {
  return JSON.stringify(value).slice(0, 180);
}

function summarizeOutput(value: unknown) {
  return JSON.stringify(value).slice(0, 180);
}

function createLogId(toolName: MCPToolName, started: number) {
  logSequence += 1;
  return `${toolName}-${started}-${logSequence}`;
}

export async function executeMcpTool<T extends MCPToolName>(
  state: SessionState,
  toolName: T,
  input: MCPToolRequestMap[T],
  context?: MCPExecutionContext
): Promise<MCPToolResponseMap[T]> {
  const { client, status } = await getMcpClient();
  const started = Date.now();

  state.execution_mode = client.mode;
  state.mcp_status = client.mode === "codex_hosted" ? "hosted" : status.available ? "connected" : "unavailable";
  state.permissions_scope = status.permissions_scope;

  if (client.mode === "codex_hosted") {
    throw new Error("Codex 宿主模式下不应直接由 Next.js 进程执行 MCP 工具。请改用 hosted task queue。");
  }

  try {
    const output = await client.run(toolName, input);
    state.tool_logs.unshift({
      id: createLogId(toolName, started),
      timestamp: new Date(started).toISOString(),
      tool_name: toolName,
      module_id: context?.module_id,
      module_name: context?.module_name,
      input_summary: summarizeInput(input),
      output_summary: summarizeOutput(output),
      status: "success",
      duration_ms: Date.now() - started,
      mode: client.mode
    });
    state.mcp_status = "connected";
    return output;
  } catch (error) {
    state.tool_logs.unshift({
      id: createLogId(toolName, started),
      timestamp: new Date(started).toISOString(),
      tool_name: toolName,
      module_id: context?.module_id,
      module_name: context?.module_name,
      input_summary: summarizeInput(input),
      output_summary: error instanceof Error ? error.message : "unknown error",
      status: "error",
      duration_ms: Date.now() - started,
      mode: client.mode
    });
    state.mcp_status = "unavailable";
    throw error;
  }
}
