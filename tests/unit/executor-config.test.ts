import { describe, expect, it } from "vitest";
// The production configurator is a native Node ESM script, intentionally kept outside the app bundle.
// @ts-expect-error The script module does not ship application-facing TypeScript declarations.
import * as executorConfig from "../../scripts/executor-config-utils.mjs";

const {
  discoverExecutorApiUrl,
  executorNeedsVercelProtection,
  normalizeExecutorApiUrl,
  preferredExecutorApiUrl,
  preferredVercelProtectedOrigin,
  readEnvValue,
  updateExecutorEnv,
  validateExecutorDeviceToken,
  validateVercelProtectionBypassSecret
} = executorConfig as {
  discoverExecutorApiUrl: (
    preferredUrl: string,
    options?: {
      fetchImpl?: typeof fetch;
      firstPort?: number;
      lastPort?: number;
      timeoutMs?: number;
    }
  ) => Promise<string>;
  normalizeExecutorApiUrl: (value: string) => string;
  preferredExecutorApiUrl: (content: string, environmentValue?: string) => string;
  preferredVercelProtectedOrigin: (
    content: string,
    environmentValue?: string,
    apiUrl?: string
  ) => string;
  executorNeedsVercelProtection: (apiUrl: string, protectedOrigin?: string) => boolean;
  readEnvValue: (content: string, key: string) => string;
  updateExecutorEnv: (
    content: string,
    values: {
      apiUrl: string;
      deviceToken: string;
      protectedOrigin?: string;
      bypassSecret?: string;
    }
  ) => string;
  validateExecutorDeviceToken: (value: string) => string;
  validateVercelProtectionBypassSecret: (value: string) => string;
};

const token = "a".repeat(43);
const bypassSecret = "bypass-secret-that-stays-on-this-machine-123";

describe("local executor configuration", () => {
  it("validates executor URLs and opaque device tokens", () => {
    expect(normalizeExecutorApiUrl("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000");
    expect(normalizeExecutorApiUrl("https://shop.example.com")).toBe("https://shop.example.com");
    expect(validateExecutorDeviceToken(token)).toBe(token);
    expect(() => normalizeExecutorApiUrl("file:///tmp/app")).toThrow("只支持 http 或 https");
    expect(() => validateExecutorDeviceToken("short token")).toThrow("长度不正确");
  });

  it("prefers the active page origin over a stale saved development port", () => {
    const existing = "SCENECART_API_URL=http://127.0.0.1:3000\n";
    expect(preferredExecutorApiUrl(existing, "http://127.0.0.1:3001")).toBe(
      "http://127.0.0.1:3001"
    );
    expect(preferredExecutorApiUrl(existing)).toBe("http://127.0.0.1:3000");
  });

  it("discovers SceneCart when another local app occupies the saved port", async () => {
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      const isSceneCart = url === "http://127.0.0.1:3001/api/runtime/health";
      return new Response(JSON.stringify(isSceneCart
        ? { status: "healthy", executor_protocol_version: "5" }
        : { error: "not found" }), {
        status: isSceneCart ? 200 : 404,
        headers: { "Content-Type": "application/json" }
      });
    }) as typeof fetch;

    await expect(discoverExecutorApiUrl("http://127.0.0.1:3000", {
      fetchImpl,
      firstPort: 3000,
      lastPort: 3002
    })).resolves.toBe("http://127.0.0.1:3001");
    expect(requested).toContain("http://127.0.0.1:3000/api/runtime/health");
    expect(requested).toContain("http://127.0.0.1:3001/api/runtime/health");
  });

  it("does not probe alternate ports for a remote production origin", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw new Error("should not run");
    }) as typeof fetch;

    await expect(discoverExecutorApiUrl("https://shop.example.com", { fetchImpl }))
      .resolves.toBe("https://shop.example.com");
    expect(calls).toBe(0);
  });

  it("updates only managed values, removes duplicates and preserves unrelated secrets", () => {
    const existing = [
      "DEEPSEEK_API_KEY=keep-me",
      "SCENECART_API_URL=http://old.example.com",
      "SCENECART_DEVICE_TOKEN=old-token-value-that-is-long-enough-123",
      "SCENECART_DEVICE_TOKEN=duplicate-token-value-that-is-long-123",
      "# existing comment",
      "QODERCLI_PATH='/old path/qodercli'",
      ""
    ].join("\n");
    const updated = updateExecutorEnv(existing, {
      apiUrl: "http://127.0.0.1:3000/",
      deviceToken: token
    });

    expect(updated).toContain("DEEPSEEK_API_KEY=keep-me");
    expect(updated).toContain("# existing comment");
    expect(updated).toContain("TAOBAO_EXECUTION_BACKEND=local_executor");
    expect(updated).toContain("SCENECART_API_URL=http://127.0.0.1:3000");
    expect(updated).toContain(`SCENECART_DEVICE_TOKEN=${token}`);
    expect(updated).toContain("QODERCLI_PATH='/old path/qodercli'");
    expect(updated.match(/SCENECART_DEVICE_TOKEN=/g)).toHaveLength(1);
    expect(readEnvValue(updated, "SCENECART_DEVICE_TOKEN")).toBe(token);
  });

  it("recognizes only an exact protected origin and validates the local bypass secret", () => {
    expect(executorNeedsVercelProtection("https://scenecart-ai.vercel.app/api"))
      .toBe(true);
    expect(executorNeedsVercelProtection("https://scenecart-ai.vercel.app.evil.test"))
      .toBe(false);
    expect(executorNeedsVercelProtection("http://127.0.0.1:3000"))
      .toBe(false);
    expect(validateVercelProtectionBypassSecret(bypassSecret)).toBe(bypassSecret);
    expect(() => validateVercelProtectionBypassSecret("too-short"))
      .toThrow("长度不正确");
    expect(() => validateVercelProtectionBypassSecret(`${bypassSecret}\nleak`))
      .toThrow("空白或控制字符");
  });

  it("persists protected-origin credentials without exposing or duplicating them", () => {
    const existing = [
      "SCENECART_VERCEL_PROTECTED_ORIGIN=https://old.example.com",
      "SCENECART_VERCEL_PROTECTION_BYPASS_SECRET=old-secret-that-is-long-enough",
      "SCENECART_VERCEL_PROTECTION_BYPASS_SECRET=duplicate-secret-that-is-long-enough",
      "UNRELATED_SECRET=keep-me",
      ""
    ].join("\n");
    const updated = updateExecutorEnv(existing, {
      apiUrl: "https://scenecart-ai.vercel.app",
      deviceToken: token,
      protectedOrigin: "https://scenecart-ai.vercel.app",
      bypassSecret
    });

    expect(readEnvValue(updated, "SCENECART_VERCEL_PROTECTED_ORIGIN"))
      .toBe("https://scenecart-ai.vercel.app");
    expect(readEnvValue(updated, "SCENECART_VERCEL_PROTECTION_BYPASS_SECRET"))
      .toBe(bypassSecret);
    expect(updated.match(/SCENECART_VERCEL_PROTECTION_BYPASS_SECRET=/g)).toHaveLength(1);
    expect(updated).toContain("UNRELATED_SECRET=keep-me");
  });

  it("fails closed for the protected production origin without a saved bypass", () => {
    expect(() => updateExecutorEnv("", {
      apiUrl: "https://scenecart-ai.vercel.app",
      deviceToken: token
    })).toThrow("长度不正确");
    expect(preferredVercelProtectedOrigin(
      "",
      "",
      "https://scenecart-ai.vercel.app"
    )).toBe("https://scenecart-ai.vercel.app");
    expect(preferredVercelProtectedOrigin(
      "SCENECART_VERCEL_PROTECTED_ORIGIN=https://preview.example.com\n",
      "",
      "https://preview.example.com"
    )).toBe("https://preview.example.com");
  });
});
