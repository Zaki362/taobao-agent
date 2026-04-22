import { PlanningModule, QuickAction, SceneBrief } from "@/lib/session/types";
import { getScenarioConfig } from "@/lib/scenarios";

function dataBoundaryNotice() {
  return [
    "数据边界：只可使用用户场景描述、预算、偏好、已有物品、不想买的类别、基础模板、模块定义和候选商品摘要。",
    "禁止使用或索取订单历史、收货地址、手机号、联系人信息、旺旺聊天记录、账号昵称头像等身份信息、购物车原始敏感数据、浏览记录原始明细。"
  ].join("\n");
}

export function parseScenePrompt(input: string, scenarioId: SceneBrief["scenario_id"]) {
  const scenario = getScenarioConfig(scenarioId);
  return [
    `你是“${scenario.name}”场景化购物 Agent 的场景理解器。`,
    "请把用户输入解析为结构化 Scene Brief，缺失字段使用合理默认值。",
    "输出只允许 JSON。",
    dataBoundaryNotice(),
    `场景字段标签：${JSON.stringify(scenario.field_labels, null, 2)}`,
    `用户输入：${input}`
  ].join("\n");
}

export function personalizeTemplatePrompt(scene: SceneBrief, template: PlanningModule[]) {
  const scenario = getScenarioConfig(scene.scenario_id);
  return [
    `你负责在“${scenario.name}”场景模板基础上做个性化补充，而不是从零生成结构。`,
    "请基于以下 Scene Brief 调整模块优先级、预算比例、策略说明和裁剪建议。",
    "输出必须是严格 JSON，不要附加解释性文本。",
    dataBoundaryNotice(),
    `Scene Brief: ${JSON.stringify(scene, null, 2)}`,
    `Template: ${JSON.stringify(template, null, 2)}`
  ].join("\n");
}

export function refinePlanPrompt(scene: SceneBrief, action: QuickAction) {
  const scenario = getScenarioConfig(scene.scenario_id);
  return [
    `你负责响应快捷操作，对既有“${scenario.name}”方案做轻量重算。`,
    "请只返回需要调整的字段、受影响模块和新的策略摘要。",
    "输出必须是严格 JSON，不要附加解释性文本。",
    dataBoundaryNotice(),
    `Scene Brief: ${JSON.stringify(scene, null, 2)}`,
    `Quick Action: ${action}`
  ].join("\n");
}

export function explainProductFitPrompt(moduleName: string, title: string) {
  return [
    "你负责生成商品适配理由。",
    "请给出一句简洁中文说明，解释商品为什么适合当前模块和场景。",
    dataBoundaryNotice(),
    `模块：${moduleName}`,
    `商品标题：${title}`
  ].join("\n");
}
