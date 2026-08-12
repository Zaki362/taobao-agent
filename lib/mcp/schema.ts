import {
  MCPToolDefinition,
  MCPToolName,
  MCPToolRequestMap,
  MCPToolResponseMap,
  ProductInfoResult,
  SearchResultItem
} from "@/lib/mcp/types";

export const mcpToolDefinitions: MCPToolDefinition[] = [
  {
    name: "search_taobao_products",
    description: "在淘宝侧根据关键词搜索商品列表。",
    risk_level: "low",
    requires_confirmation: false
  },
  {
    name: "open_product_detail",
    description: "打开指定商品详情页，用于后续浏览与详情抽取。",
    risk_level: "low",
    requires_confirmation: false
  },
  {
    name: "extract_product_info",
    description: "从商品详情页提取标题、价格、卖点与风险信息。",
    risk_level: "low",
    requires_confirmation: false
  },
  {
    name: "add_to_cart",
    description: "将指定商品加入购物车，高风险动作需要显式确认。",
    risk_level: "high",
    requires_confirmation: true
  }
];

export function getMcpToolDefinition(name: string) {
  return mcpToolDefinitions.find((tool) => tool.name === name);
}

export function isMcpToolName(name: string): name is MCPToolName {
  return Boolean(getMcpToolDefinition(name));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireTextField(source: Record<string, unknown>, field: string) {
  const value = source[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function optionalTextField(source: Record<string, unknown>, field: string) {
  const value = source[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalQuantity(source: Record<string, unknown>) {
  const value = source.quantity;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.min(99, Math.floor(value)));
}

function normalizeText(value: unknown, fallback = "", maxLength = 240) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : fallback;
  return text.slice(0, maxLength);
}

function normalizeStringArray(value: unknown, maxItems = 6, maxLength = 32) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => normalizeText(item, "", maxLength))
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index)
    .slice(0, maxItems);
}

function normalizePrice(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Number(value.toFixed(2)));
  }

  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^\d.]/g, ""));
    if (Number.isFinite(parsed)) {
      return Math.max(0, Number(parsed.toFixed(2)));
    }
  }

  return 0;
}

function productIdFromUrl(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }

  const match = value.match(/[?&]id=(\d+)/);
  return match?.[1] ?? "";
}

function normalizeSearchResultItem(value: unknown, index: number): SearchResultItem | null {
  if (!isRecord(value)) {
    return null;
  }

  const productId = normalizeText(value.product_id, productIdFromUrl(value.detail_url), 80);
  const title = normalizeText(value.title, "", 160);

  if (!productId || !title) {
    return null;
  }

  const detailUrl =
    normalizeText(value.detail_url, "", 600) || `https://item.taobao.com/item.htm?id=${productId}`;

  return {
    product_id: productId,
    title,
    price: normalizePrice(value.price),
    shop_name: normalizeText(value.shop_name, "淘宝店铺", 80) || "淘宝店铺",
    image_url: normalizeText(value.image_url, "", 600),
    detail_url: detailUrl,
    shop_badges: normalizeStringArray(value.shop_badges, 4, 20),
    highlights: normalizeStringArray(value.highlights, 6, 28)
  };
}

function dedupeSearchResults(results: SearchResultItem[]) {
  const seen = new Set<string>();
  return results.filter((item) => {
    if (seen.has(item.product_id)) {
      return false;
    }
    seen.add(item.product_id);
    return true;
  });
}

function normalizeProductInfo(
  output: unknown,
  input?: MCPToolRequestMap["extract_product_info"]
): ProductInfoResult {
  const source = isRecord(output) ? output : {};
  const productId = normalizeText(source.product_id, input?.product_id ?? productIdFromUrl(input?.detail_url), 80);
  const title = normalizeText(source.title, input?.title ?? "", 180);

  if (!productId || !title) {
    throw new Error("MCP extract_product_info output is missing product_id or title");
  }

  return {
    product_id: productId,
    title,
    price: normalizePrice(source.price),
    shop_name: normalizeText(source.shop_name, "淘宝店铺", 80) || "淘宝店铺",
    image_url: normalizeText(source.image_url, "", 600),
    detail_url:
      normalizeText(source.detail_url, input?.detail_url ?? "", 600) ||
      `https://item.taobao.com/item.htm?id=${productId}`,
    shop_badges: normalizeStringArray(source.shop_badges, 4, 20),
    highlights: normalizeStringArray(source.highlights, 6, 28),
    risk_notes: normalizeStringArray(source.risk_notes, 6, 40)
  };
}

export function validateMcpToolInput<T extends MCPToolName>(
  toolName: T,
  input: unknown
): MCPToolRequestMap[T] {
  if (!isRecord(input)) {
    throw new Error("input must be an object");
  }

  if (toolName === "search_taobao_products") {
    return {
      keyword: requireTextField(input, "keyword").slice(0, 80),
      module_id: requireTextField(input, "module_id").slice(0, 80)
    } as MCPToolRequestMap[T];
  }

  if (toolName === "open_product_detail") {
    return {
      product_id: requireTextField(input, "product_id").slice(0, 80),
      detail_url: optionalTextField(input, "detail_url")
    } as MCPToolRequestMap[T];
  }

  if (toolName === "extract_product_info") {
    return {
      product_id: requireTextField(input, "product_id").slice(0, 80),
      title: optionalTextField(input, "title"),
      detail_url: optionalTextField(input, "detail_url")
    } as MCPToolRequestMap[T];
  }

  return {
    product_id: requireTextField(input, "product_id").slice(0, 80),
    title: optionalTextField(input, "title"),
    detail_url: optionalTextField(input, "detail_url"),
    quantity: optionalQuantity(input),
    confirmed: input.confirmed === true
  } as MCPToolRequestMap[T];
}

export function validateMcpToolOutput<T extends MCPToolName>(
  toolName: T,
  output: unknown,
  input?: MCPToolRequestMap[T]
): MCPToolResponseMap[T] {
  if (toolName === "search_taobao_products") {
    if (!isRecord(output) || !Array.isArray(output.results)) {
      throw new Error("MCP search_taobao_products output must contain a results array");
    }

    const results = output.results
      .map((item, index) => normalizeSearchResultItem(item, index))
      .filter((item): item is SearchResultItem => Boolean(item));

    return {
      results: dedupeSearchResults(results).slice(0, 20)
    } as MCPToolResponseMap[T];
  }

  if (toolName === "open_product_detail") {
    const source = isRecord(output) ? output : {};
    const openInput = input as MCPToolRequestMap["open_product_detail"] | undefined;
    const productId = normalizeText(source.product_id, openInput?.product_id ?? productIdFromUrl(openInput?.detail_url), 80);

    if (!productId) {
      throw new Error("MCP open_product_detail output is missing product_id");
    }

    return {
      opened: source.opened !== false,
      product_id: productId
    } as MCPToolResponseMap[T];
  }

  if (toolName === "extract_product_info") {
    return normalizeProductInfo(
      output,
      input as MCPToolRequestMap["extract_product_info"] | undefined
    ) as MCPToolResponseMap[T];
  }

  const source = isRecord(output) ? output : {};
  const cartInput = input as MCPToolRequestMap["add_to_cart"] | undefined;
  const productId = normalizeText(source.product_id, cartInput?.product_id ?? productIdFromUrl(cartInput?.detail_url), 80);

  if (!productId) {
    throw new Error("MCP add_to_cart output is missing product_id");
  }

  return {
    success: source.success === true,
    message: normalizeText(source.message, source.success === true ? "已加入购物车" : "加购未完成", 160),
    product_id: productId,
    selected_spec: normalizeText(source.selected_spec, "", 80) || undefined,
    demo_fallback: source.demo_fallback === true
  } as MCPToolResponseMap[T];
}
