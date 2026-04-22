import {
  PlanningModule,
  QuickAction,
  RecommendationType,
  ScenarioId,
  SceneBrief,
  ShoppingPlan
} from "@/lib/session/types";
import {
  explainProductFitPrompt,
  parseScenePrompt,
  personalizeTemplatePrompt,
  refinePlanPrompt
} from "@/lib/llm/prompts";
import {
  mockExplainProductFit,
  mockParseScene,
  mockPersonalizeTemplate,
  mockRefineScene
} from "@/lib/llm/mock";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com/chat/completions";
const REQUEST_TIMEOUT_MS = 20_000;

type StructuredTask = "parse_scene" | "personalize_template" | "refine_plan";

function hasDeepSeekConfig() {
  return Boolean(process.env.DEEPSEEK_API_KEY);
}

function getStructuredModel(task: StructuredTask) {
  if (task === "parse_scene" || task === "personalize_template") {
    return process.env.DEEPSEEK_CHAT_MODEL ?? "deepseek-chat";
  }
  return process.env.DEEPSEEK_REASONER_MODEL ?? "deepseek-reasoner";
}

function getTextModel() {
  return process.env.DEEPSEEK_CHAT_MODEL ?? "deepseek-chat";
}

function sanitizeScene(scene: SceneBrief): SceneBrief {
  return {
    scenario_id: scene.scenario_id,
    scene_type: scene.scene_type,
    vehicle_type: scene.vehicle_type,
    user_stage: scene.user_stage,
    budget: scene.budget,
    priority_style: scene.priority_style,
    already_have: scene.already_have,
    avoid_items: scene.avoid_items,
    optional_notes: scene.optional_notes
  };
}

function sanitizeTemplate(template: PlanningModule[]) {
  return template.map((module) => ({
    module_id: module.module_id,
    module_name: module.module_name,
    description: module.description,
    default_priority: module.default_priority,
    default_budget_ratio: module.default_budget_ratio,
    typical_item_types: module.typical_item_types,
    optional: module.optional ?? false
  }));
}

function asStringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[，,、]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function asNumber(value: unknown, fallback: number) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const numeric = Number(value.replace(/[^\d.]/g, ""));
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return fallback;
}

function asString(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizePriorityStyle(value: unknown): SceneBrief["priority_style"] {
  if (value === "舒适优先" || value === "安全优先" || value === "性价比优先" || value === "实用优先") {
    return value;
  }
  return "实用优先";
}

function normalizeSceneBrief(value: unknown, fallback: SceneBrief): SceneBrief {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    scenario_id: (typeof source.scenario_id === "string" ? source.scenario_id : fallback.scenario_id) as ScenarioId,
    scene_type: asString(source.scene_type, fallback.scene_type),
    vehicle_type: asString(source.vehicle_type, fallback.vehicle_type),
    user_stage: asString(source.user_stage, fallback.user_stage),
    budget: asNumber(source.budget, fallback.budget),
    priority_style: normalizePriorityStyle(source.priority_style),
    already_have: asStringArray(source.already_have),
    avoid_items: asStringArray(source.avoid_items),
    optional_notes: asString(source.optional_notes, fallback.optional_notes)
  };
}

function normalizeShoppingPlan(value: unknown, fallback: ShoppingPlan): ShoppingPlan {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const rawModules = Array.isArray(source.modules) ? source.modules : [];

  return {
    overall_rationale: asString(source.overall_rationale, fallback.overall_rationale),
    personalization_summary: asString(source.personalization_summary, fallback.personalization_summary),
    modules:
      rawModules.length > 0
        ? rawModules.map((item, index) => {
            const raw = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
            const base = fallback.modules[index] ?? fallback.modules[0];
            return {
              ...base,
              module_id: asString(raw.module_id, base.module_id),
              module_name: asString(raw.module_name, base.module_name),
              description: asString(raw.description, base.description),
              default_priority: asNumber(raw.default_priority, base.default_priority),
              default_budget_ratio: asNumber(raw.default_budget_ratio, base.default_budget_ratio),
              typical_item_types: asStringArray(raw.typical_item_types).length
                ? asStringArray(raw.typical_item_types)
                : base.typical_item_types,
              optional: typeof raw.optional === "boolean" ? raw.optional : base.optional,
              priority: asNumber(raw.priority, base.priority),
              budget_allocation: asNumber(raw.budget_allocation, base.budget_allocation),
              rationale: asString(raw.rationale, base.rationale),
              recommendation_strategy: asString(raw.recommendation_strategy, base.recommendation_strategy),
              status:
                raw.status === "pending" || raw.status === "ready" || raw.status === "refined"
                  ? raw.status
                  : base.status
            };
          })
        : fallback.modules
  };
}

async function fetchWithTimeout(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function deepseekJson<T>(task: StructuredTask, prompt: string, fallback: T): Promise<T> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return fallback;
  }

  try {
    const response = await fetchWithTimeout(DEEPSEEK_BASE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: getStructuredModel(task),
        temperature: task === "parse_scene" ? 0.2 : 0.3,
        messages: [
          {
            role: "system",
            content: "你是一个严谨的购物场景规划助手，输出必须严格遵守 JSON 结构。"
          },
          {
            role: "user",
            content: prompt
          }
        ],
        response_format: {
          type: "json_object"
        }
      }),
      cache: "no-store"
    });

    if (!response.ok) {
      return fallback;
    }

    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      return fallback;
    }
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}

export async function parseScene(input: string, scenarioId: ScenarioId): Promise<{ data: SceneBrief; mode: "connected" | "mock" }> {
  const fallback = mockParseScene(input, scenarioId);
  const rawData = await deepseekJson<SceneBrief>("parse_scene", parseScenePrompt(input, scenarioId), fallback);
  const data = normalizeSceneBrief(rawData, fallback);
  return {
    data,
    mode: hasDeepSeekConfig() ? "connected" : "mock"
  };
}

export async function personalizeTemplate(
  scene: SceneBrief,
  template: PlanningModule[]
): Promise<{ data: ShoppingPlan; mode: "connected" | "mock" }> {
  const safeScene = sanitizeScene(scene);
  const safeTemplate = sanitizeTemplate(template);
  const fallback = mockPersonalizeTemplate(safeScene, template);
  const rawData = await deepseekJson<ShoppingPlan>(
    "personalize_template",
    personalizeTemplatePrompt(safeScene, safeTemplate),
    fallback
  );
  const data = normalizeShoppingPlan(rawData, fallback);
  return {
    data,
    mode: hasDeepSeekConfig() ? "connected" : "mock"
  };
}

export async function refinePlan(
  scene: SceneBrief,
  action: QuickAction
): Promise<{ data: SceneBrief; mode: "connected" | "mock" }> {
  const safeScene = sanitizeScene(scene);
  const fallback = mockRefineScene(safeScene, action);
  const rawData = await deepseekJson<SceneBrief>("refine_plan", refinePlanPrompt(safeScene, action), fallback);
  const data = normalizeSceneBrief(rawData, fallback);
  return {
    data,
    mode: hasDeepSeekConfig() ? "connected" : "mock"
  };
}

export async function explainProductFit(moduleName: string, title: string, recommendationType: RecommendationType) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return mockExplainProductFit(moduleName, { title, recommendation_type: recommendationType });
  }

  try {
    const response = await fetchWithTimeout(DEEPSEEK_BASE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: getTextModel(),
        temperature: 0.5,
        messages: [
          {
            role: "system",
            content: "你是一个购物推荐助手，请用一句简洁中文回答。"
          },
          {
            role: "user",
            content: explainProductFitPrompt(moduleName, title)
          }
        ]
      }),
      cache: "no-store"
    });
    if (!response.ok) {
      throw new Error("deepseek explain failed");
    }
    const payload = await response.json();
    return payload.choices?.[0]?.message?.content ?? mockExplainProductFit(moduleName, { title, recommendation_type: recommendationType });
  } catch {
    return mockExplainProductFit(moduleName, { title, recommendation_type: recommendationType });
  }
}
