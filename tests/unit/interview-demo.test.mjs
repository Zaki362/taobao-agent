import { describe, expect, it } from "vitest";
import {
  buildInterviewDemoCartResult,
  buildInterviewDemoSearchResult,
  loadInterviewDemoSnapshot,
  validateInterviewDemoSnapshot
} from "../../scripts/interview-demo-utils.mjs";

describe("interview demo fixture", () => {
  it("labels covered modules as historical snapshots with an explicit capture time", async () => {
    const snapshot = await loadInterviewDemoSnapshot();
    const result = buildInterviewDemoSearchResult(snapshot, {
      payload: {
        module_id: "safety-essential",
        module_name: "安全必需",
        keyword: "新能源车 应急启动电源",
        budget: 700
      }
    });

    expect(result.candidates).toHaveLength(3);
    expect(result.evidence).toMatchObject({
      source: "interview-demo-historical-snapshot",
      captured_at: "2026-08-08T14:33:55+08:00",
      realtime: false
    });
    expect(result.summary).toContain("没有执行实时搜索");
    expect(result.candidates.every((item) => item.source === "淘宝历史快照（2026-08-08）")).toBe(true);
    expect(result.candidates.every((item) => item.highlights.includes("非实时结果"))).toBe(true);
    expect(result.candidates.every((item) => item.risk_notes[0].includes("价格、库存、规格与链接状态未做实时校验"))).toBe(true);
  });

  it("uses conspicuously labeled fixed candidates for adaptive or uncovered modules", async () => {
    const snapshot = await loadInterviewDemoSnapshot();
    for (const payload of [
      {
        module_id: "adaptive-child-safety",
        module_name: "儿童安全出行",
        keyword: "新能源 SUV 儿童安全座椅 ISOFIX",
        budget: 500
      },
      {
        module_id: "decor-ambience",
        module_name: "装饰氛围",
        keyword: "新能源车 氛围灯",
        budget: 240
      }
    ]) {
      const result = buildInterviewDemoSearchResult(snapshot, { payload });
      expect(result.evidence).toMatchObject({
        source: "interview-demo-fixed-candidates",
        realtime: false
      });
      expect(result.execution_mode).toBe("interview_demo");
      expect(result.summary).toContain("固定演示候选");
      expect(result.candidates).toHaveLength(3);
      expect(result.candidates.every((item) => item.source === "SceneCart 固定演示候选")).toBe(true);
      expect(result.candidates.every((item) => item.title.includes("非淘宝实时商品"))).toBe(true);
      expect(result.candidates.every((item) => item.detail_url === "")).toBe(true);
    }
  });

  it("creates only a product-local demo cart result", () => {
    expect(buildInterviewDemoCartResult("demo-product")).toEqual({
      success: true,
      demo_fallback: true,
      execution_mode: "interview_demo",
      product_id: "demo-product",
      selected_spec: "面试演示模式（未读取或选择淘宝规格）",
      cart_note: "只写入 SceneCart 产品内演示清单；未调用淘宝加购、下单或支付能力。",
      message: "面试演示模式：已加入产品内演示清单；未调用淘宝加购或下单。"
    });
  });

  it("rejects fixtures that could be mistaken for live data", async () => {
    const snapshot = await loadInterviewDemoSnapshot();
    expect(() => validateInterviewDemoSnapshot({ ...snapshot, kind: "live_taobao_result" }))
      .toThrow("historical_taobao_snapshot");
    expect(() => validateInterviewDemoSnapshot({ ...snapshot, disclosure: "" }))
      .toThrow("disclosure");
  });
});
