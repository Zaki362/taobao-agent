import { afterEach, describe, expect, it } from "vitest";
import { databaseSslConfig } from "@/lib/runtime/database-ssl";

const originalMode = process.env.SCENECART_PRODUCT_MODE;

afterEach(() => {
  if (originalMode === undefined) delete process.env.SCENECART_PRODUCT_MODE;
  else process.env.SCENECART_PRODUCT_MODE = originalMode;
});

describe("databaseSslConfig", () => {
  it("keeps TLS disabled when it was not requested", () => {
    expect(databaseSslConfig({ DATABASE_SSL: "false" })).toBeUndefined();
  });

  it("verifies PostgreSQL certificates by default", () => {
    expect(databaseSslConfig({ DATABASE_SSL: "true" })).toEqual({ rejectUnauthorized: true });
  });

  it("normalizes an escaped PEM certificate", () => {
    expect(databaseSslConfig({ DATABASE_SSL: "true", DATABASE_SSL_CA: "line-1\\nline-2" }))
      .toEqual({ rejectUnauthorized: true, ca: "line-1\nline-2" });
  });

  it("rejects insecure TLS in formal product mode", () => {
    process.env.SCENECART_PRODUCT_MODE = "production";
    expect(() => databaseSslConfig({
      DATABASE_SSL: "true",
      DATABASE_SSL_REJECT_UNAUTHORIZED: "false"
    })).toThrow("禁止关闭 PostgreSQL 证书校验");
  });
});
