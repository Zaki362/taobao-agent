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

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const original = {
  accessMode: process.env.SCENECART_ACCESS_MODE,
  singleUserId: process.env.SCENECART_SINGLE_USER_ID,
  vercelEnvironment: process.env.VERCEL_ENV,
  nodeEnvironment: process.env.NODE_ENV
};

function restore(name: keyof typeof original, environmentKey: string) {
  const value = original[name];
  if (value === undefined) delete process.env[environmentKey];
  else process.env[environmentKey] = value;
}

beforeEach(() => {
  process.env.SCENECART_ACCESS_MODE = "single_user";
  process.env.SCENECART_SINGLE_USER_ID = OWNER_ID;
  process.env.VERCEL_ENV = "preview";
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

  it("reports a hidden interactive login while preserving the fixed owner identity", async () => {
    const response = await readAuthenticationState();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      authenticated: true,
      authentication_required: false,
      access_mode: "single_user",
      user: { id: OWNER_ID }
    });
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

  it("rejects the mode in Vercel Production", () => {
    process.env.VERCEL_ENV = "production";
    expect(() => configuredSingleUserId()).toThrow("不能用于 Production");
  });

  it("rejects an unprotected non-Vercel production runtime", () => {
    delete process.env.VERCEL_ENV;
    Reflect.set(process.env, "NODE_ENV", "production");
    expect(() => configuredSingleUserId()).toThrow("不能用于 Production");
  });

  it("disables interactive login and registration endpoints", () => {
    expect(() => assertInteractiveAuthenticationEnabled()).toThrow("不开放账号登录或注册");
  });
});
