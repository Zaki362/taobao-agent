import { MCPAdapter, MCPToolName, MCPToolRequestMap, MCPToolResponseMap } from "@/lib/mcp/types";

const baseUrl = process.env.TAOBAO_MCP_BASE_URL;
const STATUS_TTL_MS = 15_000;

let cachedStatus:
  | {
      available: boolean;
      message: string;
      permissions_scope: string[];
      cached_at: number;
    }
  | undefined;

async function parseJson(response: Response) {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Live MCP 返回非 JSON 响应：${text.slice(0, 120)}`);
  }
}

export const liveMcpAdapter: MCPAdapter = {
  mode: "experimental_local",
  async detect() {
    if (cachedStatus && Date.now() - cachedStatus.cached_at < STATUS_TTL_MS) {
      return {
        available: cachedStatus.available,
        message: cachedStatus.message,
        permissions_scope: cachedStatus.permissions_scope
      };
    }

    if (!baseUrl) {
      return {
        available: false,
        message: "未配置 TAOBAO_MCP_BASE_URL，无法连接用户自己的淘宝 MCP。",
        permissions_scope: ["未连接 Live MCP"]
      };
    }

    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/health`, {
        method: "GET",
        cache: "no-store"
      });
      const payload = await parseJson(response).catch(() => ({}));
      if (!response.ok) {
        const status = {
          available: false,
          message:
            (payload && typeof payload.error === "string" && payload.error) ||
            (payload && typeof payload.message === "string" && payload.message) ||
            `Live MCP 健康检查失败：${response.status}`,
          permissions_scope: ["搜索商品", "浏览商品详情", "加入购物车需显式确认"]
        };
        cachedStatus = {
          ...status,
          cached_at: Date.now()
        };
        return status;
      }

      const status = {
        available: true,
        message: typeof payload.message === "string" ? payload.message : "已连接用户自己的淘宝 MCP",
        permissions_scope: Array.isArray(payload.permissions_scope)
          ? (payload.permissions_scope as unknown[]).filter((item): item is string => typeof item === "string")
          : ["搜索商品", "浏览商品详情", "提取商品信息", "加入购物车需显式确认"]
      };
      cachedStatus = {
        ...status,
        cached_at: Date.now()
      };
      return status;
    } catch (error) {
      const status = {
        available: false,
        message: error instanceof Error ? error.message : "Live MCP 不可达",
        permissions_scope: ["未连接 Live MCP"]
      };
      cachedStatus = {
        ...status,
        cached_at: Date.now()
      };
      return status;
    }
  },
  async run<T extends MCPToolName>(tool: T, input: MCPToolRequestMap[T]): Promise<MCPToolResponseMap[T]> {
    if (!baseUrl) {
      throw new Error("未配置 TAOBAO_MCP_BASE_URL，无法调用 Live MCP。");
    }

    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        tool,
        input
      }),
      cache: "no-store"
    });

    if (!response.ok) {
      const payload = await parseJson(response).catch(() => ({}));
      throw new Error(typeof payload.error === "string" ? payload.error : `Live MCP 调用失败：${response.status}`);
    }

    const payload = await parseJson(response);
    if (!payload || typeof payload !== "object" || !("output" in payload)) {
      throw new Error("Live MCP 返回格式不正确，缺少 output 字段。");
    }

    cachedStatus = {
      available: true,
      message: "已连接用户自己的淘宝 MCP",
      permissions_scope: ["搜索商品", "浏览商品详情", "提取商品信息", "加入购物车需显式确认"],
      cached_at: Date.now()
    };

    return payload.output as MCPToolResponseMap[T];
  }
};
