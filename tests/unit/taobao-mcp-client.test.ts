import { describe, expect, it, vi } from "vitest";
// The executor loads this native ESM module directly from Node.
// @ts-expect-error Runtime utility intentionally has no TypeScript declarations.
import * as mcpModule from "../../scripts/taobao-mcp-client.mjs";

const {
  parseMcpResponseBody,
  TaobaoMcpClient,
  unwrapMcpToolResult
} = mcpModule;

function sse(payload: unknown, headers: Record<string, string> = {}) {
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      ...headers
    }
  });
}

describe("Taobao Streamable HTTP MCP client", () => {
  it("parses the final JSON payload from an SSE response", () => {
    expect(parseMcpResponseBody(
      'event: message\ndata: {"result":{"ok":true},"id":1}\n\n',
      "text/event-stream"
    )).toEqual({ result: { ok: true }, id: 1 });
  });

  it("unwraps JSON text blocks returned by tools/call", () => {
    expect(unwrapMcpToolResult({
      content: [{ type: "text", text: '{"result":{"products":[{"itemId":"1"}]}}' }]
    })).toEqual({ result: { products: [{ itemId: "1" }] } });
  });

  it("unwraps nested content envelopes returned by the desktop MCP", () => {
    expect(unwrapMcpToolResult({
      content: [{
        type: "text",
        text: JSON.stringify({
          content: [{ type: "text", text: JSON.stringify({ url: "https://www.taobao.com" }) }]
        })
      }]
    })).toEqual({ url: "https://www.taobao.com" });
  });

  it("initializes once and injects the real SceneCart source into tool calls", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      if (body.method === "initialize") {
        return sse({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "taobao-native-mcp", version: "1.0.0" }
          }
        }, { "mcp-session-id": "session-test" });
      }
      if (body.method === "notifications/initialized") {
        return new Response("", { status: 202 });
      }
      if (body.method === "tools/call") {
        return sse({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [{
              type: "text",
              text: JSON.stringify({ result: { keyword: "车载手机支架", products: [] } })
            }]
          }
        });
      }
      throw new Error(`unexpected method: ${String(body.method)}`);
    });
    const client = new TaobaoMcpClient({ fetchImpl, sourceApp: "SceneCartAI" });

    await expect(client.callTool("search_products", {
      keyword: "车载手机支架",
      type: "all"
    })).resolves.toEqual({ result: { keyword: "车载手机支架", products: [] } });

    const toolCall = requests.find((request) => request.method === "tools/call") as {
      params: { arguments: Record<string, unknown> };
    };
    expect(toolCall.params.arguments).toMatchObject({
      keyword: "车载手机支架",
      type: "all",
      sourceApp: "SceneCartAI"
    });
    expect(requests.filter((request) => request.method === "initialize")).toHaveLength(1);
  });

  it("surfaces MCP tool errors without retrying the shopping action", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === "initialize") {
        return sse({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: {} }
        }, { "mcp-session-id": "session-test" });
      }
      if (body.method === "notifications/initialized") return new Response("", { status: 202 });
      return sse({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          isError: true,
          content: [{ type: "text", text: '{"error":"未登录，请先登录淘宝账号"}' }]
        }
      });
    });
    const client = new TaobaoMcpClient({ fetchImpl });

    await expect(client.callTool("search_products", { keyword: "露营灯" }))
      .rejects.toThrow("未登录，请先登录淘宝账号");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("surfaces structured login failures returned without the MCP isError flag", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === "initialize") {
        return sse({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: {} }
        }, { "mcp-session-id": "session-structured-failure" });
      }
      if (body.method === "notifications/initialized") return new Response("", { status: 202 });
      return sse({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [{
            type: "text",
            text: JSON.stringify({ success: false, message: "未登录，请先登录淘宝账号" })
          }]
        }
      });
    });
    const client = new TaobaoMcpClient({ fetchImpl });

    await expect(client.callTool("search_products", { keyword: "露营灯" }))
      .rejects.toThrow("未登录，请先登录淘宝账号");
  });

  it("preserves structured SKU-selection responses for explicit user choice", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === "initialize") {
        return sse({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: {} }
        }, { "mcp-session-id": "session-sku-choice" });
      }
      if (body.method === "notifications/initialized") return new Response("", { status: 202 });
      return sse({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [{
            type: "text",
            text: JSON.stringify({ success: false, needsSkuSelection: true, availableSkus: [] })
          }]
        }
      });
    });
    const client = new TaobaoMcpClient({ fetchImpl });

    await expect(client.callTool("add_to_cart", { itemId: "product-1" }))
      .resolves.toMatchObject({ success: false, needsSkuSelection: true });
  });

  it("never replays add_to_cart when the MCP session expires after submission", async () => {
    let cartCalls = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === "initialize") {
        return sse({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: {} }
        }, { "mcp-session-id": "session-cart" });
      }
      if (body.method === "notifications/initialized") return new Response("", { status: 202 });
      cartCalls += 1;
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32001, message: "MCP session expired" }
      }), {
        status: 404,
        headers: { "content-type": "application/json" }
      });
    });
    const client = new TaobaoMcpClient({ fetchImpl });

    await expect(client.callTool("add_to_cart", { itemId: "product-1", sku: [] }))
      .rejects.toThrow("MCP session expired");
    expect(cartCalls).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("reuses one Streamable HTTP session across consecutive shopping calls", async () => {
    let initializeCount = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === "initialize") {
        initializeCount += 1;
        return sse({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: {} }
        }, { "mcp-session-id": "session-one" });
      }
      if (body.method === "notifications/initialized") return new Response("", { status: 202 });
      return sse({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: '{"ok":true}' }] }
      });
    });
    const client = new TaobaoMcpClient({ fetchImpl });

    await client.callTool("search_products", { keyword: "车载手机支架" });
    await client.callTool("search_products", { keyword: "行车记录仪" });

    expect(initializeCount).toBe(1);
  });

  it("forgets a session without remotely terminating the Taobao WebView", async () => {
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      methods.push(String(init?.method ?? "POST"));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === "initialize") {
        return sse({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: {} }
        }, { "mcp-session-id": "session-close" });
      }
      if (body.method === "notifications/initialized") return new Response("", { status: 202 });
      return sse({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
    });
    const client = new TaobaoMcpClient({ fetchImpl });

    await client.listTools();
    await client.close();

    expect(methods).not.toContain("DELETE");
    expect(client.sessionId).toBeNull();
  });

  it("forgets a half-initialized session when the initialized notification fails", async () => {
    let initializeCount = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === "initialize") {
        initializeCount += 1;
        return sse({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: {} }
        }, { "mcp-session-id": `half-session-${initializeCount}` });
      }
      if (body.method === "notifications/initialized" && initializeCount === 1) {
        throw new Error("fetch failed");
      }
      if (body.method === "notifications/initialized") return new Response("", { status: 202 });
      return sse({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
    });
    const client = new TaobaoMcpClient({ fetchImpl });

    await expect(client.listTools()).rejects.toThrow("fetch failed");
    expect(client.sessionId).toBeNull();
    await expect(client.listTools()).resolves.toEqual([]);
    expect(initializeCount).toBe(2);
    expect(client.sessionId).toBe("half-session-2");
  });
});
