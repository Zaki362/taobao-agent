import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import {
  boundedNumber,
  boundedStringArray,
  readJsonObject
} from "@/lib/api/validation";

describe("API input validation", () => {
  it("rejects oversized request bodies before parsing", async () => {
    const request = new NextRequest("http://localhost/api/test", {
      method: "POST",
      body: JSON.stringify({ value: "x".repeat(100) }),
      headers: { "content-type": "application/json" }
    });
    await expect(readJsonObject(request, 32)).rejects.toMatchObject({
      status: 413,
      code: "payload_too_large"
    });
  });

  it("rejects invalid JSON and non-object JSON", async () => {
    const invalid = new NextRequest("http://localhost/api/test", { method: "POST", body: "{" });
    await expect(readJsonObject(invalid)).rejects.toMatchObject({ code: "invalid_json" });
    const array = new NextRequest("http://localhost/api/test", { method: "POST", body: "[]" });
    await expect(readJsonObject(array)).rejects.toMatchObject({ code: "invalid_json" });
  });

  it("enforces list cardinality and item length", () => {
    expect(() => boundedStringArray(["a", "b", "c"], "items", { maxItems: 2, maxItemLength: 10 }))
      .toThrow("at most 2 items");
    expect(() => boundedStringArray(["too-long"], "items", { maxItems: 2, maxItemLength: 3 }))
      .toThrow("at most 3 characters");
  });

  it("enforces numeric ranges", () => {
    expect(() => boundedNumber(0, "budget", { min: 1, max: 100, fallback: 10 }))
      .toThrow("between 1 and 100");
    expect(boundedNumber(undefined, "budget", { min: 1, max: 100, fallback: 10 })).toBe(10);
  });
});
