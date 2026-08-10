import { describe, expect, it } from "vitest";
// The local executor loads these helpers directly in native Node ESM.
// @ts-expect-error Runtime utility intentionally has no TypeScript declarations.
import * as executorUtils from "../../scripts/local-executor-utils.mjs";

const {
  isTaobaoLoginError,
  normalizeTaobaoCartResult,
  normalizeTaobaoSearchEvidence,
  taobaoCurrentTabUrl
} = executorUtils as {
  isTaobaoLoginError: (value: unknown) => boolean;
  normalizeTaobaoCartResult: (raw: unknown, productId: string) => Record<string, unknown>;
  normalizeTaobaoSearchEvidence: (
    raw: unknown,
    context: { keyword: string; moduleId: string }
  ) => { summary: string; candidates: Array<Record<string, unknown>>; evidence: Record<string, unknown> };
  taobaoCurrentTabUrl: (raw: unknown) => string;
};

describe("local executor evidence boundary", () => {
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

  it("classifies login failures and login-page URLs before account actions", () => {
    expect(isTaobaoLoginError('{"error":"未登录，已打开登录页面，请先登录淘宝账号"}')).toBe(true);
    expect(isTaobaoLoginError("network timeout")).toBe(false);
    expect(taobaoCurrentTabUrl({ result: { url: "https://login.taobao.com/login.htm" } })).toContain("login.taobao.com");
  });

  it("accepts confirmed cart results without an agent-generated success claim", () => {
    expect(normalizeTaobaoCartResult({ result: {
      success: true,
      message: "加购成功",
      selectedSku: ["黑色", "标准版"]
    } }, "product-1")).toEqual({
      success: true,
      message: "加购成功",
      product_id: "product-1",
      selected_spec: "黑色 / 标准版"
    });
  });

  it("stops for explicit SKU selection instead of choosing a random variant", () => {
    expect(normalizeTaobaoCartResult({
      needsSkuSelection: true,
      availableSkus: [{ groupLabel: "颜色" }, { groupLabel: "版本" }]
    }, "product-2")).toMatchObject({
      success: false,
      product_id: "product-2",
      needs_sku_selection: true,
      message: "商品需要先选择规格：颜色、版本"
    });
  });
});
