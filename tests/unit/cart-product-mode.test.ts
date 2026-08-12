import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionFixture } from "@/tests/fixtures/session";
import type { ProductCandidate } from "@/lib/session/types";
import { buildAgentCompletionReport } from "@/lib/agent/completion-review";
import { acceptCurrentPurchaseBundle } from "@/lib/session/bundle-adoption";

const { executeMcpToolMock } = vi.hoisted(() => ({
  executeMcpToolMock: vi.fn()
}));

vi.mock("@/lib/mcp/client", () => ({
  getExecutionBackend: () => "qoder_cli"
}));

vi.mock("@/lib/mcp/executor", () => ({
  executeMcpTool: executeMcpToolMock
}));

vi.mock("@/lib/mcp/hosted", () => ({
  queueAddToCartTask: vi.fn()
}));

vi.mock("@/lib/runtime/jobs", () => ({
  enqueueAddToCartJob: vi.fn()
}));

import { CartItemRemovalError, removeDemoCartItem, runCartExecutor } from "@/lib/agent/cart";

const originalProductMode = process.env.SCENECART_PRODUCT_MODE;
const originalDemoFallback = process.env.ALLOW_DEMO_CART_FALLBACK;

function candidate(moduleId: string): ProductCandidate {
  return {
    product_id: "product-1",
    module_id: moduleId,
    title: "车载安全用品测试商品",
    price: 199,
    source: "淘宝",
    shop_name: "测试旗舰店",
    image_url: "https://img.alicdn.com/test.jpg",
    detail_url: "https://item.taobao.com/item.htm?id=product-1",
    shop_badges: ["旗舰店"],
    highlights: ["适配新车"],
    risk_notes: ["请确认规格"],
    fit_reason: "符合当前模块需求。",
    recommendation_type: "稳妥推荐"
  };
}

beforeEach(() => {
  executeMcpToolMock.mockReset();
  executeMcpToolMock.mockRejectedValue(new Error("淘宝真实加购失败"));
});

afterEach(() => {
  if (originalProductMode === undefined) delete process.env.SCENECART_PRODUCT_MODE;
  else process.env.SCENECART_PRODUCT_MODE = originalProductMode;
  if (originalDemoFallback === undefined) delete process.env.ALLOW_DEMO_CART_FALLBACK;
  else process.env.ALLOW_DEMO_CART_FALLBACK = originalDemoFallback;
});

describe("cart behavior by product mode", () => {
  it("keeps an explicitly labeled demo item in development preview mode", async () => {
    process.env.SCENECART_PRODUCT_MODE = "development";
    process.env.ALLOW_DEMO_CART_FALLBACK = "true";
    const state = createSessionFixture();
    const moduleId = state.shopping_plan.modules[0].module_id;
    state.module_candidates[moduleId] = [candidate(moduleId)];
    state.completion_report = buildAgentCompletionReport(state);
    const bundle = state.completion_report.purchase_bundle!;
    acceptCurrentPurchaseBundle(state, bundle.generated_at);

    const result = await runCartExecutor(state, "product-1");

    expect(result).toMatchObject({ success: true, demo_fallback: true });
    expect(state.selected_items).toHaveLength(1);
    expect(state.selected_items[0].cart_source).toBe("demo");
    expect(state.tool_logs[0].tool_name).toBe("demo_cart_fallback");
    expect(state.bundle_adoption?.status).toBe("completed");

    const removed = removeDemoCartItem(state, "product-1");
    expect(removed.cart_source).toBe("demo");
    expect(state.selected_items).toHaveLength(0);
    expect(state.bundle_adoption).toMatchObject({
      status: "accepted",
      added_product_ids: [],
      pending_product_ids: ["product-1"]
    });
  });

  it("fails closed without mutating the cart in formal product mode", async () => {
    process.env.SCENECART_PRODUCT_MODE = "production";
    process.env.ALLOW_DEMO_CART_FALLBACK = "true";
    const state = createSessionFixture();
    const moduleId = state.shopping_plan.modules[0].module_id;
    state.module_candidates[moduleId] = [candidate(moduleId)];

    await expect(runCartExecutor(state, "product-1")).rejects.toThrow("淘宝真实加购失败");
    expect(state.selected_items).toHaveLength(0);
    expect(state.tool_logs).toHaveLength(0);
  });

  it("fails closed when asked to remove a real or historical cart item", () => {
    const state = createSessionFixture();
    const moduleId = state.shopping_plan.modules[0].module_id;
    state.selected_items = [{
      product_id: "real-product",
      module_id: moduleId,
      title: "真实淘宝商品",
      price: 99,
      cart_source: "taobao",
      added_at: new Date().toISOString()
    }];

    expect(() => removeDemoCartItem(state, "real-product"))
      .toThrow(CartItemRemovalError);
    expect(state.selected_items).toHaveLength(1);

    state.selected_items[0].cart_source = undefined;
    expect(() => removeDemoCartItem(state, "real-product"))
      .toThrow("真实淘宝购物车商品需要在淘宝购物车中管理");
    expect(state.selected_items).toHaveLength(1);
  });

  it("returns a not-found error without changing the current selection", () => {
    const state = createSessionFixture();
    expect(() => removeDemoCartItem(state, "missing-product"))
      .toThrow("当前购买清单中没有这件商品");
    expect(state.selected_items).toEqual([]);
  });
});
