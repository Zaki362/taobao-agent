import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_INTERVIEW_SNAPSHOT_PATH = path.resolve(
  scriptDir,
  "../fixtures/interview-demo/taobao-snapshot-2026-08-08.json"
);

const recommendationTypes = ["稳妥推荐", "性价比推荐", "升级推荐"];

function requireText(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`面试演示快照缺少 ${field}`);
  }
  return value.trim();
}

function validateProduct(product, moduleId) {
  requireText(product?.product_id, `${moduleId}.product_id`);
  requireText(product?.title, `${moduleId}.title`);
  requireText(product?.shop_name, `${moduleId}.shop_name`);
  if (!Number.isFinite(product?.price) || product.price < 0) {
    throw new Error(`面试演示快照中的 ${moduleId}.price 无效`);
  }
}

export function validateInterviewDemoSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("面试演示快照不是 JSON 对象");
  }
  if (snapshot.kind !== "historical_taobao_snapshot") {
    throw new Error("面试演示数据必须明确标记为 historical_taobao_snapshot");
  }
  requireText(snapshot.captured_at, "captured_at");
  requireText(snapshot.disclosure, "disclosure");
  requireText(snapshot.safety_boundary, "safety_boundary");
  if (!snapshot.modules || typeof snapshot.modules !== "object") {
    throw new Error("面试演示快照缺少 modules");
  }
  for (const [moduleId, products] of Object.entries(snapshot.modules)) {
    if (!Array.isArray(products) || products.length < 3) {
      throw new Error(`面试演示快照模块 ${moduleId} 至少需要 3 个候选`);
    }
    products.forEach((product) => validateProduct(product, moduleId));
  }
  return snapshot;
}

export async function loadInterviewDemoSnapshot(
  snapshotPath = process.env.SCENECART_INTERVIEW_DEMO_SNAPSHOT || DEFAULT_INTERVIEW_SNAPSHOT_PATH
) {
  const content = await fs.readFile(path.resolve(snapshotPath), "utf8");
  return validateInterviewDemoSnapshot(JSON.parse(content));
}

function capturedDate(snapshot) {
  return String(snapshot.captured_at).slice(0, 10);
}

function historicalCandidates(snapshot, job) {
  const payload = job.payload || {};
  const moduleId = requireText(payload.module_id, "job.payload.module_id");
  const moduleName = requireText(payload.module_name || moduleId, "job.payload.module_name");
  const date = capturedDate(snapshot);
  const products = snapshot.modules[moduleId];
  if (!Array.isArray(products)) return null;

  return products.slice(0, 3).map((product, index) => ({
    product_id: product.product_id,
    title: product.title,
    price: product.price,
    source: `淘宝历史快照（${date}）`,
    shop_name: product.shop_name,
    image_url: typeof product.image_url === "string" ? product.image_url : "",
    detail_url: `https://item.taobao.com/item.htm?id=${encodeURIComponent(product.product_id)}`,
    shop_badges: product.shop_name.includes("旗舰店") ? ["历史快照", "旗舰店"] : ["历史快照"],
    highlights: ["非实时结果", `采集于 ${date}`, "仅供面试演示"],
    risk_notes: [
      `面试演示数据：采集于 ${date}，价格、库存、规格与链接状态未做实时校验。`
    ],
    fit_reason: `这是“${moduleName}”的历史淘宝搜索样本，只用于展示 SceneCart 的编排、筛选和确认流程，不代表当前价格或库存。`,
    recommendation_type: recommendationTypes[index],
    module_id: moduleId
  }));
}

function fixedDemoCandidates(job) {
  const payload = job.payload || {};
  const moduleId = requireText(payload.module_id, "job.payload.module_id");
  const moduleName = requireText(payload.module_name || moduleId, "job.payload.module_name");
  const moduleBudget = Math.max(30, Number(payload.budget) || 300);
  const prices = [0.28, 0.42, 0.58].map((ratio) => Math.round(moduleBudget * ratio * 100) / 100);

  return recommendationTypes.map((recommendationType, index) => ({
    product_id: `interview-demo-${moduleId}-${index + 1}`,
    title: `${moduleName}固定演示候选 ${index + 1}（非淘宝实时商品）`,
    price: prices[index],
    source: "SceneCart 固定演示候选",
    shop_name: "SceneCart 面试演示",
    image_url: "",
    detail_url: "",
    shop_badges: ["演示候选"],
    highlights: ["非淘宝结果", "固定可重复", "仅供面试演示"],
    risk_notes: ["固定演示候选不是淘宝商品，不可据此判断价格、库存或规格。"],
    fit_reason: `历史快照没有覆盖“${moduleName}”，因此使用明确标注的固定候选完成流程演示。`,
    recommendation_type: recommendationType,
    module_id: moduleId
  }));
}

export function buildInterviewDemoSearchResult(snapshot, job) {
  validateInterviewDemoSnapshot(snapshot);
  const payload = job.payload || {};
  const moduleId = requireText(payload.module_id, "job.payload.module_id");
  const keyword = typeof payload.keyword === "string" ? payload.keyword.trim() : "";
  const candidates = historicalCandidates(snapshot, job) || fixedDemoCandidates(job);
  const usesHistoricalSnapshot = Array.isArray(snapshot.modules[moduleId]);
  const date = capturedDate(snapshot);

  return {
    execution_mode: "interview_demo",
    summary: usesHistoricalSnapshot
      ? `面试演示：已从 ${date} 淘宝历史快照回填 ${candidates.length} 个候选；没有执行实时搜索。`
      : `面试演示：历史快照未覆盖该模块，已回填 ${candidates.length} 个固定演示候选；没有执行实时搜索。`,
    candidates,
    evidence: {
      source: usesHistoricalSnapshot ? "interview-demo-historical-snapshot" : "interview-demo-fixed-candidates",
      captured_at: snapshot.captured_at,
      keyword,
      realtime: false,
      disclosure: snapshot.disclosure
    }
  };
}

export function buildInterviewDemoCartResult(productId) {
  return {
    success: true,
    demo_fallback: true,
    execution_mode: "interview_demo",
    product_id: requireText(productId, "job.payload.product_id"),
    selected_spec: "面试演示模式（未读取或选择淘宝规格）",
    cart_note: "只写入 SceneCart 产品内演示清单；未调用淘宝加购、下单或支付能力。",
    message: "面试演示模式：已加入产品内演示清单；未调用淘宝加购或下单。"
  };
}
