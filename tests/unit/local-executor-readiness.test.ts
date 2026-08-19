import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
// The local Worker imports this native ESM module directly from Node.
// @ts-expect-error Runtime utility intentionally has no TypeScript declarations.
import * as readiness from "../../scripts/local-executor-readiness.mjs";

const {
  executorDoctorExitCode,
  isMcpReadinessError,
  MCP_READINESS_EXIT_CODE,
  mcpReadinessBackoffMs,
  missingTaobaoCartTools,
  missingTaobaoDetailTools,
  missingTaobaoTools,
  requiredTaobaoTools
} = readiness;

describe("local executor MCP readiness", () => {
  it("requires search tools without allowing optional cart tools to block search", () => {
    expect(requiredTaobaoTools(["module_search"]))
      .toEqual(["search_products", "get_current_tab"]);
    expect(requiredTaobaoTools(["module_search", "add_to_cart"]))
      .toEqual(["search_products", "get_current_tab"]);
    expect(missingTaobaoTools([
      { name: "search_products" },
      { name: "get_current_tab" }
    ], ["module_search", "add_to_cart"]))
      .toEqual([]);
    expect(missingTaobaoCartTools([
      { name: "search_products" },
      { name: "get_current_tab" }
    ]))
      .toEqual(["get_product_skus", "add_to_cart"]);
    expect(missingTaobaoDetailTools([
      { name: "navigate_to_url" },
      { name: "read_page_content" }
    ])).toEqual([]);
    expect(missingTaobaoDetailTools([{ name: "navigate_to_url" }]))
      .toEqual(["read_page_content"]);
  });

  it("opens readiness only for transport and tool-layer failures", () => {
    expect(isMcpReadinessError(new Error("fetch failed: ECONNREFUSED"))).toBe(true);
    expect(isMcpReadinessError(new Error("Tool 执行层未就绪，请确保应用已加载完成"))).toBe(true);
    expect(isMcpReadinessError({ code: "mcp_unavailable", message: "retry" })).toBe(true);
    expect(isMcpReadinessError(new Error("未登录，请先登录淘宝账号"))).toBe(false);
    expect(isMcpReadinessError(new Error("搜索结果缺少商品证据"))).toBe(false);
  });

  it("uses a capped exponential retry delay", () => {
    const options = { baseMs: 500, maxMs: 4000 };
    expect([0, 1, 2, 3, 4, 20].map((attempt) => mcpReadinessBackoffMs(attempt, options)))
      .toEqual([500, 1000, 2000, 4000, 4000, 4000]);
  });

  it("distinguishes recoverable MCP startup failures from fatal Doctor failures", () => {
    expect(executorDoctorExitCode([
      { name: "taobao_mcp", status: "pass" },
      { name: "scenecart_api", status: "pass" },
      { name: "device_token", status: "pass" }
    ])).toBe(0);
    expect(executorDoctorExitCode([
      { name: "taobao_mcp", status: "fail", detail: "fetch failed" },
      { name: "scenecart_api", status: "pass" },
      { name: "device_token", status: "pass" }
    ])).toBe(MCP_READINESS_EXIT_CODE);
    expect(executorDoctorExitCode([
      { name: "taobao_mcp", status: "fail", detail: "工具尚未加载" },
      { name: "device_token", status: "fail", detail: "unauthorized" }
    ])).toBe(1);
  });

  it("keeps claiming behind tools/list readiness without weakening auth or cart safety", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "scripts", "local-executor.mjs"),
      "utf8"
    );
    const readinessLoop = source.indexOf("async function waitForMcpReadiness()");
    const unavailableHeartbeat = source.indexOf(
      'heartbeat({ executorState: "mcp_unavailable", force: true })',
      readinessLoop
    );
    const toolDiscovery = source.indexOf("await taobaoClient.listTools(", unavailableHeartbeat);
    const onlineHeartbeat = source.indexOf(
      'heartbeat({ executorState: "online", force: true })',
      toolDiscovery
    );
    const claimGate = source.indexOf("if (mcpUnavailable)", onlineHeartbeat);
    const claimRequest = source.indexOf('/api/executor/jobs/claim', claimGate);

    expect(readinessLoop).toBeGreaterThanOrEqual(0);
    expect(unavailableHeartbeat).toBeGreaterThan(readinessLoop);
    expect(toolDiscovery).toBeGreaterThan(unavailableHeartbeat);
    expect(onlineHeartbeat).toBeGreaterThan(toolDiscovery);
    expect(claimGate).toBeGreaterThan(onlineHeartbeat);
    expect(claimRequest).toBeGreaterThan(claimGate);
    expect(source).toContain('failureDisposition === "persist_authentication_failure"');
    expect(source).not.toContain('job.job_type === "module_search" &&\n          error instanceof ExecutorJobError');
    expect(source).toContain("automatic replay is forbidden");
    expect(source).toContain("retrying without repeating the Taobao action");
  });
});
