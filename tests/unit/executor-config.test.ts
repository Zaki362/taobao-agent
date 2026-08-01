import { describe, expect, it } from "vitest";
// The production configurator is a native Node ESM script, intentionally kept outside the app bundle.
// @ts-expect-error The script module does not ship application-facing TypeScript declarations.
import * as executorConfig from "../../scripts/executor-config-utils.mjs";

const {
  normalizeExecutorApiUrl,
  readEnvValue,
  updateExecutorEnv,
  validateExecutorDeviceToken
} = executorConfig as {
  normalizeExecutorApiUrl: (value: string) => string;
  readEnvValue: (content: string, key: string) => string;
  updateExecutorEnv: (
    content: string,
    values: { apiUrl: string; deviceToken: string; qoderPath: string }
  ) => string;
  validateExecutorDeviceToken: (value: string) => string;
};

const token = "a".repeat(43);

describe("local executor configuration", () => {
  it("validates executor URLs and opaque device tokens", () => {
    expect(normalizeExecutorApiUrl("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000");
    expect(normalizeExecutorApiUrl("https://shop.example.com")).toBe("https://shop.example.com");
    expect(validateExecutorDeviceToken(token)).toBe(token);
    expect(() => normalizeExecutorApiUrl("file:///tmp/app")).toThrow("只支持 http 或 https");
    expect(() => validateExecutorDeviceToken("short token")).toThrow("长度不正确");
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
      deviceToken: token,
      qoderPath: "/Users/example/Library/Application Support/qodercli"
    });

    expect(updated).toContain("DEEPSEEK_API_KEY=keep-me");
    expect(updated).toContain("# existing comment");
    expect(updated).toContain("TAOBAO_EXECUTION_BACKEND=local_executor");
    expect(updated).toContain("SCENECART_API_URL=http://127.0.0.1:3000");
    expect(updated).toContain(`SCENECART_DEVICE_TOKEN=${token}`);
    expect(updated).toContain('QODERCLI_PATH="/Users/example/Library/Application Support/qodercli"');
    expect(updated.match(/SCENECART_DEVICE_TOKEN=/g)).toHaveLength(1);
    expect(readEnvValue(updated, "SCENECART_DEVICE_TOKEN")).toBe(token);
  });
});
