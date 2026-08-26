import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const protocolVersion = "5";
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
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function waitFor(predicate, message, timeoutMs = 15_000) {
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
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
  openChildren.delete(child);
}

afterEach(async () => {
  await Promise.all([...openChildren].map(stopChild));
  await Promise.all([...openServers].map(closeServer));
});

describe("local executor official CLI search fallback", () => {
  it("completes the same attempt once when HTTP MCP emits the limited-beta false negative", async () => {
    const jobId = `cli-fallback-${Date.now()}`;
    const leaseToken = "cli_fallback_lease_token_123456789012345";
    const stateDirectory = await fs.mkdtemp("/tmp/scenecart-cli-worker-");
    const fakeCliPath = path.join(stateDirectory, "taobao-native");
    const cliLogPath = path.join(stateDirectory, "cli-calls.jsonl");
    await fs.writeFile(fakeCliPath, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const tool = args[0];
const input = JSON.parse(args[args.indexOf("--args") + 1]);
fs.appendFileSync(process.env.TAOBAO_FAKE_CLI_LOG, JSON.stringify({ tool, input }) + "\\n");
if (tool === "list_available_pages") {
  process.stdout.write(JSON.stringify({ result: { success: true, pages: [{ name: "home" }] } }));
  process.exit(0);
}
if (tool === "search_products") {
  const outputPath = args[args.indexOf("-o") + 1];
  fs.writeFileSync(outputPath, JSON.stringify({ result: {
    keyword: input.keyword,
    type: input.type,
    count: 1,
    products: [{
      itemId: "614534453440",
      title: "CLI 真实行车记录仪",
      price: "129",
      shopName: "CLI 测试旗舰店",
      productUrl: "https://item.taobao.com/item.htm?id=614534453440"
    }]
  } }));
  process.stdout.write(JSON.stringify({ resultFile: outputPath }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ error: "unexpected tool " + tool }));
process.exit(1);
`, { mode: 0o700 });

    let claimed = false;
    let resolvedBody = null;
    let resolveCount = 0;
    let httpSearchCount = 0;
    const heartbeatBodies = [];
    const claimBodies = [];

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
          device: { id: "cli-fallback-device", capabilities: ["module_search"] },
          executor_state: body.executor_state,
          protocol_version: protocolVersion,
          lease_renewed: Boolean(body.current_job_id)
        });
      }
      if (request.url === "/api/executor/startup") {
        return json(response, 200, {
          startup_standby_established: true,
          paused_workflows: 0,
          paused_session_ids: [],
          protocol_version: protocolVersion
        });
      }
      if (request.url === "/api/executor/jobs/claim") {
        claimBodies.push(await readJson(request));
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
            max_attempts: 3,
            lease_token: leaseToken,
            payload: {
              module_id: "safety-essential",
              workflow_run_id: "workflow-cli-fallback",
              keyword: "行车记录仪"
            }
          },
          recovery: { recovered: false },
          executor_state: "online",
          protocol_version: protocolVersion
        });
      }
      if (request.url === `/api/executor/jobs/${jobId}/resolve`) {
        resolveCount += 1;
        resolvedBody = await readJson(request);
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
        }, { "mcp-session-id": "cli-fallback-mcp-session" });
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
        httpSearchCount += 1;
        return json(response, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: false,
                message: "内测期间仅开放部分用户使用，请关注后续公告"
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
        SCENECART_DEVICE_TOKEN: "cli_fallback_device_token_123456789012345",
        TAOBAO_NATIVE_MCP_URL: `${mcpOrigin}/mcp`,
        TAOBAO_NATIVE_CLI_PATH: fakeCliPath,
        TAOBAO_FAKE_CLI_LOG: cliLogPath,
        TAOBAO_SOURCE_APP: "SceneCartAI",
        EXECUTOR_STATE_DIR: stateDirectory,
        EXECUTOR_POLL_MS: "500",
        EXECUTOR_TAOBAO_SEARCH_COOLDOWN_MS: "0",
        EXECUTOR_TAOBAO_READINESS_PROBE_TIMEOUT_MS: "3000"
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
        `Worker never completed the CLI fallback. Output:\n${output}`
      );
      await waitFor(
        () => claimBodies.some((body) => body.transport === "native_cli"),
        `Worker never narrowed its claim scope after switching to the CLI. Output:\n${output}`
      );
      const cliCalls = (await fs.readFile(cliLogPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(httpSearchCount).toBe(1);
      expect(cliCalls.filter((call) => call.tool === "search_products")).toEqual([{
        tool: "search_products",
        input: { keyword: "行车记录仪", type: "all", sourceApp: "SceneCartAI" }
      }]);
      expect(resolveCount).toBe(1);
      expect(resolvedBody).toMatchObject({
        status: "completed",
        lease_token: leaseToken,
        result: {
          candidates: [{ title: "CLI 真实行车记录仪" }],
          evidence: {
            job_id: jobId,
            keyword: "行车记录仪",
            transport: "native_cli"
          }
        }
      });
      expect(output).toContain("using the official Taobao CLI for read-only searches");
      expect(output).not.toContain(`job ${jobId} failed`);
      expect(heartbeatBodies.some((body) => body.executor_state === "online")).toBe(true);
      expect(claimBodies).toContainEqual({
        transport: "native_cli",
        available_tools: ["list_available_pages", "search_products"]
      });
    } finally {
      await stopChild(child);
      await fs.rm(stateDirectory, { recursive: true, force: true });
    }
  }, 20_000);
});
