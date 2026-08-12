import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { clearAuthRateLimit, enforceAuthRateLimit, resetRateLimitsForTests } from "@/lib/security/rate-limit";

describe("authentication rate limit", () => {
  beforeEach(() => resetRateLimitsForTests());

  it("blocks repeated attempts without storing the raw identity", async () => {
    const request = new NextRequest("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "x-forwarded-for": "127.0.0.1" }
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await enforceAuthRateLimit(request, {
        action: "login",
        subject: "user@example.com",
        limit: 2,
        windowMs: 60_000,
        blockMs: 30_000
      });
    }
    await expect(enforceAuthRateLimit(request, {
      action: "login",
      subject: "user@example.com",
      limit: 2,
      windowMs: 60_000,
      blockMs: 30_000
    })).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    expect([...globalThis.__sceneCartRateLimits!.keys()][0]).not.toContain("user@example.com");
  });

  it("clears the counter after a successful authentication", async () => {
    const request = new NextRequest("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "x-forwarded-for": "127.0.0.2" }
    });
    await enforceAuthRateLimit(request, { action: "login", subject: "ok@example.com", limit: 1 });
    await clearAuthRateLimit(request, "login", "ok@example.com");
    await expect(enforceAuthRateLimit(request, {
      action: "login",
      subject: "ok@example.com",
      limit: 1
    })).resolves.toBeUndefined();
  });
});
