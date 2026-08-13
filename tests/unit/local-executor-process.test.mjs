import { spawn } from "node:child_process";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";

const protocolVersion = "3";
const openServers = new Set();
const openChildren = new Set();

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      openServers.add(server);
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => {
    openServers.delete(server);
    resolve();
  }));
}

function json(response, status, payload, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    ...headers
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

async function waitFor(predicate, message, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000))
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
  openChildren.delete(child);
}

afterEach(async () => {
  await Promise.all([...openChildren].map(stopChild));
  await Promise.all([...openServers].map(closeServer));
});

describe("local executor process readiness recovery", () => {
  it("stays alive without claiming jobs, then automatically claims after Taobao MCP recovers", async () => {
    let mcpReady = false;
    let claimCount = 0;
    const heartbeatStates = [];
    const mcpMethods = [];

    const apiServer = http.createServer(async (request, response) => {
      if (request.url === "/api/runtime/health") {
        return json(response, 200, {
          status: "healthy",
          runtime_store: "local",
          effective_executor_backend: "local_executor",
          executor_protocol_version: protocolVersion
        });
      }
      if (request.url === "/api/executor/heartbeat") {
        const body = await readJson(request);
        heartbeatStates.push(body.executor_state);
        return json(response, 200, {
          device: {
            id: "device-process-readiness",
            capabilities: ["module_search"]
          },
          executor_state: body.executor_state,
          protocol_version: protocolVersion,
          lease_renewed: false
        });
      }
      if (request.url === "/api/executor/jobs/claim") {
        claimCount += 1;
        return json(response, 200, {
          job: null,
          recovery: { recovered: false },
          executor_state: "online",
          protocol_version: protocolVersion
        });
      }
      return json(response, 404, { error: "not found" });
    });

    const mcpServer = http.createServer(async (request, response) => {
      const body = await readJson(request);
      mcpMethods.push(body.method);
      if (!mcpReady) return json(response, 503, { error: "Tool 执行层未就绪，请确保应用已加载完成" });
      if (body.method === "initialize") {
        return json(response, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            serverInfo: { name: "fake-taobao", version: "1" }
          }
        }, { "mcp-session-id": "process-readiness-session" });
      }
      if (body.method === "notifications/initialized") {
        response.writeHead(202);
        return response.end();
      }
      if (body.method === "tools/list") {
        return json(response, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              { name: "search_products", inputSchema: { type: "object" } },
              { name: "get_current_tab", inputSchema: { type: "object" } }
            ]
          }
        });
      }
      return json(response, 404, { error: "unknown MCP method" });
    });

    const [apiOrigin, mcpOrigin] = await Promise.all([listen(apiServer), listen(mcpServer)]);
    const child = spawn(process.execPath, ["scripts/local-executor.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "test",
        SCENECART_API_URL: apiOrigin,
        SCENECART_DEVICE_TOKEN: "process_readiness_device_token_123456789012345",
        TAOBAO_NATIVE_MCP_URL: `${mcpOrigin}/mcp`,
        TAOBAO_SOURCE_APP: "SceneCartAI",
        EXECUTOR_POLL_MS: "500",
        EXECUTOR_TAOBAO_READINESS_BACKOFF_BASE_MS: "250",
        EXECUTOR_TAOBAO_READINESS_BACKOFF_MAX_MS: "500",
        EXECUTOR_TAOBAO_READINESS_PROBE_TIMEOUT_MS: "3000"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    openChildren.add(child);
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });

    await waitFor(
      () => heartbeatStates.includes("mcp_unavailable") && mcpMethods.includes("initialize"),
      `Worker never entered MCP reconnect state. Output:\n${output}`
    );
    expect(child.exitCode).toBeNull();
    expect(claimCount).toBe(0);

    mcpReady = true;
    await waitFor(
      () => heartbeatStates.includes("online") && claimCount > 0,
      `Worker never recovered and claimed jobs. Output:\n${output}`
    );
    expect(child.exitCode).toBeNull();
    expect(heartbeatStates[0]).toBe("mcp_unavailable");
    expect(mcpMethods).toContain("tools/list");

    await stopChild(child);
  }, 20_000);
});
