import { describe, expect, it } from "vitest";
import { productDetailEvidencePresentation } from "@/components/dashboard-helpers";
import type { ProductCandidate, TaobaoMcpProductDetailEvidence } from "@/lib/session/types";

function candidate(): ProductCandidate {
  return {
    product_id: "product-detail-evidence-1",
    title: "行车记录仪详情证据测试商品",
    price: 399,
    source: "淘宝",
    shop_name: "测试旗舰店",
    image_url: "",
    detail_url: "https://item.taobao.com/item.htm?id=123456",
    shop_badges: ["旗舰店"],
    highlights: ["2K", "停车监控"],
    risk_notes: ["下单前确认车型适配"],
    fit_reason: "搜索摘要显示价格位于模块预算内，标题包含记录仪品类词。",
    recommendation_type: "稳妥推荐",
    module_id: "safety-essential"
  };
}

function verifiedEvidence(): TaobaoMcpProductDetailEvidence {
  return {
    schema: "scenecart.taobao-mcp-product-detail-evidence/v1",
    source: "taobao-mcp",
    status: "verified",
    tool: "navigate_to_url+read_page_content",
    tools_used: ["navigate_to_url", "read_page_content"],
    source_app: "SceneCartDetailEvidenceUnitTest",
    job_id: "detail-job-1",
    search_job_id: "search-job-1",
    module_id: "safety-essential",
    workflow_run_id: "workflow-1",
    product_id: "product-detail-evidence-1",
    detail_url: "https://item.taobao.com/item.htm?id=123456",
    captured_at: "2026-08-18T01:23:45.000Z",
    summary: {
      page_title: "行车记录仪详情证据测试商品-淘宝网",
      page_url: "https://item.taobao.com/item.htm?id=123456",
      visible_text_sha256: "a".repeat(64),
      matched_facts: ["详情页展示 2K 录制和停车监控", "页面显示价格 ¥399"],
      displayed_price_texts: ["¥399"]
    },
    recommendation_reason: "详情页明确展示 2K 录制和停车监控，符合安全模块的核心需求。页面可见价格为 ¥399，落在当前模块预算内。第三句不应进入卡片。"
  };
}

describe("product detail evidence presentation", () => {
  it("shows a bounded two-sentence reason only for verified evidence bound to the candidate", () => {
    const product = candidate();
    product.detail_evidence = verifiedEvidence();

    expect(productDetailEvidencePresentation(product)).toEqual({
      state: "verified",
      label: "本机 Worker 已读取淘宝详情页",
      reason: "详情页明确展示 2K 录制和停车监控，符合安全模块的核心需求。页面可见价格为 ¥399，落在当前模块预算内。",
      capturedAt: "2026-08-18T01:23:45.000Z",
      supportsRecommendation: true
    });
  });

  it("does not repeat the backend's verification wording as a comprehensive product claim", () => {
    const product = candidate();
    product.detail_evidence = {
      ...verifiedEvidence(),
      recommendation_reason: "已核验淘宝详情页“测试商品”，页面可见信号：2K。具体 SKU 仍需购买前确认。"
    };

    const presentation = productDetailEvidencePresentation(product);
    expect(presentation.state).toBe("verified");
    if (presentation.state === "verified") {
      expect(presentation.reason).toBe("已读取淘宝详情页“测试商品”，页面可见信号：2K。具体 SKU 仍需购买前确认。")
      expect(presentation.reason).not.toContain("已核验淘宝详情页");
    }
  });

  it("keeps an unavailable detail read explicitly at search-summary confidence", () => {
    const product = candidate();
    product.detail_evidence = {
      ...verifiedEvidence(),
      status: "unavailable",
      tools_used: ["navigate_to_url"],
      summary: undefined,
      recommendation_reason: undefined,
      unavailable_reason: "淘宝详情页要求重新登录"
    };

    expect(productDetailEvidencePresentation(product)).toEqual({
      state: "unavailable",
      label: "仅基于搜索摘要，淘宝详情页暂不可读",
      summaryReason: product.fit_reason,
      unavailableReason: "淘宝登录状态需要恢复"
    });
  });

  it("does not promote a stale product or detail URL mismatch", () => {
    const staleProduct = candidate();
    staleProduct.detail_evidence = {
      ...verifiedEvidence(),
      product_id: "another-product"
    };
    const staleUrl = candidate();
    staleUrl.detail_evidence = {
      ...verifiedEvidence(),
      detail_url: "https://item.taobao.com/item.htm?id=stale"
    };

    expect(productDetailEvidencePresentation(staleProduct).state).toBe("missing");
    expect(productDetailEvidencePresentation(staleUrl).state).toBe("missing");
  });

  it("does not label missing evidence or an empty recommendation reason as detail-backed", () => {
    const missing = candidate();
    const noReason = candidate();
    noReason.detail_evidence = {
      ...verifiedEvidence(),
      recommendation_reason: "   "
    };

    expect(productDetailEvidencePresentation(missing).label).toBe("仅基于搜索摘要，详情读取待完成");
    expect(productDetailEvidencePresentation(noReason).label).toBe("仅基于搜索摘要，详情读取待完成");
  });

  it("does not call a detail read recommendation-backed when no visible fact matched", () => {
    const product = candidate();
    product.detail_evidence = {
      ...verifiedEvidence(),
      summary: {
        ...verifiedEvidence().summary!,
        matched_facts: []
      },
      recommendation_reason: "已读取淘宝详情页并确认商品身份；适配性仍需人工核对。"
    };

    expect(productDetailEvidencePresentation(product)).toMatchObject({
      state: "verified",
      supportsRecommendation: false
    });
  });
});
