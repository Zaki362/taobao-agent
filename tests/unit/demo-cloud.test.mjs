import { describe, expect, it } from "vitest";
import {
  updateCloudDemoEnv,
  updateCloudExecutorToken
} from "../../scripts/cloud-demo-config.mjs";
import {
  normalizeCloudDemoUrl,
  parseCloudDemoArgs,
  resolveNodeProxyEnvironment,
  sanitizeCloudDemoMessage,
  validateCloudRuntime
} from "../../scripts/demo-cloud-utils.mjs";
import {
  checkCloudRuntime,
  checkRecoveryAccess,
  fetchCloudJson,
  waitForDoctor
} from "../../scripts/demo-cloud.mjs";
import { MCP_READINESS_EXIT_CODE } from "../../scripts/local-executor-readiness.mjs";

describe("cloud interview demo launcher", () => {
  it("parses check, recovery, and URL options", () => {
    expect(parseCloudDemoArgs([
      "--check",
      "--skip-recovery",
      "--url",
      "https://scenecart.example.com"
    ])).toEqual({
      checkOnly: true,
      skipRecovery: true,
      url: "https://scenecart.example.com"
    });
  });

  it("accepts only a remote HTTPS site origin", () => {
    expect(normalizeCloudDemoUrl("https://scenecart.example.com/"))
      .toBe("https://scenecart.example.com");
    expect(() => normalizeCloudDemoUrl("http://scenecart.example.com"))
      .toThrow(/HTTPS/);
    expect(() => normalizeCloudDemoUrl("https://127.0.0.1:3001"))
      .toThrow(/不能连接本地地址/);
    expect(() => normalizeCloudDemoUrl("https://scenecart.example.com/api"))
      .toThrow(/站点根地址/);
    expect(() => normalizeCloudDemoUrl("https://scenecart.example.com?token=secret"))
      .toThrow(/查询参数/);
  });

  it("requires the complete production runtime contract", () => {
    const valid = {
      status: "healthy",
      product_mode: "production",
      demo_cart_fallback: false,
      runtime_store: "postgres",
      configured_executor_backend: "local_executor",
      effective_executor_backend: "local_executor",
      executor_protocol_version: "5"
    };
    expect(validateCloudRuntime(valid, "5")).toEqual([]);
    expect(validateCloudRuntime({ ...valid, runtime_store: "local" }, "5"))
      .toContain("RUNTIME_STORE 不是 postgres");
    expect(validateCloudRuntime({ ...valid, executor_protocol_version: "4" }, "5")[0])
      .toMatch(/协议不一致/);
  });

  it("sends Vercel bypass without a SceneCart bearer for public health", async () => {
    const calls = [];
    const environment = {
      SCENECART_VERCEL_PROTECTED_ORIGIN: "https://scenecart.example.com",
      SCENECART_VERCEL_PROTECTION_BYPASS_SECRET: "bypass-secret-that-is-long-enough"
    };
    const fetchImpl = async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(JSON.stringify({ status: "healthy" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    await fetchCloudJson("https://scenecart.example.com/api/runtime/health", {
      environment,
      fetchImpl
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].init.redirect).toBe("manual");
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("x-vercel-protection-bypass")).toBe(
      "bypass-secret-that-is-long-enough"
    );
    expect(headers.has("authorization")).toBe(false);
  });

  it("requires both bypass and SceneCart recovery credentials for readiness", async () => {
    const calls = [];
    const environment = {
      SCENECART_VERCEL_PROTECTED_ORIGIN: "https://scenecart.example.com",
      SCENECART_VERCEL_PROTECTION_BYPASS_SECRET: "bypass-secret-that-is-long-enough"
    };
    const cronSecret = "cron-secret-that-is-at-least-thirty-two-characters";
    const fetchImpl = async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(JSON.stringify({ ready_for_production: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    await checkRecoveryAccess("https://scenecart.example.com", cronSecret, {
      environment,
      fetchImpl
    });

    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("x-vercel-protection-bypass")).toBe(
      "bypass-secret-that-is-long-enough"
    );
    expect(headers.get("authorization")).toBe(`Bearer ${cronSecret}`);
  });

  it("fails before sending protected probes when bypass is missing", async () => {
    let sent = false;
    await expect(checkCloudRuntime("https://scenecart.example.com", {
      environment: {
        SCENECART_VERCEL_PROTECTED_ORIGIN: "https://scenecart.example.com"
      },
      fetchImpl: async () => {
        sent = true;
        return new Response("{}");
      }
    })).rejects.toThrow(/SCENECART_VERCEL_PROTECTION_BYPASS_SECRET/);
    expect(sent).toBe(false);
  });

  it("redacts credentials from launcher errors", () => {
    expect(sanitizeCloudDemoMessage(
      "Bearer abcdefghijklmnopqrstuvwxyz0123456789 postgresql://user:password@example/db"
    )).toBe("Bearer [redacted] [redacted-database-url]");
  });

  it("enables Node's environment proxy support only when a proxy is configured", () => {
    expect(resolveNodeProxyEnvironment({ HTTPS_PROXY: "http://127.0.0.1:7890" }))
      .toEqual({ NODE_USE_ENV_PROXY: "1" });
    expect(resolveNodeProxyEnvironment({})).toEqual({});
    expect(resolveNodeProxyEnvironment({
      HTTPS_PROXY: "http://127.0.0.1:7890",
      NODE_USE_ENV_PROXY: "0"
    })).toEqual({});
  });

  it("adds or replaces only the cloud demo URL in local configuration", () => {
    expect(updateCloudDemoEnv(
      "SCENECART_API_URL=http://127.0.0.1:3001\nSCENECART_DEVICE_TOKEN=device_token\n",
      "https://scenecart-ai.vercel.app"
    )).toContain("SCENECART_API_URL=http://127.0.0.1:3001");
    expect(updateCloudDemoEnv(
      "SCENECART_DEMO_CLOUD_URL=https://old.example.com\nSCENECART_DEMO_CLOUD_URL=https://duplicate.example.com\n",
      "https://scenecart-ai.vercel.app"
    ).match(/SCENECART_DEMO_CLOUD_URL=/g)).toHaveLength(1);
  });

  it("keeps local and cloud executor credentials separate", () => {
    const configured = updateCloudExecutorToken(
      "SCENECART_API_URL=http://127.0.0.1:3001\nSCENECART_DEVICE_TOKEN=local_token\n",
      "cloud_token"
    );
    expect(configured).toContain("SCENECART_DEVICE_TOKEN=local_token");
    expect(configured).toContain("SCENECART_CLOUD_DEVICE_TOKEN=cloud_token");
  });

  it("keeps retrying transient Taobao readiness with capped backoff until it recovers", async () => {
    const results = [
      { code: MCP_READINESS_EXIT_CODE, signal: null },
      { code: MCP_READINESS_EXIT_CODE, signal: null },
      { code: 0, signal: null }
    ];
    const compactModes = [];
    const delays = [];
    let output = "";
    let errorOutput = "";

    await waitForDoctor({}, {
      checkOnly: false,
      doctor: async (_environment, options) => {
        compactModes.push(options.compact);
        return results.shift();
      },
      wait: async (delay) => delays.push(delay),
      output: { write: (value) => { output += value; } },
      errorOutput: { write: (value) => { errorOutput += value; } }
    });

    expect(compactModes).toEqual([false, true, true]);
    expect(delays).toEqual([2_000, 4_000]);
    expect(errorOutput).toMatch(/打开、解锁并登录/);
    expect(output).toMatch(/已恢复，继续启动 Worker/);
  });

  it("makes --check a single fast readiness probe", async () => {
    let calls = 0;
    let waits = 0;
    await expect(waitForDoctor({}, {
      checkOnly: true,
      doctor: async () => {
        calls += 1;
        return { code: MCP_READINESS_EXIT_CODE, signal: null };
      },
      wait: async () => { waits += 1; },
      output: { write: () => {} },
      errorOutput: { write: () => {} }
    })).rejects.toThrow(/快速检查/);
    expect(calls).toBe(1);
    expect(waits).toBe(0);
  });

  it("fails fast for Doctor API, token, protocol, and process failures", async () => {
    let waits = 0;
    await expect(waitForDoctor({}, {
      checkOnly: false,
      doctor: async () => ({ code: 1, signal: null }),
      wait: async () => { waits += 1; },
      output: { write: () => {} },
      errorOutput: { write: () => {} }
    })).rejects.toThrow(/exit 1/);
    expect(waits).toBe(0);
  });
});
