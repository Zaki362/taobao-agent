import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { MCPAdapter, MCPToolName, MCPToolRequestMap, MCPToolResponseMap } from "@/lib/mcp/types";

const execFileAsync = promisify(execFile);
const HOME_DIR = homedir();
const QODERCLI_PATH = process.env.QODERCLI_PATH || `${HOME_DIR}/.local/bin/qodercli`;
const DEFAULT_TIMEOUT_MS = 120_000;
const SEARCH_TIMEOUT_MS = 95_000;
const DETAIL_TIMEOUT_MS = 180_000;
const SOURCE_APP = "Qoderwork";
const TAOBAO_CONFIG_PATH = `${HOME_DIR}/Library/Application Support/taobao/config.json`;
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

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
    `1. 先调用 taobao-native get_product_skus，参数只使用 itemId='${input.product_id}' 和 sourceApp='${SOURCE_APP}'。`,
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
