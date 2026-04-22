import { campingScenario } from "@/lib/scenarios/camping";
import { dormMoveInScenario } from "@/lib/scenarios/dorm-move-in";
import { movingSetupScenario } from "@/lib/scenarios/moving-setup";
import { newCarScenario } from "@/lib/scenarios/new-car";
import { roomDecorScenario } from "@/lib/scenarios/room-decor";
import { ScenarioConfig } from "@/lib/scenarios/types";
import { ScenarioId } from "@/lib/session/types";

export const SCENARIO_CONFIGS: Record<ScenarioId, ScenarioConfig> = {
  "new-car": newCarScenario,
  camping: campingScenario,
  "room-decor": roomDecorScenario,
  "dorm-move-in": dormMoveInScenario,
  "moving-setup": movingSetupScenario
};

export const SCENARIO_LIST = Object.values(SCENARIO_CONFIGS);

export function getScenarioConfig(scenarioId: ScenarioId | string | undefined): ScenarioConfig {
  if (scenarioId && scenarioId in SCENARIO_CONFIGS) {
    return SCENARIO_CONFIGS[scenarioId as ScenarioId];
  }
  return SCENARIO_CONFIGS["new-car"];
}
