import { normalizeSearchKeywords } from "@/lib/agent/search-strategy";
import { personalizeTemplate } from "@/lib/llm/deepseek";
import { SceneBrief, ShoppingPlanModule } from "@/lib/session/types";
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

function normalizeBudgetAllocations<T extends ShoppingPlanModule>(modules: T[], totalBudget: number) {
  if (modules.length === 0 || !Number.isFinite(totalBudget) || totalBudget <= 0) {
    return modules;
  }

  const targetBudget = Math.round(totalBudget);
  const aiBudgetSum = modules.reduce((sum, module) => {
    return sum + (Number.isFinite(module.budget_allocation) && module.budget_allocation > 0 ? module.budget_allocation : 0);
  }, 0);

  const weights = modules.map((module) => {
    if (aiBudgetSum > 0 && Number.isFinite(module.budget_allocation) && module.budget_allocation > 0) {
      return module.budget_allocation;
    }
    return Number.isFinite(module.default_budget_ratio) && module.default_budget_ratio > 0 ? module.default_budget_ratio : 1;
  });

  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || modules.length;
  const rawAllocations = weights.map((weight) => (targetBudget * weight) / totalWeight);
  const baseAllocations = rawAllocations.map((value) => Math.floor(value));
  let remainder = targetBudget - baseAllocations.reduce((sum, value) => sum + value, 0);

  const remainderOrder = rawAllocations
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);

  for (const item of remainderOrder) {
    if (remainder <= 0) {
      break;
    }
    baseAllocations[item.index] += 1;
    remainder -= 1;
  }

  return modules.map((module, index) => ({
    ...module,
    budget_allocation: baseAllocations[index] ?? 0
  }));
}

function orderModulesByExecutionStrategy<T extends ShoppingPlanModule>(
  modules: T[],
  sequence: string[]
) {
  if (sequence.length === 0) {
    return modules;
  }

  const order = new Map(sequence.map((moduleId, index) => [moduleId, index]));
  return [...modules].sort((a, b) => {
    const aOrder = order.get(a.module_id);
    const bOrder = order.get(b.module_id);
    if (aOrder !== undefined && bOrder !== undefined) {
      return aOrder - bOrder;
    }
    if (aOrder !== undefined) {
      return -1;
    }
    if (bOrder !== undefined) {
      return 1;
    }
    return a.priority - b.priority;
  });
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
  const budgetedModules = normalizeBudgetAllocations(normalizedModules, scene.budget);
  const searchableModules = normalizeSearchKeywords(scene, budgetedModules);
  const orderedModules = orderModulesByExecutionStrategy(
    searchableModules,
    planned.data.execution_strategy?.module_sequence ?? []
  );
  return {
    ...planned,
    data: {
      ...planned.data,
      execution_strategy: {
        ...planned.data.execution_strategy,
        module_sequence: orderedModules.map((module) => module.module_id)
      },
      modules: orderedModules
    }
  };
}
