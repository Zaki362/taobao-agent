"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { jsonFetch } from "@/components/dashboard-api";
import { StatusPage } from "@/components/dashboard-common";
import { ConfirmPlanPage, ConfirmScenePage } from "@/components/dashboard-confirmation";
import { CartReviewPage, SearchSummaryPage } from "@/components/dashboard-execution";
import { buildSceneInputFromBrief, getExecutionModeLabel, isHostedMode, isQueuedExecutionMode } from "@/components/dashboard-helpers";
import { LandingPage, RequirementPage, ResumeBanner, TopHeader } from "@/components/dashboard-intake";
import { ResultsPage } from "@/components/dashboard-results";
import { CartReviewItem, HostedWorkerStatus, MpcStatus } from "@/components/dashboard-types";
import {
  ResumeSnapshot,
  SelectedScenario,
  buildDashboardPersistenceSnapshot,
  restoreDashboardSnapshot,
  toRestorableStage
} from "@/components/dashboard-workflow";
import {
  WORKFLOW_STORAGE_KEY,
  defaultInput,
  stageLabels,
} from "@/components/dashboard-config";
import { formatCurrency } from "@/lib/utils";
import { isRenderableSessionState } from "@/lib/session/guards";
import {
  AgentDecision,
  BudgetReallocationSuggestion,
  ProductCandidate,
  QuickAction,
  RefinementImpactSummary,
  SessionState,
  WorkflowStage
} from "@/lib/session/types";
import type { AgentDirectiveProfile } from "@/lib/agent/directives";
import type { ShoppingSessionSummary } from "@/lib/session/summaries";

type HostedTaskInstruction = {
  task: {
    task_id: string;
    title: string;
  } | null;
  instruction: string | null;
};

type SearchStrategyUpdateResponse = {
  state: unknown;
};

type AgentNextActionResponse = {
  decision: AgentDecision;
  agent_decisions: AgentDecision[];
};

type AgentRunResponse = {
  outcome: "queued" | "waiting" | "completed" | "paused" | "no_op";
  agent_runtime: SessionState["agent_runtime"];
};

const SESSION_REQUIRED_STAGES: WorkflowStage[] = [
  "confirm_plan",
  "searching",
  "review_results",
  "cart_review"
];

export function Dashboard() {
  const hasRestoredRef = useRef(false);
  const autoResumeHandledRef = useRef(false);
  const searchParams = useSearchParams();
  const [interactiveReady, setInteractiveReady] = useState(false);
  const [stage, setStage] = useState<WorkflowStage>("landing");
  const [selectedScenario, setSelectedScenario] = useState<SelectedScenario>(null);
  const [sceneInput, setSceneInput] = useState(defaultInput);
  const [parsedScene, setParsedScene] = useState<SessionState["scene_brief"] | null>(null);
  const [parseDeepSeekMode, setParseDeepSeekMode] = useState<SessionState["deepseek_status"] | null>(null);
  const [session, setSession] = useState<SessionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState("等待开始");
  const [searchSummary, setSearchSummary] = useState<string[]>([]);
  const [expandedLogs, setExpandedLogs] = useState(false);
  const [expandedModel, setExpandedModel] = useState(false);
  const [selectedModuleId, setSelectedModuleId] = useState("");
  const [mcpStatus, setMcpStatus] = useState<MpcStatus | null>(null);
  const [hostedInstruction, setHostedInstruction] = useState<string>("");
  const [workerStatus, setWorkerStatus] = useState<HostedWorkerStatus | null>(null);
  const [resumeSnapshot, setResumeSnapshot] = useState<ResumeSnapshot>(null);
  const [cartingProductId, setCartingProductId] = useState("");
  const [removingCartProductId, setRemovingCartProductId] = useState("");
  const [workflowControlBusy, setWorkflowControlBusy] = useState(false);
  const [recentSessions, setRecentSessions] = useState<ShoppingSessionSummary[]>([]);
  const [archivedSessions, setArchivedSessions] = useState<ShoppingSessionSummary[]>([]);
  const [recentSessionsLoading, setRecentSessionsLoading] = useState(true);
  const [resumingSessionId, setResumingSessionId] = useState("");
  const [lifecycleSessionId, setLifecycleSessionId] = useState("");

  const selectedModule = session?.shopping_plan.modules.find((item) => item.module_id === selectedModuleId) ?? session?.shopping_plan.modules[0];
  const selectedProducts = selectedModule ? session?.module_candidates[selectedModule.module_id] ?? [] : [];
  const pendingHostedTasks = session?.hosted_tasks.filter((task) => task.status === "pending" || task.status === "running") ?? [];
  const completedHostedTasks = session?.hosted_tasks.filter((task) => task.status === "completed") ?? [];
  const estimatedTotal = useMemo(
    () => session?.selected_items.reduce((sum, item) => sum + item.price, 0) ?? 0,
    [session]
  );
  const cartReviewItems = useMemo(() => {
    if (!session) {
      return [];
    }

    return session.selected_items.map((item) => {
      const candidate = Object.values(session.module_candidates)
        .flat()
        .find((product) => product.product_id === item.product_id);

      return {
        ...item,
        image_url: item.image_url || candidate?.image_url || "",
        detail_url: item.detail_url || candidate?.detail_url || "",
        shop_name: item.shop_name || candidate?.shop_name || "淘宝店铺",
        module_name:
          item.module_name ||
          session.shopping_plan.modules.find((module) => module.module_id === item.module_id)?.module_name ||
          "已选模块",
        selected_spec: item.selected_spec || "默认可选规格（以淘宝购物车页为准）",
        cart_source: item.cart_source || "taobao",
        cart_note: item.cart_note || ""
      };
    });
  }, [session]);

  async function refreshMcpStatus() {
    const status = await jsonFetch<MpcStatus>("/api/mcp/status");
    setMcpStatus(status);
    return status;
  }

  async function refreshRecentSessions() {
    setRecentSessionsLoading(true);
    try {
      const [activeData, archivedData] = await Promise.all([
        jsonFetch<{ sessions?: ShoppingSessionSummary[] }>("/api/sessions?view=summary&limit=6"),
        jsonFetch<{ sessions?: ShoppingSessionSummary[] }>("/api/sessions?view=summary&archive=archived&limit=20")
      ]);
      setRecentSessions(Array.isArray(activeData.sessions) ? activeData.sessions : []);
      setArchivedSessions(Array.isArray(archivedData.sessions) ? archivedData.sessions : []);
    } catch {
      // Logged-out formal deployments return 401 here. The landing page remains usable
      // and the login entry explains how to access account-bound history.
      setRecentSessions([]);
      setArchivedSessions([]);
    } finally {
      setRecentSessionsLoading(false);
    }
  }

  async function hydrateSession(sessionId: string) {
    const data = await jsonFetch<unknown>(`/api/session/state?session_id=${sessionId}`);
    if (!isRenderableSessionState(data)) {
      throw new Error("会话状态不完整");
    }
    setSession(data);
    if (!selectedModuleId) {
      setSelectedModuleId(data.shopping_plan.modules[0]?.module_id ?? "");
    }
    return data;
  }

  async function refreshHostedInstruction(sessionId: string) {
    if (!isHostedMode(mcpStatus)) {
      setHostedInstruction("");
      return { task: null, instruction: null } satisfies HostedTaskInstruction;
    }
    const data = await jsonFetch<HostedTaskInstruction>(`/api/hosted/tasks/next?session_id=${sessionId}`);
    setHostedInstruction(data.instruction ?? "");
    return data;
  }

  async function refreshWorkerStatus() {
    if (!isHostedMode(mcpStatus)) {
      setWorkerStatus(null);
      return null;
    }
    const data = await jsonFetch<HostedWorkerStatus>("/api/hosted/worker-status");
    setWorkerStatus(data);
    return data;
  }

  function resetWorkflow() {
    setStage("landing");
    setSelectedScenario(null);
    setSceneInput(defaultInput);
    setParsedScene(null);
    setParseDeepSeekMode(null);
    setSession(null);
    setErrorMessage("");
    setStatusMessage("等待开始");
    setSearchSummary([]);
    setExpandedLogs(false);
    setExpandedModel(false);
    setSelectedModuleId("");
    setHostedInstruction("");
    setCartingProductId("");
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(WORKFLOW_STORAGE_KEY);
    }
    refreshRecentSessions().catch(() => undefined);
  }

  async function enterScenario() {
    setResumeSnapshot(null);
    setSelectedScenario("new-car");
    setStage("input_requirement");
    setErrorMessage("");
    setStatusMessage("请选择你的场景需求并开始理解");
    try {
      await refreshMcpStatus();
      setHostedInstruction("");
    } catch {
      setMcpStatus({
        mode: "local_executor",
        available: false,
        message: "本地执行器状态检查失败，请刷新页面后重试。",
        permissions_scope: ["淘宝搜索", "详情提取", "加入购物车需显式确认"]
      });
    }
  }

  useEffect(() => {
    setInteractiveReady(true);
    refreshRecentSessions().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (hasRestoredRef.current || typeof window === "undefined") {
      return;
    }

    hasRestoredRef.current = true;
    const raw = window.localStorage.getItem(WORKFLOW_STORAGE_KEY);
    if (!raw) {
      return;
    }

    const snapshot = restoreDashboardSnapshot(raw, defaultInput);
    if (!snapshot) {
      window.localStorage.removeItem(WORKFLOW_STORAGE_KEY);
      return;
    }

    refreshMcpStatus().catch(() => undefined);
    setResumeSnapshot(snapshot);
  }, []);

  useEffect(() => {
    const shouldAutoResume = searchParams.get("resume") === "1";
    if (!shouldAutoResume) {
      autoResumeHandledRef.current = false;
      return;
    }
    if (!resumeSnapshot || autoResumeHandledRef.current) {
      return;
    }

    autoResumeHandledRef.current = true;
    resumeWorkflow()
      .catch(() => undefined)
      .finally(() => {
        if (typeof window !== "undefined") {
          window.history.replaceState({}, "", "/");
        }
      });
  }, [resumeSnapshot, searchParams]);

  useEffect(() => {
    if (typeof window === "undefined" || !hasRestoredRef.current || resumeSnapshot) {
      return;
    }

    const payload = buildDashboardPersistenceSnapshot({
      stage,
      selectedScenario,
      sceneInput,
      parsedScene,
      parseDeepSeekMode,
      sessionId: session?.session_id ?? null,
      selectedModuleId,
      expandedLogs,
      expandedModel,
      statusMessage,
      searchSummary
    });

    if (!payload) {
      window.localStorage.removeItem(WORKFLOW_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(WORKFLOW_STORAGE_KEY, JSON.stringify(payload));
  }, [
    expandedLogs,
    expandedModel,
    parsedScene,
    parseDeepSeekMode,
    sceneInput,
    searchSummary,
    selectedModuleId,
    selectedScenario,
    session?.session_id,
    stage,
    statusMessage,
    resumeSnapshot
  ]);

  useEffect(() => {
    if (busy) {
      return;
    }

    if (stage === "confirm_scene" && !parsedScene) {
      setErrorMessage("场景理解结果暂不可用，请重新提交需求。");
      setStatusMessage("请重新提交需求");
      setStage(selectedScenario ? "input_requirement" : "landing");
      return;
    }

    if (SESSION_REQUIRED_STAGES.includes(stage) && !session) {
      setErrorMessage("当前步骤所需的会话数据暂不可用，已返回最近可继续的步骤。");
      if (parsedScene) {
        setStatusMessage("请重新确认需求并生成购物规划");
        setStage("confirm_scene");
      } else if (selectedScenario) {
        setStatusMessage("请重新提交需求");
        setStage("input_requirement");
      } else {
        setStatusMessage("等待开始");
        setStage("landing");
      }
    }
  }, [busy, parsedScene, selectedScenario, session, stage]);

  async function resumeWorkflow() {
    if (!resumeSnapshot) {
      return;
    }

    setSceneInput(resumeSnapshot.sceneInput);
    setSelectedScenario(resumeSnapshot.selectedScenario);
    setParsedScene(resumeSnapshot.parsedScene);
    setParseDeepSeekMode(resumeSnapshot.parseDeepSeekMode);
    setExpandedLogs(resumeSnapshot.expandedLogs);
    setExpandedModel(resumeSnapshot.expandedModel);
    setStatusMessage(resumeSnapshot.statusMessage);
    setSearchSummary(resumeSnapshot.searchSummary);
    setSelectedModuleId(resumeSnapshot.selectedModuleId);
    setResumeSnapshot(null);

    if (resumeSnapshot.sessionId) {
      try {
        const data = await hydrateSession(resumeSnapshot.sessionId);
        await refreshHostedInstruction(resumeSnapshot.sessionId).catch(() => undefined);
        setStage(
          toRestorableStage({
            stage: resumeSnapshot.stage,
            hasSession: true,
            hasParsedScene: true,
            hasScenario: true
          })
        );
        setSelectedScenario("new-car");
        setParsedScene(data.scene_brief);
        setParseDeepSeekMode(data.deepseek_status);
        setSelectedModuleId(
          resumeSnapshot.selectedModuleId || data.shopping_plan.modules[0]?.module_id || ""
        );
        return;
      } catch {
        resetWorkflow();
        return;
      }
    }

    setStage(
      toRestorableStage({
        stage: resumeSnapshot.stage,
        hasSession: false,
        hasParsedScene: Boolean(resumeSnapshot.parsedScene),
        hasScenario: resumeSnapshot.selectedScenario === "new-car"
      })
    );
  }

  async function resumeServerSession(summary: ShoppingSessionSummary) {
    setResumingSessionId(summary.session_id);
    setErrorMessage("");
    setStatusMessage("正在读取服务端购物任务");
    try {
      const data = await hydrateSession(summary.session_id);
      await refreshMcpStatus().catch(() => undefined);
      await refreshHostedInstruction(summary.session_id).catch(() => undefined);
      const selectedModule =
        data.shopping_plan.modules.find((module) => module.module_id === data.agent_runtime.current_module_id) ??
        data.shopping_plan.modules.find((module) => (data.module_candidates[module.module_id]?.length ?? 0) > 0) ??
        data.shopping_plan.modules[0];

      setResumeSnapshot(null);
      setSelectedScenario("new-car");
      setSceneInput(data.raw_input || buildSceneInputFromBrief(data.scene_brief));
      setParsedScene(data.scene_brief);
      setParseDeepSeekMode(data.deepseek_status);
      setSelectedModuleId(selectedModule?.module_id ?? "");
      setSearchSummary(
        summary.resume_stage === "confirm_plan"
          ? []
          : [data.completion_report?.summary ?? data.agent_runtime.workflow_message]
      );
      setStage(summary.resume_stage);
      setStatusMessage(
        summary.resume_stage === "confirm_plan"
          ? "已恢复购物规划，请确认后开始搜索。"
          : summary.resume_stage === "searching"
            ? data.agent_runtime.workflow_message
            : "已恢复推荐结果，可以继续比较、调整或加购。"
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "恢复购物任务失败");
    } finally {
      setResumingSessionId("");
    }
  }

  async function updateServerSessionLifecycle(
    summary: ShoppingSessionSummary,
    action: "archive" | "restore"
  ) {
    const confirmed = window.confirm(
      action === "archive"
        ? `确认归档「${summary.requirement}」吗？尚未执行的后台动作会停止，之后仍可恢复。`
        : `确认恢复「${summary.requirement}」吗？恢复后不会自动开始搜索。`
    );
    if (!confirmed) return;

    setLifecycleSessionId(summary.session_id);
    setErrorMessage("");
    try {
      await jsonFetch("/api/session/archive", {
        method: "POST",
        body: JSON.stringify({
          session_id: summary.session_id,
          action,
          confirmed: true
        })
      });
      if (action === "archive" && resumeSnapshot?.sessionId === summary.session_id) {
        setResumeSnapshot(null);
        window.localStorage.removeItem(WORKFLOW_STORAGE_KEY);
      }
      await refreshRecentSessions();
      setStatusMessage(action === "archive" ? "购物任务已安全归档" : "购物任务已恢复，可从最近任务继续");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "更新购物任务状态失败");
    } finally {
      setLifecycleSessionId("");
    }
  }

  function restartWorkflowFromBanner() {
    resetWorkflow();
    setResumeSnapshot(null);
  }

  useEffect(() => {
    if (!isHostedMode(mcpStatus)) {
      setWorkerStatus(null);
      return;
    }

    refreshWorkerStatus().catch(() => undefined);
    const timer = window.setInterval(() => {
      refreshWorkerStatus().catch(() => undefined);
    }, 5000);

    return () => window.clearInterval(timer);
  }, [mcpStatus?.mode]);

  useEffect(() => {
    if (!session || !isHostedMode(mcpStatus)) {
      setHostedInstruction("");
      return;
    }
    refreshHostedInstruction(session.session_id).catch(() => undefined);
  }, [mcpStatus?.mode, session?.session_id]);

  useEffect(() => {
    if (!session || pendingHostedTasks.length === 0) {
      return;
    }

    const timer = window.setInterval(() => {
      hydrateSession(session.session_id).catch(() => undefined);
      refreshHostedInstruction(session.session_id).catch(() => undefined);
    }, 4000);

    return () => window.clearInterval(timer);
  }, [session, pendingHostedTasks.length]);

  useEffect(() => {
    if (!session || mcpStatus?.mode !== "local_executor") {
      return;
    }

    const sessionId = session.session_id;
    const cursorKey = `scenecart-event-cursor:${sessionId}`;
    const after = window.sessionStorage.getItem(cursorKey) ?? "0";
    const stream = new EventSource(
      `/api/runtime/events/stream?session_id=${encodeURIComponent(sessionId)}&after=${encodeURIComponent(after)}`
    );
    let refreshTimer: number | undefined;

    const refreshFromEvent = (event: Event) => {
      const eventId = (event as MessageEvent).lastEventId;
      if (eventId) window.sessionStorage.setItem(cursorKey, eventId);
      let eventType = "执行任务已更新";
      try {
        const payload = JSON.parse((event as MessageEvent).data) as {
          event_type?: string;
          payload?: { job_type?: string };
        };
        if (payload.event_type === "job.completed") {
          eventType = payload.payload?.job_type === "add_to_cart"
            ? "后台加购已完成"
            : "后台搜索已完成";
        } else if (payload.event_type === "agent.workflow.updated") {
          eventType = "服务端 Agent 已推进到下一状态";
        } else if (payload.event_type === "job.failed") {
          eventType = "后台任务执行失败，可在执行台查看原因";
        } else if (payload.event_type === "job.retry_scheduled") {
          eventType = "后台任务正在自动重试";
        } else if (payload.event_type === "job.requeued") {
          eventType = "任务已重新进入本地执行器队列";
        }
      } catch {
        // The persisted session remains the source of truth when event metadata is unavailable.
      }

      if (refreshTimer) {
        window.clearTimeout(refreshTimer);
      }
      refreshTimer = window.setTimeout(() => {
        hydrateSession(sessionId)
          .then(() => setStatusMessage(eventType))
          .catch(() => undefined);
      }, 120);
    };

    for (const eventName of [
      "job.created",
      "job.requeued",
      "job.claimed",
      "job.completed",
      "job.failed",
      "job.retry_scheduled",
      "job.cancelled",
      "agent.workflow.updated"
    ]) {
      stream.addEventListener(eventName, refreshFromEvent);
    }

    return () => {
      if (refreshTimer) {
        window.clearTimeout(refreshTimer);
      }
      stream.close();
    };
  }, [mcpStatus?.mode, session?.session_id]);

  async function startParsing() {
    setResumeSnapshot(null);
    setBusy(true);
    setErrorMessage("");
    setStatusMessage("正在理解你的购物场景");
    setStage("parsing");
    try {
      const parsed = await jsonFetch<{
        scene_brief: SessionState["scene_brief"];
        deepseek_mode: SessionState["deepseek_status"];
      }>("/api/scene/parse", {
        method: "POST",
        body: JSON.stringify({ raw_input: sceneInput }),
        timeoutMs: 30_000
      });
      if (
        !parsed.scene_brief ||
        typeof parsed.scene_brief.budget !== "number" ||
        !Array.isArray(parsed.scene_brief.already_have) ||
        !Array.isArray(parsed.scene_brief.avoid_items)
      ) {
        throw new Error("需求解析结果不完整，请重新尝试。");
      }
      setParsedScene(parsed.scene_brief);
      setParseDeepSeekMode(parsed.deepseek_mode);
      setStage("confirm_scene");
      setStatusMessage("已完成场景理解，请确认需求后进入规划");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "需求解析失败");
      setStage("input_requirement");
    } finally {
      setBusy(false);
    }
  }

  async function confirmSceneAndPlan() {
    if (!parsedScene) {
      return;
    }
    setBusy(true);
    setErrorMessage("");
    setStage("planning");
    setStatusMessage("正在基于模板生成购物规划");
    try {
      const planned = await jsonFetch<{ session_id: string }>("/api/scene/plan", {
        method: "POST",
        body: JSON.stringify({
          raw_input: buildSceneInputFromBrief(parsedScene),
          scene_brief: parsedScene,
          parse_deepseek_mode: parseDeepSeekMode
        }),
        timeoutMs: 45_000
      });
      const hydrated = await hydrateSession(planned.session_id);
      await refreshHostedInstruction(planned.session_id);
      setSelectedModuleId(hydrated.shopping_plan.modules[0]?.module_id ?? "");
      setStage("confirm_plan");
      setStatusMessage("购物规划已生成，请确认后开始搜索");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "生成购物规划失败");
      setStage("confirm_scene");
    } finally {
      setBusy(false);
    }
  }

  async function startSearching() {
    if (!session) {
      return;
    }
    setBusy(true);
    setErrorMessage("");
    setStage("searching");
    const executionLabel = getExecutionModeLabel(mcpStatus);
    const serverManagedWorkflow = mcpStatus?.mode === "local_executor";
    setStatusMessage(`正在通过${executionLabel}串行搜索优先模块，并先返回商品摘要`);
    try {
      const summary: string[] = [];
      const modules = session.shopping_plan.modules;
      if (modules.length === 0) {
        throw new Error("当前规划中没有可搜索模块");
      }

      if (serverManagedWorkflow) {
        await jsonFetch<AgentRunResponse>("/api/agent/run", {
          method: "POST",
          body: JSON.stringify({ session_id: session.session_id })
        });
        const latestSession = await waitForServerWorkflow(session.session_id, modules.length);
        const completedModules = modules.filter(
          (module) => (latestSession.module_candidates[module.module_id]?.length ?? 0) > 0
        );
        setSelectedModuleId(completedModules[0]?.module_id ?? modules[0]?.module_id ?? "");
        setSearchSummary([
          `服务端 Agent 已整理 ${completedModules.length}/${modules.length} 个模块的候选`,
          latestSession.market_feedback.summary,
          latestSession.agent_runtime.workflow_message
        ]);
        setStatusMessage(
          latestSession.agent_runtime.workflow_status === "paused"
            ? latestSession.agent_runtime.workflow_message
            : "后台 Agent 搜索流程已完成。你可以直接查看推荐结果。"
        );
        return;
      }

      let latestSession = session;
      const maxDecisionRounds = Math.max(8, modules.length * 3 + 4);

      for (let round = 0; round < maxDecisionRounds; round += 1) {
        const { decision } = await jsonFetch<AgentNextActionResponse>("/api/agent/next-action", {
          method: "POST",
          body: JSON.stringify({ session_id: latestSession.session_id })
        });

        if (decision.action === "complete_workflow") {
          summary.push(`Agent 已结束本轮执行：${decision.reason}`);
          break;
        }

        if (decision.action === "wait_for_tools") {
          summary.push(`Agent 正在等待工具回填：${decision.reason}`);
          setSearchSummary([...summary]);
          if (mcpStatus?.mode === "local_executor") {
            const activeTask = latestSession.hosted_tasks.find(
              (task) => task.task_type === "module_search" && (task.status === "pending" || task.status === "running")
            );
            if (activeTask) {
              setStatusMessage(`本地执行器正在处理「${activeTask.module_name ?? "当前模块"}」，完成后 Agent 会自动继续`);
              await waitForRuntimeJob(latestSession.session_id, activeTask.task_id);
              latestSession = await hydrateSession(latestSession.session_id);
              continue;
            }
          }
          break;
        }

        if (decision.action === "skip_module") {
          summary.push(`Agent 跳过「${decision.module_name ?? "当前模块"}」：${decision.reason}`);
          setSearchSummary([...summary]);
          continue;
        }

        if (!decision.module_id) {
          throw new Error("Agent 决策缺少 module_id，已停止本轮执行");
        }

        const module = latestSession.shopping_plan.modules.find(
          (item) => item.module_id === decision.module_id
        );
        if (!module) {
          throw new Error(`Agent 返回了未知模块：${decision.module_id}`);
        }

        setStatusMessage(
          decision.action === "retry_module"
            ? `Agent 正在补搜「${module.module_name}」：${decision.keyword_override ?? "备用搜索词"}`
            : `Agent 决定搜索「${module.module_name}」：${decision.reason}`
        );

        try {
          await jsonFetch("/api/modules/search", {
            method: "POST",
            body: JSON.stringify({
              session_id: latestSession.session_id,
              module_id: module.module_id,
              keyword_override: decision.keyword_override
            })
          });
          latestSession = await hydrateSession(latestSession.session_id);
          await refreshHostedInstruction(latestSession.session_id);

          const task = latestSession.hosted_tasks.find(
            (entry) =>
              entry.task_type === "module_search" &&
              entry.module_id === module.module_id &&
              (entry.status === "pending" || entry.status === "running" || entry.status === "completed")
          );
          const count = latestSession.module_candidates[module.module_id]?.length ?? 0;

          if (isQueuedExecutionMode(mcpStatus)) {
            summary.push(
              task?.status === "completed"
                ? `Agent 已完成「${module.module_name}」并返回 ${count} 个候选商品`
                : mcpStatus?.mode === "local_executor"
                  ? `Agent 已提交「${module.module_name}」任务，等待本地执行器回填`
                  : `Agent 已提交「${module.module_name}」任务，等待宿主工具回填`
            );
          } else {
            summary.push(
              count > 0
                ? `${decision.action === "retry_module" ? "补搜" : "搜索"}完成：「${module.module_name}」形成 ${count} 个候选商品`
                : `已执行「${module.module_name}」，当前没有可展示候选，Agent 将决定继续或跳过`
            );
          }
        } catch (error) {
          summary.push(
            `「${module.module_name}」执行未完成：${error instanceof Error ? error.message : "未知错误"}`
          );
          latestSession = await hydrateSession(latestSession.session_id);
        }

        setSearchSummary([...summary]);
      }

      latestSession = await hydrateSession(latestSession.session_id);

      setSelectedModuleId(
        modules.find((module) => (latestSession.module_candidates[module.module_id]?.length ?? 0) > 0)?.module_id ??
        modules[0]?.module_id ??
        ""
      );
      setSearchSummary(summary);
      setStatusMessage(
        isQueuedExecutionMode(mcpStatus)
          ? mcpStatus?.mode === "local_executor"
            ? "后台搜索流程已结束或暂停。已完成结果会自动保存在当前会话。"
            : "执行任务已提交。你可以先查看任务摘要，等 Codex 宿主回填结果后再查看推荐。"
          : "优先模块搜索已完成。你可以直接查看推荐结果。"
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "执行搜索失败");
    } finally {
      setBusy(false);
    }
  }

  async function waitForServerWorkflow(sessionId: string, moduleCount: number) {
    const deadline = Date.now() + 6 * 60 * 1000;
    let latest = await hydrateSession(sessionId);

    while (Date.now() < deadline) {
      const runtime = latest.agent_runtime;
      const completedCount = latest.shopping_plan.modules.filter(
        (module) => (latest.module_candidates[module.module_id]?.length ?? 0) > 0
      ).length;
      const currentModule = latest.shopping_plan.modules.find(
        (module) => module.module_id === runtime.current_module_id
      );
      setSearchSummary([
        `服务端 Agent 已整理 ${completedCount}/${moduleCount} 个模块`,
        runtime.workflow_message
      ]);
      setStatusMessage(
        runtime.workflow_status === "waiting_for_tools"
          ? `本地执行器正在处理「${currentModule?.module_name ?? "当前模块"}」，页面关闭后服务端仍会继续`
          : runtime.workflow_message
      );

      if (runtime.workflow_status === "completed" || runtime.workflow_status === "paused") return latest;
      if (runtime.workflow_status === "error") {
        throw new Error(runtime.workflow_message || "服务端 Agent 已暂停");
      }

      await new Promise((resolve) => window.setTimeout(resolve, 1_200));
      latest = await hydrateSession(sessionId);
    }

    throw new Error("搜索仍在后台执行。你可以关闭页面，稍后通过当前进度继续查看。");
  }

  async function pauseServerWorkflow() {
    if (!session) return;
    if (!window.confirm("当前模块可以继续完成，但 Agent 不会自动进入下一个模块。确认暂停自动搜索吗？")) {
      return;
    }
    setWorkflowControlBusy(true);
    setErrorMessage("");
    try {
      const response = await jsonFetch<{ state: unknown }>("/api/agent/pause", {
        method: "POST",
        body: JSON.stringify({ session_id: session.session_id, confirmed: true })
      });
      if (!isRenderableSessionState(response.state)) {
        throw new Error("暂停后返回的会话状态不完整");
      }
      setSession(response.state);
      setSearchSummary((current) => [
        ...current.filter((item) => !item.startsWith("用户已暂停")),
        "用户已暂停自动推进；当前模块如已被领取仍会完成，之后不会继续搜索"
      ]);
      setStatusMessage(response.state.agent_runtime.workflow_message);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "暂停 Agent 搜索失败");
    } finally {
      setWorkflowControlBusy(false);
    }
  }

  async function resumeServerWorkflow() {
    if (!session) return;
    if (!window.confirm("将保留已有候选和已完成模块，从当前进度继续搜索。确认继续吗？")) {
      return;
    }
    setWorkflowControlBusy(true);
    setBusy(true);
    setErrorMessage("");
    setStatusMessage("正在从原进度恢复 Agent 搜索");
    try {
      const response = await jsonFetch<{ state: unknown }>("/api/agent/resume", {
        method: "POST",
        body: JSON.stringify({ session_id: session.session_id, confirmed: true })
      });
      if (!isRenderableSessionState(response.state)) {
        throw new Error("恢复后返回的会话状态不完整");
      }
      setSession(response.state);
      const latest = await waitForServerWorkflow(session.session_id, session.shopping_plan.modules.length);
      const completedModules = latest.shopping_plan.modules.filter(
        (module) => (latest.module_candidates[module.module_id]?.length ?? 0) > 0
      );
      setSelectedModuleId(completedModules[0]?.module_id ?? latest.shopping_plan.modules[0]?.module_id ?? "");
      setSearchSummary([
        `服务端 Agent 已整理 ${completedModules.length}/${latest.shopping_plan.modules.length} 个模块`,
        latest.market_feedback.summary,
        latest.agent_runtime.workflow_message
      ]);
      setStatusMessage(
        latest.agent_runtime.workflow_status === "paused"
          ? latest.agent_runtime.workflow_message
          : "后台 Agent 搜索流程已完成。你可以直接查看推荐结果。"
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "继续 Agent 搜索失败");
    } finally {
      setBusy(false);
      setWorkflowControlBusy(false);
    }
  }

  function waitForRuntimeJob(sessionId: string, jobId: string) {
    return new Promise<void>((resolve, reject) => {
      const stream = new EventSource(`/api/runtime/events/stream?session_id=${encodeURIComponent(sessionId)}`);
      const timeout = window.setTimeout(() => {
        stream.close();
        reject(new Error("本地执行任务仍在后台运行，你可以稍后返回当前进度继续查看。"));
      }, 6 * 60 * 1000);
      const finish = () => {
        window.clearTimeout(timeout);
        stream.close();
        resolve();
      };
      for (const eventName of ["job.completed", "job.failed"] as const) {
        stream.addEventListener(eventName, (event) => {
          try {
            const payload = JSON.parse((event as MessageEvent).data) as { job_id?: string };
            if (payload.job_id === jobId) finish();
          } catch {
            // Auxiliary events can be ignored; the persisted session is authoritative.
          }
        });
      }
      stream.onerror = () => {
        // EventSource reconnects automatically; the timeout handles a genuinely unavailable stream.
      };
    });
  }

  async function applyQuickAction(action: QuickAction) {
    if (!session) {
      return;
    }
    setBusy(true);
    setErrorMessage("");
    setStage("refining");
    setStatusMessage(`正在根据「${action}」重算方案`);
    try {
      const result = await jsonFetch<{
        session_id: string;
        impacted_modules: string[];
        refinement_impact?: RefinementImpactSummary;
      }>("/api/scene/refine", {
        method: "POST",
        body: JSON.stringify({
          session_id: session.session_id,
          quick_action: action
        }),
        timeoutMs: 70_000
      });
      const hydrated = await hydrateSession(result.session_id);
      await refreshHostedInstruction(result.session_id);
      const impactedModules = result.impacted_modules;
      const focusModuleId = impactedModules[0] ?? hydrated.shopping_plan.modules[0]?.module_id ?? "";
      setSearchSummary([]);
      setParsedScene(hydrated.scene_brief);
      setSelectedModuleId(focusModuleId);
      setStage("confirm_plan");
      setStatusMessage(result.refinement_impact?.summary ?? (
        impactedModules.length > 0
          ? `调整后的规划已更新，预计影响 ${impactedModules.length} 个模块，请确认最新方案后开始搜索`
          : "调整后的规划已更新，已有候选会尽量保留，请确认最新方案后开始搜索"
      ));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "调整失败");
      setStage("review_results");
    } finally {
      setBusy(false);
    }
  }

  async function applyBudgetSuggestion(suggestion: BudgetReallocationSuggestion) {
    if (!session) {
      return;
    }

    const confirmed = window.confirm(
      `确认从「${suggestion.from_module_name}」向「${suggestion.to_module_name}」调配 ${formatCurrency(suggestion.amount)}？\n\n两个模块的旧候选会被清除，其他模块结果和已选商品会保留。确认新规划后才会重新搜索。`
    );
    if (!confirmed) {
      return;
    }

    setBusy(true);
    setErrorMessage("");
    setStatusMessage("正在应用真实价格反馈并校验预算总额");
    try {
      const result = await jsonFetch<{
        session_id: string;
        impacted_modules: string[];
        refinement_impact: RefinementImpactSummary;
      }>("/api/session/budget-reallocation", {
        method: "POST",
        body: JSON.stringify({
          session_id: session.session_id,
          from_module_id: suggestion.from_module_id,
          to_module_id: suggestion.to_module_id,
          confirmed: true
        }),
        timeoutMs: 20_000
      });
      const hydrated = await hydrateSession(result.session_id);
      setParsedScene(hydrated.scene_brief);
      setSearchSummary([]);
      setSelectedModuleId(
        suggestion.to_module_id || result.impacted_modules[0] || hydrated.shopping_plan.modules[0]?.module_id || ""
      );
      setStage("confirm_plan");
      setStatusMessage(result.refinement_impact.summary);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "预算调配失败");
      setStage("review_results");
    } finally {
      setBusy(false);
    }
  }

  async function recoverCompletionGaps() {
    if (!session?.completion_report || session.completion_report.uncovered_module_ids.length === 0) {
      return;
    }

    const moduleNames = session.completion_report.uncovered_module_ids
      .map((moduleId) => session.shopping_plan.modules.find((module) => module.module_id === moduleId)?.module_name)
      .filter((name): name is string => Boolean(name));
    const confirmed = window.confirm(
      `确认让 Agent 继续补齐以下模块吗？\n\n${moduleNames.join("、") || "未覆盖模块"}\n\n其他模块的候选和已选商品会保留。`
    );
    if (!confirmed) {
      return;
    }

    setBusy(true);
    setErrorMessage("");
    setStage("searching");
    setSearchSummary([`已确认补齐：${moduleNames.join("、") || "未覆盖模块"}`]);
    setStatusMessage("Agent 正在重新执行未覆盖模块");
    try {
      const response = await jsonFetch<{
        recovered_module_ids: string[];
        outcome: AgentRunResponse["outcome"];
      }>("/api/agent/remediate", {
        method: "POST",
        body: JSON.stringify({
          session_id: session.session_id,
          confirmed: true
        })
      });
      const latestSession = await waitForServerWorkflow(
        session.session_id,
        session.shopping_plan.modules.length
      );
      const firstRecoveredModule = response.recovered_module_ids.find(
        (moduleId) => (latestSession.module_candidates[moduleId]?.length ?? 0) > 0
      );
      setSelectedModuleId(firstRecoveredModule ?? selectedModuleId);
      setSearchSummary([
        `Agent 已重新处理 ${response.recovered_module_ids.length} 个缺口模块`,
        latestSession.completion_report?.summary ?? latestSession.agent_runtime.workflow_message
      ]);
      setStage("review_results");
      setStatusMessage("缺口模块已重新处理，完成报告和推荐结果已更新。");
    } catch (error) {
      await hydrateSession(session.session_id).catch(() => undefined);
      setErrorMessage(error instanceof Error ? error.message : "补齐缺口模块失败");
      setStage("review_results");
    } finally {
      setBusy(false);
    }
  }

  async function improveThinCandidates() {
    if (!session?.completion_report || session.completion_report.thin_module_ids.length === 0) {
      return;
    }

    const moduleNames = session.completion_report.thin_module_ids
      .map((moduleId) => session.shopping_plan.modules.find((module) => module.module_id === moduleId)?.module_name)
      .filter((name): name is string => Boolean(name));
    const confirmed = window.confirm(
      `确认让 Agent 增量优化以下候选池吗？\n\n${moduleNames.join("、") || "薄弱模块"}\n\n现有候选和已选商品会保留，新结果会合并重排。`
    );
    if (!confirmed) return;

    setBusy(true);
    setErrorMessage("");
    setStage("searching");
    setSearchSummary([`已确认优化：${moduleNames.join("、") || "薄弱模块"}`]);
    setStatusMessage("Agent 正在为薄弱候选池增量补搜");
    try {
      const response = await jsonFetch<{
        targeted_module_ids: string[];
        outcome: AgentRunResponse["outcome"];
      }>("/api/agent/remediate", {
        method: "POST",
        body: JSON.stringify({
          session_id: session.session_id,
          scope: "thin",
          confirmed: true
        })
      });
      const latestSession = await waitForServerWorkflow(
        session.session_id,
        session.shopping_plan.modules.length
      );
      setSelectedModuleId(response.targeted_module_ids[0] ?? selectedModuleId);
      setSearchSummary([
        `Agent 已增量优化 ${response.targeted_module_ids.length} 个薄弱模块`,
        latestSession.completion_report?.summary ?? latestSession.agent_runtime.workflow_message
      ]);
      setStage("review_results");
      setStatusMessage("薄弱候选池已重新评估，原候选与新结果已合并。");
    } catch (error) {
      await hydrateSession(session.session_id).catch(() => undefined);
      setErrorMessage(error instanceof Error ? error.message : "优化薄弱候选池失败");
      setStage("review_results");
    } finally {
      setBusy(false);
    }
  }

  async function updateAgentProfile(profile: AgentDirectiveProfile) {
    if (!session) {
      return;
    }

    setBusy(true);
    setErrorMessage("");
    setStatusMessage("正在更新 AI 执行档位");
    try {
      await jsonFetch("/api/session/agent-directives", {
        method: "POST",
        body: JSON.stringify({
          session_id: session.session_id,
          profile
        })
      });
      const hydrated = await hydrateSession(session.session_id);
      setStatusMessage(
        `AI 执行档位已更新为 ${hydrated.shopping_plan.agent_directives.autonomy_level} · ${hydrated.shopping_plan.agent_directives.search_depth}`
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "更新 AI 执行档位失败");
    } finally {
      setBusy(false);
    }
  }

  async function updateModuleSearchStrategy(
    moduleId: string,
    payload: {
      primaryKeyword: string;
      alternateKeywords: string[];
    }
  ) {
    if (!session) {
      return;
    }

    setBusy(true);
    setErrorMessage("");
    setStatusMessage("正在保存模块搜索任务包");
    try {
      const result = await jsonFetch<SearchStrategyUpdateResponse>("/api/session/search-strategy", {
        method: "POST",
        body: JSON.stringify({
          session_id: session.session_id,
          module_id: moduleId,
          primary_keyword: payload.primaryKeyword,
          alternate_keywords: payload.alternateKeywords
        })
      });
      if (!isRenderableSessionState(result.state)) {
        throw new Error("搜索任务包保存后返回的会话状态不完整");
      }
      setSession(result.state);
      setSelectedModuleId(moduleId);
      setStatusMessage("搜索任务包已保存。该模块旧候选会失效，后续搜索将按新策略执行。");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "保存搜索任务包失败");
    } finally {
      setBusy(false);
    }
  }

  async function searchSpecificModule(moduleId: string, keywordOverride?: string) {
    if (!session) {
      return;
    }
    setBusy(true);
    setErrorMessage("");
    setStatusMessage(keywordOverride ? `正在按 Agent 建议补搜：${keywordOverride}` : "正在为当前模块执行搜索");
    try {
      await jsonFetch("/api/modules/search", {
        method: "POST",
        body: JSON.stringify({
          session_id: session.session_id,
          module_id: moduleId,
          keyword_override: keywordOverride
        })
      });
      await hydrateSession(session.session_id);
      await refreshHostedInstruction(session.session_id);
      setSelectedModuleId(moduleId);
      setStage("review_results");
      setStatusMessage("当前模块搜索摘要已完成，你可以先查看结果，再按需进入详情");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "模块搜索失败");
    } finally {
      setBusy(false);
    }
  }

  async function addToCart(product: ProductCandidate) {
    if (!session) {
      return;
    }
    const confirmed = window.confirm(`确认将「${product.title}」加入购物车吗？`);
    if (!confirmed) {
      return;
    }
    setBusy(true);
    setCartingProductId(product.product_id);
    setStatusMessage(`正在将 ${product.title} 加入购物车`);
    try {
      const response = await jsonFetch<{
        async?: boolean;
        demo_fallback?: boolean;
        result?: {
          message?: string;
        };
      }>("/api/cart/add", {
        method: "POST",
        body: JSON.stringify({
          session_id: session.session_id,
          product_id: product.product_id,
          confirmed: true
        })
      });
      const hydrated = await hydrateSession(session.session_id);
      await refreshHostedInstruction(session.session_id);
      setStage("review_results");
      setStatusMessage(
        response.demo_fallback
          ? `真实加购失败，已将 ${product.title} 加入产品内演示购物车`
          : response.async || hydrated.hosted_tasks.some(
          (task) =>
            task.task_type === "add_to_cart" &&
            task.product_id === product.product_id &&
            (task.status === "pending" || task.status === "running")
        )
          ? `已提交后台执行加购：${product.title}，页面会自动同步结果`
          : isHostedMode(mcpStatus)
            ? `已将加购请求提交给 Codex 宿主：${product.title}`
            : response.result?.message || `已完成加入购物车：${product.title}`
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "加入购物车失败");
      setStage("review_results");
    } finally {
      setBusy(false);
      setCartingProductId("");
    }
  }

  async function removeDemoCartItem(item: CartReviewItem) {
    if (!session || item.cart_source !== "demo") {
      return;
    }
    const confirmed = window.confirm(`确认将「${item.title}」从产品内演示清单移除吗？`);
    if (!confirmed) {
      return;
    }

    setBusy(true);
    setRemovingCartProductId(item.product_id);
    setErrorMessage("");
    setStatusMessage(`正在从演示清单移除 ${item.title}`);
    try {
      const response = await jsonFetch<{ state: unknown }>("/api/cart/remove", {
        method: "POST",
        body: JSON.stringify({
          session_id: session.session_id,
          product_id: item.product_id,
          confirmed: true
        })
      });
      if (!isRenderableSessionState(response.state)) {
        throw new Error("移除商品后返回的会话状态不完整");
      }
      setSession(response.state);
      setStatusMessage(`已将 ${item.title} 从产品内演示清单移除`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "移除演示商品失败");
    } finally {
      setBusy(false);
      setRemovingCartProductId("");
    }
  }

  async function acceptPurchaseBundle() {
    const purchaseBundle = session?.completion_report?.purchase_bundle;
    if (!session || !purchaseBundle) return;
    const confirmed = window.confirm(
      "采用后会生成产品内待处理清单，不会自动加入淘宝购物车。每件商品仍需你逐件确认，是否继续？"
    );
    if (!confirmed) return;

    setBusy(true);
    setErrorMessage("");
    setStatusMessage("正在确认 Agent 购买组合");
    try {
      const response = await jsonFetch<{ state: unknown }>("/api/session/purchase-bundle", {
        method: "POST",
        body: JSON.stringify({
          session_id: session.session_id,
          bundle_generated_at: purchaseBundle.generated_at,
          confirmed: true
        })
      });
      if (!isRenderableSessionState(response.state)) {
        throw new Error("采用购买组合后返回的会话状态不完整");
      }
      setSession(response.state);
      setStatusMessage("已采用 Agent 组合。接下来可逐件确认加入淘宝购物车。");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "采用购买组合失败");
    } finally {
      setBusy(false);
    }
  }

  const missingStageData =
    (stage === "confirm_scene" && !parsedScene) ||
    (SESSION_REQUIRED_STAGES.includes(stage) && !session);

  return (
    <main className="min-h-screen">
      <div className="page-shell">
        <TopHeader currentStage={stageLabels[stage]} />

        {resumeSnapshot ? (
          <ResumeBanner
            snapshot={resumeSnapshot}
            onResume={resumeWorkflow}
            onRestart={restartWorkflowFromBanner}
          />
        ) : null}

        {stage === "landing" || stage === "scenario_select" ? (
          <LandingPage
            onEnterScenario={enterScenario}
            interactiveReady={interactiveReady}
            recentSessions={recentSessions.filter((item) => item.session_id !== resumeSnapshot?.sessionId)}
            archivedSessions={archivedSessions}
            recentSessionsLoading={recentSessionsLoading}
            resumingSessionId={resumingSessionId}
            lifecycleSessionId={lifecycleSessionId}
            onResumeSession={resumeServerSession}
            onArchiveSession={(summary) => updateServerSessionLifecycle(summary, "archive")}
            onRestoreSession={(summary) => updateServerSessionLifecycle(summary, "restore")}
          />
        ) : null}

        {stage === "input_requirement" ? (
          <RequirementPage
            sceneInput={sceneInput}
            onSceneInputChange={setSceneInput}
            onExampleClick={setSceneInput}
            onBack={resetWorkflow}
            onContinue={startParsing}
            errorMessage={errorMessage}
            busy={busy}
          />
        ) : null}

        {stage === "parsing" ? <StatusPage title="正在理解需求" description={statusMessage} loading /> : null}

        {stage === "confirm_scene" && parsedScene ? (
          <ConfirmScenePage
            scene={parsedScene}
            onSceneChange={setParsedScene}
            onSceneInputChange={setSceneInput}
            onBack={() => setStage("input_requirement")}
            onConfirm={confirmSceneAndPlan}
            busy={busy}
            statusMessage={statusMessage}
            expandedModel={expandedModel}
            setExpandedModel={setExpandedModel}
          />
        ) : null}

        {stage === "planning" ? <StatusPage title="正在生成购物规划" description={statusMessage} loading /> : null}

        {stage === "confirm_plan" && session ? (
          <ConfirmPlanPage
            session={session}
            onBack={() => setStage("input_requirement")}
            onAdjust={() => setStage("confirm_scene")}
            onAgentProfileChange={updateAgentProfile}
            onSearchStrategyChange={updateModuleSearchStrategy}
            onConfirm={startSearching}
            busy={busy}
            expandedModel={expandedModel}
            setExpandedModel={setExpandedModel}
          />
        ) : null}

        {stage === "searching" && session ? (
          <SearchSummaryPage
            session={session}
            mcpStatus={mcpStatus}
            workerStatus={workerStatus}
            searchSummary={searchSummary}
            pendingCount={pendingHostedTasks.length}
            completedCount={completedHostedTasks.length}
            hostedInstruction={hostedInstruction}
            expandedLogs={expandedLogs}
            setExpandedLogs={setExpandedLogs}
            onRefresh={async () => {
              await hydrateSession(session.session_id);
              await refreshHostedInstruction(session.session_id);
            }}
            onViewResults={() => setStage("review_results")}
            onPauseWorkflow={pauseServerWorkflow}
            onResumeWorkflow={resumeServerWorkflow}
            busy={busy}
            workflowControlBusy={workflowControlBusy}
          />
        ) : null}

        {stage === "review_results" && session ? (
          <ResultsPage
            session={session}
            selectedModuleId={selectedModuleId}
            onSelectModule={setSelectedModuleId}
            selectedProducts={selectedProducts}
            estimatedTotal={estimatedTotal}
            onQuickAction={applyQuickAction}
            onApplyBudgetSuggestion={applyBudgetSuggestion}
            onRecoverCompletionGaps={recoverCompletionGaps}
            onImproveThinCandidates={improveThinCandidates}
            onAcceptPurchaseBundle={acceptPurchaseBundle}
            onAddToCart={addToCart}
            onProceedToCartReview={() => setStage("cart_review")}
            expandedLogs={expandedLogs}
            setExpandedLogs={setExpandedLogs}
            mcpStatus={mcpStatus}
            workerStatus={workerStatus}
            hostedInstruction={hostedInstruction}
            onRefresh={async () => {
              await hydrateSession(session.session_id);
              await refreshHostedInstruction(session.session_id);
            }}
            onSearchModule={searchSpecificModule}
            cartingProductId={cartingProductId}
            busy={busy}
          />
        ) : null}

        {stage === "cart_review" && session ? (
          <CartReviewPage
            items={cartReviewItems}
            total={estimatedTotal}
            onBack={() => setStage("review_results")}
            onRemoveDemoItem={removeDemoCartItem}
            removingProductId={removingCartProductId}
          />
        ) : null}

        {stage === "refining" ? <StatusPage title="正在调整推荐" description={statusMessage} loading /> : null}

        {stage === "carting" ? <StatusPage title="正在加入购物车" description={statusMessage} loading /> : null}

        {missingStageData ? (
          <StatusPage
            title="正在恢复当前步骤"
            description="页面状态正在校准，将自动返回最近可继续的步骤。"
            loading
          />
        ) : null}

        {errorMessage ? (
          <div className="rounded-[24px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {errorMessage}
          </div>
        ) : null}
      </div>
    </main>
  );
}
