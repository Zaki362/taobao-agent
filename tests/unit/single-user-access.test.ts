import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authenticateToken, cookies, findUserById } = vi.hoisted(() => ({
  authenticateToken: vi.fn(),
  cookies: vi.fn(),
  findUserById: vi.fn()
}));

vi.mock("next/headers", () => ({ cookies }));
vi.mock("@/lib/auth/service", () => ({ authenticateToken }));
vi.mock("@/lib/runtime", () => ({
  getRuntimeRepository: () => ({ findUserById }),
  runtimeStoreMode: () => "local"
}));

import {
  assertInteractiveAuthenticationEnabled,
  configuredSingleUserId
} from "@/lib/auth/access-mode";
import { getRequestIdentity, requireAuthenticatedIdentity } from "@/lib/auth/request";
import { GET as readAuthenticationState } from "@/app/api/auth/me/route";
import { POST as closedLogin } from "@/app/api/auth/login/route";
import { POST as closedRegistration } from "@/app/api/auth/register/route";
import { inspectSingleUserExposureConfiguration } from "@/lib/auth/outer-protection";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const original = {
  accessMode: process.env.SCENECART_ACCESS_MODE,
  singleUserId: process.env.SCENECART_SINGLE_USER_ID,
  vercelEnvironment: process.env.VERCEL_ENV,
  nodeEnvironment: process.env.NODE_ENV,
  productMode: process.env.SCENECART_PRODUCT_MODE,
  appOrigin: process.env.APP_ORIGIN,
  protectionVerified: process.env.SCENECART_OUTER_PROTECTION_VERIFIED,
  protectionScope: process.env.SCENECART_OUTER_PROTECTION_SCOPE,
  protectionVerifiedAt: process.env.SCENECART_OUTER_PROTECTION_VERIFIED_AT,
  protectionProjectId: process.env.SCENECART_OUTER_PROTECTION_PROJECT_ID,
  protectionOrigin: process.env.SCENECART_OUTER_PROTECTION_ORIGIN,
  protectionAuditReceipt: process.env.SCENECART_OUTER_PROTECTION_AUDIT_RECEIPT,
  unprotectedRiskAccepted: process.env.SCENECART_ALLOW_UNPROTECTED_SINGLE_USER_PRODUCTION,
  vercelProjectId: process.env.VERCEL_PROJECT_ID,
  vercelProductionUrl: process.env.VERCEL_PROJECT_PRODUCTION_URL
};

function restore(name: keyof typeof original, environmentKey: string) {
  const value = original[name];
  if (value === undefined) delete process.env[environmentKey];
  else process.env[environmentKey] = value;
}

function configureOuterProtection(scope: "preview" | "all_deployments" = "preview") {
  process.env.APP_ORIGIN = "https://scenecart.example.com";
  process.env.SCENECART_OUTER_PROTECTION_VERIFIED = "true";
  process.env.SCENECART_OUTER_PROTECTION_SCOPE = scope;
  process.env.SCENECART_OUTER_PROTECTION_VERIFIED_AT = new Date().toISOString();
  process.env.SCENECART_OUTER_PROTECTION_PROJECT_ID = "project_scenecart";
  process.env.SCENECART_OUTER_PROTECTION_ORIGIN = "https://scenecart.example.com";
  process.env.VERCEL_PROJECT_ID = "project_scenecart";
  process.env.VERCEL_PROJECT_PRODUCTION_URL = "scenecart.example.com";
}

beforeEach(() => {
  process.env.SCENECART_ACCESS_MODE = "single_user";
  process.env.SCENECART_SINGLE_USER_ID = OWNER_ID;
  delete process.env.SCENECART_ALLOW_UNPROTECTED_SINGLE_USER_PRODUCTION;
  process.env.VERCEL_ENV = "preview";
  configureOuterProtection();
  findUserById.mockReset().mockResolvedValue({
    id: OWNER_ID,
    email: "owner@example.com",
    password_hash: "unused",
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z"
  });
  authenticateToken.mockReset();
  cookies.mockReset().mockResolvedValue({ get: () => ({ value: "old-cookie" }) });
});

afterEach(() => {
  restore("accessMode", "SCENECART_ACCESS_MODE");
  restore("singleUserId", "SCENECART_SINGLE_USER_ID");
  restore("vercelEnvironment", "VERCEL_ENV");
  restore("nodeEnvironment", "NODE_ENV");
  restore("productMode", "SCENECART_PRODUCT_MODE");
  restore("appOrigin", "APP_ORIGIN");
  restore("protectionVerified", "SCENECART_OUTER_PROTECTION_VERIFIED");
  restore("protectionScope", "SCENECART_OUTER_PROTECTION_SCOPE");
  restore("protectionVerifiedAt", "SCENECART_OUTER_PROTECTION_VERIFIED_AT");
  restore("protectionProjectId", "SCENECART_OUTER_PROTECTION_PROJECT_ID");
  restore("protectionOrigin", "SCENECART_OUTER_PROTECTION_ORIGIN");
  restore("protectionAuditReceipt", "SCENECART_OUTER_PROTECTION_AUDIT_RECEIPT");
  restore("unprotectedRiskAccepted", "SCENECART_ALLOW_UNPROTECTED_SINGLE_USER_PRODUCTION");
  restore("vercelProjectId", "VERCEL_PROJECT_ID");
  restore("vercelProductionUrl", "VERCEL_PROJECT_PRODUCTION_URL");
});

describe("single-user Preview access", () => {
  it("always resolves the configured owner before considering an old account cookie", async () => {
    const identity = await getRequestIdentity();

    expect(identity).toMatchObject({
      userId: OWNER_ID,
      authenticated: true,
      accessMode: "single_user"
    });
    expect(findUserById).toHaveBeenCalledWith(OWNER_ID);
    expect(cookies).not.toHaveBeenCalled();
    expect(authenticateToken).not.toHaveBeenCalled();
    await expect(requireAuthenticatedIdentity()).resolves.toMatchObject({ userId: OWNER_ID });
  });

  it("reports fixed access without exposing the owner identity", async () => {
    const response = await readAuthenticationState();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      authenticated: true,
      access_mode: "single_user",
      persistence_scope: "single_user"
    });
    expect(JSON.stringify(payload)).not.toContain(OWNER_ID);
    expect(JSON.stringify(payload)).not.toContain("owner@example.com");
  });

  it("fails closed when the configured owner does not exist", async () => {
    findUserById.mockResolvedValue(null);
    await expect(getRequestIdentity()).rejects.toMatchObject({
      status: 503,
      code: "single_user_owner_not_found"
    });
  });

  it("rejects missing or malformed owner IDs", () => {
    process.env.SCENECART_SINGLE_USER_ID = "not-a-uuid";
    expect(() => configuredSingleUserId()).toThrow("缺少有效的 SCENECART_SINGLE_USER_ID");
  });

  it("allows Vercel Production only with all-deployments outer protection", () => {
    process.env.VERCEL_ENV = "production";
    process.env.SCENECART_PRODUCT_MODE = "production";
    configureOuterProtection("all_deployments");
    expect(configuredSingleUserId()).toBe(OWNER_ID);

    process.env.SCENECART_OUTER_PROTECTION_SCOPE = "preview";
    expect(() => configuredSingleUserId()).toThrow("Production 必须保护所有部署");
  });

  it("allows the canonical unprotected Production only after explicit server-side risk acceptance", () => {
    process.env.VERCEL_ENV = "production";
    process.env.SCENECART_PRODUCT_MODE = "production";
    process.env.APP_ORIGIN = "https://scenecart-ai.vercel.app";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "scenecart-ai.vercel.app";
    process.env.SCENECART_ALLOW_UNPROTECTED_SINGLE_USER_PRODUCTION = "true";
    process.env.SCENECART_OUTER_PROTECTION_VERIFIED = "false";
    delete process.env.SCENECART_OUTER_PROTECTION_SCOPE;
    delete process.env.SCENECART_OUTER_PROTECTION_VERIFIED_AT;
    delete process.env.SCENECART_OUTER_PROTECTION_PROJECT_ID;
    delete process.env.SCENECART_OUTER_PROTECTION_ORIGIN;
    delete process.env.SCENECART_OUTER_PROTECTION_AUDIT_RECEIPT;

    expect(configuredSingleUserId()).toBe(OWNER_ID);
    expect(inspectSingleUserExposureConfiguration()).toMatchObject({
      mode: "unprotected_risk_accepted",
      valid: true,
      outerProtection: { valid: false }
    });

    process.env.APP_ORIGIN = "https://wrong-project.vercel.app";
    expect(() => configuredSingleUserId()).toThrow("必须精确匹配 scenecart-ai");
  });

  it("does not accept an unprotected Production flag while claiming protection was verified", () => {
    process.env.VERCEL_ENV = "production";
    process.env.SCENECART_PRODUCT_MODE = "production";
    process.env.APP_ORIGIN = "https://scenecart-ai.vercel.app";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "scenecart-ai.vercel.app";
    process.env.SCENECART_ALLOW_UNPROTECTED_SINGLE_USER_PRODUCTION = "true";
    process.env.SCENECART_OUTER_PROTECTION_VERIFIED = "true";

    expect(() => configuredSingleUserId()).toThrow("必须明确声明外层保护未验证");
  });

  it("rejects stale outer-protection proof in unprotected Production mode", () => {
    process.env.VERCEL_ENV = "production";
    process.env.SCENECART_PRODUCT_MODE = "production";
    process.env.APP_ORIGIN = "https://scenecart-ai.vercel.app";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "scenecart-ai.vercel.app";
    process.env.SCENECART_ALLOW_UNPROTECTED_SINGLE_USER_PRODUCTION = "true";
    process.env.SCENECART_OUTER_PROTECTION_VERIFIED = "false";
    delete process.env.SCENECART_OUTER_PROTECTION_SCOPE;
    delete process.env.SCENECART_OUTER_PROTECTION_VERIFIED_AT;
    delete process.env.SCENECART_OUTER_PROTECTION_PROJECT_ID;
    delete process.env.SCENECART_OUTER_PROTECTION_ORIGIN;
    process.env.SCENECART_OUTER_PROTECTION_AUDIT_RECEIPT = "/tmp/stale-proof.json";

    expect(() => configuredSingleUserId()).toThrow("不得保留过期的外层保护证明");
  });

  it("rejects an unprotected non-Vercel production runtime", () => {
    delete process.env.VERCEL_ENV;
    Reflect.set(process.env, "NODE_ENV", "production");
    expect(() => configuredSingleUserId()).toThrow("VERCEL_ENV 必须是 preview 或 production");
  });

  it("allows a local next-start preview only when APP_ORIGIN is exact loopback", () => {
    delete process.env.VERCEL_ENV;
    Reflect.set(process.env, "NODE_ENV", "production");
    process.env.APP_ORIGIN = "http://127.0.0.1:3100";

    expect(configuredSingleUserId()).toBe(OWNER_ID);

    process.env.APP_ORIGIN = "https://scenecart.example.com";
    expect(() => configuredSingleUserId()).toThrow("VERCEL_ENV 必须是 preview 或 production");
  });

  it("disables interactive login and registration endpoints", () => {
    expect(() => assertInteractiveAuthenticationEnabled()).toThrow("不开放账号登录或注册");
    try {
      assertInteractiveAuthenticationEnabled();
    } catch (error) {
      expect(error).toMatchObject({ status: 410, code: "interactive_authentication_disabled" });
    }
  });

  it("returns 410 before reading login or registration request bodies", async () => {
    const readBody = vi.fn(() => Promise.reject(new Error("body must not be read")));
    const request = { json: readBody };
    const login = await (closedLogin as (...args: unknown[]) => Promise<Response>)(request);
    const registration = await (closedRegistration as (...args: unknown[]) => Promise<Response>)(request);

    expect(login.status).toBe(410);
    expect(registration.status).toBe(410);
    expect(readBody).not.toHaveBeenCalled();
  });
});
