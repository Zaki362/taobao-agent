import { parseScene } from "@/lib/llm/deepseek";
import { ScenarioId, SceneBrief } from "@/lib/session/types";
import { getScenarioConfig } from "@/lib/scenarios";

function normalizeRawInput(rawInput: unknown) {
  if (typeof rawInput === "string" && rawInput.trim()) {
    return rawInput.trim();
  }
  return getDefaultSceneInput();
}

export async function runSceneParser(rawInput: unknown, scenarioId: ScenarioId = "new-car") {
  return parseScene(normalizeRawInput(rawInput), scenarioId);
}

export function getDefaultSceneInput(scenarioId: ScenarioId = "new-car") {
  return getScenarioConfig(scenarioId).example_prompts[0] ?? "预算 1000，希望先买最实用的必需品。";
}

export function sceneSummary(scene: SceneBrief) {
  return `${scene.vehicle_type} · ${scene.user_stage} · 预算 ${scene.budget} · ${scene.priority_style}`;
}
