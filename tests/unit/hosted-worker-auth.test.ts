import { afterEach, describe, expect, it } from "vitest";
import { ApiRouteError } from "@/lib/api/responses";
import { assertLegacyHostedWorkerAvailable } from "@/lib/auth/hosted-worker";

const originalMode = process.env.SCENECART_PRODUCT_MODE;

afterEach(() => {
  if (originalMode === undefined) {
    delete process.env.SCENECART_PRODUCT_MODE;
  } else {
    process.env.SCENECART_PRODUCT_MODE = originalMode;
  }
});

describe("legacy hosted worker boundary", () => {
  it("keeps the compatibility channel available only in development", () => {
    process.env.SCENECART_PRODUCT_MODE = "development";
    expect(() => assertLegacyHostedWorkerAvailable()).not.toThrow();
  });

  it("fails closed in formal product mode", () => {
    process.env.SCENECART_PRODUCT_MODE = "production";
    try {
      assertLegacyHostedWorkerAvailable();
      throw new Error("expected the legacy hosted channel to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiRouteError);
      expect(error).toMatchObject({
        status: 410,
        code: "legacy_hosted_disabled"
      });
    }
  });
});
