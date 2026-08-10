import { describe, expect, it } from "vitest";
import {
  normalizeSearchKeywords,
  toStableTaobaoSearchKeyword
} from "@/lib/agent/search-strategy";
import { createSessionFixture } from "@/tests/fixtures/session";
import type { ShoppingPlanModule } from "@/lib/session/types";

describe("Taobao search keyword stability", () => {
  it("sends one concrete product category per module instead of a composite scene query", () => {
    const state = createSessionFixture();
    const modules: ShoppingPlanModule[] = state.shopping_plan.modules.map((module) => {
      const strategy = module.search_strategy;
      return {
        ...module,
        search_keyword: [
          state.scene_brief.vehicle_type,
          module.module_name,
          ...module.typical_item_types.slice(0, 3),
          state.scene_brief.priority_style
        ].join(" "),
        search_strategy: strategy
          ? {
              ...strategy,
              primary_keyword: [
                state.scene_brief.vehicle_type,
                ...module.typical_item_types.slice(0, 3)
              ].join(" "),
              alternate_keywords: [
                `${state.scene_brief.vehicle_type} ${module.typical_item_types[1] ?? module.module_name}`
              ]
            }
          : undefined
      };
    });

    const normalized = normalizeSearchKeywords(state.scene_brief, modules);

    expect(new Set(normalized.map((module) => module.search_keyword)).size).toBe(normalized.length);
    for (const module of normalized) {
      expect(module.typical_item_types).toContain(module.search_keyword);
      expect(module.search_keyword).not.toContain(state.scene_brief.vehicle_type);
      expect(
        module.typical_item_types.filter((term) => module.search_keyword?.includes(term))
      ).toHaveLength(1);
      expect(module.search_strategy?.alternate_keywords.every((keyword) =>
        module.typical_item_types.includes(keyword)
      )).toBe(true);
    }
  });

  it("keeps the category selected by the model but removes extra scene and filter terms", () => {
    const state = createSessionFixture();
    const module = state.shopping_plan.modules.find((item) => item.module_id === "storage-organization");

    expect(module).toBeDefined();
    expect(toStableTaobaoSearchKeyword(
      module!,
      "新能源车 后备箱收纳箱 座椅缝隙收纳 性价比"
    )).toBe("后备箱收纳箱");
  });
});
