"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  LEGACY_WORKFLOW_STORAGE_KEY,
  defaultInput,
  workflowStorageKeyForOwner
} from "@/components/dashboard-config";
import {
  type ResumeSnapshot,
  type SelectedScenario,
  buildDashboardPersistenceSnapshot,
  restoreDashboardSnapshot,
  serializeDashboardSnapshot
} from "@/components/dashboard-workflow";
import type { SessionState, WorkflowStage } from "@/lib/session/types";

type AuthenticationSnapshot = {
  authenticated?: boolean;
  authentication_required?: boolean;
  user?: { id?: string } | null;
};

type DashboardPersistenceInput = {
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

export function useDashboardPersistence(input: DashboardPersistenceInput) {
  const {
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
  } = input;
  const hasRestoredRef = useRef(false);
  const [resumeSnapshot, setResumeSnapshot] = useState<ResumeSnapshot>(null);
  const [owner, setOwner] = useState<string | false | null>(null);
  const storageKey = typeof owner === "string" ? workflowStorageKeyForOwner(owner) : null;

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me")
      .then(async (response) => {
        if (!response.ok) return false as const;
        const payload = await response.json() as AuthenticationSnapshot;
        if (payload.authenticated && typeof payload.user?.id === "string") {
          return `user:${payload.user.id}`;
        }
        return payload.authentication_required === false ? "anonymous" : false;
      })
      .catch(() => false as const)
      .then((resolvedOwner) => {
        if (cancelled) return;
        window.localStorage.removeItem(LEGACY_WORKFLOW_STORAGE_KEY);
        setOwner(resolvedOwner);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (hasRestoredRef.current || owner === null) return;
    hasRestoredRef.current = true;
    window.localStorage.removeItem(LEGACY_WORKFLOW_STORAGE_KEY);
    if (!storageKey || typeof owner !== "string") return;
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return;
    const snapshot = restoreDashboardSnapshot(raw, defaultInput, owner);
    if (!snapshot) {
      window.localStorage.removeItem(storageKey);
      return;
    }
    setResumeSnapshot(snapshot);
  }, [owner, storageKey]);

  useEffect(() => {
    if (
      !hasRestoredRef.current ||
      resumeSnapshot ||
      !storageKey ||
      typeof owner !== "string"
    ) return;

    const snapshot = buildDashboardPersistenceSnapshot({
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
    });
    if (!snapshot) {
      window.localStorage.removeItem(storageKey);
      return;
    }
    window.localStorage.setItem(storageKey, serializeDashboardSnapshot(snapshot, owner));
  }, [
    expandedLogs,
    expandedModel,
    parseDeepSeekMode,
    parsedScene,
    sceneInput,
    searchSummary,
    selectedModuleId,
    selectedScenario,
    sessionId,
    stage,
    statusMessage,
    owner,
    resumeSnapshot,
    storageKey
  ]);

  const clearPersistedSnapshot = useCallback(() => {
    window.localStorage.removeItem(LEGACY_WORKFLOW_STORAGE_KEY);
    if (storageKey) window.localStorage.removeItem(storageKey);
  }, [storageKey]);

  return {
    resumeSnapshot,
    setResumeSnapshot,
    clearPersistedSnapshot
  };
}
