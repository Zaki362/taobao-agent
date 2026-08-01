export type ProductMode = "development" | "production";

export function getProductMode(): ProductMode {
  return process.env.SCENECART_PRODUCT_MODE === "production" ? "production" : "development";
}

export function isFormalProductMode() {
  return getProductMode() === "production";
}

export function allowDemoCartFallback() {
  if (isFormalProductMode()) {
    return false;
  }
  return process.env.ALLOW_DEMO_CART_FALLBACK !== "false";
}

export function isMcpDebugEnabled() {
  return !isFormalProductMode() && process.env.SCENECART_ENABLE_MCP_DEBUG === "true";
}
