import { describe, expect, it } from "vitest";
import { databaseSslConfig } from "../../scripts/database-ssl.mjs";

describe("migration databaseSslConfig", () => {
  it("allows a development database to omit TLS", () => {
    expect(databaseSslConfig({})).toBeUndefined();
    expect(databaseSslConfig({ DATABASE_SSL: "false" })).toBeUndefined();
  });

  it.each([
    {},
    { DATABASE_SSL: "false" }
  ])("fails closed when formal migrations omit TLS", (databaseEnvironment) => {
    expect(() => databaseSslConfig({
      SCENECART_PRODUCT_MODE: "production",
      ...databaseEnvironment
    })).toThrow("正式运行要求 PostgreSQL 全程使用 TLS");
  });

  it("requires certificate verification for formal migrations", () => {
    expect(() => databaseSslConfig({
      NODE_ENV: "production",
      DATABASE_SSL: "true",
      DATABASE_SSL_REJECT_UNAUTHORIZED: "false",
      DATABASE_SSL_CA: "certificate"
    })).toThrow("禁止关闭 PostgreSQL 证书校验");
  });

  it("normalizes a verified private CA", () => {
    expect(databaseSslConfig({
      SCENECART_PRODUCT_MODE: "production",
      DATABASE_SSL: "true",
      DATABASE_SSL_CA: "line-1\\nline-2"
    })).toEqual({ rejectUnauthorized: true, ca: "line-1\nline-2" });
  });
});
