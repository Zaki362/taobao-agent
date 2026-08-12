import type { MCPAdapter, MCPToolName, MCPToolRequestMap, MCPToolResponseMap } from "@/lib/mcp/types";

export const localExecutorMcpAdapter: MCPAdapter = {
  mode: "local_executor",
  async detect() {
    return {
      available: true,
      message: "当前使用本地执行器队列。淘宝 Skill 调用不会在 Next.js 请求进程中执行。",
      permissions_scope: ["本地淘宝搜索", "本地商品详情", "加购需显式确认"]
    };
  },
  async run<T extends MCPToolName>(
    _tool: T,
    _input: MCPToolRequestMap[T]
  ): Promise<MCPToolResponseMap[T]> {
    throw new Error("local_executor mode requires a durable runtime job instead of a direct MCP call");
  }
};
