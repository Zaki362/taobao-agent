import path from "node:path";

const RECOMMENDATION_TYPES = ["稳妥推荐", "性价比推荐", "升级推荐"];
const SEARCH_RISK_NOTE = "当前为搜索结果摘要，未自动打开详情页，建议点开淘宝详情页确认规格与适配性";

function asText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueStrings(values, limit = 6) {
  return [...new Set(values.map(asText).filter(Boolean))].slice(0, limit);
}

function asStringList(value) {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.filter((item) => typeof item === "string"));
}

function normalizePrice(value) {
  const price = typeof value === "number"
    ? value
    : Number.parseFloat(asText(value).replace(/[^0-9.]/g, ""));
  return Number.isFinite(price) && price >= 0 ? price : 0;
}

function normalizeImageUrl(value) {
  const imageUrl = asText(value);
  if (!imageUrl) return "";
  if (imageUrl.startsWith("//")) return `https:${imageUrl}`;
  return imageUrl.replace(/^http:\/\//i, "https://");
}

function normalizeDetailUrl(value, productId) {
  const detailUrl = asText(value);
  if (/^https?:\/\//i.test(detailUrl)) return detailUrl.replace(/^http:\/\//i, "https://");
  return productId ? `https://item.taobao.com/item.htm?id=${encodeURIComponent(productId)}` : "";
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function searchEvidencePath(baseDir, jobId) {
  const safeJobId = String(jobId).replace(/[^a-zA-Z0-9_-]/g, "-");
  return path.join(baseDir, `${safeJobId}.json`);
}

export function buildSearchEvidencePrompt(input) {
  const toolArgs = JSON.stringify({
    keyword: String(input.keyword ?? "").trim(),
    sourceApp: "Qoderwork"
  });
  const command = [
    "taobao-native search_products",
    "--args",
    shellSingleQuote(toolArgs),
    "-o",
    shellSingleQuote(input.evidencePath)
  ].join(" ");

  return [
    "你是 SceneCart AI 的淘宝工具宿主，只执行下面一个原子搜索任务。",
    "必须调用 Bash 工具，并且只调用一次；禁止使用 Skill、Read、Edit、Web 或其他工具。",
    "禁止自行生成、补全或猜测任何商品信息，也不要重试失败的命令。",
    "严格执行以下命令，不得改写关键词、参数或输出路径：",
    command,
    "命令成功后只返回严格 JSON：{\"ok\":true}",
    "命令失败后只返回严格 JSON：{\"ok\":false,\"error\":\"原始错误摘要\"}"
  ].join("\n");
}

export function qoderPrintArgs(prompt, tools = ["Bash"]) {
  const toolList = uniqueStrings(tools, 8).join(",");
  return [
    "-p",
    prompt,
    "--cwd",
    process.cwd(),
    "--permission-mode",
    "bypass_permissions",
    "--dangerously-skip-permissions",
    "--tools",
    toolList,
    "--allowed-tools",
    toolList,
    "--no-session-persistence",
    "--max-model-request-retries",
    "1",
    "--max-output-tokens",
    "512",
    "--output-format",
    "text"
  ];
}

export function normalizeTaobaoSearchEvidence(raw, context) {
  const root = raw && typeof raw === "object" ? raw : {};
  const result = root.result && typeof root.result === "object" ? root.result : root;
  const products = Array.isArray(result.products)
    ? result.products
    : Array.isArray(result.results)
      ? result.results
      : null;
  if (!products) {
    throw new Error("淘宝搜索证据缺少 result.products，已拒绝使用未经工具验证的商品数据。");
  }

  const seen = new Set();
  const normalized = [];
  for (const item of products) {
    if (!item || typeof item !== "object") continue;
    const productId = asText(item.itemId ?? item.product_id ?? item.id);
    const title = asText(item.title);
    if (!productId || !title || seen.has(productId)) continue;
    seen.add(productId);

    const shopName = asText(item.shopName ?? item.shop_name);
    const shopBadges = asStringList(item.shopTags ?? item.shop_badges);
    const highlights = uniqueStrings([
      ...asStringList(item.sellingPoints ?? item.highlights),
      shopName.includes("旗舰店") ? "旗舰店" : "",
      "来自淘宝实时搜索"
    ]);
    const index = normalized.length;
    normalized.push({
      product_id: productId,
      title,
      price: normalizePrice(item.price),
      source: "淘宝",
      shop_name: shopName,
      image_url: normalizeImageUrl(item.image ?? item.image_url),
      detail_url: normalizeDetailUrl(item.productUrl ?? item.detail_url, productId),
      shop_badges: shopBadges,
      highlights,
      risk_notes: [SEARCH_RISK_NOTE],
      fit_reason: `来自“${context.keyword}”的真实淘宝搜索结果，后续由 SceneCart 按预算与模块目标进行排序。`,
      recommendation_type: RECOMMENDATION_TYPES[index % RECOMMENDATION_TYPES.length],
      module_id: context.moduleId
    });
    if (normalized.length >= 10) break;
  }

  return {
    summary: normalized.length > 0
      ? `已通过淘宝工具搜索“${context.keyword}”，获得 ${normalized.length} 个可验证候选。`
      : `淘宝工具已完成“${context.keyword}”搜索，但未返回可用候选。`,
    candidates: normalized,
    evidence: {
      source: "taobao-native",
      keyword: asText(result.keyword) || context.keyword,
      raw_result_count: Number.isFinite(Number(result.count)) ? Number(result.count) : products.length
    }
  };
}

export function isTaobaoLoginError(value) {
  return /未登录|请先登录淘宝账号|已打开登录页面|login\.taobao\.com/i.test(String(value ?? ""));
}

export function isRepeatedToolCallError(value) {
  return /repeated tool call was denied/i.test(String(value ?? ""));
}

export function isQoderCreditError(value) {
  return /credit usage limit|usage limit|insufficient credits?|quota exceeded|upgrade your subscription plan|qoder\.com\/pricing|pricingUrl/i.test(
    String(value ?? "")
  );
}
