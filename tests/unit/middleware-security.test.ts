import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { AUTH_COOKIE_NAME } from "@/lib/auth/constants";
import { middleware } from "@/middleware";

const originalAuthRequired = process.env.AUTH_REQUIRED;
const originalAppOrigin = process.env.APP_ORIGIN;

function restore(name: "AUTH_REQUIRED" | "APP_ORIGIN", value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function mutationRequest(headers: Record<string, string>) {
  return new NextRequest("https://scenecart.example.com/api/session/archive", {
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
    }));

    expect(response.headers.get("x-middleware-next")).toBe("1");
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
});
