import { afterEach, describe, expect, it } from "vitest";
import { isAuthenticationRequired, shouldUseSecureAuthCookie } from "@/lib/auth/request";
import { assertRuntimeRepositoryConfiguration, getRuntimeRepository } from "@/lib/runtime";

const original = {
  productMode: process.env.SCENECART_PRODUCT_MODE,
  runtimeStore: process.env.RUNTIME_STORE,
  databaseUrl: process.env.DATABASE_URL,
  authRequired: process.env.AUTH_REQUIRED,
  accessMode: process.env.SCENECART_ACCESS_MODE,
  singleUserId: process.env.SCENECART_SINGLE_USER_ID,
  vercelEnvironment: process.env.VERCEL_ENV,
  authCookieSecure: process.env.AUTH_COOKIE_SECURE,
  appOrigin: process.env.APP_ORIGIN,
  protectionVerified: process.env.SCENECART_OUTER_PROTECTION_VERIFIED,
  protectionScope: process.env.SCENECART_OUTER_PROTECTION_SCOPE,
  protectionVerifiedAt: process.env.SCENECART_OUTER_PROTECTION_VERIFIED_AT,
  protectionProjectId: process.env.SCENECART_OUTER_PROTECTION_PROJECT_ID,
  protectionOrigin: process.env.SCENECART_OUTER_PROTECTION_ORIGIN,
  unprotectedRiskAccepted: process.env.SCENECART_ALLOW_UNPROTECTED_SINGLE_USER_PRODUCTION,
  vercelProjectId: process.env.VERCEL_PROJECT_ID,
  vercelProductionUrl: process.env.VERCEL_PROJECT_PRODUCTION_URL
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
  restore("accessMode", "SCENECART_ACCESS_MODE");
  restore("singleUserId", "SCENECART_SINGLE_USER_ID");
  restore("vercelEnvironment", "VERCEL_ENV");
  restore("authCookieSecure", "AUTH_COOKIE_SECURE");
    restore("appOrigin", "APP_ORIGIN");
    restore("protectionVerified", "SCENECART_OUTER_PROTECTION_VERIFIED");
    restore("protectionScope", "SCENECART_OUTER_PROTECTION_SCOPE");
    restore("protectionVerifiedAt", "SCENECART_OUTER_PROTECTION_VERIFIED_AT");
    restore("protectionProjectId", "SCENECART_OUTER_PROTECTION_PROJECT_ID");
    restore("protectionOrigin", "SCENECART_OUTER_PROTECTION_ORIGIN");
    restore("unprotectedRiskAccepted", "SCENECART_ALLOW_UNPROTECTED_SINGLE_USER_PRODUCTION");
    restore("vercelProjectId", "VERCEL_PROJECT_ID");
    restore("vercelProductionUrl", "VERCEL_PROJECT_PRODUCTION_URL");
});

describe("formal runtime safety", () => {
  it("forces account isolation even when production authentication is misconfigured", () => {
    process.env.SCENECART_PRODUCT_MODE = "production";
    process.env.AUTH_REQUIRED = "false";

    expect(isAuthenticationRequired()).toBe(true);
  });

  it("allows a fixed-owner access mode on a protected Vercel Preview", () => {
    process.env.SCENECART_PRODUCT_MODE = "production";
    process.env.SCENECART_ACCESS_MODE = "single_user";
    process.env.SCENECART_SINGLE_USER_ID = "11111111-1111-4111-8111-111111111111";
    process.env.VERCEL_ENV = "preview";
    process.env.APP_ORIGIN = "https://scenecart.example.com";
    process.env.SCENECART_OUTER_PROTECTION_VERIFIED = "true";
    process.env.SCENECART_OUTER_PROTECTION_SCOPE = "preview";
    process.env.SCENECART_OUTER_PROTECTION_VERIFIED_AT = new Date().toISOString();
    process.env.SCENECART_OUTER_PROTECTION_PROJECT_ID = "project_scenecart";
    process.env.SCENECART_OUTER_PROTECTION_ORIGIN = "https://scenecart.example.com";
    process.env.VERCEL_PROJECT_ID = "project_scenecart";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "scenecart.example.com";

    expect(isAuthenticationRequired()).toBe(false);
  });

  it("makes the authentication contract fail closed without Production outer protection", () => {
    process.env.SCENECART_ACCESS_MODE = "single_user";
    process.env.SCENECART_SINGLE_USER_ID = "11111111-1111-4111-8111-111111111111";
    process.env.VERCEL_ENV = "production";

    expect(() => isAuthenticationRequired()).toThrow("访问边界配置无效");
  });

  it("allows canonical unprotected Vercel Production only after explicit risk acceptance", () => {
    process.env.SCENECART_PRODUCT_MODE = "production";
    process.env.SCENECART_ACCESS_MODE = "single_user";
    process.env.SCENECART_SINGLE_USER_ID = "11111111-1111-4111-8111-111111111111";
    process.env.VERCEL_ENV = "production";
    process.env.APP_ORIGIN = "https://scenecart-ai.vercel.app";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "scenecart-ai.vercel.app";
    process.env.SCENECART_ALLOW_UNPROTECTED_SINGLE_USER_PRODUCTION = "true";
    process.env.SCENECART_OUTER_PROTECTION_VERIFIED = "false";

    expect(isAuthenticationRequired()).toBe(false);
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

    expect(shouldUseSecureAuthCookie()).toBe(true);
  });

  it("keeps an HTTP local production preview usable when explicitly requested", () => {
    process.env.APP_ORIGIN = "http://127.0.0.1:3000";
    process.env.AUTH_COOKIE_SECURE = "false";

    expect(shouldUseSecureAuthCookie()).toBe(false);
  });
});
