import { describe, expect, it } from "vitest";
import { databaseSslConfig } from "@/lib/runtime/database-ssl";

describe("databaseSslConfig", () => {
  it("allows development environments to keep TLS disabled", () => {
    expect(databaseSslConfig({})).toBeUndefined();
    expect(databaseSslConfig({ DATABASE_SSL: "false" })).toBeUndefined();
  });

  it("verifies PostgreSQL certificates by default", () => {
    expect(databaseSslConfig({ DATABASE_SSL: "true" })).toEqual({ rejectUnauthorized: true });
  });

  it("normalizes an escaped PEM certificate", () => {
    expect(databaseSslConfig({ DATABASE_SSL: "true", DATABASE_SSL_CA: "line-1\\nline-2" }))
      .toEqual({ rejectUnauthorized: true, ca: "line-1\nline-2" });
  });

  it.each([
    {},
    { DATABASE_SSL: "false" }
  ])("fails closed when TLS is missing or disabled in formal product mode", (databaseEnvironment) => {
    expect(() => databaseSslConfig({
      SCENECART_PRODUCT_MODE: "production",
      ...databaseEnvironment
    })).toThrow("正式运行要求 PostgreSQL 全程使用 TLS");
  });

  it("also fails closed when NODE_ENV marks a formal runtime", () => {
    expect(() => databaseSslConfig({
      NODE_ENV: "production"
    })).toThrow("正式运行要求 PostgreSQL 全程使用 TLS");
  });

  it("accepts verified TLS in formal product mode", () => {
    expect(databaseSslConfig({
      SCENECART_PRODUCT_MODE: "production",
      DATABASE_SSL: "true"
    })).toEqual({ rejectUnauthorized: true });
  });

  it("rejects disabled certificate verification in formal product mode even with a CA", () => {
    expect(() => databaseSslConfig({
      SCENECART_PRODUCT_MODE: "production",
      DATABASE_SSL: "true",
      DATABASE_SSL_REJECT_UNAUTHORIZED: "false",
      DATABASE_SSL_CA: "certificate"
    })).toThrow("禁止关闭 PostgreSQL 证书校验");
  });
});
