import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  isProductionReleaseUrl,
  normalizeReleaseUrl,
  parseReleaseVerifyArgs,
  sanitizeReleaseDetail,
  verifyRuntime
} from "../../scripts/release-verify.mjs";

describe("release verification", () => {
  it("requires a separate recent live protection receipt in addition to environment declarations", () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scenecart-release-audit-"));
    const receiptPath = path.join(directory, "outer-protection.json");
    const baseEnvironment = {
      ...process.env,
      SCENECART_PRODUCT_MODE: "production",
      ALLOW_DEMO_CART_FALLBACK: "false",
      RUNTIME_STORE: "postgres",
      DATABASE_URL: "postgresql://example.invalid/scenecart",
      DATABASE_SSL: "true",
      DATABASE_SSL_REJECT_UNAUTHORIZED: "true",
      SCENECART_ACCESS_MODE: "single_user",
      SCENECART_SINGLE_USER_ID: "11111111-1111-4111-8111-111111111111",
      VERCEL_ENV: "production",
      VERCEL_PROJECT_ID: "project_scenecart",
      VERCEL_PROJECT_PRODUCTION_URL: "scenecart.example.com",
      SCENECART_OUTER_PROTECTION_VERIFIED: "true",
      SCENECART_OUTER_PROTECTION_SCOPE: "all_deployments",
      SCENECART_OUTER_PROTECTION_VERIFIED_AT: new Date().toISOString(),
      SCENECART_OUTER_PROTECTION_PROJECT_ID: "project_scenecart",
      SCENECART_OUTER_PROTECTION_ORIGIN: "https://scenecart.example.com",
      SCENECART_CRON_SECRET: "release-recovery-secret-with-at-least-32-characters",
      APP_ORIGIN: "https://scenecart.example.com",
      NEXT_PUBLIC_SCENECART_PUBLIC_DEMO_URL: "https://demo.example.com",
      TAOBAO_EXECUTION_BACKEND: "local_executor",
      HOSTED_WORKER_TOKEN: "",
      SCENECART_ENABLE_MCP_DEBUG: "false",
      DEEPSEEK_API_KEY: "release-test-key",
      DEEPSEEK_DISABLED: "false",
      TAOBAO_MCP_MODE: ""
    };
    const runAudit = (environment) => {
      const result = spawnSync(process.execPath, [path.join(root, "scripts/release-audit.mjs"), "--json"], {
        cwd: root,
        env: environment,
        encoding: "utf8"
      });
      return { status: result.status, report: JSON.parse(result.stdout) };
    };

    try {
      const withoutReceipt = runAudit(baseEnvironment);
      expect(withoutReceipt.status).toBe(1);
      expect(withoutReceipt.report.checks.find((item) => item.id === "outer_protection_live_audit"))
        .toMatchObject({ status: "fail" });

      fs.writeFileSync(receiptPath, JSON.stringify({
        version: 1,
        environment: "production",
        project_id: "project_scenecart",
        origin: "https://scenecart.example.com",
        deployment_id: "dpl_verified_candidate",
        verified_at: new Date().toISOString(),
        checks: {
          vercel_protection_settings_observed: true,
          unauthenticated_page_challenged: true,
          unauthenticated_api_challenged: true,
          authorized_owner_page_succeeded: true,
          application_login_absent: true
        }
      }));
      const withReceipt = runAudit({
        ...baseEnvironment,
        SCENECART_OUTER_PROTECTION_AUDIT_RECEIPT: receiptPath
      });
      expect(withReceipt.status).toBe(0);
      expect(withReceipt.report.ready_for_release).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

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
