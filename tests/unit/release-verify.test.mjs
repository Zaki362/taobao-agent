import { describe, expect, it } from "vitest";
import {
  isProductionReleaseUrl,
  normalizeReleaseUrl,
  parseReleaseVerifyArgs,
  sanitizeReleaseDetail,
  verifyRuntime
} from "../../scripts/release-verify.mjs";

describe("release verification", () => {
  it("normalizes only credential-free HTTP origins", () => {
    expect(normalizeReleaseUrl("https://scenecart.example.com/app?debug=1")).toBe(
      "https://scenecart.example.com"
    );
    expect(normalizeReleaseUrl("https://first.example.com,https://second.example.com")).toBe(
      "https://first.example.com"
    );
    expect(normalizeReleaseUrl("https://user:secret@example.com")).toBeNull();
    expect(normalizeReleaseUrl("not-a-url")).toBeNull();
    expect(isProductionReleaseUrl("https://scenecart.example.com")).toBe(true);
    expect(isProductionReleaseUrl("http://scenecart.example.com")).toBe(false);
    expect(isProductionReleaseUrl("https://127.0.0.1:3000")).toBe(false);
  });

  it("parses explicit verification options with bounded timeouts", () => {
    expect(parseReleaseVerifyArgs([
      "--json",
      "--static",
      "--url=https://scenecart.example.com",
      "--timeout-ms=20000"
    ])).toEqual({
      json: true,
      staticOnly: true,
      url: "https://scenecart.example.com",
      timeoutMs: 20_000
    });
    expect(() => parseReleaseVerifyArgs(["--timeout-ms=100"])).toThrow("1000 到 120000");
    expect(() => parseReleaseVerifyArgs(["--unknown"])).toThrow("未知参数");
  });

  it("redacts credentials from diagnostic output", () => {
    const databaseUrl = ["postgresql", "://user:password@db.example.com/app"].join("");
    const apiKey = ["s", "k-example-secret-123456"].join("");
    const unsafe = `failed ${databaseUrl} with ${apiKey} Bearer token-value-at-least-12`;
    const safe = sanitizeReleaseDetail(unsafe);
    expect(safe).toContain("[redacted-database-url]");
    expect(safe).toContain("[redacted-api-key]");
    expect(safe).toContain("Bearer [redacted]");
    expect(safe).not.toContain("password");
    expect(safe).not.toContain("example-secret");
  });

  it("verifies health and protected readiness without exposing the token", async () => {
    const calls = [];
    const secret = "release-verification-secret-at-least-32-characters";
    const fetchImpl = async (url, init) => {
      calls.push({ url, authorization: init.headers?.Authorization });
      if (url.endsWith("/api/runtime/health")) {
        return new Response(JSON.stringify({
          status: "healthy",
          product_mode: "production",
          demo_cart_fallback: false,
          runtime_store: "postgres",
          configured_executor_backend: "local_executor",
          effective_executor_backend: "local_executor"
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        ready_for_production: true,
        checks: []
      }), { status: 200 });
    };

    const report = await verifyRuntime("https://scenecart.example.com", {
      secret,
      fetchImpl
    });

    expect(report.checks.map((item) => item.status)).toEqual(["pass", "pass", "pass"]);
    expect(calls).toEqual([
      {
        url: "https://scenecart.example.com/api/runtime/health",
        authorization: undefined
      },
      {
        url: "https://scenecart.example.com/api/internal/runtime-readiness",
        authorization: `Bearer ${secret}`
      }
    ]);
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("fails closed when health is unreachable or the internal secret is absent", async () => {
    const report = await verifyRuntime("https://scenecart.example.com", {
      secret: "",
      fetchImpl: async () => {
        throw new Error("network unavailable");
      }
    });

    expect(report.checks).toMatchObject([
      { id: "runtime_health", status: "fail" },
      { id: "runtime_contract", status: "fail" },
      { id: "runtime_readiness", status: "fail" }
    ]);
  });
});
