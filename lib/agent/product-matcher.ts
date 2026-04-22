import { getExecutionBackend } from "@/lib/mcp/client";
import { executeMcpTool } from "@/lib/mcp/executor";
import { queueModuleSearchTask } from "@/lib/mcp/hosted";
import { searchIntentForModule } from "@/lib/agent/search-intents";
import { ProductCandidate, SessionState } from "@/lib/session/types";

function buildFastFitReason(moduleName: string, title: string, recommendationType: ProductCandidate["recommendation_type"]) {
  const feature =
    moduleName === "安全必需"
      ? "优先覆盖行车安全和取证刚需"
      : moduleName === "车内实用"
        ? "优先解决上车后高频使用场景"
        : moduleName === "清洁维护"
          ? "更适合作为提车初期的基础维护补充"
          : moduleName === "收纳整理"
            ? "更适合快速改善车内和后备箱整理效率"
            : "更适合作为首阶段补充配置";

  const strategy =
    recommendationType === "稳妥推荐"
      ? "整体选择更稳妥，适合先下单确认核心需求。"
      : recommendationType === "性价比推荐"
        ? "价格和实用性更均衡，适合控制预算。"
        : "规格更高，适合希望一步到位的选择。";

  return `「${title}」${feature}，${strategy}`;
}

export async function runModuleSearch(state: SessionState, moduleId: string) {
  const module = state.shopping_plan.modules.find((item) => item.module_id === moduleId);
  if (!module) {
    throw new Error("module not found");
  }

  const searchIntent = module.search_keyword || searchIntentForModule(state.scene_brief, module);
  if (getExecutionBackend() === "codex_hosted") {
    queueModuleSearchTask(state, {
      module_id: module.module_id,
      module_name: module.module_name,
      search_intent: searchIntent
    });
    return state.module_candidates[moduleId] ?? [];
  }

  const searchResult = await executeMcpTool(state, "search_taobao_products", {
    keyword: searchIntent,
    module_id: module.module_id
  }, {
    module_id: module.module_id,
    module_name: module.module_name
  });

  const rotatedResults =
    state.last_action === "换一批推荐" && searchResult.results.length > 1
      ? [...searchResult.results.slice(1), searchResult.results[0]]
      : searchResult.results;

  const candidates: ProductCandidate[] = [];
  const recommendationTypes: Array<ProductCandidate["recommendation_type"]> = [
    "稳妥推荐",
    "性价比推荐",
    "升级推荐"
  ];

  for (let index = 0; index < rotatedResults.slice(0, 3).length; index += 1) {
    const item = rotatedResults[index];
    if (!item) {
      continue;
    }

    const recommendationType = recommendationTypes[index] ?? "稳妥推荐";
    const detail = {
      product_id: item.product_id,
      title: item.title,
      price: item.price,
      shop_name: item.shop_name,
      image_url: item.image_url,
      detail_url: item.detail_url,
      shop_badges: item.shop_badges,
      highlights: item.highlights,
      risk_notes: ["当前为搜索结果摘要，未自动打开详情页，建议点开淘宝详情页确认规格与适配性"]
    };

    candidates.push({
      product_id: detail.product_id,
      title: detail.title,
      price: detail.price,
      source: "淘宝",
      shop_name: detail.shop_name,
      image_url: detail.image_url,
      detail_url: detail.detail_url,
      shop_badges: detail.shop_badges,
      highlights: detail.highlights,
      risk_notes: detail.risk_notes,
      fit_reason: buildFastFitReason(module.module_name, detail.title, recommendationType),
      recommendation_type: recommendationType,
      module_id: module.module_id
    });
  }

  state.module_candidates[moduleId] = candidates;
  return candidates;
}
