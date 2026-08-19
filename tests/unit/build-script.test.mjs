import { describe, expect, it } from "vitest";
import { shouldRunProductionMigrations } from "../../scripts/build.mjs";

describe("production build migration gate", () => {
  it("runs migrations only for Vercel Production builds", () => {
    expect(shouldRunProductionMigrations({ VERCEL_ENV: "production" })).toBe(true);
    expect(shouldRunProductionMigrations({ VERCEL_ENV: "preview" })).toBe(false);
    expect(shouldRunProductionMigrations({ VERCEL_ENV: "development" })).toBe(false);
    expect(shouldRunProductionMigrations({})).toBe(false);
  });
});
