import { isScenarioId } from "@/lib/scenarios";
import { ScenarioId, SessionState, WorkflowStage } from "@/lib/session/types";
import { API_INPUT_LIMITS } from "@/lib/api/input-limits";

export const WORKFLOW_SNAPSHOT_VERSION = 2;
export const WORKFLOW_SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60_000;

export type SelectedScenario = ScenarioId | null;

export type PersistedDashboardState = {
  stage: WorkflowStage;
  selectedScenario: SelectedScenario;
  sceneInput: string;
  parsedScene: SessionState["scene_brief"] | null;
  parseDeepSeekMode: SessionState["deepseek_status"] | null;
  sessionId: string | null;
  selectedModuleId: string;
  expandedLogs: boolean;
  expandedModel: boolean;
  statusMessage: string;
  searchSummary: string[];
};

export type ResumeSnapshot = PersistedDashboardState | null;

type PersistedDashboardEnvelope = {
  version: typeof WORKFLOW_SNAPSHOT_VERSION;
  owner: string;
  savedAt: number;
  state: PersistedDashboardState;
};

const WORKFLOW_STAGES: WorkflowStage[] = [
  "landing",
  "scenario_select",
  "input_requirement",
  "parsing",
  "confirm_scene",
  "planning",
  "confirm_plan",
  "searching",
  "review_results",
  "cart_review",
  "refining",
  "carting"
];

function isWorkflowStage(value: string): value is WorkflowStage {
  return WORKFLOW_STAGES.includes(value as WorkflowStage);
}

function fallbackStageForAvailableState({
  hasSession,
  hasParsedScene,
  hasScenario
}: {
  hasSession: boolean;
  hasParsedScene: boolean;
  hasScenario: boolean;
}): WorkflowStage {
  if (hasSession) {
    return "review_results";
  }
  if (hasParsedScene) {
    return "confirm_scene";
  }
  if (hasScenario) {
    return "input_requirement";
  }
  return "landing";
}

export function toRestorableStage({
  stage,
  hasSession,
  hasParsedScene,
  hasScenario
}: {
  stage: WorkflowStage | string;
  hasSession: boolean;
  hasParsedScene: boolean;
  hasScenario: boolean;
}): WorkflowStage {
  if (stage === "confirm_refine") {
    return fallbackStageForAvailableState({ hasSession, hasParsedScene, hasScenario });
  }

  if (!isWorkflowStage(stage)) {
    return fallbackStageForAvailableState({ hasSession, hasParsedScene, hasScenario });
  }

  if (!hasScenario && stage !== "landing") {
    return "landing";
  }

  if (stage === "parsing") {
    return "input_requirement";
  }

  if (stage === "planning") {
    return hasParsedScene ? "confirm_scene" : "input_requirement";
  }

  if (stage === "searching") {
    if (hasSession) {
      return "searching";
    }
    return hasParsedScene ? "confirm_scene" : "input_requirement";
  }

  if (stage === "refining" || stage === "carting") {
    if (hasSession) {
      return "review_results";
    }
    return hasParsedScene ? "confirm_scene" : "input_requirement";
  }

  if (stage === "confirm_scene" && !hasParsedScene) {
    return "input_requirement";
  }

  if (
    (stage === "confirm_plan" ||
      stage === "review_results" ||
      stage === "cart_review") &&
    !hasSession
  ) {
    return hasParsedScene ? "confirm_scene" : "input_requirement";
  }

  if (stage === "scenario_select") {
    return "landing";
  }

  return stage;
}

export function resolveHydratedSessionStage(
  preferredStage: WorkflowStage | string,
  state: SessionState
): WorkflowStage {
  const status = state.agent_runtime.workflow_status;
  if (status === "running" || status === "waiting_for_tools" || status === "paused" || status === "error") {
    return "searching";
  }
  if (status === "idle" && !state.completion_report && state.last_refinement) {
    return "confirm_plan";
  }

  const coveredModuleCount = state.shopping_plan.modules.filter(
    (module) => (state.module_candidates[module.module_id]?.length ?? 0) > 0
  ).length;
  if (status === "completed" || state.completion_report || coveredModuleCount > 0) {
    const restorablePreferredStage = toRestorableStage({
      stage: preferredStage,
      hasSession: true,
      hasParsedScene: true,
      hasScenario: true
    });
    if (restorablePreferredStage === "searching") {
      return "searching";
    }
    if (
      restorablePreferredStage === "cart_review" &&
      (state.selected_items.length > 0 || Boolean(state.bundle_adoption))
    ) {
      return "cart_review";
    }
    return "review_results";
  }
  return "confirm_plan";
}

export function statusMessageForRestoredStage(stage: WorkflowStage | string, fallback: string) {
  if (stage === "landing") return "等待开始";
  if (stage === "input_requirement") return "请选择你的场景需求并开始理解";
  if (stage === "confirm_scene") return "已恢复到需求确认页，请确认需求后进入规划";
  if (stage === "confirm_plan") return "已恢复到购物规划页，请确认后开始搜索";
  if (stage === "review_results") return "已恢复到推荐结果页，可以继续查看、加购或重新搜索";
  if (stage === "cart_review") return "已恢复到购买确认页";
  return fallback || "等待开始";
}

export function serializeDashboardSnapshot(
  state: PersistedDashboardState,
  owner: string,
  savedAt = Date.now()
) {
  const envelope: PersistedDashboardEnvelope = {
    version: WORKFLOW_SNAPSHOT_VERSION,
    owner,
    savedAt,
    state
  };
  return JSON.stringify(envelope);
}

export function restoreDashboardSnapshot(
  raw: string,
  fallbackSceneInput: string,
  expectedOwner: string,
  now = Date.now()
): ResumeSnapshot {
  try {
    const envelope = JSON.parse(raw) as Partial<PersistedDashboardEnvelope>;
    if (
      envelope.version !== WORKFLOW_SNAPSHOT_VERSION ||
      envelope.owner !== expectedOwner ||
      typeof envelope.savedAt !== "number" ||
      envelope.savedAt > now + 5 * 60_000 ||
      now - envelope.savedAt > WORKFLOW_SNAPSHOT_TTL_MS ||
      !envelope.state ||
      typeof envelope.state !== "object"
    ) {
      return null;
    }
    const persisted = envelope.state as Partial<PersistedDashboardState>;
    const selectedScenario = isScenarioId(persisted.selectedScenario) ? persisted.selectedScenario : null;
    const parsedScene = persisted.parsedScene ?? null;
    const parseDeepSeekMode =
      persisted.parseDeepSeekMode === "connected" || persisted.parseDeepSeekMode === "mock"
        ? persisted.parseDeepSeekMode
        : null;
    const sessionId = typeof persisted.sessionId === "string" ? persisted.sessionId : null;
    const stage = toRestorableStage({
      stage: persisted.stage ?? "input_requirement",
      hasSession: Boolean(sessionId),
      hasParsedScene: Boolean(parsedScene),
      hasScenario: Boolean(selectedScenario)
    });

    return {
      stage,
      selectedScenario,
      sceneInput:
        typeof persisted.sceneInput === "string" && persisted.sceneInput.length <= API_INPUT_LIMITS.sceneInputLength
          ? persisted.sceneInput
          : fallbackSceneInput,
      parsedScene,
      parseDeepSeekMode,
      sessionId,
      selectedModuleId: typeof persisted.selectedModuleId === "string" ? persisted.selectedModuleId : "",
      expandedLogs: typeof persisted.expandedLogs === "boolean" ? persisted.expandedLogs : false,
      expandedModel: typeof persisted.expandedModel === "boolean" ? persisted.expandedModel : false,
      statusMessage: statusMessageForRestoredStage(
        stage,
        typeof persisted.statusMessage === "string" ? persisted.statusMessage : "等待开始"
      ),
      searchSummary: Array.isArray(persisted.searchSummary)
        ? persisted.searchSummary
            .filter((item): item is string => typeof item === "string")
            .slice(0, 20)
            .map((item) => item.slice(0, 500))
        : []
    };
  } catch {
    return null;
  }
}

export function buildDashboardPersistenceSnapshot({
  stage,
  selectedScenario,
  sceneInput,
  parsedScene,
  parseDeepSeekMode,
  sessionId,
  selectedModuleId,
  expandedLogs,
  expandedModel,
  statusMessage,
  searchSummary
}: {
  stage: WorkflowStage;
  selectedScenario: SelectedScenario;
  sceneInput: string;
  parsedScene: SessionState["scene_brief"] | null;
  parseDeepSeekMode: SessionState["deepseek_status"] | null;
  sessionId: string | null;
  selectedModuleId: string;
  expandedLogs: boolean;
  expandedModel: boolean;
  statusMessage: string;
  searchSummary: string[];
}): PersistedDashboardState | null {
  const restorableStage = toRestorableStage({
    stage,
    hasSession: Boolean(sessionId),
    hasParsedScene: Boolean(parsedScene),
    hasScenario: Boolean(selectedScenario)
  });

  if (restorableStage === "landing" && !selectedScenario && !sessionId && !parsedScene) {
    return null;
  }

  return {
    stage: restorableStage,
    selectedScenario,
    sceneInput,
    parsedScene,
    parseDeepSeekMode,
    sessionId,
    selectedModuleId,
    expandedLogs,
    expandedModel,
    statusMessage: statusMessageForRestoredStage(restorableStage, statusMessage),
    searchSummary
  };
}
