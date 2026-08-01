import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/mcp/run/route";

const originalProductMode = process.env.SCENECART_PRODUCT_MODE;
const originalMcpDebug = process.env.SCENECART_ENABLE_MCP_DEBUG;

afterEach(() => {
  if (originalProductMode === undefined) delete process.env.SCENECART_PRODUCT_MODE;
  else process.env.SCENECART_PRODUCT_MODE = originalProductMode;
  if (originalMcpDebug === undefined) delete process.env.SCENECART_ENABLE_MCP_DEBUG;
  else process.env.SCENECART_ENABLE_MCP_DEBUG = originalMcpDebug;
});

function debugRequest() {
  return new NextRequest("http://localhost/api/mcp/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tool_name: "search_taobao_products",
      input: { keyword: "车载手机支架", module_id: "practical-interior" }
    })
  });
}

describe("manual MCP debug route", () => {
  it("is hidden by default", async () => {
    process.env.SCENECART_PRODUCT_MODE = "development";
    delete process.env.SCENECART_ENABLE_MCP_DEBUG;

    const response = await POST(debugRequest());

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
  });

  it("remains hidden in formal product mode even when misconfigured", async () => {
    process.env.SCENECART_PRODUCT_MODE = "production";
    process.env.SCENECART_ENABLE_MCP_DEBUG = "true";

    const response = await POST(debugRequest());

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
  });
});
