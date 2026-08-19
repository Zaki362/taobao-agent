import { spawn } from "node:child_process";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

const protocolVersion = "4";
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

  it("reads one preferred product through listed detail tools without any cart mutation", async () => {
    const jobId = `detail-process-${Date.now()}`;
    const stateDirectory = await fs.mkdtemp(path.join("/tmp", "scenecart-detail-worker-"));
    const detailUrl = "https://item.taobao.com/item.htm?id=843402079981";
    const operations = [];
    const toolCalls = [];
    const heartbeatBodies = [];
    let claimed = false;
    let resolvedBody = null;

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
        heartbeatBodies.push(body);
        return json(response, 200, {
          device: { id: "detail-device", capabilities: ["module_search"] },
          executor_state: body.executor_state,
          protocol_version: protocolVersion,
          lease_renewed: Boolean(body.current_job_id)
        });
      }
      if (request.url === "/api/executor/jobs/claim") {
        if (claimed) {
          return json(response, 200, {
            job: null,
            recovery: { recovered: false },
            executor_state: "online",
            protocol_version: protocolVersion
          });
        }
        claimed = true;
        return json(response, 200, {
          job: {
            id: jobId,
            job_type: "product_detail",
            attempts: 1,
            max_attempts: 2,
            lease_token: "detail-lease-token-123456789",
            payload: {
              search_job_id: "search-job-parent",
              module_id: "practical-interior",
              workflow_run_id: "workflow-detail",
              product_id: "843402079981",
              detail_url: detailUrl
            }
          },
          recovery: { recovered: false },
          executor_state: "online",
          protocol_version: protocolVersion
        });
      }
      if (request.url === `/api/executor/jobs/${jobId}/resolve`) {
        resolvedBody = await readJson(request);
        return json(response, 200, {
          job: { id: jobId, job_type: "product_detail", status: "completed" },
          already_completed: false,
          continuation: { outcome: "queued", error: null },
          protocol_version: protocolVersion
        });
      }
      return json(response, 404, { error: "not found" });
    });

    const mcpServer = http.createServer(async (request, response) => {
      const body = await readJson(request);
      if (body.method === "initialize") {
        return json(response, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-taobao", version: "1" }
          }
        }, { "mcp-session-id": "detail-process-session" });
      }
      if (body.method === "notifications/initialized") {
        response.writeHead(202);
        return response.end();
      }
      if (body.method === "tools/list") {
        operations.push("tools/list");
        return json(response, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              { name: "search_products", inputSchema: { type: "object" } },
              { name: "get_current_tab", inputSchema: { type: "object" } },
              { name: "navigate_to_url", inputSchema: { type: "object" } },
              { name: "read_page_content", inputSchema: { type: "object" } }
            ]
          }
        });
      }
      if (body.method === "tools/call") {
        const call = body.params;
        operations.push(call.name);
        toolCalls.push(call);
        const value = call.name === "navigate_to_url"
          ? { result: { success: true, url: detailUrl } }
          : {
              result: {
                title: "车载手机支架 - 淘宝网",
                url: detailUrl,
                content: "测试旗舰店 稳固夹持 适配多种车型 页面可见价 ￥73.80"
              }
            };
        return json(response, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [{ type: "text", text: JSON.stringify(value) }]
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
        SCENECART_DEVICE_TOKEN: "detail_device_token_12345678901234567890",
        TAOBAO_NATIVE_MCP_URL: `${mcpOrigin}/mcp`,
        TAOBAO_SOURCE_APP: "SceneCartAI",
        EXECUTOR_POLL_MS: "500",
        EXECUTOR_STATE_DIR: stateDirectory,
        EXECUTOR_TAOBAO_READINESS_BACKOFF_BASE_MS: "250",
        EXECUTOR_TAOBAO_READINESS_BACKOFF_MAX_MS: "500"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    openChildren.add(child);
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });

    try {
      await waitFor(
        () => resolvedBody !== null,
        `Worker never resolved the detail job. Output:\n${output}`
      );
      expect(operations.slice(0, 3)).toEqual([
        "tools/list",
        "navigate_to_url",
        "read_page_content"
      ]);
      expect(toolCalls).toHaveLength(2);
      expect(toolCalls[0]).toMatchObject({
        name: "navigate_to_url",
        arguments: { url: detailUrl, sourceApp: "SceneCartAI" }
      });
      expect(toolCalls[1]).toMatchObject({
        name: "read_page_content",
        arguments: { maxLength: 5000, sourceApp: "SceneCartAI" }
      });
      expect(toolCalls.some((call) => call.name === "add_to_cart")).toBe(false);
      expect(heartbeatBodies.find((body) => body.current_job_id === jobId)).toMatchObject({
        current_job_id: jobId,
        lease_token: "detail-lease-token-123456789"
      });
      expect(resolvedBody).toMatchObject({
        status: "completed",
        result: {
          detail_evidence: {
            status: "verified",
            product_id: "843402079981",
            detail_url: detailUrl,
            tools_used: ["navigate_to_url", "read_page_content"]
          }
        }
      });
    } finally {
      await stopChild(child);
      await fs.rm(stateDirectory, { recursive: true, force: true });
    }
  }, 20_000);

  it("retries a max-attempt successful result acknowledgement without repeating Taobao search", async () => {
    const jobId = `search-ack-process-${Date.now()}`;
    const leaseToken = "search-ack-lease-token-123456789";
    const stateDirectory = await fs.mkdtemp(path.join("/tmp", "scenecart-result-ack-worker-"));
    let claimed = false;
    let searchCalls = 0;
    let resolveCalls = 0;
    let completedBody = null;

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
        return json(response, 200, {
          device: { id: "result-ack-device", capabilities: ["module_search"] },
          executor_state: body.executor_state,
          protocol_version: protocolVersion,
          lease_renewed: Boolean(
            body.current_job_id === jobId && body.lease_token === leaseToken
          )
        });
      }
      if (request.url === "/api/executor/jobs/claim") {
        if (claimed) {
          return json(response, 200, {
            job: null,
            recovery: { recovered: false },
            executor_state: "online",
            protocol_version: protocolVersion
          });
        }
        claimed = true;
        return json(response, 200, {
          job: {
            id: jobId,
            job_type: "module_search",
            attempts: 1,
            max_attempts: 1,
            lease_token: leaseToken,
            payload: {
              keyword: "行车记录仪",
              module_id: "safety-essential",
              workflow_run_id: "workflow-result-ack"
            }
          },
          recovery: { recovered: false },
          executor_state: "online",
          protocol_version: protocolVersion
        });
      }
      if (request.url === `/api/executor/jobs/${jobId}/resolve`) {
        resolveCalls += 1;
        const body = await readJson(request);
        if (resolveCalls === 1) {
          return json(response, 409, {
            error: "injected non-discardable protocol conflict",
            code: "job_lease_token_required"
          });
        }
        if (resolveCalls <= 4) {
          return json(response, 503, {
            error: "injected resolve outage",
            code: "temporary_unavailable"
          });
        }
        completedBody = body;
        return json(response, 200, {
          job: { id: jobId, job_type: "module_search", status: "completed" },
          already_completed: false,
          continuation: { outcome: "queued", error: null },
          protocol_version: protocolVersion
        });
      }
      return json(response, 404, { error: "not found" });
    });

    const mcpServer = http.createServer(async (request, response) => {
      const body = await readJson(request);
      if (body.method === "initialize") {
        return json(response, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-taobao", version: "1" }
          }
        }, { "mcp-session-id": "result-ack-process-session" });
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
      if (body.method === "tools/call" && body.params?.name === "search_products") {
        searchCalls += 1;
        return json(response, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [{
              type: "text",
              text: JSON.stringify({
                result: {
                  keyword: "行车记录仪",
                  count: 1,
                  products: [{
                    itemId: "614534453440",
                    title: "测试行车记录仪",
                    price: "129",
                    shopName: "测试旗舰店",
                    productUrl: "https://item.taobao.com/item.htm?id=614534453440"
                  }]
                }
              })
            }]
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
        SCENECART_DEVICE_TOKEN: "result_ack_device_token_123456789012345",
        TAOBAO_NATIVE_MCP_URL: `${mcpOrigin}/mcp`,
        TAOBAO_SOURCE_APP: "SceneCartAI",
        EXECUTOR_STATE_DIR: stateDirectory,
        EXECUTOR_POLL_MS: "500",
        EXECUTOR_RESULT_ACK_RETRY_MS: "250",
        EXECUTOR_RESOLVE_RETRY_BASE_MS: "50",
        EXECUTOR_TAOBAO_SEARCH_COOLDOWN_MS: "0",
        EXECUTOR_TAOBAO_READINESS_BACKOFF_BASE_MS: "250",
        EXECUTOR_TAOBAO_READINESS_BACKOFF_MAX_MS: "500"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    openChildren.add(child);
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });

    try {
      await waitFor(
        () => completedBody !== null,
        `Worker never durably retried the successful callback. Output:\n${output}`,
        15_000
      );
      expect(resolveCalls).toBe(5);
      expect(searchCalls).toBe(1);
      expect(completedBody).toMatchObject({
        status: "completed",
        lease_token: leaseToken,
        result: {
          evidence: {
            schema: "scenecart.taobao-mcp-search-evidence/v1",
            job_id: jobId
          }
        }
      });
      await waitFor(
        () => output.includes(`server confirmed durable result acknowledgement for ${jobId}`),
        `Worker did not clear the acknowledged WAL. Output:\n${output}`
      );
      await expect(fs.stat(path.join(stateDirectory, "pending-result-acknowledgement.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await stopChild(child);
      await fs.rm(stateDirectory, { recursive: true, force: true });
    }
  }, 20_000);
});
