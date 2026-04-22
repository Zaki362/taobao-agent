import { MCPToolDefinition } from "@/lib/mcp/types";

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
