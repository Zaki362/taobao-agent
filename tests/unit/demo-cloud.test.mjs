import { describe, expect, it } from "vitest";
import {
  updateCloudDemoEnv,
  updateCloudExecutorToken
} from "../../scripts/cloud-demo-config.mjs";
import {
  normalizeCloudDemoUrl,
  parseCloudDemoArgs,
  sanitizeCloudDemoMessage,
  validateCloudRuntime
} from "../../scripts/demo-cloud-utils.mjs";

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
      executor_protocol_version: "3"
    };
    expect(validateCloudRuntime(valid, "3")).toEqual([]);
    expect(validateCloudRuntime({ ...valid, runtime_store: "local" }, "3"))
      .toContain("RUNTIME_STORE 不是 postgres");
    expect(validateCloudRuntime({ ...valid, executor_protocol_version: "2" }, "3")[0])
      .toMatch(/协议不一致/);
  });

  it("redacts credentials from launcher errors", () => {
    expect(sanitizeCloudDemoMessage(
      "Bearer abcdefghijklmnopqrstuvwxyz0123456789 postgresql://user:password@example/db"
    )).toBe("Bearer [redacted] [redacted-database-url]");
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
});
