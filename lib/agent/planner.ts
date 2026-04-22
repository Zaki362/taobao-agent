import { personalizeTemplate } from "@/lib/llm/deepseek";
import { searchIntentForModule } from "@/lib/agent/search-intents";
import { SceneBrief } from "@/lib/session/types";
import { getScenarioConfig } from "@/lib/scenarios";

function normalizePriorityTiers<T extends { module_id: string; priority: number }>(modules: T[]) {
  if (modules.length === 0) {
    return modules;
  }

  const sorted = [...modules].sort((a, b) => b.priority - a.priority);
  const bucketCount = Math.min(4, sorted.length);

  const tierMap = new Map<string, number>();
  sorted.forEach((module, index) => {
    const bucketIndex = Math.floor((index * bucketCount) / sorted.length);
    const normalized = Math.min(bucketCount, bucketIndex + 1);
    tierMap.set(module.module_id, normalized);
  });

  return sorted.map((module) => ({
    ...module,
    priority: tierMap.get(module.module_id) ?? 4
  }));
}

export async function runTemplatePlanner() {
  return getScenarioConfig("new-car").base_template_modules;
}

export async function runTemplatePlannerForScenario(scene: SceneBrief) {
  return getScenarioConfig(scene.scenario_id).base_template_modules;
}

export async function runDeepSeekPlanner(scene: SceneBrief) {
  const planned = await personalizeTemplate(scene, getScenarioConfig(scene.scenario_id).base_template_modules);
  const normalizedModules = normalizePriorityTiers(planned.data.modules);
  return {
    ...planned,
    data: {
      ...planned.data,
      modules: normalizedModules.map((module) => ({
        ...module,
        search_keyword: searchIntentForModule(scene, module)
      }))
    }
  };
}
