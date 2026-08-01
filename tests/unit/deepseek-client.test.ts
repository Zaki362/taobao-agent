import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  explainProductFit,
  getDeepSeekTimeoutMs,
  parseScene
} from "@/lib/llm/deepseek";
import { mockParseScene } from "@/lib/llm/mock";
import {
  getLlmTelemetrySnapshot,
  resetLlmTelemetryForTests
} from "@/lib/llm/telemetry";

const MANAGED_ENV_KEYS = [
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_DISABLED",
  "DEEPSEEK_REQUEST_TIMEOUT_MS",
  "DEEPSEEK_PARSE_TIMEOUT_MS"
] as const;

const originalEnv = Object.fromEntries(
  MANAGED_ENV_KEYS.map((key) => [key, process.env[key]])
) as Record<(typeof MANAGED_ENV_KEYS)[number], string | undefined>;

function responseForContent(content: string, status = 200) {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }]
  }), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function taskTelemetry(task: string) {
  return getLlmTelemetrySnapshot().tasks.find((item) => item.task === task);
}

describe("DeepSeek client reliability", () => {
  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = "unit-test-key";
    process.env.DEEPSEEK_DISABLED = "false";
    delete process.env.DEEPSEEK_REQUEST_TIMEOUT_MS;
    delete process.env.DEEPSEEK_PARSE_TIMEOUT_MS;
    resetLlmTelemetryForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetLlmTelemetryForTests();
    for (const key of MANAGED_ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("uses bounded task-specific timeout configuration", () => {
    expect(getDeepSeekTimeoutMs("parse_scene")).toBe(15_000);

    process.env.DEEPSEEK_REQUEST_TIMEOUT_MS = "9000";
    expect(getDeepSeekTimeoutMs("parse_scene")).toBe(9_000);

    process.env.DEEPSEEK_PARSE_TIMEOUT_MS = "1";
    expect(getDeepSeekTimeoutMs("parse_scene")).toBe(250);

    process.env.DEEPSEEK_PARSE_TIMEOUT_MS = "999999";
    expect(getDeepSeekTimeoutMs("parse_scene")).toBe(60_000);
  });

  it("returns a connected result for valid strict JSON", async () => {
    const expected = mockParseScene("新能源车预算 1800，安全优先");
    vi.stubGlobal("fetch", vi.fn(async () => responseForContent(JSON.stringify(expected))));

    const result = await parseScene("新能源车预算 1800，安全优先", "new-car");

    expect(result.mode).toBe("connected");
    expect(result.data).toMatchObject({ budget: 1800, priority_style: "安全优先" });
    expect(taskTelemetry("parse_scene")).toMatchObject({ connected: 1, fallback: 0 });
  });

  it("falls back cleanly on an upstream HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));

    const result = await parseScene("预算 1500，实用优先", "new-car");

    expect(result.mode).toBe("mock");
    expect(result.data.budget).toBe(1500);
    expect(taskTelemetry("parse_scene")).toMatchObject({
      fallback: 1,
      last_reason: "http_503"
    });
  });

  it("times out while reading a stalled response body", async () => {
    process.env.DEEPSEEK_PARSE_TIMEOUT_MS = "250";
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => ({
      ok: true,
      status: 200,
      text: () => new Promise<string>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      })
    }) as Response));

    const startedAt = Date.now();
    const result = await parseScene("预算 1200，只买必需品", "new-car");

    expect(result.mode).toBe("mock");
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(taskTelemetry("parse_scene")).toMatchObject({
      fallback: 1,
      last_reason: "timeout"
    });
  });

  it("falls back when either response JSON layer is malformed", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("not-json", { status: 200 }))
      .mockResolvedValueOnce(responseForContent("not-json"));
    vi.stubGlobal("fetch", fetchMock);

    const outerResult = await parseScene("预算 900，实用优先", "new-car");
    const innerResult = await parseScene("预算 900，实用优先", "new-car");

    expect(outerResult.mode).toBe("mock");
    expect(innerResult.mode).toBe("mock");
    expect(taskTelemetry("parse_scene")).toMatchObject({
      calls: 2,
      fallback: 2,
      last_reason: "invalid_json"
    });
  });

  it("downgrades schema-invalid model output instead of trusting it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => responseForContent(JSON.stringify({
      scenario_id: "new-car",
      budget: "not-a-number"
    }))));

    const result = await parseScene("预算 1600，实用优先", "new-car");

    expect(result.mode).toBe("mock");
    expect(result.data.budget).toBe(1600);
    expect(taskTelemetry("parse_scene")?.last_reason).toContain("schema_validation_failed");
  });

  it("records recommendation explanation fallback without calling the network when disabled", async () => {
    process.env.DEEPSEEK_DISABLED = "true";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const explanation = await explainProductFit("安全必需", "高清行车记录仪", "稳妥推荐");

    expect(explanation.length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(taskTelemetry("explain_product_fit")).toMatchObject({
      fallback: 1,
      last_reason: "explicitly_disabled"
    });
  });
});
