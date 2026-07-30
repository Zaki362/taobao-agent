import { afterEach, describe, expect, it } from "vitest";
import { getConfiguredExecutionBackend, getExecutionBackend } from "@/lib/mcp/client";

const originalProductMode = process.env.SCENECART_PRODUCT_MODE;
const originalBackend = process.env.TAOBAO_EXECUTION_BACKEND;

afterEach(() => {
  if (originalProductMode === undefined) delete process.env.SCENECART_PRODUCT_MODE;
  else process.env.SCENECART_PRODUCT_MODE = originalProductMode;
  if (originalBackend === undefined) delete process.env.TAOBAO_EXECUTION_BACKEND;
  else process.env.TAOBAO_EXECUTION_BACKEND = originalBackend;
});

describe("MCP backend policy", () => {
  it("keeps explicitly selected compatibility backends in development", () => {
    process.env.SCENECART_PRODUCT_MODE = "development";
    process.env.TAOBAO_EXECUTION_BACKEND = "qoder_cli";

    expect(getConfiguredExecutionBackend()).toBe("qoder_cli");
    expect(getExecutionBackend()).toBe("qoder_cli");
  });

  it("fails closed to the durable local executor in formal product mode", () => {
    process.env.SCENECART_PRODUCT_MODE = "production";
    process.env.TAOBAO_EXECUTION_BACKEND = "qoder_cli";

    expect(getConfiguredExecutionBackend()).toBe("qoder_cli");
    expect(getExecutionBackend()).toBe("local_executor");
  });

  it("keeps the durable executor unchanged in formal product mode", () => {
    process.env.SCENECART_PRODUCT_MODE = "production";
    process.env.TAOBAO_EXECUTION_BACKEND = "local_executor";

    expect(getConfiguredExecutionBackend()).toBe("local_executor");
    expect(getExecutionBackend()).toBe("local_executor");
  });
});
