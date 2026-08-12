export interface MCPToolRequestMap {
  search_taobao_products: {
    keyword: string;
    module_id: string;
  };
  open_product_detail: {
    product_id: string;
    detail_url?: string;
  };
  extract_product_info: {
    product_id: string;
    title?: string;
    detail_url?: string;
  };
  add_to_cart: {
    product_id: string;
    title?: string;
    detail_url?: string;
    quantity?: number;
    confirmed: boolean;
  };
}

export interface SearchResultItem {
  product_id: string;
  title: string;
  price: number;
  shop_name: string;
  image_url: string;
  detail_url: string;
  shop_badges: string[];
  highlights: string[];
}

export interface ProductInfoResult extends SearchResultItem {
  risk_notes: string[];
}

export interface MCPToolResponseMap {
  search_taobao_products: {
    results: SearchResultItem[];
  };
  open_product_detail: {
    opened: boolean;
    product_id: string;
  };
  extract_product_info: ProductInfoResult;
  add_to_cart: {
    success: boolean;
    message: string;
    product_id: string;
    selected_spec?: string;
    demo_fallback?: boolean;
  };
}

export type MCPToolName = keyof MCPToolRequestMap;

export interface MCPToolDefinition {
  name: MCPToolName;
  description: string;
  risk_level: "low" | "medium" | "high";
  requires_confirmation: boolean;
}

export interface MCPAdapter {
  mode: "codex_hosted" | "experimental_local" | "qoder_cli" | "local_executor";
  detect(): Promise<{
    available: boolean;
    message: string;
    permissions_scope: string[];
  }>;
  run<T extends MCPToolName>(
    tool: T,
    input: MCPToolRequestMap[T]
  ): Promise<MCPToolResponseMap[T]>;
}
