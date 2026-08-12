import { describe, expect, it } from "vitest";
import { canAccessSession } from "@/lib/runtime/local-repository";
import { createSessionFixture } from "@/tests/fixtures/session";

describe("local session ownership", () => {
  it("requires exact ownership whenever the request is authenticated", () => {
    const owned = createSessionFixture({ owner_id: "user-a" });
    const legacyAnonymous = createSessionFixture({ owner_id: undefined });

    expect(canAccessSession(owned, "user-a")).toBe(true);
    expect(canAccessSession(owned, "user-b")).toBe(false);
    expect(canAccessSession(legacyAnonymous, "user-a")).toBe(false);
  });

  it("keeps legacy anonymous sessions available in explicit anonymous development", () => {
    const legacyAnonymous = createSessionFixture({ owner_id: undefined });
    expect(canAccessSession(legacyAnonymous)).toBe(true);
  });
});
