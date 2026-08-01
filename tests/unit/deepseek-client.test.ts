import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  explainProductFit,
  getDeepSeekTimeoutMs,
  parseScene,
  reviewCandidatePool,
  selectAgentDecisionModelTier
} from "@/lib/llm/deepseek";
import { mockParseScene } from "@/lib/llm/mock";
import type { AgentDecisionProposal, ProductCandidate } from "@/lib/session/types";
import { createSessionFixture } from "@/tests/fixtures/session";
import { reviewModuleCandidates } from "@/lib/agent/candidate-reviewer";
import {
  getLlmTelemetrySnapshot,
  resetLlmTelemetryForTests
} from "@/lib/llm/telemetry";

const MANAGED_ENV_KEYS = [
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_DISABLED",
  "DEEPSEEK_REQUEST_TIMEOUT_MS",
  "DEEPSEEK_PARSE_TIMEOUT_MS",
  "DEEPSEEK_AGENT_CHAT_TIMEOUT_MS",
  "DEEPSEEK_AGENT_REASONER_TIMEOUT_MS"
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

function candidate(
  productId: string,
  title: string,
  recommendationType: ProductCandidate["recommendation_type"],
  fitReason: string
): ProductCandidate {
  return {
    product_id: productId,
    title,
    price: recommendationType === "升级推荐" ? 399 : 199,
    source: "淘宝",
    shop_name: "测试旗舰店",
    image_url: "https://img.example.com/item.jpg",
    detail_url: `https://item.taobao.com/item.htm?id=${productId}`,
    shop_badges: ["旗舰店"],
    highlights: ["适配新能源车"],
    risk_notes: ["需确认车型适配"],
    fit_reason: fitReason,
    recommendation_type: recommendationType,
    module_id: "safety-essential"
  };
}

describe("DeepSeek client reliability", () => {
  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = "unit-test-key";
    process.env.DEEPSEEK_DISABLED = "false";
    delete process.env.DEEPSEEK_REQUEST_TIMEOUT_MS;
    delete process.env.DEEPSEEK_PARSE_TIMEOUT_MS;
    delete process.env.DEEPSEEK_AGENT_CHAT_TIMEOUT_MS;
    delete process.env.DEEPSEEK_AGENT_REASONER_TIMEOUT_MS;
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

  it("uses chat for routine scheduling and reserves reasoner for recovery decisions", () => {
    const state = createSessionFixture();
    const module = state.shopping_plan.modules[0];
    const proposal: AgentDecisionProposal = {
      action: "search_module",
      confidence: "high",
      module_id: module.module_id,
      reason: "先完成首个高优先级模块。",
      evidence: ["尚未形成候选池"],
      expected_gain: "形成候选池",
      tool_cost: 1
    };

    expect(selectAgentDecisionModelTier(state, proposal)).toBe("chat");

    state.module_search_traces[module.module_id] = {
      module_id: module.module_id,
      module_name: module.module_name,
      status: "thin",
      primary_keyword: module.search_keyword ?? module.module_name,
      searched_keywords: [module.search_keyword ?? module.module_name],
      attempts: [],
      result_count: 1,
      candidate_count: 1,
      ai_decision_summary: "候选池偏薄",
      next_action: "建议补搜",
      generated_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    expect(selectAgentDecisionModelTier(state, proposal)).toBe("reasoner");
    expect(selectAgentDecisionModelTier(state, { ...proposal, action: "retry_module" })).toBe("reasoner");
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

  it("reviews a candidate pool and returns one bounded fit reason per known product", async () => {
    const state = createSessionFixture();
    const module = state.shopping_plan.modules.find((item) => item.module_id === "safety-essential")!;
    const candidates = [
      candidate("p-1", "高清夜视行车记录仪", "稳妥推荐", "规则生成的稳妥理由。"),
      candidate("p-2", "停车监控行车记录仪", "升级推荐", "规则生成的升级理由。")
    ];
    const fallbackReview = reviewModuleCandidates(state, module, candidates);
    vi.stubGlobal("fetch", vi.fn(async () => responseForContent(JSON.stringify({
      module_id: module.module_id,
      status: "ready",
      summary: "候选池覆盖两个价格档位，可以进入详情确认。",
      strengths: ["包含旗舰店候选"],
      caveats: ["仍需确认安装规格"],
      next_action: "优先查看稳妥推荐的详情。",
      suggested_keyword: "",
      fit_reasons: [
        { product_id: "p-1", fit_reason: "价格落在模块预算内，旗舰店与夜视信号适合提车初期优先核验。" },
        { product_id: "p-2", fit_reason: "停车监控卖点贴合安全模块，适合作为预算允许时的升级候选。" }
      ]
    }))));

    const result = await reviewCandidatePool({
      scene: state.scene_brief,
      module,
      candidates,
      fallbackReview
    });

    expect(result.mode).toBe("connected");
    expect(result.data.source).toBe("deepseek");
    expect(result.fitReasons).toEqual({
      "p-1": "价格落在模块预算内，旗舰店与夜视信号适合提车初期优先核验。",
      "p-2": "停车监控卖点贴合安全模块，适合作为预算允许时的升级候选。"
    });
    expect(taskTelemetry("review_candidates")).toMatchObject({ connected: 1, fallback: 0 });
  });

  it("rejects fit reasons for unknown product ids and preserves deterministic reasons", async () => {
    const state = createSessionFixture();
    const module = state.shopping_plan.modules.find((item) => item.module_id === "safety-essential")!;
    const candidates = [
      candidate("p-1", "高清夜视行车记录仪", "稳妥推荐", "保留这条规则理由。")
    ];
    const fallbackReview = reviewModuleCandidates(state, module, candidates);
    vi.stubGlobal("fetch", vi.fn(async () => responseForContent(JSON.stringify({
      module_id: module.module_id,
      status: "ready",
      summary: "候选池可用。",
      strengths: ["价格合理"],
      caveats: ["确认规格"],
      next_action: "查看详情。",
      suggested_keyword: "",
      fit_reasons: [
        { product_id: "invented-product", fit_reason: "这条理由不应写入任何真实候选商品。" }
      ]
    }))));

    const result = await reviewCandidatePool({
      scene: state.scene_brief,
      module,
      candidates,
      fallbackReview
    });

    expect(result.mode).toBe("mock");
    expect(result.data).toBe(fallbackReview);
    expect(result.fitReasons).toEqual({ "p-1": "保留这条规则理由。" });
    expect(taskTelemetry("review_candidates")).toMatchObject({
      connected: 0,
      fallback: 1,
      last_reason: "schema_validation_failed:candidate_review_invalid"
    });
  });

  it("rejects a structurally valid review bound to a different module", async () => {
    const state = createSessionFixture();
    const module = state.shopping_plan.modules.find((item) => item.module_id === "safety-essential")!;
    const candidates = [
      candidate("p-1", "高清夜视行车记录仪", "稳妥推荐", "保留当前模块的规则理由。")
    ];
    const fallbackReview = reviewModuleCandidates(state, module, candidates);
    vi.stubGlobal("fetch", vi.fn(async () => responseForContent(JSON.stringify({
      module_id: "practical-interior",
      status: "ready",
      summary: "这份结果错误地属于另一模块。",
      strengths: ["结构完整"],
      caveats: ["模块不匹配"],
      next_action: "不应采用。",
      suggested_keyword: "",
      fit_reasons: [
        { product_id: "p-1", fit_reason: "即使商品编号存在，也不能跨模块覆盖推荐理由。" }
      ]
    }))));

    const result = await reviewCandidatePool({
      scene: state.scene_brief,
      module,
      candidates,
      fallbackReview
    });

    expect(result.mode).toBe("mock");
    expect(result.data.module_id).toBe("safety-essential");
    expect(result.fitReasons["p-1"]).toBe("保留当前模块的规则理由。");
  });
});
