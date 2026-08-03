import { describe, expect, it } from "vitest";
// The local executor loads these helpers directly in native Node ESM.
// @ts-expect-error Runtime utility intentionally has no TypeScript declarations.
import * as executorUtils from "../../scripts/local-executor-utils.mjs";

const {
  buildSearchEvidencePrompt,
  isQoderCreditError,
  isRepeatedToolCallError,
  isTaobaoLoginError,
  normalizeTaobaoSearchEvidence,
  qoderPrintArgs,
  searchEvidencePath
} = executorUtils as {
  buildSearchEvidencePrompt: (input: {
    keyword: string;
    moduleName: string;
    moduleId: string;
    evidencePath: string;
  }) => string;
  isQoderCreditError: (value: unknown) => boolean;
  isRepeatedToolCallError: (value: unknown) => boolean;
  isTaobaoLoginError: (value: unknown) => boolean;
  normalizeTaobaoSearchEvidence: (
    raw: unknown,
    context: { keyword: string; moduleId: string }
  ) => { summary: string; candidates: Array<Record<string, unknown>>; evidence: Record<string, unknown> };
  qoderPrintArgs: (prompt: string, tools?: string[]) => string[];
  searchEvidencePath: (baseDir: string, jobId: string) => string;
};

describe("local executor evidence boundary", () => {
  it("builds a single-command Taobao prompt and uses Qoder 1.1 flags", () => {
    const evidencePath = searchEvidencePath("/tmp/evidence", "job/unsafe");
    const prompt = buildSearchEvidencePrompt({
      keyword: "车载手机支架",
      moduleName: "车内实用",
      moduleId: "practical-interior",
      evidencePath
    });
    const args = qoderPrintArgs(prompt, ["Bash"]);

    expect(evidencePath).toBe("/tmp/evidence/job-unsafe.json");
    expect(prompt).toContain("taobao-native search_products");
    expect(prompt).toContain('"keyword":"车载手机支架"');
    expect(prompt).toContain("并且只调用一次");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--output-format");
    expect(args).not.toContain("--yolo");
    expect(args).not.toContain("-q");
    expect(args).not.toContain("-f");
  });

  it("normalizes only products contained in a Taobao evidence artifact", () => {
    const result = normalizeTaobaoSearchEvidence({
      result: {
        keyword: "车载手机支架",
        count: 2,
        products: [
          {
            itemId: "843402079981",
            title: "车载手机支架",
            price: "73.8",
            shopName: "示例旗舰店",
            image: "http://img.alicdn.com/item.jpg",
            productUrl: "https://item.taobao.com/item.htm?id=843402079981",
            shopTags: ["天猫"],
            sellingPoints: ["稳固"]
          },
          {
            itemId: "843402079981",
            title: "重复商品",
            price: "1"
          }
        ]
      }
    }, {
      keyword: "车载手机支架",
      moduleId: "practical-interior"
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      product_id: "843402079981",
      title: "车载手机支架",
      price: 73.8,
      source: "淘宝",
      shop_name: "示例旗舰店",
      image_url: "https://img.alicdn.com/item.jpg",
      module_id: "practical-interior"
    });
    expect(result.candidates[0].highlights).toEqual(expect.arrayContaining(["稳固", "旗舰店", "来自淘宝实时搜索"]));
    expect(result.evidence).toMatchObject({ source: "taobao-native", raw_result_count: 2 });
  });

  it("rejects model-shaped JSON when no Taobao product evidence exists", () => {
    expect(() => normalizeTaobaoSearchEvidence({
      summary: "模型自行声称搜索成功",
      candidates: [{ product_id: "fake" }]
    }, {
      keyword: "车载手机支架",
      moduleId: "practical-interior"
    })).toThrow("缺少 result.products");
  });

  it("classifies login and repeated-call failures without retrying blindly", () => {
    expect(isTaobaoLoginError('{"error":"未登录，已打开登录页面，请先登录淘宝账号"}')).toBe(true);
    expect(isRepeatedToolCallError("Repeated tool call was denied")).toBe(true);
    expect(isTaobaoLoginError("network timeout")).toBe(false);
  });

  it("classifies Qoder account credit exhaustion as an actionable failure", () => {
    expect(isQoderCreditError(
      "You've reached your credit usage limit. Please upgrade your subscription plan."
    )).toBe(true);
    expect(isQoderCreditError('{"pricingUrl":"https://qoder.com/pricing?client=qoder"}')).toBe(true);
    expect(isQoderCreditError("network timeout")).toBe(false);
  });
});
