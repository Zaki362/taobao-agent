import {
  AgentDecisionProposal,
  PlanningModule,
  ModuleCandidateReview,
  PlanQualityReview,
  ProductCandidate,
  QuickAction,
  RecommendationType,
  ScenarioId,
  SceneBrief,
  SessionState,
  ShoppingPlan,
  ShoppingPlanModule
} from "@/lib/session/types";
import {
  explainProductFitPrompt,
  parseScenePrompt,
  personalizeTemplatePrompt,
  reviewCandidatePoolPrompt,
  reviewShoppingPlanPrompt,
  refinePlanPrompt,
  decideNextActionPrompt
} from "@/lib/llm/prompts";
import {
  mockExplainProductFit,
  mockParseScene,
  mockPersonalizeTemplate,
  mockReviewShoppingPlan,
  mockRefineScene
} from "@/lib/llm/mock";
import { normalizeSceneBriefOptions } from "@/lib/scenarios/normalize";
import { getScenarioConfig, isScenarioId } from "@/lib/scenarios";
import {
  validateProductFitOutput,
  validateCandidateReviewOutput,
  validatePlanQualityReviewOutput,
  validateSceneBriefOutput,
  validateShoppingPlanOutput,
  validateAgentDecisionOutput
} from "@/lib/llm/validation";
import { downgradeLastLlmCall, recordLlmCall, type LlmTaskName } from "@/lib/llm/telemetry";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com/chat/completions";
const REQUEST_TIMEOUT_MS = 20_000;
const REVIEW_TIMEOUT_MS = 8_000;
const PLAN_REVIEW_TIMEOUT_MS = 6_000;
const AGENT_DECISION_TIMEOUT_MS = 8_000;

type StructuredTask = LlmTaskName;
type LlmMode = "connected" | "mock";

function getStructuredModel(task: StructuredTask) {
  if (task === "decide_next_action") {
    return process.env.DEEPSEEK_REASONER_MODEL ?? "deepseek-reasoner";
  }
  if (task === "parse_scene" || task === "personalize_template" || task === "review_candidates" || task === "review_plan") {
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

function asBudgetRatio(value: unknown, fallback: number) {
  const ratio = asNumber(value, fallback);
  return ratio > 1 && ratio <= 100 ? ratio / 100 : ratio;
}

function asString(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function uniqueStringArray(values: string[], maxItems = 5) {
  return Array.from(new Set(values.map((item) => item.trim()).filter(Boolean))).slice(0, maxItems);
}

function normalizePriorityStyle(value: unknown): SceneBrief["priority_style"] {
  if (value === "舒适优先" || value === "安全优先" || value === "性价比优先" || value === "实用优先") {
    return value;
  }
  return "实用优先";
}

function normalizeSearchStrategy(value: unknown, fallback: ShoppingPlan["modules"][number]["search_strategy"]) {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  if (!fallback && !asString(source.primary_keyword, "")) {
    return undefined;
  }

  return {
    primary_keyword: asString(source.primary_keyword, fallback?.primary_keyword ?? ""),
    alternate_keywords: uniqueStringArray(
      asStringArray(source.alternate_keywords).length
        ? asStringArray(source.alternate_keywords)
        : fallback?.alternate_keywords ?? [],
      3
    ),
    include_terms: asStringArray(source.include_terms).length
      ? uniqueStringArray(asStringArray(source.include_terms))
      : fallback?.include_terms ?? [],
    exclude_terms: asStringArray(source.exclude_terms).length
      ? uniqueStringArray(asStringArray(source.exclude_terms))
      : fallback?.exclude_terms ?? [],
    ranking_focus: asStringArray(source.ranking_focus).length
      ? uniqueStringArray(asStringArray(source.ranking_focus))
      : fallback?.ranking_focus ?? [],
    must_have_signals: asStringArray(source.must_have_signals).length
      ? uniqueStringArray(asStringArray(source.must_have_signals), 4)
      : fallback?.must_have_signals ?? [],
    reject_signals: asStringArray(source.reject_signals).length
      ? uniqueStringArray(asStringArray(source.reject_signals), 4)
      : fallback?.reject_signals ?? [],
    quality_checks: asStringArray(source.quality_checks).length
      ? uniqueStringArray(asStringArray(source.quality_checks), 4)
      : fallback?.quality_checks ?? [],
    price_band: asString(source.price_band, fallback?.price_band ?? ""),
    reasoning: asString(source.reasoning, fallback?.reasoning ?? ""),
    failure_recovery: asString(source.failure_recovery, fallback?.failure_recovery ?? "")
  };
}

function normalizeExecutionStrategy(
  value: unknown,
  fallback: ShoppingPlan["execution_strategy"],
  allowedModuleIds: string[]
): ShoppingPlan["execution_strategy"] {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const allowed = new Set(allowedModuleIds);
  const moduleSequence = asStringArray(source.module_sequence).filter((moduleId) => allowed.has(moduleId));

  return {
    module_sequence: moduleSequence.length ? moduleSequence : fallback.module_sequence,
    budget_guardrails: asStringArray(source.budget_guardrails).length
      ? asStringArray(source.budget_guardrails)
      : fallback.budget_guardrails,
    tradeoffs: asStringArray(source.tradeoffs).length
      ? asStringArray(source.tradeoffs)
      : fallback.tradeoffs,
    search_notes: asStringArray(source.search_notes).length
      ? asStringArray(source.search_notes)
      : fallback.search_notes,
    stop_rules: asStringArray(source.stop_rules).length
      ? asStringArray(source.stop_rules)
      : fallback.stop_rules
  };
}

export function normalizeAgentDirectives(
  value: unknown,
  fallback: ShoppingPlan["agent_directives"]
): ShoppingPlan["agent_directives"] {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const autonomyLevel =
    source.autonomy_level === "保守执行" ||
    source.autonomy_level === "平衡执行" ||
    source.autonomy_level === "探索执行"
      ? source.autonomy_level
      : fallback.autonomy_level;
  const searchDepth =
    source.search_depth === "轻量搜索" ||
    source.search_depth === "标准搜索" ||
    source.search_depth === "深度搜索"
      ? source.search_depth
      : fallback.search_depth;

  return {
    autonomy_level: autonomyLevel,
    search_depth: searchDepth,
    detail_policy: asString(source.detail_policy, fallback.detail_policy),
    recovery_policy: asString(source.recovery_policy, fallback.recovery_policy),
    rerank_rules: asStringArray(source.rerank_rules).length
      ? uniqueStringArray(asStringArray(source.rerank_rules), 4)
      : fallback.rerank_rules,
    user_confirmation_points: uniqueStringArray([
      ...fallback.user_confirmation_points,
      ...asStringArray(source.user_confirmation_points)
    ], 5),
    safety_boundaries: uniqueStringArray([
      ...fallback.safety_boundaries,
      ...asStringArray(source.safety_boundaries)
    ], 6)
  };
}

function normalizeCandidateReview(
  value: Partial<ModuleCandidateReview>,
  fallback: ModuleCandidateReview
): ModuleCandidateReview {
  return {
    module_id: asString(value.module_id, fallback.module_id),
    status:
      value.status === "ready" ||
      value.status === "needs_detail_check" ||
      value.status === "thin" ||
      value.status === "needs_refine"
        ? value.status
        : fallback.status,
    source: "deepseek",
    summary: asString(value.summary, fallback.summary),
    strengths: uniqueStringArray(asStringArray(value.strengths), 4).length
      ? uniqueStringArray(asStringArray(value.strengths), 4)
      : fallback.strengths,
    caveats: uniqueStringArray(asStringArray(value.caveats), 4).length
      ? uniqueStringArray(asStringArray(value.caveats), 4)
      : fallback.caveats,
    next_action: asString(value.next_action, fallback.next_action),
    suggested_keyword: asString(value.suggested_keyword, fallback.suggested_keyword ?? "") || undefined,
    generated_at: new Date().toISOString()
  };
}

function normalizePlanQualityReview(
  value: Partial<PlanQualityReview>,
  fallback: PlanQualityReview
): PlanQualityReview {
  return {
    status:
      value.status === "ready" || value.status === "needs_attention" || value.status === "risky"
        ? value.status
        : fallback.status,
    source: "deepseek",
    summary: asString(value.summary, fallback.summary),
    strengths: uniqueStringArray(asStringArray(value.strengths), 4).length
      ? uniqueStringArray(asStringArray(value.strengths), 4)
      : fallback.strengths,
    risks: uniqueStringArray(asStringArray(value.risks), 4).length
      ? uniqueStringArray(asStringArray(value.risks), 4)
      : fallback.risks,
    improvement_suggestions: uniqueStringArray(asStringArray(value.improvement_suggestions), 4).length
      ? uniqueStringArray(asStringArray(value.improvement_suggestions), 4)
      : fallback.improvement_suggestions,
    budget_comment: asString(value.budget_comment, fallback.budget_comment),
    keyword_comment: asString(value.keyword_comment, fallback.keyword_comment),
    module_comment: asString(value.module_comment, fallback.module_comment),
    generated_at: new Date().toISOString()
  };
}

function normalizeOptionalNotes(value: unknown, fallback: string) {
  const originalNotes = fallback.trim();
  const modelNotes = asString(value, "").trim();
  if (!modelNotes || /^(无|无额外说明|暂无|none)$/i.test(modelNotes)) {
    return originalNotes;
  }
  if (!originalNotes || modelNotes.includes(originalNotes)) {
    return modelNotes;
  }
  if (originalNotes.includes(modelNotes)) {
    return originalNotes;
  }
  return `${originalNotes}\n模型补充：${modelNotes}`;
}

export function normalizeSceneBrief(value: unknown, fallback: SceneBrief): SceneBrief {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return normalizeSceneBriefOptions({
    scenario_id: isScenarioId(source.scenario_id) ? source.scenario_id : fallback.scenario_id,
    scene_type: asString(source.scene_type, fallback.scene_type),
    vehicle_type: asString(source.vehicle_type, fallback.vehicle_type),
    user_stage: asString(source.user_stage, fallback.user_stage),
    budget: asNumber(source.budget, fallback.budget),
    priority_style: normalizePriorityStyle(source.priority_style),
    already_have: asStringArray(source.already_have),
    avoid_items: asStringArray(source.avoid_items),
    optional_notes: normalizeOptionalNotes(source.optional_notes, fallback.optional_notes)
  }, fallback);
}

export function normalizeShoppingPlan(
  value: unknown,
  fallback: ShoppingPlan,
  template: PlanningModule[] = fallback.modules
): ShoppingPlan {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const rawModules = Array.isArray(source.modules) ? source.modules : [];
  const fallbackById = new Map(fallback.modules.map((module) => [module.module_id, module]));
  const templateById = new Map(template.map((module) => [module.module_id, module]));
  const normalizedModules: ShoppingPlanModule[] = rawModules.length > 0
    ? rawModules.map((item) => {
        const raw = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
        const rawModuleId = asString(raw.module_id, "");
        const personalizedBase = fallbackById.get(rawModuleId);
        const templateDefinition = templateById.get(rawModuleId);
        const itemTypes = uniqueStringArray(asStringArray(raw.typical_item_types), 6);
        const adaptivePrimaryKeyword = asString(
          raw.search_keyword,
          asString(
            raw.search_strategy && typeof raw.search_strategy === "object"
              ? (raw.search_strategy as Record<string, unknown>).primary_keyword
              : undefined,
            `${asString(raw.module_name, "专项需求")} ${itemTypes.slice(0, 3).join(" ")}`.trim()
          )
        );
        const adaptiveBase: ShoppingPlanModule = {
          module_id: rawModuleId,
          module_name: asString(raw.module_name, "专项需求"),
          description: asString(raw.description, "根据用户特殊使用场景补充的可选模块。"),
          default_priority: Math.max(1, Math.min(asNumber(raw.default_priority, 50), 120)),
          default_budget_ratio: Math.max(0.03, Math.min(asBudgetRatio(raw.default_budget_ratio, 0.1), 0.3)),
          typical_item_types: itemTypes,
          optional: true,
          origin: "ai_adaptive",
          priority: asNumber(raw.priority, 50),
          budget_allocation: Math.max(0, asNumber(raw.budget_allocation, 0)),
          rationale: asString(raw.rationale, "用户描述中存在基础模板未覆盖的专项需求。"),
          recommendation_strategy: asString(raw.recommendation_strategy, "优先选择需求匹配明确、规格清楚且预算可控的商品。"),
          search_keyword: adaptivePrimaryKeyword,
          search_strategy: {
            primary_keyword: adaptivePrimaryKeyword,
            alternate_keywords: [],
            include_terms: itemTypes.slice(0, 3),
            exclude_terms: [],
            ranking_focus: ["专项需求匹配", "规格明确", "预算可控"],
            must_have_signals: itemTypes.slice(0, 4),
            reject_signals: [],
            quality_checks: ["商品图片完整", "详情链接可打开", "店铺信息明确", "规格描述清楚"],
            price_band: "按模块预算控制",
            reasoning: "围绕用户明确提出的专项使用场景搜索。",
            failure_recovery: "首轮候选不足时，改用更明确的用品类型补搜一次。"
          },
          status: "ready"
        };
        const templateBase = templateDefinition
          ? {
              ...adaptiveBase,
              ...templateDefinition,
              module_id: templateDefinition.module_id,
              module_name: templateDefinition.module_name,
              description: templateDefinition.description,
              typical_item_types: templateDefinition.typical_item_types,
              optional: templateDefinition.optional,
              origin: "base_template" as const
            }
          : undefined;
        const isTemplateModule = Boolean(templateDefinition);
        const base = personalizedBase ?? templateBase ?? adaptiveBase;
        const moduleId = isTemplateModule ? templateDefinition!.module_id : rawModuleId;
        return {
          ...base,
          module_id: moduleId,
          module_name: asString(raw.module_name, base.module_name),
          description: asString(raw.description, base.description),
          default_priority: asNumber(raw.default_priority, base.default_priority),
          default_budget_ratio: isTemplateModule
            ? Math.max(0.01, Math.min(asBudgetRatio(raw.default_budget_ratio, base.default_budget_ratio), 1))
            : Math.max(0.03, Math.min(asBudgetRatio(raw.default_budget_ratio, base.default_budget_ratio), 0.3)),
          typical_item_types: itemTypes.length ? itemTypes : base.typical_item_types,
          optional: isTemplateModule
            ? (typeof raw.optional === "boolean" ? raw.optional : base.optional)
            : true,
          origin: isTemplateModule ? "base_template" : "ai_adaptive",
          priority: asNumber(raw.priority, base.priority),
          budget_allocation: asNumber(raw.budget_allocation, base.budget_allocation),
          rationale: asString(raw.rationale, base.rationale),
          recommendation_strategy: asString(raw.recommendation_strategy, base.recommendation_strategy),
          search_keyword: asString(raw.search_keyword, base.search_keyword ?? ""),
          search_strategy: normalizeSearchStrategy(raw.search_strategy, base.search_strategy),
          status:
            raw.status === "pending" || raw.status === "ready" || raw.status === "refined"
              ? raw.status
              : base.status
        };
      })
    : fallback.modules.map((module) => ({ ...module, origin: module.origin ?? "base_template" }));
  const hasModelAdaptiveModule = normalizedModules.some((module) => module.origin === "ai_adaptive");
  const adaptiveBackfill = hasModelAdaptiveModule
    ? []
    : fallback.modules.filter(
        (module) =>
          module.origin === "ai_adaptive" &&
          !normalizedModules.some((item) => item.module_id === module.module_id)
      );
  const modules = [...normalizedModules, ...adaptiveBackfill];
  const executionStrategy = normalizeExecutionStrategy(
    source.execution_strategy,
    fallback.execution_strategy,
    modules.map((module) => module.module_id)
  );
  const moduleSequence = [
    ...executionStrategy.module_sequence,
    ...modules
      .map((module) => module.module_id)
      .filter((moduleId) => !executionStrategy.module_sequence.includes(moduleId))
  ];

  return {
    overall_rationale: asString(source.overall_rationale, fallback.overall_rationale),
    personalization_summary: asString(source.personalization_summary, fallback.personalization_summary),
    execution_strategy: {
      ...executionStrategy,
      module_sequence: moduleSequence
    },
    agent_directives: normalizeAgentDirectives(source.agent_directives, fallback.agent_directives),
    modules
  };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function deepseekJson<T>(
  task: StructuredTask,
  prompt: string,
  fallback: T,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<{ data: T; mode: LlmMode }> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const startedAt = Date.now();
  const model = getStructuredModel(task);
  const finish = (data: T, mode: LlmMode, reason?: string) => {
    recordLlmCall({ task, model, mode, durationMs: Date.now() - startedAt, reason });
    return { data, mode };
  };
  if (process.env.DEEPSEEK_DISABLED === "true") {
    return finish(fallback, "mock", "explicitly_disabled");
  }
  if (!apiKey) {
    return finish(fallback, "mock", "api_key_missing");
  }

  try {
    const response = await fetchWithTimeout(DEEPSEEK_BASE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: task === "parse_scene" || task === "review_candidates" ? 0.2 : 0.3,
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
    }, timeoutMs);

    if (!response.ok) {
      return finish(fallback, "mock", `http_${response.status}`);
    }

    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      return finish(fallback, "mock", "empty_content");
    }
    return finish(JSON.parse(content) as T, "connected");
  } catch (error) {
    const reason = error instanceof Error && error.name === "AbortError"
      ? "timeout"
      : error instanceof SyntaxError
        ? "invalid_json"
        : "request_failed";
    return finish(fallback, "mock", reason);
  }
}

export async function parseScene(input: string, scenarioId: ScenarioId): Promise<{ data: SceneBrief; mode: "connected" | "mock" }> {
  const fallback = mockParseScene(input, scenarioId);
  const result = await deepseekJson<SceneBrief>("parse_scene", parseScenePrompt(input, scenarioId), fallback);
  const validation = result.mode === "connected" ? validateSceneBriefOutput(result.data) : { valid: true };
  if (result.mode === "connected" && !validation.valid) {
    downgradeLastLlmCall("parse_scene", `schema_validation_failed:${validation.reason ?? "unknown"}`);
  }
  const data = validation.valid ? normalizeSceneBrief(result.data, fallback) : fallback;
  return {
    data,
    mode: validation.valid ? result.mode : "mock"
  };
}

export async function personalizeTemplate(
  scene: SceneBrief,
  template: PlanningModule[]
): Promise<{ data: ShoppingPlan; mode: "connected" | "mock" }> {
  const safeScene = sanitizeScene(scene);
  const safeTemplate = sanitizeTemplate(template);
  const fallback = mockPersonalizeTemplate(safeScene, template);
  const adaptivePolicy = getScenarioConfig(scene.scenario_id).adaptive_module_policy;
  const result = await deepseekJson<ShoppingPlan>(
    "personalize_template",
    personalizeTemplatePrompt(safeScene, safeTemplate),
    fallback
  );
  const validation = result.mode === "connected"
    ? validateShoppingPlanOutput(result.data, template, {
        maxAdaptiveModules: adaptivePolicy?.max_modules ?? 0,
        adaptiveIdPrefix: adaptivePolicy?.id_prefix,
        prohibitedTerms: adaptivePolicy?.prohibited_terms
      })
    : { valid: true };
  if (result.mode === "connected" && !validation.valid) {
    downgradeLastLlmCall("personalize_template", `schema_validation_failed:${validation.reason ?? "unknown"}`);
  }
  const data = validation.valid ? normalizeShoppingPlan(result.data, fallback, template) : fallback;
  return {
    data,
    mode: validation.valid ? result.mode : "mock"
  };
}

export async function refinePlan(
  scene: SceneBrief,
  action: QuickAction
): Promise<{ data: SceneBrief; mode: "connected" | "mock" }> {
  const safeScene = sanitizeScene(scene);
  const fallback = mockRefineScene(safeScene, action);
  const result = await deepseekJson<SceneBrief>("refine_plan", refinePlanPrompt(safeScene, action), fallback);
  const validation = result.mode === "connected" ? validateSceneBriefOutput(result.data) : { valid: true };
  if (result.mode === "connected" && !validation.valid) {
    downgradeLastLlmCall("refine_plan", `schema_validation_failed:${validation.reason ?? "unknown"}`);
  }
  const data = validation.valid ? normalizeSceneBrief(result.data, fallback) : fallback;
  return {
    data,
    mode: validation.valid ? result.mode : "mock"
  };
}

export async function reviewShoppingPlan(
  scene: SceneBrief,
  plan: ShoppingPlan
): Promise<{ data: PlanQualityReview; mode: LlmMode }> {
  const safeScene = sanitizeScene(scene);
  const fallback = mockReviewShoppingPlan(safeScene, plan);
  const result = await deepseekJson<Partial<PlanQualityReview>>(
    "review_plan",
    reviewShoppingPlanPrompt(safeScene, plan),
    fallback,
    PLAN_REVIEW_TIMEOUT_MS
  );
  const validation = result.mode === "connected" ? validatePlanQualityReviewOutput(result.data) : true;
  if (result.mode === "connected" && !validation) {
    downgradeLastLlmCall("review_plan", "schema_validation_failed:plan_review_invalid");
  }
  return {
    data: validation ? normalizePlanQualityReview(result.data, fallback) : fallback,
    mode: validation ? result.mode : "mock"
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
    const content = payload.choices?.[0]?.message?.content;
    return validateProductFitOutput(content)
      ? content.trim()
      : mockExplainProductFit(moduleName, { title, recommendation_type: recommendationType });
  } catch {
    return mockExplainProductFit(moduleName, { title, recommendation_type: recommendationType });
  }
}

export async function reviewCandidatePool({
  scene,
  module,
  candidates,
  fallbackReview
}: {
  scene: SceneBrief;
  module: ShoppingPlan["modules"][number];
  candidates: ProductCandidate[];
  fallbackReview: ModuleCandidateReview;
}): Promise<{ data: ModuleCandidateReview; mode: LlmMode }> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return { data: fallbackReview, mode: "mock" };
  }

  const result = await deepseekJson<Partial<ModuleCandidateReview>>(
    "review_candidates",
    reviewCandidatePoolPrompt({
      scene: sanitizeScene(scene),
      module,
      candidates,
      fallbackReview
    }),
    fallbackReview,
    REVIEW_TIMEOUT_MS
  );
  const validation = result.mode === "connected" ? validateCandidateReviewOutput(result.data) : true;
  if (result.mode === "connected" && !validation) {
    downgradeLastLlmCall("review_candidates", "schema_validation_failed:candidate_review_invalid");
  }
  return {
    data: validation ? normalizeCandidateReview(result.data, fallbackReview) : fallbackReview,
    mode: validation ? result.mode : "mock"
  };
}

export async function decideAgentNextAction(
  state: SessionState,
  fallback: AgentDecisionProposal
): Promise<{ data: AgentDecisionProposal; mode: LlmMode }> {
  const result = await deepseekJson<AgentDecisionProposal>(
    "decide_next_action",
    decideNextActionPrompt(state, fallback),
    fallback,
    AGENT_DECISION_TIMEOUT_MS
  );
  if (result.mode !== "connected" || !validateAgentDecisionOutput(result.data)) {
    if (result.mode === "connected") {
      downgradeLastLlmCall("decide_next_action", "schema_validation_failed:agent_decision_invalid");
    }
    return { data: fallback, mode: "mock" };
  }
  return {
    data: {
      action: result.data.action,
      confidence: result.data.confidence,
      module_id: typeof result.data.module_id === "string" ? result.data.module_id.trim() : undefined,
      keyword_override: typeof result.data.keyword_override === "string"
        ? result.data.keyword_override.replace(/\s+/g, " ").trim().slice(0, 80)
        : undefined,
      reason: result.data.reason.trim().slice(0, 300),
      evidence: result.data.evidence.map((item) => item.trim()).filter(Boolean).slice(0, 4),
      expected_gain: result.data.expected_gain.trim().slice(0, 220),
      tool_cost: Math.max(0, Math.min(Math.round(result.data.tool_cost), 1))
    },
    mode: "connected"
  };
}
