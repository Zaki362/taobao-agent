import { afterEach, describe, expect, it } from "vitest";
import { ApiRouteError } from "@/lib/api/responses";
import { assertWorkflowRecoveryAccess } from "@/lib/runtime/internal-auth";

const originalSecret = process.env.SCENECART_CRON_SECRET;

afterEach(() => {
  if (originalSecret === undefined) {
    delete process.env.SCENECART_CRON_SECRET;
  } else {
    process.env.SCENECART_CRON_SECRET = originalSecret;
  }
});

describe("workflow recovery internal authentication", () => {
  const validSecret = "recovery-test-secret-with-at-least-32-characters";

  function rejected(request: Request) {
    try {
      assertWorkflowRecoveryAccess(request);
      throw new Error("expected recovery access to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiRouteError);
      return error as ApiRouteError;
    }
  }

  it("fails closed when the recovery secret is not configured", () => {
    delete process.env.SCENECART_CRON_SECRET;
    expect(rejected(new Request("http://localhost/internal"))).toMatchObject({
      status: 503,
      code: "recovery_not_configured"
    });
  });

  it("rejects a missing or incorrect bearer token", () => {
    process.env.SCENECART_CRON_SECRET = validSecret;
    expect(rejected(new Request("http://localhost/internal"))).toMatchObject({ status: 401 });
    expect(rejected(new Request("http://localhost/internal", {
      headers: { Authorization: "Bearer wrong-secret" }
    }))).toMatchObject({ status: 401 });
  });

  it("accepts only the configured bearer token", () => {
    process.env.SCENECART_CRON_SECRET = validSecret;
    expect(() => assertWorkflowRecoveryAccess(new Request("http://localhost/internal", {
      headers: { Authorization: `Bearer ${validSecret}` }
    }))).not.toThrow();
  });
});
