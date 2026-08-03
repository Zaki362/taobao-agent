import { PriorityStyle, SceneBrief } from "@/lib/session/types";
import { getScenarioConfig, isScenarioId } from "@/lib/scenarios";

function compact(value: string) {
  return value.replace(/\s+/g, "").trim();
}

function normalizeConfiguredOption(value: string, options: string[] | undefined, fallback: string) {
  const cleaned = compact(value || fallback);
  if (!cleaned || !options?.length) {
    return value || fallback;
  }

  const exact = options.find((option) => compact(option) === cleaned);
  if (exact) {
    return exact;
  }

  const fuzzy = options.find((option) => {
    const normalizedOption = compact(option);
    return cleaned.includes(normalizedOption) || normalizedOption.includes(cleaned);
  });
  if (fuzzy) {
    return fuzzy;
  }

  return value || fallback;
}

function normalizeVehicleType(value: string, fallback: string, options?: string[], scenarioId = "new-car") {
  if (scenarioId !== "new-car") {
    return normalizeConfiguredOption(value, options, fallback);
  }
  if (/新能源|电车|纯电/.test(value)) {
    return options?.find((option) => option.includes("新能源")) ?? "新能源车";
  }
  if (/混动|插混|增程/.test(value)) {
    return options?.find((option) => option.includes("混动")) ?? "混动车";
  }
  if (/suv/i.test(value)) {
    return options?.find((option) => option.toLowerCase().includes("suv")) ?? "SUV";
  }
  return normalizeConfiguredOption(value, options, fallback);
}

function normalizeUserStage(value: string, fallback: string, options?: string[], scenarioId = "new-car") {
  if (scenarioId !== "new-car") {
    return normalizeConfiguredOption(value, options, fallback);
  }
  if (/刚提|提车|新车/.test(value)) {
    return options?.find((option) => option.includes("提车初期")) ?? "提车初期";
  }
  if (/第一周|一周/.test(value)) {
    return options?.find((option) => option.includes("第一周")) ?? "第一周";
  }
  if (/首月|一个月|第一月/.test(value)) {
    return options?.find((option) => option.includes("首月")) ?? "首月补齐";
  }
  if (/第一阶段|首购|先买|先补齐/.test(value)) {
    return options?.find((option) => option.includes("第一阶段")) ?? "第一阶段首购";
  }
  return normalizeConfiguredOption(value, options, fallback);
}

function normalizePriorityStyle(value: SceneBrief["priority_style"], fallback: PriorityStyle, options?: PriorityStyle[]) {
  if (options?.includes(value)) {
    return value;
  }
  return fallback;
}

export function normalizeSceneBriefOptions(scene: SceneBrief, fallback?: SceneBrief): SceneBrief {
  const fallbackScene = fallback ?? scene;
  const fallbackScenarioId = isScenarioId(fallbackScene.scenario_id) ? fallbackScene.scenario_id : "new-car";
  const scenarioId = isScenarioId(scene.scenario_id) ? scene.scenario_id : fallbackScenarioId;
  const scenario = getScenarioConfig(scenarioId);
  const optionSets = scenario.field_option_sets;

  return {
    ...scene,
    scenario_id: scenario.id,
    scene_type: scene.scene_type || scenario.name,
    vehicle_type: normalizeVehicleType(
      scene.vehicle_type,
      fallbackScene.vehicle_type,
      optionSets.vehicle_type,
      scenarioId
    ),
    user_stage: normalizeUserStage(
      scene.user_stage,
      fallbackScene.user_stage,
      optionSets.user_stage,
      scenarioId
    ),
    priority_style: normalizePriorityStyle(
      scene.priority_style,
      fallbackScene.priority_style,
      optionSets.priority_style
    )
  };
}
