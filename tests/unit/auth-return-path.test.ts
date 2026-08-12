import { describe, expect, it } from "vitest";
import { normalizeAuthReturnPath } from "@/lib/auth/return-path";

describe("authentication return path", () => {
  it("keeps safe same-origin application paths", () => {
    expect(normalizeAuthReturnPath("/settings/executor")).toBe("/settings/executor");
    expect(normalizeAuthReturnPath("/?resume=1#progress")).toBe("/?resume=1#progress");
  });

  it("rejects external, protocol-relative and ambiguous redirects", () => {
    expect(normalizeAuthReturnPath("https://example.com/steal")).toBe("/");
    expect(normalizeAuthReturnPath("//example.com/steal")).toBe("/");
    expect(normalizeAuthReturnPath("/\\example.com/steal")).toBe("/");
    expect(normalizeAuthReturnPath("/login")).toBe("/");
    expect(normalizeAuthReturnPath(["/settings/executor"])).toBe("/");
  });
});
