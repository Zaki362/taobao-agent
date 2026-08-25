import { describe, expect, it } from "vitest";
import { pacePublicDemoTourDuration } from "@/lib/demo/tour-timing";

describe("public demo tour timing", () => {
  it("keeps the fourth tour step at the original cadence", () => {
    expect(pacePublicDemoTourDuration(2200, 3)).toBe(2200);
  });

  it("accelerates the results boundary and later steps by 1.5x", () => {
    expect(pacePublicDemoTourDuration(2200, 4)).toBe(1467);
    expect(pacePublicDemoTourDuration(1050, 4)).toBe(700);
    expect(pacePublicDemoTourDuration(180, 4)).toBe(120);
    expect(pacePublicDemoTourDuration(4200, 14)).toBe(2800);
  });
});
