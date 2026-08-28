import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
// The local Worker imports this native ESM module directly from Node.
// @ts-expect-error Runtime utility intentionally has no TypeScript declarations.
import * as readiness from "../../scripts/local-executor-readiness.mjs";
// Worker-only security helpers intentionally remain native Node ESM outside the browser bundle.
// @ts-expect-error Runtime utility intentionally has no TypeScript declarations.
import * as protectionBypass from "../../scripts/vercel-protection-bypass.mjs";

const {
  isVercelProtectionChallenge,
  redactSceneCartSecrets,
  vercelProtectedFetch,
  vercelProtectionBypassHeaders
} = protectionBypass;

const {
  executorDoctorExitCode,
  isMcpReadinessError,
  isTaobaoLimitedBetaError,
  MCP_READINESS_EXIT_CODE,
  mcpReadinessBackoffMs,
  missingTaobaoCartTools,
  missingTaobaoDetailTools,
  missingTaobaoTools,
  requiredTaobaoTools,
  shouldFallbackToTaobaoNativeCli
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

  it("uses the official CLI only for safe read-only transport and beta-gate fallback", () => {
    const limitedBeta = new Error("内测期间仅开放部分用户使用，请关注后续公告");
    expect(isTaobaoLimitedBetaError(limitedBeta)).toBe(true);
    expect(shouldFallbackToTaobaoNativeCli(limitedBeta)).toBe(true);
    expect(shouldFallbackToTaobaoNativeCli(new Error("fetch failed"))).toBe(true);
    expect(shouldFallbackToTaobaoNativeCli(new Error("淘宝桌面版当前未登录"))).toBe(false);
    expect(shouldFallbackToTaobaoNativeCli(new Error("商品证据格式无效"))).toBe(false);
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

describe("local executor Vercel protection boundary", () => {
  const protectedOrigin = "https://protected.scenecart.test";
  const bypassSecret = "bypass_secret_that_must_never_be_logged_123";
  const deviceToken = "device_token_that_must_never_be_logged_123";
  const cronSecret = "cron_secret_that_must_never_be_logged_12345";
  const environment = {
    SCENECART_VERCEL_PROTECTED_ORIGIN: protectedOrigin,
    SCENECART_VERCEL_PROTECTION_BYPASS_SECRET: bypassSecret,
    SCENECART_DEVICE_TOKEN: deviceToken,
    SCENECART_CRON_SECRET: cronSecret
  };

  function protectedServer(requiredAuthorization: string) {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (headers.get("x-vercel-protection-bypass") !== bypassSecret) {
        return new Response("<html>Vercel Authentication Required</html>", {
          status: 403,
          headers: { "Content-Type": "text/html", "x-vercel-id": "test" }
        });
      }
      if (headers.get("authorization") !== requiredAuthorization) {
        return new Response(JSON.stringify({ error: "invalid SceneCart credential" }), {
          status: 401,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ ok: true, path: new URL(String(input)).pathname }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as typeof fetch;
  }

  it("sends a bypass only to the exact protected remote origin and fails closed when it is missing", () => {
    expect(vercelProtectionBypassHeaders(`${protectedOrigin}/api/runtime/health`, environment))
      .toEqual({ "x-vercel-protection-bypass": bypassSecret });
    expect(vercelProtectionBypassHeaders("https://other.scenecart.test/api/runtime/health", environment))
      .toEqual({});
    expect(vercelProtectionBypassHeaders("http://127.0.0.1:3000/api/runtime/health", {}))
      .toEqual({});
    expect(() => vercelProtectionBypassHeaders(`${protectedOrigin}/api/runtime/health`, {
      SCENECART_VERCEL_PROTECTED_ORIGIN: protectedOrigin
    })).toThrow(/请求已在发送前停止/);
  });

  it("keeps Vercel bypass and SceneCart device Bearer as independent credentials", async () => {
    const fetchImpl = protectedServer(`Bearer ${deviceToken}`);
    const noBypass = await fetchImpl(`${protectedOrigin}/api/executor/startup`, {
      method: "POST",
      headers: { Authorization: `Bearer ${deviceToken}` }
    });
    expect(isVercelProtectionChallenge(noBypass, {
      input: `${protectedOrigin}/api/executor/startup`,
      body: await noBypass.text(),
      environment
    })).toBe(true);

    const bypassOnly = await vercelProtectedFetch(
      `${protectedOrigin}/api/executor/heartbeat`,
      { method: "POST" },
      { environment, fetchImpl }
    );
    expect(bypassOnly.status).toBe(401);

    for (const pathname of [
      "/api/executor/startup",
      "/api/executor/heartbeat",
      "/api/executor/jobs/claim",
      "/api/executor/jobs/job-1/resolve"
    ]) {
      const response = await vercelProtectedFetch(
        `${protectedOrigin}${pathname}`,
        { method: "POST", headers: { Authorization: `Bearer ${deviceToken}` } },
        { environment, fetchImpl }
      );
      expect(response.status).toBe(200);
    }
  });

  it("requires bypass plus the independent cron Bearer for recovery", async () => {
    const fetchImpl = protectedServer(`Bearer ${cronSecret}`);
    const bypassOnly = await vercelProtectedFetch(
      `${protectedOrigin}/api/internal/workflow-recovery?limit=5`,
      {},
      { environment, fetchImpl }
    );
    expect(bypassOnly.status).toBe(401);

    const authenticated = await vercelProtectedFetch(
      `${protectedOrigin}/api/internal/workflow-recovery?limit=5`,
      { headers: { Authorization: `Bearer ${cronSecret}` } },
      { environment, fetchImpl }
    );
    expect(authenticated.status).toBe(200);
  });

  it("classifies an outer-protection rejection and redacts every machine secret", async () => {
    const alwaysChallenges = (async () => new Response(
      `<html>Vercel Authentication Required ${bypassSecret} ${deviceToken} ${cronSecret}</html>`,
      { status: 403, headers: { "Content-Type": "text/html" } }
    )) as typeof fetch;
    await expect(vercelProtectedFetch(
      `${protectedOrigin}/api/runtime/health`,
      {},
      { environment, fetchImpl: alwaysChallenges }
    )).rejects.toMatchObject({
      name: "VercelProtectionError",
      code: "vercel_protection_failed",
      status: 403
    });

    const unsafe = `Authorization: Bearer ${deviceToken}; x-vercel-protection-bypass=${bypassSecret}; cron=${cronSecret}`;
    const safe = redactSceneCartSecrets(unsafe, environment);
    expect(safe).not.toContain(deviceToken);
    expect(safe).not.toContain(bypassSecret);
    expect(safe).not.toContain(cronSecret);
  });

  it("does not mistake an arbitrary HTML 403 for verified Vercel protection", async () => {
    const response = new Response("<html>application forbidden</html>", {
      status: 403,
      headers: { "Content-Type": "text/html" }
    });
    expect(isVercelProtectionChallenge(response, {
      input: `${protectedOrigin}/api/runtime/health`,
      body: await response.text(),
      environment
    })).toBe(false);
  });

  it("forces manual redirects so the bypass never reaches a second origin", async () => {
    const calls: Array<{ url: string; redirect?: RequestRedirect; bypass: string | null }> = [];
    const redirectingFetch = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        redirect: init?.redirect,
        bypass: headers.get("x-vercel-protection-bypass")
      });
      if (init?.redirect !== "manual") {
        calls.push({
          url: "https://attacker.example/collect",
          redirect: init?.redirect,
          bypass: headers.get("x-vercel-protection-bypass")
        });
      }
      return new Response(null, {
        status: 302,
        headers: { Location: "https://attacker.example/collect" }
      });
    }) as typeof fetch;

    await expect(vercelProtectedFetch(
      `${protectedOrigin}/api/runtime/health`,
      { redirect: "follow" },
      { environment, fetchImpl: redirectingFetch }
    )).rejects.toMatchObject({
      code: "vercel_protection_redirect_blocked",
      status: 302
    });
    expect(calls).toEqual([{
      url: `${protectedOrigin}/api/runtime/health`,
      redirect: "manual",
      bypass: bypassSecret
    }]);
  });

  it("wires protection failures into fatal Worker paths instead of retry loops", async () => {
    const [executorSource, doctorSource, recoverySource] = await Promise.all([
      fs.readFile(path.join(process.cwd(), "scripts", "local-executor.mjs"), "utf8"),
      fs.readFile(path.join(process.cwd(), "scripts", "executor-doctor.mjs"), "utf8"),
      fs.readFile(path.join(process.cwd(), "scripts", "workflow-recovery-worker.mjs"), "utf8")
    ]);
    expect(executorSource).toContain("isVercelProtectionError(error)");
    expect(executorSource).toContain("new FatalExecutorApiError(");
    expect(doctorSource).toContain("vercelProtectedFetch");
    expect(recoverySource).toContain("fatalAuthenticationError = error");
    expect(recoverySource).toContain("if (fatalAuthenticationError) process.exitCode = 1");
  });
});
