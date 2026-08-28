import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { AUTH_COOKIE_NAME } from "@/lib/auth/constants";
import { middleware } from "@/middleware";

const originalAuthRequired = process.env.AUTH_REQUIRED;
const originalAppOrigin = process.env.APP_ORIGIN;
const originalAccessMode = process.env.SCENECART_ACCESS_MODE;
const originalVercelEnvironment = process.env.VERCEL_ENV;
const originalVercelUrl = process.env.VERCEL_URL;
const originalProtectionVerified = process.env.SCENECART_OUTER_PROTECTION_VERIFIED;
const originalProtectionScope = process.env.SCENECART_OUTER_PROTECTION_SCOPE;
const originalProtectionVerifiedAt = process.env.SCENECART_OUTER_PROTECTION_VERIFIED_AT;
const originalProtectionProjectId = process.env.SCENECART_OUTER_PROTECTION_PROJECT_ID;
const originalProtectionOrigin = process.env.SCENECART_OUTER_PROTECTION_ORIGIN;
const originalVercelProjectId = process.env.VERCEL_PROJECT_ID;
const originalVercelProductionUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;

function restore(name: "AUTH_REQUIRED" | "APP_ORIGIN", value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function mutationRequest(
  headers: Record<string, string>,
  pathname = "/api/session/archive"
) {
  return new NextRequest(`https://scenecart.example.com${pathname}`, {
    method: "POST",
    headers
  });
}

describe("API mutation origin protection", () => {
  beforeEach(() => {
    process.env.AUTH_REQUIRED = "true";
    process.env.APP_ORIGIN = "https://scenecart.example.com";
  });

  afterAll(() => {
    restore("AUTH_REQUIRED", originalAuthRequired);
    restore("APP_ORIGIN", originalAppOrigin);
    if (originalAccessMode === undefined) delete process.env.SCENECART_ACCESS_MODE;
    else process.env.SCENECART_ACCESS_MODE = originalAccessMode;
    if (originalVercelEnvironment === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = originalVercelEnvironment;
    if (originalVercelUrl === undefined) delete process.env.VERCEL_URL;
    else process.env.VERCEL_URL = originalVercelUrl;
    if (originalProtectionVerified === undefined) delete process.env.SCENECART_OUTER_PROTECTION_VERIFIED;
    else process.env.SCENECART_OUTER_PROTECTION_VERIFIED = originalProtectionVerified;
    if (originalProtectionScope === undefined) delete process.env.SCENECART_OUTER_PROTECTION_SCOPE;
    else process.env.SCENECART_OUTER_PROTECTION_SCOPE = originalProtectionScope;
    if (originalProtectionVerifiedAt === undefined) delete process.env.SCENECART_OUTER_PROTECTION_VERIFIED_AT;
    else process.env.SCENECART_OUTER_PROTECTION_VERIFIED_AT = originalProtectionVerifiedAt;
    if (originalProtectionProjectId === undefined) delete process.env.SCENECART_OUTER_PROTECTION_PROJECT_ID;
    else process.env.SCENECART_OUTER_PROTECTION_PROJECT_ID = originalProtectionProjectId;
    if (originalProtectionOrigin === undefined) delete process.env.SCENECART_OUTER_PROTECTION_ORIGIN;
    else process.env.SCENECART_OUTER_PROTECTION_ORIGIN = originalProtectionOrigin;
    if (originalVercelProjectId === undefined) delete process.env.VERCEL_PROJECT_ID;
    else process.env.VERCEL_PROJECT_ID = originalVercelProjectId;
    if (originalVercelProductionUrl === undefined) delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    else process.env.VERCEL_PROJECT_PRODUCTION_URL = originalVercelProductionUrl;
  });

  it("does not let an arbitrary Bearer value bypass Origin checks for a session request", async () => {
    const response = middleware(mutationRequest({
      authorization: "Bearer not-a-valid-machine-token",
      cookie: `${AUTH_COOKIE_NAME}=valid-browser-session`,
      origin: "https://attacker.example"
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_origin" });
  });

  it("keeps cookie-free Bearer machine requests independent from browser Origin checks", () => {
    const response = middleware(mutationRequest({
      authorization: "Bearer machine-token"
    }, "/api/executor/heartbeat"));

    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("does not let a fake Bearer bypass Origin checks on ordinary fixed-owner APIs", async () => {
    const response = middleware(mutationRequest({
      authorization: "Bearer not-a-device-token"
    }, "/api/scene/plan"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_origin" });
  });

  it("does not treat browser device enrollment as a machine-authenticated endpoint", async () => {
    const response = middleware(mutationRequest({
      authorization: "Bearer not-a-device-token"
    }, "/api/executor/devices"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_origin" });
  });

  it("allows a same-origin session mutation", () => {
    const response = middleware(mutationRequest({
      cookie: `${AUTH_COOKIE_NAME}=valid-browser-session`,
      origin: "https://scenecart.example.com"
    }));

    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("does not let forwarded host headers expand an explicit origin allowlist", async () => {
    const response = middleware(mutationRequest({
      cookie: `${AUTH_COOKIE_NAME}=valid-browser-session`,
      origin: "https://attacker.example",
      "x-forwarded-host": "attacker.example",
      "x-forwarded-proto": "https"
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_origin" });
  });

  it("allows the platform-provided host for a protected single-user Preview", () => {
    process.env.SCENECART_ACCESS_MODE = "single_user";
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_URL = "scenecart-owner-preview.example.vercel.app";
    process.env.SCENECART_OUTER_PROTECTION_VERIFIED = "true";
    process.env.SCENECART_OUTER_PROTECTION_SCOPE = "preview";
    process.env.SCENECART_OUTER_PROTECTION_VERIFIED_AT = new Date().toISOString();
    process.env.SCENECART_OUTER_PROTECTION_PROJECT_ID = "project_scenecart";
    process.env.SCENECART_OUTER_PROTECTION_ORIGIN = "https://scenecart.example.com";
    process.env.VERCEL_PROJECT_ID = "project_scenecart";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "scenecart.example.com";

    const response = middleware(mutationRequest({
      origin: "https://scenecart-owner-preview.example.vercel.app"
    }));

    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("fails closed for browser mutations when single-user Preview lacks proof", async () => {
    process.env.SCENECART_ACCESS_MODE = "single_user";
    process.env.VERCEL_ENV = "preview";
    delete process.env.SCENECART_OUTER_PROTECTION_VERIFIED;

    const response = middleware(mutationRequest({
      origin: "https://scenecart.example.com"
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "single_user_outer_protection_required"
    });
  });

  it("does not let a machine Bearer token bypass a missing outer-protection contract", async () => {
    process.env.SCENECART_ACCESS_MODE = "single_user";
    process.env.VERCEL_ENV = "preview";
    delete process.env.SCENECART_OUTER_PROTECTION_VERIFIED;

    const response = middleware(mutationRequest({
      authorization: "Bearer valid-looking-device-token"
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "single_user_outer_protection_required"
    });
  });
});
