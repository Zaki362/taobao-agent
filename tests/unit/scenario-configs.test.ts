import { describe, expect, it } from "vitest";
import { SCENARIO_LIST } from "@/lib/scenarios";

describe("scenario configurations", () => {
  it("exposes five complete shopping scenarios", () => {
    expect(SCENARIO_LIST).toHaveLength(5);

    for (const scenario of SCENARIO_LIST) {
      expect(scenario.enabled).toBe(true);
      expect(scenario.example_prompts).toHaveLength(3);
      expect(scenario.base_template_modules.length).toBeGreaterThanOrEqual(5);
      expect(scenario.quick_actions.length).toBeGreaterThanOrEqual(6);
      expect(scenario.field_option_sets.vehicle_type?.length).toBeGreaterThan(2);
      expect(scenario.field_option_sets.user_stage?.length).toBeGreaterThan(2);
    }
  });
});
