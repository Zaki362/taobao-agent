import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAuthRateLimit,
  acquireEventStreamLease,
  enforceAuthRateLimit,
  resetRateLimitsForTests,
  withAiConcurrencyLimit
} from "@/lib/security/rate-limit";

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

  it("blocks registration bursts even when every attempt changes the email", async () => {
    const request = new NextRequest("http://localhost/api/auth/register", { method: "POST" });
    await enforceAuthRateLimit(request, { action: "register", subject: "first@example.com", ipLimit: 2 });
    await enforceAuthRateLimit(request, { action: "register", subject: "second@example.com", ipLimit: 2 });
    await expect(enforceAuthRateLimit(request, {
      action: "register",
      subject: "third@example.com",
      ipLimit: 2
    })).rejects.toMatchObject({ status: 429, code: "rate_limited" });
  });

  it("allows only one concurrent AI workflow per identity", async () => {
    const request = new NextRequest("http://localhost/api/scene/plan", { method: "POST" });
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const active = new Promise<void>((resolve) => { started = resolve; });
    const first = withAiConcurrencyLimit(request, "user-1", async () => {
      started();
      await gate;
      return "done";
    });
    await active;

    await expect(withAiConcurrencyLimit(request, "user-1", async () => "duplicate"))
      .rejects.toMatchObject({ status: 429, code: "workflow_concurrency_limited" });
    release();
    await expect(first).resolves.toBe("done");
    await expect(withAiConcurrencyLimit(request, "user-1", async () => "next"))
      .resolves.toBe("next");
  });

  it("caps concurrent event streams per session", async () => {
    const request = new NextRequest("http://localhost/api/runtime/events/stream");
    const releases = await Promise.all([
      acquireEventStreamLease(request, "user-1", "session-1"),
      acquireEventStreamLease(request, "user-1", "session-1"),
      acquireEventStreamLease(request, "user-1", "session-1")
    ]);
    await expect(acquireEventStreamLease(request, "user-1", "session-1"))
      .rejects.toMatchObject({ status: 429, code: "event_stream_concurrency_limited" });
    await releases[0]();
    const replacement = await acquireEventStreamLease(request, "user-1", "session-1");
    await Promise.all([...releases.slice(1).map((release) => release()), replacement()]);
  });
});
