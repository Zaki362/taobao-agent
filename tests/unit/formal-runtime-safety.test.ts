import { afterEach, describe, expect, it } from "vitest";
import { isAuthenticationRequired, useSecureAuthCookie } from "@/lib/auth/request";
import { assertRuntimeRepositoryConfiguration, getRuntimeRepository } from "@/lib/runtime";

const original = {
  productMode: process.env.SCENECART_PRODUCT_MODE,
  runtimeStore: process.env.RUNTIME_STORE,
  databaseUrl: process.env.DATABASE_URL,
  authRequired: process.env.AUTH_REQUIRED,
  authCookieSecure: process.env.AUTH_COOKIE_SECURE,
  appOrigin: process.env.APP_ORIGIN
};

function restore(key: keyof typeof original, environmentKey: string) {
  const value = original[key];
  if (value === undefined) delete process.env[environmentKey];
  else process.env[environmentKey] = value;
}

afterEach(() => {
  restore("productMode", "SCENECART_PRODUCT_MODE");
  restore("runtimeStore", "RUNTIME_STORE");
  restore("databaseUrl", "DATABASE_URL");
  restore("authRequired", "AUTH_REQUIRED");
  restore("authCookieSecure", "AUTH_COOKIE_SECURE");
  restore("appOrigin", "APP_ORIGIN");
});

describe("formal runtime safety", () => {
  it("forces account isolation even when production authentication is misconfigured", () => {
    process.env.SCENECART_PRODUCT_MODE = "production";
    process.env.AUTH_REQUIRED = "false";

    expect(isAuthenticationRequired()).toBe(true);
  });

  it("refuses to use the local repository in formal product mode", () => {
    process.env.SCENECART_PRODUCT_MODE = "production";
    process.env.RUNTIME_STORE = "local";
    delete process.env.DATABASE_URL;

    expect(() => assertRuntimeRepositoryConfiguration()).toThrow("拒绝使用本地运行时");
    expect(() => getRuntimeRepository()).toThrow("拒绝使用本地运行时");
  });

  it("requires a database URL before exposing the production repository", () => {
    process.env.SCENECART_PRODUCT_MODE = "production";
    process.env.RUNTIME_STORE = "postgres";
    delete process.env.DATABASE_URL;

    expect(() => getRuntimeRepository()).toThrow("缺少 DATABASE_URL");
  });

  it("allows a configured PostgreSQL repository in formal product mode", () => {
    process.env.SCENECART_PRODUCT_MODE = "production";
    process.env.RUNTIME_STORE = "postgres";
    process.env.DATABASE_URL = "postgresql://example.invalid/scenecart";

    expect(() => assertRuntimeRepositoryConfiguration()).not.toThrow();
    expect(getRuntimeRepository()).toBeTruthy();
  });

  it("does not allow an explicit false flag to downgrade cookies on HTTPS", () => {
    process.env.APP_ORIGIN = "https://scenecart.example.com";
    process.env.AUTH_COOKIE_SECURE = "false";

    expect(useSecureAuthCookie()).toBe(true);
  });

  it("keeps an HTTP local production preview usable when explicitly requested", () => {
    process.env.APP_ORIGIN = "http://127.0.0.1:3000";
    process.env.AUTH_COOKIE_SECURE = "false";

    expect(useSecureAuthCookie()).toBe(false);
  });
});
