import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const RECOMMENDATION_TYPES = ["稳妥推荐", "性价比推荐", "升级推荐"];
const SEARCH_RISK_NOTE = "当前为搜索结果摘要，未自动打开详情页，建议点开淘宝详情页确认规格与适配性";
const PRODUCT_DETAIL_EVIDENCE_SCHEMA = "scenecart.taobao-mcp-product-detail-evidence/v1";
const PRODUCT_DETAIL_TOOL = "navigate_to_url+read_page_content";
export const PENDING_AUTH_FAILURE_SCHEMA = "scenecart.pending-auth-failure/v1";
export const PENDING_RESULT_ACKNOWLEDGEMENT_SCHEMA = "scenecart.pending-result-acknowledgement/v1";
const AUTH_FAILURE_JOB_TYPES = new Set(["module_search", "add_to_cart"]);
const RESULT_ACKNOWLEDGEMENT_JOB_TYPES = new Set(["module_search", "product_detail", "add_to_cart"]);

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

export function isTrustedTaobaoDetailUrl(value) {
  try {
    const url = new URL(asText(value));
    if (url.protocol !== "https:") return false;
    const hostname = url.hostname.toLowerCase();
    return ["taobao.com", "tmall.com", "tmall.hk", "tb.cn"].some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}

function resultObject(raw) {
  const root = raw && typeof raw === "object" ? raw : {};
  return root.result && typeof root.result === "object" ? root.result : root;
}

function availableSkuGroups(result) {
  if (Array.isArray(result.availableSkus)) return result.availableSkus;
  if (Array.isArray(result.available_skus)) return result.available_skus;
  return [];
}

function skuGroupLabel(group, index) {
  if (!group || typeof group !== "object") return `规格 ${index + 1}`;
  return asText(group.groupLabel ?? group.label ?? group.name) || `规格 ${index + 1}`;
}

function skuGroupOptions(group) {
  if (!group || typeof group !== "object") return [];
  if (Array.isArray(group.options)) return group.options;
  if (Array.isArray(group.values)) return group.values;
  return [];
}

function skuOptionText(option) {
  if (typeof option === "string") return asText(option);
  if (!option || typeof option !== "object") return "";
  return asText(option.text ?? option.value ?? option.name ?? option.label);
}

function requestedSkuSelection(payload, groups) {
  const source = payload && typeof payload === "object" ? payload : {};
  const keys = ["sku", "selectedSku", "selected_sku", "skuSelection", "sku_selection"];
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = source[key];
    if (Array.isArray(value)) {
      return {
        provided: value.length > 0,
        validShape: value.length > 0 && value.every((entry) => typeof entry === "string" && entry.trim()),
        values: value.map(asText)
      };
    }
    if (value && typeof value === "object") {
      const values = groups.map((group, index) => asText(value[skuGroupLabel(group, index)]));
      return {
        provided: Object.keys(value).length > 0,
        validShape: values.length > 0 && values.every(Boolean),
        values
      };
    }
    return { provided: Boolean(value), validShape: false, values: [] };
  }
  return { provided: false, validShape: false, values: [] };
}

function skuSelectionRequired(productId, skus, message) {
  const labels = skus.map(skuGroupLabel);
  return {
    success: false,
    code: "sku_selection_required",
    error_code: "sku_selection_required",
    message: message || (labels.length > 0
      ? `商品需要先选择规格：${[...new Set(labels)].join("、")}`
      : "商品需要先选择规格，请打开淘宝详情页确认后再加购。"),
    product_id: productId,
    needsSkuSelection: true,
    needs_sku_selection: true,
    availableSkus: skus,
    available_skus: skus,
    retryable: false
  };
}

/**
 * Build the only safe follow-up to get_product_skus. Multi-SKU products are
 * never assigned a default variant: every dimension must come from an explicit
 * task payload and match an enabled option returned by Taobao.
 */
export function prepareTaobaoCartAction(raw, payload, productId) {
  const result = resultObject(raw);
  if (result.success === false) {
    throw new Error(asText(result.error ?? result.message) || "淘宝 get_product_skus 未返回可用结果。");
  }

  const skus = availableSkuGroups(result);
  const hasSku = typeof result.hasSku === "boolean"
    ? result.hasSku
    : typeof result.has_sku === "boolean"
      ? result.has_sku
      : undefined;
  const allSelected = result.allSelected === true || result.all_selected === true;

  if (allSelected || (hasSku === false && skus.length === 0)) {
    return {
      action: "add_to_cart",
      arguments: { itemId: productId }
    };
  }

  const skuExists = hasSku === true || skus.length > 0;
  if (!skuExists) {
    throw new Error("淘宝 get_product_skus 响应缺少 hasSku/allSelected 证据，已停止加购。");
  }

  const requested = requestedSkuSelection(payload, skus);
  if (!requested.provided) {
    return {
      action: "sku_selection_required",
      result: skuSelectionRequired(productId, skus)
    };
  }
  if (!requested.validShape || requested.values.length !== skus.length) {
    return {
      action: "sku_selection_required",
      result: skuSelectionRequired(
        productId,
        skus,
        `商品规格选择不完整，需要按 ${skus.length} 个维度重新选择。`
      )
    };
  }

  const selected = [];
  for (let index = 0; index < skus.length; index += 1) {
    const group = skus[index];
    const options = skuGroupOptions(group);
    const requestedValue = requested.values[index];
    const option = options.find((entry) => skuOptionText(entry) === requestedValue);
    const optionDisabled = option && typeof option === "object" && (
      option.disabled === true || option.available === false || option.inStock === false
    );
    if (!option || optionDisabled) {
      const label = skuGroupLabel(group, index);
      const reason = optionDisabled ? "当前无货" : "不在淘宝返回的可选项中";
      return {
        action: "sku_selection_required",
        result: skuSelectionRequired(
          productId,
          skus,
          `“${label}”中的“${requestedValue || "未选择"}”${reason}，请重新选择规格。`
        )
      };
    }
    selected.push(skuOptionText(option));
  }

  return {
    action: "add_to_cart",
    arguments: { itemId: productId, sku: selected }
  };
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
      fit_reason: `来自“${context.keyword}”的真实淘宝搜索结果，后续由场景购按预算与模块目标进行排序。`,
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

export function buildTaobaoMcpSearchEvidence(context) {
  const sourceApp = asText(context?.sourceApp);
  const jobId = asText(context?.jobId);
  const moduleId = asText(context?.moduleId);
  const workflowRunId = asText(context?.workflowRunId);
  const keyword = asText(context?.keyword);
  const capturedAt = asText(context?.capturedAt) || new Date().toISOString();
  const rawResultCount = Number(context?.rawResultCount);
  const transport = context?.transport === "native_cli" ? "native_cli" : "http_mcp";
  if (!sourceApp || !jobId || !moduleId || !workflowRunId || !keyword) {
    throw new Error("淘宝 MCP 搜索证据缺少任务上下文。");
  }
  if (!Number.isFinite(Date.parse(capturedAt))) {
    throw new Error("淘宝 MCP 搜索证据时间无效。");
  }
  if (!Number.isInteger(rawResultCount) || rawResultCount < 0) {
    throw new Error("淘宝 MCP 搜索证据结果数量无效。");
  }
  return {
    schema: "scenecart.taobao-mcp-search-evidence/v1",
    source: "taobao-mcp",
    tool: "search_products",
    source_app: sourceApp,
    job_id: jobId,
    module_id: moduleId,
    workflow_run_id: workflowRunId,
    keyword,
    captured_at: capturedAt,
    cache_hit: false,
    raw_result_count: rawResultCount,
    transport
  };
}

function detailEvidenceContext(context) {
  const sourceApp = asText(context?.sourceApp);
  const jobId = asText(context?.jobId);
  const searchJobId = asText(context?.searchJobId);
  const moduleId = asText(context?.moduleId);
  const workflowRunId = asText(context?.workflowRunId);
  const productId = asText(context?.productId);
  const detailUrl = asText(context?.detailUrl);
  const capturedAt = asText(context?.capturedAt) || new Date().toISOString();
  if (!sourceApp || !jobId || !searchJobId || !moduleId || !workflowRunId || !productId || !detailUrl) {
    throw new Error("淘宝 MCP 详情证据缺少任务上下文。");
  }
  if (!Number.isFinite(Date.parse(capturedAt))) {
    throw new Error("淘宝 MCP 详情证据时间无效。");
  }
  return {
    schema: PRODUCT_DETAIL_EVIDENCE_SCHEMA,
    source: "taobao-mcp",
    tool: PRODUCT_DETAIL_TOOL,
    source_app: sourceApp,
    job_id: jobId,
    search_job_id: searchJobId,
    module_id: moduleId,
    workflow_run_id: workflowRunId,
    product_id: productId,
    detail_url: detailUrl,
    captured_at: capturedAt
  };
}

export function buildUnavailableTaobaoMcpProductDetailEvidence(context, reason, toolsUsed = []) {
  const unavailableReason = asText(reason).replace(/\s+/g, " ").slice(0, 300);
  if (!unavailableReason) throw new Error("淘宝 MCP 详情不可用证据缺少原因。");
  return {
    ...detailEvidenceContext(context),
    status: "unavailable",
    tools_used: uniqueStrings(
      toolsUsed.filter((tool) => tool === "navigate_to_url" || tool === "read_page_content"),
      2
    ),
    unavailable_reason: unavailableReason
  };
}

export function normalizeTaobaoMcpProductDetailEvidence(raw, context) {
  const result = resultObject(raw);
  if (result.success === false) {
    throw new Error(asText(result.error ?? result.message) || "淘宝详情读取失败。");
  }
  const pageTitle = asText(result.title ?? result.pageTitle ?? result.page_title).replace(/\s+/g, " ").slice(0, 300);
  const pageUrl = asText(result.url ?? result.pageUrl ?? result.page_url).slice(0, 1000);
  const visibleText = asText(
    result.content ?? result.text ?? result.visibleText ?? result.visible_text
  ).replace(/\s+/g, " ");
  if (!pageTitle || !pageUrl || !visibleText) {
    throw new Error("淘宝 read_page_content 未返回完整的标题、URL 和可见正文。");
  }
  const displayedPriceTexts = uniqueStrings(
    visibleText.match(/(?:¥|￥)\s*\d+(?:\.\d{1,2})?/g) ?? [],
    5
  );
  const factTerms = uniqueStrings(
    (Array.isArray(context?.factTerms) ? context.factTerms : [])
      .filter((term) => typeof term === "string")
      .map((term) => term.slice(0, 40)),
    12
  );
  const matchedFacts = factTerms.filter((term) => visibleText.includes(term)).slice(0, 5);
  return {
    ...detailEvidenceContext(context),
    status: "verified",
    tools_used: ["navigate_to_url", "read_page_content"],
    summary: {
      page_title: pageTitle,
      page_url: pageUrl,
      visible_text_sha256: createHash("sha256").update(visibleText).digest("hex"),
      matched_facts: matchedFacts,
      // These are deliberately labelled as visible strings, not authoritative
      // SKU prices. Exact SKU pricing still requires explicit SKU selection.
      displayed_price_texts: displayedPriceTexts
    }
  };
}

export function taobaoCurrentTabUrl(raw) {
  const root = raw && typeof raw === "object" ? raw : {};
  const result = root.result && typeof root.result === "object" ? root.result : root;
  return typeof result.url === "string" ? result.url : "";
}

export function classifyTaobaoAuthentication(raw) {
  const root = raw && typeof raw === "object" ? raw : {};
  const result = root.result && typeof root.result === "object" ? root.result : root;
  const failureText = [result.error, result.message, result.url]
    .filter((value) => typeof value === "string")
    .join("\n");
  if (isTaobaoLoginError(failureText)) return "authentication_required";

  const url = taobaoCurrentTabUrl(raw);
  if (!url) return "unknown";
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const trustedTaobaoHost =
      hostname === "taobao.com" ||
      hostname.endsWith(".taobao.com") ||
      hostname === "tmall.com" ||
      hostname.endsWith(".tmall.com");
    if (!trustedTaobaoHost) return "unknown";
    const authenticationHost = hostname
      .split(".")
      .some((label) => label === "login" || label === "passport");
    if (
      authenticationHost ||
      /\/(?:login|signin)(?:[/?#]|$)/i.test(parsed.pathname)
    ) {
      return "authentication_required";
    }
    return "authenticated";
  } catch {
    return "unknown";
  }
}

export function normalizeTaobaoCartResult(raw, productId) {
  const result = resultObject(raw);
  if (result.success === true) {
    const selectedSku = Array.isArray(result.selectedSku)
      ? result.selectedSku
      : Array.isArray(result.selected_sku)
        ? result.selected_sku
        : [];
    return {
      success: true,
      message: typeof result.message === "string" ? result.message : "已加入淘宝购物车",
      product_id: productId,
      selected_spec: selectedSku.length > 0 ? selectedSku.map(asText).filter(Boolean).join(" / ") : undefined
    };
  }
  if (result.needsSkuSelection === true || result.needs_sku_selection === true) {
    return skuSelectionRequired(productId, availableSkuGroups(result), asText(result.message));
  }
  throw new Error(typeof result.error === "string" ? result.error : "淘宝 MCP 未确认加购成功。");
}

export function isTaobaoLoginError(value) {
  return /未登录|请先登录淘宝账号|已打开登录页面|(?:login|passport)(?:\.[a-z0-9-]+)*\.(?:taobao|tmall)\.com/i.test(String(value ?? ""));
}

function isAuthenticationFailureMessage(value) {
  return /\[auth_required\]|auth(?:entication)?[_ ]required/i.test(String(value ?? "")) ||
    isTaobaoLoginError(value);
}

export function createPendingAuthenticationFailure(job, error, createdAt = new Date().toISOString()) {
  const jobId = asText(job?.id);
  const jobType = asText(job?.job_type);
  const leaseToken = asText(job?.lease_token);
  const errorMessage = asText(error);
  if (!jobId || !AUTH_FAILURE_JOB_TYPES.has(jobType) || leaseToken.length < 16 || leaseToken.length > 200) {
    throw new Error("登录失败回调缺少有效的执行任务上下文。");
  }
  if (!isAuthenticationFailureMessage(errorMessage)) {
    throw new Error("登录失败回调必须包含可验证的 authentication_required 错误。");
  }
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error("登录失败回调时间无效。");
  }
  return {
    schema: PENDING_AUTH_FAILURE_SCHEMA,
    job_id: jobId,
    job_type: jobType,
    lease_token: leaseToken,
    error: errorMessage.slice(0, 1000),
    retryable: false,
    failure_kind: "authentication_required",
    created_at: createdAt
  };
}

export function parsePendingAuthenticationFailure(value) {
  const candidate = value && typeof value === "object" ? value : {};
  return createPendingAuthenticationFailure(
    {
      id: candidate.schema === PENDING_AUTH_FAILURE_SCHEMA ? candidate.job_id : "",
      job_type: candidate.job_type,
      lease_token: candidate.lease_token
    },
    candidate.error,
    candidate.created_at
  );
}

/**
 * One Worker can execute only one Taobao action at a time, so a single durable
 * callback slot is sufficient. The callback is written before its lease is
 * released and removed only after the API confirms `job.status === "failed"`.
 */
export class PendingAuthenticationFailureStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return parsePendingAuthenticationFailure(JSON.parse(raw));
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async syncParentDirectory() {
    let handle;
    try {
      handle = await fs.open(path.dirname(this.filePath), "r");
      await handle.sync();
    } catch (error) {
      if (!["EINVAL", "ENOTSUP", "EPERM"].includes(error?.code)) throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async save(callback) {
    const normalized = parsePendingAuthenticationFailure(callback);
    const directory = path.dirname(this.filePath);
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(normalized), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, this.filePath);
      await fs.chmod(this.filePath, 0o600);
      await this.syncParentDirectory();
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
    return normalized;
  }

  async clear(expectedJobId) {
    const current = await this.load();
    if (!current) return false;
    if (current.job_id !== expectedJobId) {
      throw new Error("拒绝清除不匹配的登录失败回调。");
    }
    await fs.unlink(this.filePath);
    await this.syncParentDirectory();
    return true;
  }
}

export async function deliverPendingAuthenticationFailure(store, report) {
  const callback = await store.load();
  if (!callback) return { state: "empty", callback: null };
  try {
    const response = await report(callback);
    if (
      response?.job?.id !== callback.job_id ||
      (
        response?.job?.status !== "failed" &&
        response?.authentication_failure_acknowledged !== true
      )
    ) {
      return {
        state: "pending",
        callback,
        error: "服务端尚未确认登录失败任务进入 failed 终态。"
      };
    }
    await store.clear(callback.job_id);
    return { state: "confirmed", callback, response };
  } catch (error) {
    return {
      state: "pending",
      callback,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function authenticationFailureWasAcknowledged(response, callback) {
  return response?.job?.id === callback.job_id && (
    response?.job?.status === "failed" ||
    response?.authentication_failure_acknowledged === true
  );
}

export class PendingAuthenticationFailureCoordinator {
  constructor(store) {
    this.store = store;
    this.pending = null;
  }

  async restore() {
    this.pending = await this.store.load();
    return this.pending;
  }

  hold(callback) {
    this.pending = parsePendingAuthenticationFailure(callback);
    return this.pending;
  }

  async current() {
    if (this.pending) return this.pending;
    this.pending = await this.store.load();
    return this.pending;
  }

  async persistHeld() {
    const callback = await this.current();
    if (!callback) return { persisted: true, callback: null };
    try {
      await this.store.save(callback);
      return { persisted: true, callback };
    } catch (error) {
      return {
        persisted: false,
        callback,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async deliver(report) {
    const callback = await this.current();
    if (!callback) return { state: "empty", callback: null, persisted: true };
    const persistence = await this.persistHeld();
    try {
      const response = await report(callback);
      if (!authenticationFailureWasAcknowledged(response, callback)) {
        return {
          state: "pending",
          callback,
          persisted: persistence.persisted,
          error: "服务端尚未确认登录失败回调已安全处理。"
        };
      }

      // Server acknowledgement is authoritative. Failure to remove a stale disk
      // copy is safe: a restart will pause and receive the same idempotent ACK.
      this.pending = null;
      let cleanupError;
      try {
        const stored = await this.store.load();
        if (stored?.job_id === callback.job_id && stored?.lease_token === callback.lease_token) {
          await this.store.clear(callback.job_id);
        }
      } catch (error) {
        cleanupError = error instanceof Error ? error.message : String(error);
      }
      return {
        state: "confirmed",
        callback,
        response,
        persisted: persistence.persisted,
        cleanup_error: cleanupError
      };
    } catch (error) {
      return {
        state: "pending",
        callback,
        persisted: persistence.persisted,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

export function createPendingResultAcknowledgement(job, result, createdAt = new Date().toISOString()) {
  const jobId = asText(job?.id);
  const jobType = asText(job?.job_type);
  const leaseToken = asText(job?.lease_token);
  if (
    !jobId || jobId.length > 200 ||
    !RESULT_ACKNOWLEDGEMENT_JOB_TYPES.has(jobType) ||
    leaseToken.length < 16 || leaseToken.length > 200
  ) {
    throw new Error("结果回调缺少有效的执行任务上下文。");
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("结果回调必须包含对象结果。");
  }
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error("结果回调时间无效。");
  }
  return {
    schema: PENDING_RESULT_ACKNOWLEDGEMENT_SCHEMA,
    job_id: jobId,
    job_type: jobType,
    lease_token: leaseToken,
    result,
    created_at: createdAt
  };
}

export function parsePendingResultAcknowledgement(value) {
  const candidate = value && typeof value === "object" ? value : {};
  return createPendingResultAcknowledgement(
    {
      id: candidate.schema === PENDING_RESULT_ACKNOWLEDGEMENT_SCHEMA ? candidate.job_id : "",
      job_type: candidate.job_type,
      lease_token: candidate.lease_token
    },
    candidate.result,
    candidate.created_at
  );
}

/**
 * A successful local operation and its server acknowledgement are two distinct
 * durability boundaries. This write-ahead record is fsynced before the Worker
 * releases the execution lease. It is removed only after an idempotent
 * `completed` response, or an explicit stale/superseded response.
 */
export class PendingResultAcknowledgementStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return parsePendingResultAcknowledgement(JSON.parse(raw));
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async syncParentDirectory() {
    let handle;
    try {
      handle = await fs.open(path.dirname(this.filePath), "r");
      await handle.sync();
    } catch (error) {
      if (!["EINVAL", "ENOTSUP", "EPERM"].includes(error?.code)) throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async save(callback) {
    const normalized = parsePendingResultAcknowledgement(callback);
    const directory = path.dirname(this.filePath);
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(normalized), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, this.filePath);
      await fs.chmod(this.filePath, 0o600);
      await this.syncParentDirectory();
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
    return normalized;
  }

  async clear(expectedJobId, expectedLeaseToken) {
    const current = await this.load();
    if (!current) return false;
    if (
      current.job_id !== expectedJobId ||
      current.lease_token !== expectedLeaseToken
    ) {
      throw new Error("拒绝清除不匹配的结果回调。");
    }
    await fs.unlink(this.filePath);
    await this.syncParentDirectory();
    return true;
  }
}

function resultAcknowledgementWasConfirmed(response, callback) {
  return response?.job?.id === callback.job_id && response?.job?.status === "completed";
}

export class PendingResultAcknowledgementCoordinator {
  constructor(store) {
    this.store = store;
    this.pending = null;
  }

  async restore() {
    this.pending = await this.store.load();
    return this.pending;
  }

  hold(callback) {
    const normalized = parsePendingResultAcknowledgement(callback);
    if (
      this.pending &&
      (
        this.pending.job_id !== normalized.job_id ||
        this.pending.lease_token !== normalized.lease_token
      )
    ) {
      throw new Error("已有另一个结果等待服务端确认，拒绝覆盖回调账本。");
    }
    this.pending = normalized;
    return this.pending;
  }

  async current() {
    if (this.pending) return this.pending;
    this.pending = await this.store.load();
    return this.pending;
  }

  async persistHeld() {
    const callback = await this.current();
    if (!callback) return { persisted: true, callback: null };
    try {
      await this.store.save(callback);
      return { persisted: true, callback };
    } catch (error) {
      return {
        persisted: false,
        callback,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async deliver(report, options = {}) {
    const callback = await this.current();
    if (!callback) return { state: "empty", callback: null, persisted: true };
    const persistence = await this.persistHeld();
    let response;
    try {
      response = await report(callback);
      if (!resultAcknowledgementWasConfirmed(response, callback)) {
        return {
          state: "pending",
          callback,
          persisted: persistence.persisted,
          error: "服务端尚未确认任务进入 completed 终态。"
        };
      }
    } catch (error) {
      if (options.isFatalError?.(error, callback)) throw error;
      if (!options.isDiscardableError?.(error, callback)) {
        return {
          state: "pending",
          callback,
          persisted: persistence.persisted,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }

    const discarded = !response;
    this.pending = null;
    let cleanupError;
    try {
      const stored = await this.store.load();
      if (
        stored?.job_id === callback.job_id &&
        stored?.lease_token === callback.lease_token
      ) {
        await this.store.clear(callback.job_id, callback.lease_token);
      }
    } catch (error) {
      cleanupError = error instanceof Error ? error.message : String(error);
    }
    return {
      state: discarded ? "discarded" : "confirmed",
      callback,
      response,
      persisted: persistence.persisted,
      cleanup_error: cleanupError
    };
  }
}

export function executorFailureDisposition({ authenticationRequired, leaseLost }) {
  // Authentication failure is durable evidence that the action must not be
  // replayed. It wins even when lease renewal failed at the same time: the
  // late callback path can safely terminalize the previously claimed Job.
  if (authenticationRequired) return "persist_authentication_failure";
  if (leaseLost) return "abandon_lost_lease";
  return "report_failure";
}
