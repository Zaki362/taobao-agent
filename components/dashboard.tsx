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
import { HostedWorkerStatus, MpcStatus } from "@/components/dashboard-types";
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
import { AgentDecision, ProductCandidate, QuickAction, RefinementImpactSummary, SessionState, WorkflowStage } from "@/lib/session/types";
import type { AgentDirectiveProfile } from "@/lib/agent/directives";

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
    const data = await jsonFetch<HostedTaskInstruction>(`/api/hosted/tasks/next?session_id=${sessionId}`);
    setHostedInstruction(data.instruction ?? "");
    return data;
  }

  async function refreshWorkerStatus() {
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
        mode: "codex_hosted",
        available: false,
        message: "Codex 宿主状态检查失败，请刷新页面后重试。",
        permissions_scope: ["淘宝搜索", "详情提取", "加入购物车需显式确认"]
      });
    }
  }

  useEffect(() => {
    setInteractiveReady(true);
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
    refreshWorkerStatus().catch(() => undefined);
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

  function restartWorkflowFromBanner() {
    resetWorkflow();
    setResumeSnapshot(null);
  }

  useEffect(() => {
    refreshWorkerStatus().catch(() => undefined);
    const timer = window.setInterval(() => {
      refreshWorkerStatus().catch(() => undefined);
    }, 5000);

    return () => window.clearInterval(timer);
  }, []);

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
          `服务端 Agent 已完成 ${completedModules.length}/${modules.length} 个模块的候选整理`,
          latestSession.market_feedback.summary,
          latestSession.agent_runtime.workflow_message
        ]);
        setStatusMessage("后台 Agent 搜索流程已完成。你可以直接查看推荐结果。");
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

      if (runtime.workflow_status === "completed") return latest;
      if (runtime.workflow_status === "paused" || runtime.workflow_status === "error") {
        throw new Error(runtime.workflow_message || "服务端 Agent 已暂停");
      }

      await new Promise((resolve) => window.setTimeout(resolve, 1_200));
      latest = await hydrateSession(sessionId);
    }

    throw new Error("搜索仍在后台执行。你可以关闭页面，稍后通过当前进度继续查看。");
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
          <LandingPage onEnterScenario={enterScenario} interactiveReady={interactiveReady} />
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
            busy={busy}
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
