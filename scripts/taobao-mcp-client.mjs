const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const NON_REPLAYABLE_TOOLS = new Set(["add_to_cart"]);

function parseJsonText(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function parseMcpResponseBody(body, contentType = "") {
  const text = String(body ?? "").trim();
  if (!text) return null;
  if (!contentType.includes("text/event-stream")) {
    return parseJsonText(text);
  }

  const messages = [];
  let dataLines = [];
  const flush = () => {
    if (dataLines.length === 0) return;
    const parsed = parseJsonText(dataLines.join("\n"));
    if (parsed !== null) messages.push(parsed);
    dataLines = [];
  };

  for (const line of text.split(/\r?\n/)) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  flush();
  return messages.at(-1) ?? null;
}

export function unwrapMcpToolResult(result, depth = 0) {
  if (depth > 4) return result;
  if (!result || typeof result !== "object") return result;
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return unwrapMcpToolResult(result.structuredContent, depth + 1);
  }

  const blocks = Array.isArray(result.content) ? result.content : [];
  const parsedBlocks = blocks
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => parseJsonText(block.text))
    .filter((value) => value !== null);
  if (parsedBlocks.length === 1) return unwrapMcpToolResult(parsedBlocks[0], depth + 1);
  if (parsedBlocks.length > 1) return parsedBlocks;
  return result;
}

function errorMessage(payload, fallback) {
  if (payload && typeof payload === "object") {
    if (typeof payload.error === "string") return payload.error;
    if (payload.error && typeof payload.error.message === "string") return payload.error.message;
  }
  return fallback;
}

export class TaobaoMcpClient {
  constructor(options = {}) {
    this.endpoint = options.endpoint || "http://127.0.0.1:3654/mcp";
    this.sourceApp = options.sourceApp || "SceneCartAI";
    this.timeoutMs = Math.max(Number(options.timeoutMs || 60000), 5000);
    this.fetchImpl = options.fetchImpl || fetch;
    this.sessionId = null;
    this.requestId = 0;
  }

  signal(externalSignal) {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    return externalSignal
      ? AbortSignal.any([externalSignal, timeoutSignal])
      : timeoutSignal;
  }

  async post(payload, options = {}) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream"
    };
    if (options.withSession !== false && this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }

    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: this.signal(options.signal)
    });
    const body = await response.text();
    const parsed = parseMcpResponseBody(body, response.headers.get("content-type") || "");
    if (!response.ok) {
      throw new Error(errorMessage(parsed, body || `淘宝 MCP 请求失败：HTTP ${response.status}`));
    }
    return { response, payload: parsed };
  }

  async initialize(signal) {
    try {
      const id = ++this.requestId;
      const initialized = await this.post({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: DEFAULT_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: this.sourceApp, version: "0.1.0" }
        }
      }, { withSession: false, signal });
      const payload = initialized.payload;
      if (!payload || payload.id !== id || payload.error) {
        throw new Error(errorMessage(payload, "淘宝 MCP 初始化响应无效"));
      }
      const sessionId = initialized.response.headers.get("mcp-session-id");
      if (!sessionId) throw new Error("淘宝 MCP 未返回会话 ID");
      this.sessionId = sessionId;
      await this.post({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      }, { signal });
      return payload.result;
    } catch (error) {
      // A server can allocate a session and then disappear before accepting the
      // initialized notification. Never reuse that half-initialized session on
      // the next readiness probe.
      this.resetSession();
      throw error;
    }
  }

  async ensureSession(signal) {
    if (!this.sessionId) await this.initialize(signal);
  }

  resetSession() {
    this.sessionId = null;
    this.requestId = 0;
  }

  async close() {
    // Taobao Desktop currently couples remote MCP session termination to its
    // shopping WebView lifecycle. Sending HTTP DELETE can invalidate the next
    // authenticated tool call, so only forget the local session and let the
    // desktop server reclaim it by TTL.
    this.resetSession();
  }

  async request(method, params, signal, canRecover = true) {
    await this.ensureSession(signal);
    const id = ++this.requestId;
    try {
      const { payload } = await this.post({ jsonrpc: "2.0", id, method, params }, { signal });
      if (!payload || payload.id !== id || payload.error) {
        throw new Error(errorMessage(payload, `淘宝 MCP ${method} 响应无效`));
      }
      return payload.result;
    } catch (error) {
      if (canRecover && /会话ID|session|HTTP 404/i.test(error instanceof Error ? error.message : String(error))) {
        this.sessionId = null;
        return this.request(method, params, signal, false);
      }
      throw error;
    }
  }

  async listTools(signal) {
    const result = await this.request("tools/list", {}, signal);
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name, argumentsValue = {}, signal) {
    const result = await this.request("tools/call", {
      name,
      arguments: {
        ...argumentsValue,
        sourceApp: argumentsValue.sourceApp || this.sourceApp
      }
    }, signal, !NON_REPLAYABLE_TOOLS.has(name));
    const unwrapped = unwrapMcpToolResult(result);
    if (result?.isError) {
      throw new Error(typeof unwrapped === "string" ? unwrapped : JSON.stringify(unwrapped));
    }
    if (unwrapped && typeof unwrapped === "object" && typeof unwrapped.error === "string") {
      throw new Error(unwrapped.error);
    }
    if (
      unwrapped &&
      typeof unwrapped === "object" &&
      unwrapped.success === false &&
      unwrapped.needsSkuSelection !== true &&
      unwrapped.needs_sku_selection !== true
    ) {
      const message = typeof unwrapped.message === "string"
        ? unwrapped.message
        : `淘宝 MCP 工具 ${name} 返回失败`;
      throw new Error(message);
    }
    return unwrapped;
  }
}
