import { afterEach, describe, expect, it } from "vitest";
import {
  allowDemoCartFallback,
  getProductMode,
  isFormalProductMode,
  isMcpDebugEnabled
} from "@/lib/runtime/product-mode";

const originalProductMode = process.env.SCENECART_PRODUCT_MODE;
const originalDemoFallback = process.env.ALLOW_DEMO_CART_FALLBACK;
const originalMcpDebug = process.env.SCENECART_ENABLE_MCP_DEBUG;

afterEach(() => {
  if (originalProductMode === undefined) delete process.env.SCENECART_PRODUCT_MODE;
  else process.env.SCENECART_PRODUCT_MODE = originalProductMode;
  if (originalDemoFallback === undefined) delete process.env.ALLOW_DEMO_CART_FALLBACK;
  else process.env.ALLOW_DEMO_CART_FALLBACK = originalDemoFallback;
  if (originalMcpDebug === undefined) delete process.env.SCENECART_ENABLE_MCP_DEBUG;
  else process.env.SCENECART_ENABLE_MCP_DEBUG = originalMcpDebug;
});

describe("product runtime mode", () => {
  it("keeps the demo cart fallback available in development by default", () => {
    process.env.SCENECART_PRODUCT_MODE = "development";
    delete process.env.ALLOW_DEMO_CART_FALLBACK;

    expect(getProductMode()).toBe("development");
    expect(isFormalProductMode()).toBe(false);
    expect(allowDemoCartFallback()).toBe(true);
  });

  it("allows development to opt out of demo cart fallback", () => {
    process.env.SCENECART_PRODUCT_MODE = "development";
    process.env.ALLOW_DEMO_CART_FALLBACK = "false";

    expect(allowDemoCartFallback()).toBe(false);
  });

  it("always disables demo cart fallback in formal product mode", () => {
    process.env.SCENECART_PRODUCT_MODE = "production";
    process.env.ALLOW_DEMO_CART_FALLBACK = "true";

    expect(isFormalProductMode()).toBe(true);
    expect(allowDemoCartFallback()).toBe(false);
  });

  it("keeps manual MCP debugging disabled unless development explicitly opts in", () => {
    process.env.SCENECART_PRODUCT_MODE = "development";
    delete process.env.SCENECART_ENABLE_MCP_DEBUG;
    expect(isMcpDebugEnabled()).toBe(false);

    process.env.SCENECART_ENABLE_MCP_DEBUG = "true";
    expect(isMcpDebugEnabled()).toBe(true);
  });

  it("always disables manual MCP debugging in formal product mode", () => {
    process.env.SCENECART_PRODUCT_MODE = "production";
    process.env.SCENECART_ENABLE_MCP_DEBUG = "true";

    expect(isMcpDebugEnabled()).toBe(false);
  });
});
