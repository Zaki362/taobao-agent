import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRouteError, apiRouteError } from "@/lib/api/responses";

describe("API error boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns a stable fallback and redacts secrets from logs for an unexpected error", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = apiRouteError(
      new Error(
        "database failed at postgresql://scene:super-secret@db.internal/app " +
        "with Bearer executor-secret-token from /Users/example/private/config.json"
      ),
      "runtime health check failed"
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "runtime health check failed",
      code: "internal_error"
    });

    const logged = errorLog.mock.calls.flat().join(" ");
    expect(logged).toContain("[redacted-database-url]");
    expect(logged).toContain("Bearer [redacted-token]");
    expect(logged).toContain("[local-path]");
    expect(logged).not.toContain("super-secret");
    expect(logged).not.toContain("executor-secret-token");
    expect(logged).not.toContain("db.internal");
  });

  it("keeps explicitly classified errors public", async () => {
    const response = apiRouteError(
      new ApiRouteError("邮箱或密码不正确", 401, "invalid_credentials"),
      "login failed"
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "邮箱或密码不正确",
      code: "invalid_credentials"
    });
  });

  it("keeps the existing safe mapping for known external tool failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = apiRouteError(new Error("ETIMEDOUT"), "mcp run failed");

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({
      code: "external_tool_timeout"
    });
  });

  it("classifies stale executor callbacks so a durable Worker WAL can stop retrying", async () => {
    const lostLease = apiRouteError(new Error("job lease token mismatch"), "resolve failed");
    expect(lostLease.status).toBe(409);
    await expect(lostLease.json()).resolves.toMatchObject({ code: "job_lease_lost" });

    const superseded = apiRouteError(
      new Error("stale product detail callback"),
      "resolve failed"
    );
    expect(superseded.status).toBe(409);
    await expect(superseded.json()).resolves.toMatchObject({ code: "job_superseded" });
  });
});
