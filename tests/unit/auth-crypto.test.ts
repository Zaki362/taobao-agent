import { describe, expect, it } from "vitest";
import {
  createOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  normalizeEmail,
  validatePassword,
  verifyPassword
} from "@/lib/auth/crypto";

describe("authentication crypto", () => {
  it("normalizes email and validates password length", () => {
    expect(normalizeEmail("  USER@Example.COM ")).toBe("user@example.com");
    expect(validatePassword("short")).toContain("8");
    expect(validatePassword("secure-password")).toBeNull();
  });

  it("hashes passwords with a random salt and verifies them safely", async () => {
    const first = await hashPassword("correct horse battery staple");
    const second = await hashPassword("correct horse battery staple");
    expect(first).not.toBe(second);
    expect(await verifyPassword("correct horse battery staple", first)).toBe(true);
    expect(await verifyPassword("wrong password", first)).toBe(false);
  });

  it("stores only a one-way digest for opaque tokens", () => {
    const token = createOpaqueToken();
    expect(token.length).toBeGreaterThan(30);
    expect(hashOpaqueToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashOpaqueToken(token)).not.toContain(token);
  });
});
