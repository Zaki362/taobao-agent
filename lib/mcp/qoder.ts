import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { MCPAdapter, MCPToolName, MCPToolRequestMap, MCPToolResponseMap } from "@/lib/mcp/types";

const execFileAsync = promisify(execFile);
const QODERCLI_PATH = process.env.QODERCLI_PATH || "/Users/guohuaz/.local/bin/qodercli";
const TAOBAO_NATIVE_PATH =
  process.env.TAOBAO_NATIVE_PATH || "/Users/guohuaz/Library/Application Support/taobao/cli/bin/taobao-native";
const DEFAULT_TIMEOUT_MS = 120_000;
const SEARCH_TIMEOUT_MS = 95_000;
const DETAIL_TIMEOUT_MS = 180_000;
const SOURCE_APP = "Qoderwork";
const TAOBAO_CONFIG_PATH = "/Users/guohuaz/Library/Application Support/taobao/config.json";
let qoderExecutionChain: Promise<void> = Promise.resolve();

function buildErrorMessage(error: unknown) {
  if (!error || typeof error !== "object") {
    return String(error);
  }
  const candidate = error as {
    message?: string;
    stderr?: string;
    stdout?: string;
    code?: string | number;
    signal?: string;
    killed?: boolean;
  };
  const parts = [candidate.message, candidate.stderr, candidate.stdout].filter(Boolean).map((item) => String(item).trim());

  if (candidate.code === "ETIMEDOUT" || candidate.killed) {
    parts.unshift("Qoder CLI 执行超时。淘宝搜索/详情提取仍未在限定时间内完成。");
  }

  if (candidate.signal) {
    parts.push(`signal=${candidate.signal}`);
  }

  return parts.join("\n").trim();
}

async function runQoder(args: string[], timeout = DEFAULT_TIMEOUT_MS) {
  return execFileAsync(QODERCLI_PATH, args, {
    env: process.env,
    timeout,
    maxBuffer: 1024 * 1024 * 8
  });
}

async function runLocal(command: string, args: string[], timeout = 30_000) {
  return execFileAsync(command, args, {
    env: process.env,
    timeout,
    maxBuffer: 1024 * 1024 * 8
  });
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function stableId(prefix: string, input: string) {
  const digest = createHash("sha1").update(input).digest("hex").slice(0, 10);
  return `${prefix}-${digest}`;
}

function workspaceResultPath(prefix: string, input: string) {
  return `${process.cwd()}/.data/qoder/${stableId(prefix, input)}.json`;
}

function inlineArgs(payload: Record<string, unknown>) {
  return JSON.stringify(payload);
}

function parseEmbeddedJson(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function extractCliPayload(text: string) {
  const parsed = parseEmbeddedJson(text);
  if (!parsed || typeof parsed !== "object") {
    return parsed;
  }

  const record = parsed as { result?: unknown; error?: unknown };
  return record.result ?? parsed;
}

function extractCliError(text: string) {
  const parsed = parseEmbeddedJson(text);
  if (parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string") {
    return (parsed as { error: string }).error;
  }

  return text.trim();
}

function normalizeImageUrl(value: unknown) {
  if (typeof value !== "string" || value.length === 0) {
    return "";
  }
  return value.replace(/_\.webp$/, "");
}

function normalizeDetailUrl(productId: string, rawUrl?: string) {
  if (!productId) {
    return rawUrl ?? "";
  }

  const sourceUrl = rawUrl ?? "";

  if (sourceUrl && (sourceUrl.includes("item.taobao.com") || sourceUrl.includes("detail.tmall.com"))) {
    return sourceUrl;
  }

  const looksLikeTmall =
    Boolean(sourceUrl) &&
    (sourceUrl.includes("tmall") ||
      sourceUrl.includes("detail.tmall.com") ||
      sourceUrl.includes("skuId=") ||
      sourceUrl.includes("%2F%2Fdetail.tmall.com") ||
      sourceUrl.includes("%2Fdetail.tmall.com"));

  return looksLikeTmall
    ? `https://detail.tmall.com/item.htm?id=${productId}`
    : `https://item.taobao.com/item.htm?id=${productId}`;
}

const SEARCH_RESULT_FALLBACK_PATH = `${process.cwd()}/search_result.json`;

async function loadSearchFallback(startedAt: number, keyword: string) {
  try {
    const fileStat = await stat(SEARCH_RESULT_FALLBACK_PATH);
    const raw = await readFile(SEARCH_RESULT_FALLBACK_PATH, "utf-8");
    const payload = parseEmbeddedJson(raw) as
      | {
          result?: {
            keyword?: string;
            products?: Array<{
              itemId?: string | number;
              title?: string;
              price?: string | number;
              shopName?: string;
              image?: string;
              productUrl?: string;
              shopTags?: string[];
              sellingPoints?: string[];
            }>;
          };
        }
      | null;

    const resultKeyword = String(payload?.result?.keyword ?? "").trim();
    const normalizedKeyword = keyword.trim();
    const fileAgeMs = Date.now() - fileStat.mtimeMs;
    const isFreshForThisRun = fileStat.mtimeMs + 1_000 >= startedAt;
    const isRecentKeywordMatch =
      normalizedKeyword.length > 0 &&
      resultKeyword === normalizedKeyword &&
      fileAgeMs <= 10 * 60 * 1000;

    if (!isFreshForThisRun && !isRecentKeywordMatch) {
      return null;
    }

    const products = payload?.result?.products;
    if (!Array.isArray(products) || products.length === 0) {
      return null;
    }

    return {
      results: products
        .map((product) => {
          const productId = String(product.itemId ?? "").trim();
          if (!productId) {
            return null;
          }

          const numericPrice =
            typeof product.price === "number"
              ? product.price
              : Number.parseFloat(String(product.price ?? "0").replace(/[^\d.]/g, "")) || 0;

          return {
            product_id: productId,
            title: product.title?.trim() || "淘宝商品",
            price: numericPrice,
            shop_name: product.shopName?.trim() || "淘宝店铺",
            image_url: normalizeImageUrl(product.image),
            detail_url: normalizeDetailUrl(productId, product.productUrl),
            shop_badges: Array.isArray(product.shopTags) ? product.shopTags.filter(Boolean) : [],
            highlights: Array.isArray(product.sellingPoints) ? product.sellingPoints.filter(Boolean) : []
          };
        })
        .filter(Boolean)
    };
  } catch {
    return null;
  }
}

async function waitForSearchFallback(startedAt: number, keyword: string) {
  const waitPlan = [0, 1_500, 3_000];
  for (const waitMs of waitPlan) {
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    const fallback = await loadSearchFallback(startedAt, keyword);
    if (fallback) {
      return fallback;
    }
  }
  return null;
}

function isToolNotReadyMessage(message: string) {
  return (
    message.includes("Tool 执行层未就绪") ||
    message.includes("请确保应用已加载完成") ||
    message.includes("连接失败")
  );
}

async function ensureQoderDataDir() {
  await mkdir(`${process.cwd()}/.data/qoder`, { recursive: true });
}

async function launchTaobaoApp() {
  try {
    await runLocal(
      TAOBAO_NATIVE_PATH,
      ["launch", "--args", inlineArgs({ sourceApp: SOURCE_APP })],
      15_000
    );
    return;
  } catch {
    // Fall through to macOS app launch fallback.
  }

  try {
    await runLocal("open", ["-a", "/Applications/淘宝桌面版.app"], 15_000);
  } catch {
    // Best effort only.
  }
}

async function callTaobaoNative(
  tool: string,
  args: Record<string, unknown>,
  outputPath?: string,
  timeout = 30_000
) {
  await ensureQoderDataDir();

  const payload = inlineArgs({
    ...args,
    sourceApp: SOURCE_APP
  });

  const cliArgs = [tool, "--args", payload];
  if (outputPath) {
    cliArgs.push("-o", outputPath);
  }

  let stdout = "";
  let stderr = "";

  try {
    const response = await runLocal(TAOBAO_NATIVE_PATH, cliArgs, timeout);
    stdout = response.stdout ?? "";
    stderr = response.stderr ?? "";
  } catch (error) {
    const candidate = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    stdout = candidate.stdout ?? "";
    stderr = candidate.stderr ?? "";
    const combinedError = `${stdout}\n${stderr}\n${candidate.message ?? ""}`.trim();
    const parsedError = extractCliError(combinedError);
    throw new Error(parsedError || buildErrorMessage(error));
  }

  const combined = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
  const parsedError = extractCliError(combined);

  if (parsedError && parsedError !== combined && isToolNotReadyMessage(parsedError)) {
    throw new Error(parsedError);
  }

  if (combined.includes("\"error\"")) {
    const embedded = extractCliError(combined);
    if (embedded) {
      throw new Error(embedded);
    }
  }

  if (outputPath) {
    const fileText = await readFile(outputPath, "utf8");
    return extractCliPayload(fileText);
  }

  return extractCliPayload(combined);
}

async function callTaobaoNativeWithRetry(
  tool: string,
  args: Record<string, unknown>,
  options?: {
    outputPath?: string;
    timeout?: number;
    waitMs?: number[];
    relaunchOnRetry?: boolean;
  }
) {
  const waitPlan = options?.waitMs ?? [0, 4_000, 8_000];
  let lastError: unknown = null;

  for (let index = 0; index < waitPlan.length; index += 1) {
    const waitMs = waitPlan[index] ?? 0;
    if (index > 0 && options?.relaunchOnRetry) {
      await launchTaobaoApp();
    }
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    try {
      return await callTaobaoNative(tool, args, options?.outputPath, options?.timeout);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!isToolNotReadyMessage(message) || index === waitPlan.length - 1) {
        throw error;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function chooseSkuValues(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const record = payload as {
    hasSku?: boolean;
    allSelected?: boolean;
    availableSkus?: Array<{
      label?: string;
      options?: Array<{
        text?: string;
        disabled?: boolean;
        selected?: boolean;
      }>;
    }>;
  };

  if (record.hasSku === false || record.allSelected === true) {
    return [];
  }

  const groups = Array.isArray(record.availableSkus) ? record.availableSkus : [];
  return groups
    .map((group) => {
      const options = Array.isArray(group.options) ? group.options : [];
      const selected = options.find((option) => option?.selected && !option?.disabled && typeof option.text === "string");
      if (selected?.text) {
        return selected.text;
      }
      const firstAvailable = options.find((option) => !option?.disabled && typeof option.text === "string");
      return firstAvailable?.text ?? null;
    })
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

function extractTextBlob(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }
  if (Array.isArray(payload)) {
    return payload.map((item) => extractTextBlob(item)).filter(Boolean).join("\n");
  }
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const record = payload as Record<string, unknown>;
  return Object.values(record)
    .map((value) => extractTextBlob(value))
    .filter(Boolean)
    .join("\n");
}

function parseShopName(text: string) {
  const match = text.match(/([^\s\n]{1,40}(?:旗舰店|专卖店|专营店|企业店|官方店|店铺))/);
  return match?.[1] ?? "淘宝店铺";
}

function parsePrice(text: string) {
  const match = text.match(/(?:¥|￥)\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!match?.[1]) {
    return 0;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : 0;
}

function parseImageUrl(text: string) {
  const match = text.match(/https?:\/\/[^\s"'<>]+(?:alicdn\.com|gw\.alicdn\.com)[^\s"'<>]+/);
  return normalizeImageUrl(match?.[0] ?? "");
}

function parseHighlights(text: string) {
  const candidates = [
    "夜视",
    "前后双录",
    "停车监控",
    "真空吸附",
    "磁吸",
    "防抖",
    "免走线",
    "高清",
    "4K",
    "旋转",
    "Magsafe"
  ];
  return candidates.filter((item) => text.includes(item)).slice(0, 4);
}

function buildRiskNotes(text: string, price: number) {
  const notes: string[] = [];
  if (price <= 0) {
    notes.push("未从详情页稳定提取到价格，建议打开淘宝详情页再次确认");
  }
  if (text.includes("仅开放部分用户使用")) {
    notes.push("当前页面命中了受限或灰度页面，建议更换同款商品再试");
  }
  if (text.includes("广告") || text.includes("推广")) {
    notes.push("当前可能来自广告落地页，建议以详情页最终规格信息为准");
  }
  return notes;
}

async function runDirectExtractProductInfo(input: MCPToolRequestMap["extract_product_info"]) {
  const target = normalizeDetailUrl(input.product_id, input.detail_url);
  const contentPath = workspaceResultPath("detail", input.product_id);

  await callTaobaoNativeWithRetry(
    "navigate_to_url",
    {
      url: target
    },
    {
      waitMs: [0, 4_000, 8_000]
    }
  );
  await sleep(3_000);

  const payload = await callTaobaoNativeWithRetry(
    "read_page_content",
    {},
    {
      outputPath: contentPath,
      timeout: 45_000,
      waitMs: [0, 3_000]
    }
  );

  const text = extractTextBlob(payload);
  const price = parsePrice(text);
  const shopName = parseShopName(text);
  const imageUrl = parseImageUrl(text);
  const highlights = parseHighlights(text);
  const riskNotes = buildRiskNotes(text, price);

  return {
    product_id: input.product_id,
    title: input.title ?? "商品详情",
    price,
    shop_name: shopName,
    image_url: imageUrl,
    detail_url: target,
    shop_badges: shopName.includes("旗舰店") ? ["旗舰店"] : [],
    highlights,
    risk_notes: riskNotes.length > 0 ? riskNotes : ["详情页已读取，建议确认最终规格与适配性"]
  } satisfies MCPToolResponseMap["extract_product_info"];
}

async function runDirectAddToCart(input: MCPToolRequestMap["add_to_cart"]) {
  const itemId = input.product_id;
  const skuPath = workspaceResultPath("sku", itemId);
  const target = normalizeDetailUrl(itemId, input.detail_url);

  if (target) {
    await callTaobaoNativeWithRetry("navigate_to_url", {
      url: target
    });
    await sleep(3_000);
  }

  const skuPayload = await callTaobaoNativeWithRetry(
    "get_product_skus",
    {
      itemId
    },
    {
      outputPath: skuPath
    }
  );

  const selectedSku = chooseSkuValues(skuPayload);
  const addPayload = await callTaobaoNativeWithRetry("add_to_cart", {
    itemId,
    ...(selectedSku.length ? { sku: selectedSku } : {})
  });

  const result = (addPayload ?? {}) as {
    success?: boolean;
    message?: string;
    error?: string;
  };

  if (result.success) {
    return {
      success: true,
      message: typeof result.message === "string" && result.message.length > 0 ? result.message : "已加入购物车",
      product_id: itemId
    } satisfies MCPToolResponseMap["add_to_cart"];
  }

  throw new Error(
    typeof result.error === "string"
      ? result.error
      : typeof result.message === "string" && result.message.length > 0
        ? result.message
        : "加入购物车失败"
  );
}

async function runDirectSearch(input: MCPToolRequestMap["search_taobao_products"]) {
  const resultPath = workspaceResultPath("search", `${input.module_id}-${input.keyword}`);
  const payload = await callTaobaoNativeWithRetry(
    "search_products",
    {
      keyword: input.keyword
    },
    {
      outputPath: resultPath,
      timeout: 60_000,
      waitMs: [0, 5_000, 10_000]
    }
  );

  const products =
    (payload &&
    typeof payload === "object" &&
    Array.isArray((payload as { products?: unknown[] }).products)
      ? (payload as { products: unknown[] }).products
      : payload &&
          typeof payload === "object" &&
          typeof (payload as { result?: unknown }).result === "object" &&
          Array.isArray((((payload as { result?: { products?: unknown[] } }).result) ?? {}).products)
        ? ((((payload as { result: { products: unknown[] } }).result) ?? {}).products)
        : []) ?? [];

  return {
    results: products
      .map((item) => {
        if (!item || typeof item !== "object") {
          return null;
        }

        const record = item as {
          itemId?: unknown;
          title?: unknown;
          price?: unknown;
          shopName?: unknown;
          image?: unknown;
          productUrl?: unknown;
        };

        const productId = typeof record.itemId === "string" ? record.itemId : "";
        const title = typeof record.title === "string" ? record.title : "";
        const detailUrl = typeof record.productUrl === "string" ? record.productUrl : "";

        if (!productId || !title || !detailUrl) {
          return null;
        }

        const priceValue =
          typeof record.price === "number"
            ? record.price
            : typeof record.price === "string"
              ? Number(record.price)
              : 0;

        return {
          product_id: productId,
          title,
          price: Number.isFinite(priceValue) ? priceValue : 0,
          shop_name: typeof record.shopName === "string" ? record.shopName : "淘宝店铺",
          image_url: normalizeImageUrl(record.image),
          detail_url: normalizeDetailUrl(productId, detailUrl),
          shop_badges: [],
          highlights: []
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .slice(0, 10)
  } satisfies MCPToolResponseMap["search_taobao_products"];
}

async function runDirectOpenDetail(input: MCPToolRequestMap["open_product_detail"]) {
  const target = normalizeDetailUrl(input.product_id, input.detail_url);
  await callTaobaoNativeWithRetry(
    "navigate_to_url",
    {
      url: target
    },
    {
      waitMs: [0, 4_000, 8_000]
    }
  );

  return {
    opened: true,
    product_id: input.product_id
  } satisfies MCPToolResponseMap["open_product_detail"];
}

function parseJsonObject(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Qoder CLI 未返回内容。");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error(`Qoder CLI 返回不是有效 JSON：${trimmed.slice(0, 300)}`);
  }
}

function extractTextFromJsonEnvelope(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as {
    type?: string;
    message?: {
      content?: Array<{
        type?: string;
        text?: string;
      }>;
    };
  };

  if (record.type !== "result") {
    return null;
  }

  const content = record.message?.content;
  if (!Array.isArray(content)) {
    return null;
  }

  const textBlock = content.find((item) => item?.type === "text" && typeof item.text === "string");
  return textBlock?.text ?? null;
}

function parseQoderResult(stdout: string) {
  const envelope = parseJsonObject(stdout);
  const extractedText = extractTextFromJsonEnvelope(envelope);
  if (typeof extractedText === "string") {
    return parseJsonObject(extractedText);
  }
  return envelope;
}

async function runPrompt(
  prompt: string,
  timeout = DEFAULT_TIMEOUT_MS,
  maxTurns = 6,
  options?: {
    fallbackLoader?: (startedAt: number) => Promise<unknown | null>;
  }
) {
  const task = async () => {
    const startedAt = Date.now();
    try {
      const { stdout } = await runQoder([
        "-p",
        prompt,
        "-q",
        "--yolo",
        "--allowed-tools",
        "Skill,Bash,Read",
        "--max-turns",
        String(maxTurns),
        "-f",
        "text"
      ], timeout);
      return parseQoderResult(stdout);
    } catch (error) {
      const fallback = await options?.fallbackLoader?.(startedAt);
      if (fallback) {
        return fallback;
      }
      throw new Error(buildErrorMessage(error));
    }
  };

  const execution = qoderExecutionChain.then(task, task);
  qoderExecutionChain = execution.then(() => undefined, () => undefined);
  return execution;
}

async function probeQoder() {
  try {
    const { stdout, stderr } = await runQoder(["--version"]);
    return `${stdout}\n${stderr}`.trim();
  } catch (error) {
    throw new Error(buildErrorMessage(error));
  }
}

function searchPrompt(input: MCPToolRequestMap["search_taobao_products"]) {
  return [
    "你是一个淘宝购物执行器。",
    "请使用你当前已经安装并可用的淘宝 skill / 工具能力执行真实搜索，不要编造数据。",
    "不要使用 Edit 工具，不要手动创建或改写 search_result.json。",
    "如果需要落盘，请只通过 Bash 调用工具自带的 -o 输出文件能力。",
    `搜索词：${input.keyword}`,
    `模块ID：${input.module_id}`,
    "返回最多 10 条最相关商品。",
    "只返回严格 JSON，格式如下：",
    JSON.stringify(
      {
        results: [
          {
            product_id: "string",
            title: "string",
            price: 0,
            shop_name: "string",
            image_url: "string",
            detail_url: "string",
            shop_badges: ["string"],
            highlights: ["string"]
          }
        ]
      },
      null,
      2
    )
  ].join("\n");
}

function addToCartPrompt(input: MCPToolRequestMap["add_to_cart"]) {
  return [
    "你是一个淘宝加入购物车执行器。",
    "请使用你当前已经安装并可用的淘宝 skill / 工具能力完成真实加购，不要编造结果。",
    "不要使用 Edit 工具。",
    "禁止调用 navigate_to_url、禁止先打开商品详情页、禁止依赖 detail_url 跳转页面。",
    "必须只通过 itemId 走工具链：先 get_product_skus，再 add_to_cart。",
    `已确认执行：${input.confirmed ? "是" : "否"}。数量：${input.quantity ?? 1}。`,
    `商品ID：${input.product_id}。商品标题参考：${input.title ?? "未提供"}。`,
    "执行要求：",
    `1. 先调用 taobao-native get_product_skus，参数只使用 itemId='${input.product_id}' 和 sourceApp='Qoderwork'。`,
    "2. 如果 hasSku=false 或 allSelected=true，则直接调用 taobao-native add_to_cart，仅传 itemId 和 sourceApp。",
    "3. 如果存在 SKU，则从 get_product_skus 返回中选择默认已选规格；若没有默认项，则为每个维度选择第一个可选值。",
    "4. 然后调用 taobao-native add_to_cart，传入 itemId、完整 sku 数组、sourceApp。",
    "5. 不要额外搜索，不要打开详情页，不要做任何页面导航。",
    "不要输出解释，不要要求用户继续操作。",
    "最终只返回严格 JSON：",
    JSON.stringify(
      {
        success: true,
        message: "已加入购物车",
        product_id: input.product_id
      },
      null,
      2
    )
  ].join("\n");
}

async function detectQoderReadiness() {
  try {
    const output = await probeQoder();
    const permissionState = await readTaobaoPermissionState();

    if (output.includes("User not logged in")) {
      return {
        available: false,
        message: "Qoder CLI 尚未登录。请先运行 qodercli /login 或配置 QODER_PERSONAL_ACCESS_TOKEN。",
        permissions_scope: ["未登录 Qoder CLI"]
      };
    }

    if (permissionState && permissionState.mcpEnabled && permissionState.mcpAiAppsAuthorized && !permissionState.mcpOrderEnabled) {
      return {
        available: true,
        message: "Qoder CLI 已就绪，但淘宝桌面版未开启订单/加购权限。当前可执行搜索与详情读取，加购会被系统拦截以避免拉起登录页。",
        permissions_scope: ["淘宝搜索", "详情提取", "订单/加购权限未开启"]
      };
    }

    return {
      available: true,
      message: "Qoder CLI 已就绪。当前将通过已安装的 Qoder skill / 工具能力执行淘宝任务。",
      permissions_scope: ["淘宝搜索", "详情提取", "加入购物车需显式确认"]
    };
  } catch (error) {
    const message = buildErrorMessage(error);
    if (message.includes("User not logged in")) {
      return {
        available: false,
        message: "Qoder CLI 尚未登录。请先运行 qodercli /login 或配置 QODER_PERSONAL_ACCESS_TOKEN。",
        permissions_scope: ["未登录 Qoder CLI"]
      };
    }

    if (message.includes("operation not permitted")) {
      return {
        available: true,
        message: "Qoder CLI 已安装，但当前环境无法完整探测其本地工作目录权限。实际执行能力将在真实运行时验证。",
        permissions_scope: ["Qoder CLI 探测受限"]
      };
    }

    return {
      available: false,
      message: message || "Qoder CLI 不可用。",
      permissions_scope: ["Qoder CLI 未就绪"]
    };
  }
}

async function readTaobaoPermissionState() {
  try {
    const raw = await readFile(TAOBAO_CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as {
      mcpEnabled?: boolean;
      mcpOrderEnabled?: boolean;
      mcpChatEnabled?: boolean;
      mcpAiAppsAuthorized?: boolean;
    };

    return {
      mcpEnabled: Boolean(parsed.mcpEnabled),
      mcpOrderEnabled: Boolean(parsed.mcpOrderEnabled),
      mcpChatEnabled: Boolean(parsed.mcpChatEnabled),
      mcpAiAppsAuthorized: Boolean(parsed.mcpAiAppsAuthorized)
    };
  } catch {
    return null;
  }
}

async function assertOrderPermissionEnabled() {
  const permissionState = await readTaobaoPermissionState();
  if (!permissionState) {
    return;
  }

  if (!permissionState.mcpEnabled || !permissionState.mcpAiAppsAuthorized || !permissionState.mcpOrderEnabled) {
    throw new Error(
      "淘宝桌面版当前未开启订单/加购权限（mcpOrderEnabled=false 或 AI 应用未完成订单授权）。已阻止本次加购，避免再次拉起登录页。请在淘宝桌面版 AI 设置中开启订单权限后重试。"
    );
  }
}

export const qoderMcpAdapter: MCPAdapter = {
  mode: "qoder_cli",
  async detect() {
    return detectQoderReadiness();
  },
  async run<T extends MCPToolName>(tool: T, input: MCPToolRequestMap[T]): Promise<MCPToolResponseMap[T]> {
    if (tool === "search_taobao_products") {
      return (await runPrompt(
        searchPrompt(input as MCPToolRequestMap["search_taobao_products"]),
        SEARCH_TIMEOUT_MS,
        6,
        {
          fallbackLoader: (startedAt) =>
            waitForSearchFallback(
              startedAt,
              (input as MCPToolRequestMap["search_taobao_products"]).keyword
            )
        }
      )) as unknown as MCPToolResponseMap[T];
    }
    if (tool === "open_product_detail") {
      return (await runPrompt(
        [
          "请使用你当前在 Qoder 中已经安装好的淘宝 skill 打开指定商品详情页。",
          "不要解释，只返回严格 JSON。",
          `商品ID：${(input as MCPToolRequestMap["open_product_detail"]).product_id}`,
          `详情链接：${(input as MCPToolRequestMap["open_product_detail"]).detail_url}`,
          JSON.stringify({
            opened: true,
            product_id: (input as MCPToolRequestMap["open_product_detail"]).product_id
          }, null, 2)
        ].join("\n"),
        60_000,
        4
      )) as unknown as MCPToolResponseMap[T];
    }
    if (tool === "extract_product_info") {
      return (await runPrompt(
        [
          "你是一个淘宝商品详情信息提取器。",
          "必须使用你当前在 Qoder 中已经安装好的淘宝 skill / 工具能力打开并读取详情页。",
          "不要直接调用本地 taobao-native CLI。",
          `商品ID：${(input as MCPToolRequestMap["extract_product_info"]).product_id}`,
          `商品标题参考：${(input as MCPToolRequestMap["extract_product_info"]).title ?? "未提供"}`,
          `详情链接：${(input as MCPToolRequestMap["extract_product_info"]).detail_url ?? ""}`,
          "只返回严格 JSON。",
          JSON.stringify({
            product_id: (input as MCPToolRequestMap["extract_product_info"]).product_id,
            title: (input as MCPToolRequestMap["extract_product_info"]).title ?? "商品详情",
            price: 0,
            shop_name: "string",
            image_url: "string",
            detail_url: (input as MCPToolRequestMap["extract_product_info"]).detail_url ?? "",
            shop_badges: ["string"],
            highlights: ["string"],
            risk_notes: ["string"]
          }, null, 2)
        ].join("\n"),
        DETAIL_TIMEOUT_MS,
        5
      )) as unknown as MCPToolResponseMap[T];
    }
    if (tool === "add_to_cart") {
      await assertOrderPermissionEnabled();
      return (await runPrompt(
        addToCartPrompt(input as MCPToolRequestMap["add_to_cart"]),
        DETAIL_TIMEOUT_MS,
        5
      )) as unknown as MCPToolResponseMap[T];
    }

    throw new Error(`Qoder CLI adapter 不支持工具：${tool}`);
  }
};
