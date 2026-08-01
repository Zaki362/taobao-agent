import { describe, expect, it } from "vitest";
import {
  InvalidSearchKeywordError,
  moduleSearchAnchorTerms,
  normalizeModelSearchKeyword,
  requireValidModuleSearchKeyword,
  validateAutonomousSearchKeyword
} from "@/lib/agent/search-strategy";
import { apiRouteError } from "@/lib/api/responses";
import { createSessionFixture } from "@/tests/fixtures/session";

describe("module search keyword guard", () => {
  it("keeps model freedom for brand and feature terms inside the module envelope", () => {
    const module = createSessionFixture().shopping_plan.modules[0];
    const anchor = module.typical_item_types[0];
    const validation = validateAutonomousSearchKeyword(
      module,
      `  ${anchor}   官方旗舰 夜视 高性价比  `
    );

    expect(validation).toMatchObject({
      valid: true,
      normalized: `${anchor} 官方旗舰 夜视 高性价比`
    });
    expect(validation.matched_anchors).toContain(anchor);
    expect(moduleSearchAnchorTerms(module)).toContain(anchor);
  });

  it("rejects unrelated, overlong, multiline, URL and command keywords", () => {
    const module = createSessionFixture().shopping_plan.modules[0];
    const anchor = module.typical_item_types[0];
    const validation = validateAutonomousSearchKeyword(
      module,
      `${anchor}\nhttps://example.com --yolo taobao-native ${"超".repeat(90)}`
    );

    expect(validation.valid).toBe(false);
    expect(validation.notes).toEqual(expect.arrayContaining([
      "自主搜索词不能超过 80 个字符",
      "自主搜索词不能包含换行或控制字符",
      "自主搜索词不能包含 URL",
      "自主搜索词不能包含工具调用指令",
      "自主搜索词不能包含命令行参数"
    ]));
  });

  it("throws a typed error for an invalid manual keyword", () => {
    const module = createSessionFixture().shopping_plan.modules[0];

    expect(() => requireValidModuleSearchKeyword(module, "露营帐篷 户外过夜"))
      .toThrow(InvalidSearchKeywordError);
  });

  it("repairs a grounded model filter while keeping manual inputs strict", () => {
    const module = createSessionFixture().shopping_plan.modules[0];
    const groundedSignal = module.search_strategy?.ranking_focus[0] ?? "适配当前阶段";
    const modelKeyword = `官方旗舰 ${groundedSignal} 高性价比`;
    const normalized = normalizeModelSearchKeyword(module, modelKeyword);

    expect(normalized.valid).toBe(true);
    expect(normalized.repaired).toBe(true);
    expect(normalized.normalized).toContain(module.typical_item_types[0]);
    expect(normalized.repair_notes[0]).toContain("补齐品类锚点");
    expect(() => requireValidModuleSearchKeyword(module, modelKeyword)).toThrow(InvalidSearchKeywordError);
  });

  it("does not repair unrelated or instruction-like model keywords", () => {
    const module = createSessionFixture().shopping_plan.modules[0];

    expect(normalizeModelSearchKeyword(module, "双人露营帐篷 户外过夜").valid).toBe(false);
    expect(normalizeModelSearchKeyword(module, "帐篷旗舰 适配当前阶段").valid).toBe(false);
    expect(normalizeModelSearchKeyword(module, "官方旗舰 taobao-native --yolo").valid).toBe(false);
  });

  it("maps invalid manual keywords to a stable public 400 response", async () => {
    const response = apiRouteError(
      new InvalidSearchKeywordError("搜索词与模块不匹配", ["搜索词与模块不匹配"]),
      "failed to update search strategy"
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "搜索词与模块不匹配",
      code: "invalid_search_keyword"
    });
  });
});
