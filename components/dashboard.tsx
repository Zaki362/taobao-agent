"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Loader2,
  Settings2,
  ShoppingCart,
  Sparkles,
  Store,
  Wand2
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { getScenarioConfig } from "@/lib/scenarios";
import { formatCurrency } from "@/lib/utils";
import { PriorityStyle, ProductCandidate, QuickAction, SessionState, WorkflowStage } from "@/lib/session/types";

const scenarioOptions = [
  { id: "new-car", label: "新车选购", description: "已支持", enabled: true },
  { id: "camping", label: "露营准备", description: "即将支持", enabled: false },
  { id: "room-decor", label: "房间装饰", description: "即将支持", enabled: false },
  { id: "dorm-move-in", label: "宿舍入学", description: "即将支持", enabled: false },
  { id: "moving-setup", label: "搬家置办", description: "即将支持", enabled: false }
] as const;

const requirementExamples = getScenarioConfig("new-car").example_prompts;
const vehicleOptions = getScenarioConfig("new-car").field_option_sets.vehicle_type ?? ["新能源车", "轿车", "SUV", "混动车", "MPV"];
const stageOptions = getScenarioConfig("new-car").field_option_sets.user_stage ?? ["提车初期", "第一周", "第一阶段首购", "首月补齐"];
const preferenceOptions: PriorityStyle[] = getScenarioConfig("new-car").field_option_sets.priority_style ?? ["实用优先", "舒适优先", "安全优先", "性价比优先"];
const alreadyHaveOptions = getScenarioConfig("new-car").field_option_sets.already_have ?? ["行车记录仪", "车载手机支架", "应急启动电源", "车载充电器", "脚垫", "纸巾收纳"];
const avoidItemOptions = getScenarioConfig("new-car").field_option_sets.avoid_items ?? ["装饰类", "香薰摆件", "高价升级款", "复杂安装类", "占空间收纳箱"];
const quickActions: QuickAction[] = getScenarioConfig("new-car").quick_actions;

const stageLabels: Record<WorkflowStage, string> = {
  landing: "场景入口",
  scenario_select: "场景选择",
  input_requirement: "输入需求",
  parsing: "理解需求",
  confirm_scene: "确认场景",
  planning: "生成规划",
  confirm_plan: "确认规划",
  searching: "执行搜索",
  review_results: "查看推荐",
  cart_review: "确认下单",
  refining: "调整方案",
  confirm_refine: "确认调整",
  carting: "加入购物车"
};

const defaultInput = getScenarioConfig("new-car").example_prompts[0];
const WORKFLOW_STORAGE_KEY = "scenecart-dashboard-state";

type MpcStatus = {
  mode: "codex_hosted" | "experimental_local" | "qoder_cli";
  available: boolean;
  message: string;
  permissions_scope: string[];
};

type HostedTaskInstruction = {
  task: {
    task_id: string;
    title: string;
  } | null;
  instruction: string | null;
};

type HostedWorkerStatus = {
  online: boolean;
  updated_at: string | null;
  started_at: string | null;
  state: string;
  mode: string | null;
  interval_ms: number | null;
  pid: number | null;
  api_base_url: string | null;
  last_task_id: string | null;
  last_task_type: string | null;
  last_result: string | null;
  last_error: string | null;
};

type PersistedDashboardState = {
  stage: WorkflowStage;
  selectedScenario: "new-car" | null;
  sceneInput: string;
  parsedScene: SessionState["scene_brief"] | null;
  sessionId: string | null;
  selectedModuleId: string;
  expandedLogs: boolean;
  expandedModel: boolean;
  statusMessage: string;
  searchSummary: string[];
  refineSummary: string[];
};

type ResumeSnapshot = PersistedDashboardState | null;

function isHostedMode(status: MpcStatus | null) {
  return status?.mode === "codex_hosted";
}

function getExecutionModeLabel(status: MpcStatus | null) {
  if (status?.mode === "qoder_cli") {
    return "Qoder CLI 直连执行";
  }
  if (status?.mode === "codex_hosted") {
    return "Codex 宿主代理执行";
  }
  return "实验性本地桥接";
}

function toggleMultiValue(list: string[], value: string) {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function getPriorityTone(priority: number) {
  if (priority <= 1) return "优先级最高";
  if (priority === 2) return "优先级较高";
  if (priority === 3) return "优先级中等";
  return "可后置考虑";
}

function getBudgetReason(module: SessionState["shopping_plan"]["modules"][number], totalBudget: number) {
  const ratio = totalBudget > 0 ? Math.round((module.budget_allocation / totalBudget) * 100) : 0;
  const priorityLabel = getPriorityTone(module.priority);
  if (module.priority <= 1) {
    return `${priorityLabel}，需要先保障核心功能，约占总预算 ${ratio}%。`;
  }
  if (module.priority === 2) {
    return `${priorityLabel}，兼顾体验与实用，约占总预算 ${ratio}%。`;
  }
  return `${priorityLabel}，建议在前置需求满足后再投入，约占总预算 ${ratio}%。`;
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json") ? await response.json().catch(() => null) : null;

  if (!response.ok) {
    const errorMessage =
      payload && typeof payload.error === "string"
        ? payload.error
        : response.statusText || "Request failed";
    throw new Error(`${url} - ${errorMessage}`);
  }

  return payload as T;
}

function isSessionState(value: unknown): value is SessionState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.session_id === "string" &&
    record.scene_brief !== null &&
    typeof record.scene_brief === "object" &&
    Array.isArray(record.base_template) &&
    record.shopping_plan !== null &&
    typeof record.shopping_plan === "object" &&
    Array.isArray((record.shopping_plan as Record<string, unknown>).modules)
  );
}

function buildSceneInputFromBrief(scene: SessionState["scene_brief"]) {
  const parts = [
    scene.vehicle_type,
    `预算 ${scene.budget}`,
    scene.priority_style,
    scene.user_stage
  ];
  if (scene.already_have.length > 0) {
    parts.push(`已有：${scene.already_have.join("、")}`);
  }
  if (scene.avoid_items.length > 0) {
    parts.push(`不考虑：${scene.avoid_items.join("、")}`);
  }
  if (scene.optional_notes) {
    parts.push(scene.optional_notes);
  }
  return parts.join("，");
}

export function Dashboard() {
  const hasRestoredRef = useRef(false);
  const autoResumeHandledRef = useRef(false);
  const searchParams = useSearchParams();
  const [stage, setStage] = useState<WorkflowStage>("landing");
  const [selectedScenario, setSelectedScenario] = useState<"new-car" | null>(null);
  const [sceneInput, setSceneInput] = useState(defaultInput);
  const [parsedScene, setParsedScene] = useState<SessionState["scene_brief"] | null>(null);
  const [session, setSession] = useState<SessionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState("等待开始");
  const [searchSummary, setSearchSummary] = useState<string[]>([]);
  const [refineSummary, setRefineSummary] = useState<string[]>([]);
  const [expandedLogs, setExpandedLogs] = useState(false);
  const [expandedModel, setExpandedModel] = useState(false);
  const [selectedModuleId, setSelectedModuleId] = useState("");
  const [mcpStatus, setMcpStatus] = useState<MpcStatus | null>(null);
  const [hostedInstruction, setHostedInstruction] = useState<string>("");
  const [workerStatus, setWorkerStatus] = useState<HostedWorkerStatus | null>(null);
  const [resumeSnapshot, setResumeSnapshot] = useState<ResumeSnapshot>(null);

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
    if (!isSessionState(data)) {
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
    setSession(null);
    setErrorMessage("");
    setStatusMessage("等待开始");
    setSearchSummary([]);
    setRefineSummary([]);
    setExpandedLogs(false);
    setExpandedModel(false);
    setSelectedModuleId("");
    setHostedInstruction("");
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
    if (hasRestoredRef.current || typeof window === "undefined") {
      return;
    }

    hasRestoredRef.current = true;
    const raw = window.localStorage.getItem(WORKFLOW_STORAGE_KEY);
    if (!raw) {
      return;
    }

    try {
      const persisted = JSON.parse(raw) as Partial<PersistedDashboardState>;
      refreshMcpStatus().catch(() => undefined);
      refreshWorkerStatus().catch(() => undefined);
      setResumeSnapshot({
        stage: persisted.stage ?? "input_requirement",
        selectedScenario: persisted.selectedScenario === "new-car" ? "new-car" : null,
        sceneInput: typeof persisted.sceneInput === "string" ? persisted.sceneInput : defaultInput,
        parsedScene: persisted.parsedScene ?? null,
        sessionId: typeof persisted.sessionId === "string" ? persisted.sessionId : null,
        selectedModuleId: typeof persisted.selectedModuleId === "string" ? persisted.selectedModuleId : "",
        expandedLogs: typeof persisted.expandedLogs === "boolean" ? persisted.expandedLogs : false,
        expandedModel: typeof persisted.expandedModel === "boolean" ? persisted.expandedModel : false,
        statusMessage: typeof persisted.statusMessage === "string" ? persisted.statusMessage : "等待开始",
        searchSummary: Array.isArray(persisted.searchSummary) ? persisted.searchSummary : [],
        refineSummary: Array.isArray(persisted.refineSummary) ? persisted.refineSummary : []
      });
    } catch {
      window.localStorage.removeItem(WORKFLOW_STORAGE_KEY);
    }
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

    const payload: PersistedDashboardState = {
      stage,
      selectedScenario,
      sceneInput,
      parsedScene,
      sessionId: session?.session_id ?? null,
      selectedModuleId,
      expandedLogs,
      expandedModel,
      statusMessage,
      searchSummary,
      refineSummary
    };

    window.localStorage.setItem(WORKFLOW_STORAGE_KEY, JSON.stringify(payload));
  }, [
    expandedLogs,
    expandedModel,
    parsedScene,
    refineSummary,
    sceneInput,
    searchSummary,
    selectedModuleId,
    selectedScenario,
    session?.session_id,
    stage,
    statusMessage,
    resumeSnapshot
  ]);

  async function resumeWorkflow() {
    if (!resumeSnapshot) {
      return;
    }

    setSceneInput(resumeSnapshot.sceneInput);
    setSelectedScenario(resumeSnapshot.selectedScenario);
    setParsedScene(resumeSnapshot.parsedScene);
    setExpandedLogs(resumeSnapshot.expandedLogs);
    setExpandedModel(resumeSnapshot.expandedModel);
    setStatusMessage(resumeSnapshot.statusMessage);
    setSearchSummary(resumeSnapshot.searchSummary);
    setRefineSummary(resumeSnapshot.refineSummary);
    setSelectedModuleId(resumeSnapshot.selectedModuleId);
    setResumeSnapshot(null);

    if (resumeSnapshot.sessionId) {
      try {
        const data = await hydrateSession(resumeSnapshot.sessionId);
        await refreshHostedInstruction(resumeSnapshot.sessionId).catch(() => undefined);
        setStage(resumeSnapshot.stage);
        setSelectedScenario("new-car");
        setParsedScene(data.scene_brief);
        setSelectedModuleId(
          resumeSnapshot.selectedModuleId || data.shopping_plan.modules[0]?.module_id || ""
        );
        return;
      } catch {
        resetWorkflow();
        return;
      }
    }

    setStage(resumeSnapshot.selectedScenario === "new-car" ? resumeSnapshot.stage : "landing");
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
        body: JSON.stringify({ raw_input: sceneInput })
      });
      setParsedScene(parsed.scene_brief);
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
          scene_brief: parsedScene
        })
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
    setStatusMessage(`正在通过${executionLabel}串行搜索优先模块，并先返回商品摘要`);
    try {
      const summary: string[] = [];
      const modules = session.shopping_plan.modules;
      if (modules.length === 0) {
        throw new Error("当前规划中没有可搜索模块");
      }

      let latestSession = session;

      for (let index = 0; index < modules.length; index += 1) {
        const module = modules[index];
        setStatusMessage(
          `正在通过${executionLabel}搜索模块 ${index + 1}/${modules.length}：${module.module_name}`
        );

        try {
          await jsonFetch("/api/modules/search", {
            method: "POST",
            body: JSON.stringify({
              session_id: latestSession.session_id,
              module_id: module.module_id
            })
          });
          const hydrated = await hydrateSession(latestSession.session_id);
          latestSession = hydrated;
          await refreshHostedInstruction(latestSession.session_id);

          const task = hydrated.hosted_tasks.find(
            (entry) =>
              entry.task_type === "module_search" &&
              entry.module_id === module.module_id &&
              (entry.status === "pending" || entry.status === "running" || entry.status === "completed")
          );
          const count = hydrated.module_candidates[module.module_id]?.length ?? 0;

          if (isHostedMode(mcpStatus)) {
            summary.push(
              task?.status === "completed"
                ? `Codex 宿主已完成「${module.module_name}」并返回 ${count} 个候选商品`
                : `已向 Codex 宿主提交「${module.module_name}」任务，等待搜索与详情提取完成`
            );
          } else {
            summary.push(
              count > 0
                ? `已完成「${module.module_name}」搜索摘要，并生成 ${count} 个候选商品`
                : `已执行「${module.module_name}」搜索，但暂未返回可展示商品`
            );
          }
        } catch (error) {
          summary.push(
            `「${module.module_name}」搜索未完成：${error instanceof Error ? error.message : "未知错误"}`
          );
        }

        setSearchSummary([...summary]);
      }

      setSelectedModuleId(modules[0]?.module_id ?? "");
      setSearchSummary(summary);
      setStatusMessage(
        isHostedMode(mcpStatus)
          ? "执行任务已提交。你可以先查看任务摘要，等 Codex 宿主回填结果后再查看推荐。"
          : "优先模块搜索已完成。你可以直接查看推荐结果。"
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "执行搜索失败");
    } finally {
      setBusy(false);
    }
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
      const result = await jsonFetch<{ session_id: string; impacted_modules: string[] }>("/api/scene/refine", {
        method: "POST",
        body: JSON.stringify({
          session_id: session.session_id,
          quick_action: action
        })
      });
      let hydrated = await hydrateSession(result.session_id);
      await refreshHostedInstruction(result.session_id);
      const impactedModules = result.impacted_modules.length
        ? result.impacted_modules
        : hydrated.shopping_plan.modules.map((module) => module.module_id);
      const moduleNames = hydrated.shopping_plan.modules
        .filter((module) => impactedModules.includes(module.module_id))
        .map((module) => module.module_name);
      const summary = [
        `已按「${action}」完成局部重算`,
        moduleNames.length ? `受影响模块：${moduleNames.join("、")}` : "本次调整未改变模块结构",
        `当前预算：${formatCurrency(hydrated.scene_brief.budget)}`,
        "已更新购物规划，确认最新方案后再开始搜索"
      ];
      setRefineSummary(summary);
      setSearchSummary([]);
      setParsedScene(hydrated.scene_brief);
      setSelectedModuleId(impactedModules[0] ?? hydrated.shopping_plan.modules[0]?.module_id ?? "");
      setStage("confirm_plan");
      setStatusMessage("调整后的规划已更新，请确认最新方案后开始搜索");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "调整失败");
      setStage("review_results");
    } finally {
      setBusy(false);
    }
  }

  async function searchSpecificModule(moduleId: string) {
    if (!session) {
      return;
    }
    setBusy(true);
    setErrorMessage("");
    setStatusMessage("正在为当前模块执行搜索");
    try {
      await jsonFetch("/api/modules/search", {
        method: "POST",
        body: JSON.stringify({
          session_id: session.session_id,
          module_id: moduleId
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
    setStage("carting");
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
          product_id: product.product_id
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
    }
  }

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

        {stage === "landing" ? (
          <LandingPage onEnterScenario={enterScenario} />
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

        {stage === "confirm_refine" && session ? (
          <ConfirmRefinePage
            summary={refineSummary}
            onBack={() => setStage("review_results")}
            onConfirm={() => setStage("review_results")}
          />
        ) : null}

        {stage === "carting" ? <StatusPage title="正在加入购物车" description={statusMessage} loading /> : null}

        {errorMessage ? (
          <div className="rounded-[24px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {errorMessage}
          </div>
        ) : null}
      </div>
    </main>
  );
}

function TopHeader({ currentStage }: { currentStage: string }) {
  return (
    <Card className="hero-card">
      <CardContent className="flex flex-col gap-5 px-6 py-6 md:flex-row md:items-end md:justify-between md:px-8 md:py-7">
        <div className="max-w-3xl">
          <div className="flex items-center gap-2">
            <Badge>SceneCart AI</Badge>
            <Badge variant="outline">场景化购物 Agent</Badge>
          </div>
          <h1 className="mt-4 text-balance text-[34px] font-semibold leading-[1.12] tracking-tight text-foreground md:text-[42px]">
            帮你分阶段完成场景化购物决策
          </h1>
          <p className="mt-3 max-w-2xl text-[15px] leading-7 text-muted-foreground md:text-base">
            不只是给你一堆商品，而是先理解场景，再规划清单，最后执行搜索与购物。
          </p>
        </div>
        <div className="flex flex-col items-start gap-3 md:items-end">
          <div className="subtle-card px-4 py-3">
            <p className="label-text">当前步骤</p>
            <p className="mt-2 text-base font-semibold">{currentStage}</p>
          </div>
          <a
            href="/hosted"
            className="inline-flex h-11 items-center justify-center rounded-full border border-border/80 bg-white px-5 text-sm font-medium text-foreground shadow-sm transition hover:border-primary/30 hover:bg-white"
          >
            打开后端执行台
          </a>
        </div>
      </CardContent>
    </Card>
  );
}

function LandingPage({ onEnterScenario }: { onEnterScenario: () => void }) {
  return (
    <Card className="section-card">
      <CardContent className="space-y-8 px-6 py-8 md:px-8 md:py-9">
        <div className="max-w-3xl">
          <p className="label-text">Scene Entry</p>
          <h2 className="mt-4 section-heading text-balance">选择一个购物场景，Agent 会带你一步步完成决策</h2>
          <p className="mt-3 max-w-2xl section-subheading">
            从场景切入，而不是从单品搜索开始。先明确任务、预算和阶段，再逐步得到清单和推荐结果。
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          {scenarioOptions.map((scenario) => (
            <button
              key={scenario.id}
              className={`min-h-[168px] rounded-[28px] border p-5 text-left transition ${
                scenario.enabled
                  ? "border-primary/15 bg-white hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-card"
                  : "cursor-not-allowed border-border/70 bg-muted/45 opacity-70"
              }`}
              onClick={scenario.enabled ? onEnterScenario : undefined}
              disabled={!scenario.enabled}
            >
              <div className="flex items-center justify-between">
                <p className="text-lg font-semibold">{scenario.label}</p>
                {scenario.enabled ? <ChevronRight className="h-4 w-4 text-primary" /> : <Badge variant="outline">即将支持</Badge>}
              </div>
              <p className="mt-8 text-sm text-muted-foreground">{scenario.description}</p>
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ResumeBanner({
  snapshot,
  onResume,
  onRestart
}: {
  snapshot: PersistedDashboardState;
  onResume: () => void;
  onRestart: () => void;
}) {
  return (
    <Card className="section-card border-primary/10">
      <CardContent className="flex flex-col gap-4 px-6 py-5 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">发现上次未完成的会话</p>
          <p className="mt-1 text-sm leading-7 text-muted-foreground">
            上次停留在「{stageLabels[snapshot.stage]}」，需求为「{snapshot.sceneInput.slice(0, 36)}
            {snapshot.sceneInput.length > 36 ? "..." : ""}」。
          </p>
        </div>
        <div className="flex gap-3">
          <Button variant="outline" onClick={onRestart}>重新开始</Button>
          <Button onClick={onResume}>继续上次会话</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function RequirementPage({
  sceneInput,
  onSceneInputChange,
  onExampleClick,
  onBack,
  onContinue,
  errorMessage,
  busy
}: {
  sceneInput: string;
  onSceneInputChange: (value: string) => void;
  onExampleClick: (value: string) => void;
  onBack: () => void;
  onContinue: () => void;
  errorMessage: string;
  busy: boolean;
}) {
  return (
    <Card className="section-card">
      <CardHeader>
        <CardTitle>新车选购</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <Textarea value={sceneInput} onChange={(event) => onSceneInputChange(event.target.value)} className="min-h-40 text-base" />
        <div className="flex flex-wrap gap-2.5">
          {requirementExamples.map((example) => (
            <button
              key={example}
              className="rounded-full border border-border/80 bg-white px-4 py-2 text-sm text-muted-foreground shadow-sm transition hover:border-primary/30 hover:text-foreground"
              onClick={() => onExampleClick(example)}
            >
              {example}
            </button>
          ))}
        </div>
        {errorMessage ? <div className="rounded-[22px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{errorMessage}</div> : null}
        <div className="flex gap-3">
          <Button variant="outline" onClick={onBack}>返回场景入口</Button>
          <Button onClick={onContinue} disabled={busy}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
            开始理解需求
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function StatusPage({ title, description, loading }: { title: string; description: string; loading?: boolean }) {
  return (
    <Card className="section-card">
      <CardContent className="flex min-h-[360px] flex-col items-center justify-center gap-4 px-6 py-8 text-center">
        {loading ? <Loader2 className="h-6 w-6 animate-spin text-primary" /> : <CheckCircle2 className="h-6 w-6 text-primary" />}
        <h2 className="text-balance text-2xl font-semibold md:text-[30px]">{title}</h2>
        <p className="max-w-xl text-[15px] leading-7 text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}

function ConfirmScenePage({
  scene,
  onSceneChange,
  onSceneInputChange,
  onBack,
  onConfirm,
  busy,
  statusMessage,
  expandedModel,
  setExpandedModel
}: {
  scene: SessionState["scene_brief"];
  onSceneChange: (scene: SessionState["scene_brief"]) => void;
  onSceneInputChange: (value: string) => void;
  onBack: () => void;
  onConfirm: () => void;
  busy: boolean;
  statusMessage: string;
  expandedModel: boolean;
  setExpandedModel: (value: boolean) => void;
}) {
  const updateScene = (patch: Partial<SessionState["scene_brief"]>) => {
    const next = { ...scene, ...patch };
    onSceneChange(next);
    onSceneInputChange(buildSceneInputFromBrief(next));
  };

  return (
    <Card className="section-card">
      <CardHeader>
        <CardTitle>确认场景理解结果</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2">
          <EditableChoiceField
            label="车型"
            value={scene.vehicle_type}
            options={[...vehicleOptions]}
            onSelect={(value) => updateScene({ vehicle_type: value })}
          />
          <EditableBudgetField
            label="预算"
            value={scene.budget}
            onChange={(value) => updateScene({ budget: value })}
          />
          <EditableChoiceField
            label="偏好"
            value={scene.priority_style}
            options={preferenceOptions}
            onSelect={(value) => updateScene({ priority_style: value as PriorityStyle })}
          />
          <EditableChoiceField
            label="阶段"
            value={scene.user_stage}
            options={[...stageOptions]}
            onSelect={(value) => updateScene({ user_stage: value })}
          />
          <EditableTagField
            label="排除项"
            selected={scene.avoid_items}
            options={avoidItemOptions}
            emptyLabel="无"
            onToggle={(value) => updateScene({ avoid_items: toggleMultiValue(scene.avoid_items, value) })}
          />
          <EditableTagField
            label="已有物品"
            selected={scene.already_have}
            options={alreadyHaveOptions}
            emptyLabel="无"
            onToggle={(value) => updateScene({ already_have: toggleMultiValue(scene.already_have, value) })}
          />
        </div>
        <details open={expandedModel} onToggle={(event) => setExpandedModel((event.target as HTMLDetailsElement).open)} className="subtle-card p-4">
          <summary className="cursor-pointer text-sm font-medium">查看过程</summary>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">
            已完成场景理解。系统根据你的需求提取出结构化 Scene Brief，后续会在基础模板上做个性化调整。
          </p>
        </details>
        <div className="panel-muted px-4 py-3 text-sm text-muted-foreground">{statusMessage}</div>
        <div className="flex gap-3">
          <Button variant="outline" onClick={onBack}>返回修改需求</Button>
          <Button onClick={onConfirm} disabled={busy}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowRight className="mr-2 h-4 w-4" />}
            确认需求，开始生成购物规划
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ConfirmPlanPage({
  session,
  onBack,
  onAdjust,
  onConfirm,
  busy,
  expandedModel,
  setExpandedModel
}: {
  session: SessionState;
  onBack: () => void;
  onAdjust: () => void;
  onConfirm: () => void;
  busy: boolean;
  expandedModel: boolean;
  setExpandedModel: (value: boolean) => void;
}) {
  return (
    <Card className="section-card">
      <CardHeader>
        <CardTitle>确认购物规划</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4">
          {session.shopping_plan.modules.map((module) => (
            <div key={module.module_id} className="subtle-card p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-semibold">{module.module_name}</p>
                    <Badge variant="secondary">{getPriorityTone(module.priority)}</Badge>
                  </div>
                  <p className="mt-2 max-w-2xl text-sm leading-7 text-muted-foreground">{module.description}</p>
                  <div className="mt-4 grid gap-2 text-xs leading-6 text-muted-foreground md:grid-cols-2">
                    <p>搜索关键词：{module.search_keyword ?? module.typical_item_types.slice(0, 3).join(" · ")}</p>
                    <p>策略说明：{module.recommendation_strategy}</p>
                    <p className="md:col-span-2">预算说明：{getBudgetReason(module, session.scene_brief.budget)}</p>
                  </div>
                </div>
                <div className="min-w-[108px] rounded-[18px] bg-secondary/55 px-4 py-3 text-right">
                  <p className="text-xs text-muted-foreground">预算分配</p>
                  <p className="mt-1 text-lg font-semibold">{formatCurrency(module.budget_allocation)}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
        <details open={expandedModel} onToggle={(event) => setExpandedModel((event.target as HTMLDetailsElement).open)} className="subtle-card p-4">
          <summary className="cursor-pointer text-sm font-medium">查看过程</summary>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">{session.shopping_plan.personalization_summary}</p>
          <p className="mt-2 text-sm leading-7 text-muted-foreground">{session.shopping_plan.overall_rationale}</p>
        </details>
        <div className="flex gap-3">
          <Button variant="outline" onClick={onBack}>返回修改需求</Button>
          <Button variant="outline" onClick={onAdjust}>重新调整规划</Button>
          <Button onClick={onConfirm} disabled={busy}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowRight className="mr-2 h-4 w-4" />}
            确认规划，开始搜索推荐商品
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SearchSummaryPage({
  session,
  mcpStatus,
  workerStatus,
  searchSummary,
  pendingCount,
  completedCount,
  hostedInstruction,
  expandedLogs,
  setExpandedLogs,
  onRefresh,
  onViewResults,
  busy
}: {
  session: SessionState;
  mcpStatus: MpcStatus | null;
  workerStatus: HostedWorkerStatus | null;
  searchSummary: string[];
  pendingCount: number;
  completedCount: number;
  hostedInstruction: string;
  expandedLogs: boolean;
  setExpandedLogs: (value: boolean) => void;
  onRefresh: () => void;
  onViewResults: () => void;
  busy: boolean;
}) {
  const hostedMode = isHostedMode(mcpStatus);

  return (
    <Card className="section-card">
      <CardHeader>
        <CardTitle>{hostedMode ? "宿主代理执行摘要" : "Qoder 执行摘要"}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-3">
          {hostedMode ? (
            <>
              <InfoBlock label="已提交任务" value={`${session.hosted_tasks.length} 个`} />
              <InfoBlock label="待执行 / 运行中" value={`${pendingCount} 个`} />
              <InfoBlock label="已回填结果" value={`${completedCount} 个`} />
            </>
          ) : (
            <>
              <InfoBlock label="已完成模块" value={`${session.shopping_plan.modules.filter((module) => (session.module_candidates[module.module_id] ?? []).length > 0).length} 个`} />
              <InfoBlock label="候选商品" value={`${Object.values(session.module_candidates).reduce((sum, list) => sum + list.length, 0)} 个`} />
              <InfoBlock label="工具调用" value={`${session.tool_logs.length} 次`} />
            </>
          )}
        </div>
        <div className="space-y-2">
          {searchSummary.map((item) => (
            <div key={item} className="panel-muted px-4 py-3 text-sm text-muted-foreground">
              {item}
            </div>
          ))}
        </div>
        <div className={`rounded-[22px] p-4 text-sm ${
          mcpStatus?.available ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"
        }`}>
          {mcpStatus?.message ?? "正在检查淘宝 MCP 状态"}
        </div>
        {hostedMode ? (
          <div className={`rounded-[22px] p-4 text-sm ${
            workerStatus?.online ? "bg-sky-50 text-sky-700" : "bg-amber-50 text-amber-800"
          }`}>
            {workerStatus?.online
              ? `宿主代理队列已在线，当前状态：${workerStatus.state}${workerStatus.last_task_id ? `，最近任务 ${workerStatus.last_task_id}` : ""}`
              : "宿主代理队列离线。待执行任务不会被打包到宿主工作区，请先运行 npm run worker:codex -- watch"}
          </div>
        ) : (
          <div className="rounded-[22px] bg-sky-50 p-4 text-sm text-sky-700">
            当前为 Qoder 直连执行模式。搜索、详情提取与加购动作会直接由 Qoder 调起已安装的淘宝 skill 执行，不经过宿主任务队列。
          </div>
        )}
        <details open={expandedLogs} onToggle={(event) => setExpandedLogs((event.target as HTMLDetailsElement).open)} className="subtle-card p-4">
          <summary className="cursor-pointer text-sm font-medium">查看执行轨迹</summary>
          <div className="mt-3 space-y-3">
            {hostedMode
              ? session.hosted_tasks.slice(0, 8).map((task) => (
                  <div key={task.task_id} className="rounded-[18px] border border-border/80 bg-white p-3 text-sm shadow-sm">
                    <p className="font-medium">{task.module_name ? `[${task.module_name}] ` : ""}{task.title}</p>
                    <p className="mt-1 text-muted-foreground">{task.description}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{task.status.toUpperCase()} · {task.updated_at}</p>
                  </div>
                ))
              : null}
            {session.tool_logs.slice(0, 12).map((log) => (
              <div key={log.id} className="rounded-[18px] border border-border/80 bg-white p-3 text-sm shadow-sm">
                <p className="font-medium">{log.module_name ? `[${log.module_name}] ` : ""}{log.tool_name}</p>
                <p className="mt-1 text-muted-foreground">{log.input_summary}</p>
                <p className="mt-1 text-xs text-muted-foreground">{log.status.toUpperCase()} · {log.duration_ms}ms</p>
                <p className="mt-1 text-xs text-muted-foreground">{log.output_summary}</p>
              </div>
            ))}
          </div>
        </details>
        {hostedMode && hostedInstruction ? (
          <HostedInstructionCard instruction={hostedInstruction} />
        ) : null}
        <div className="flex gap-3">
          <Button variant="outline" onClick={onRefresh}>{hostedMode ? "刷新宿主结果" : "刷新执行结果"}</Button>
          <Button variant="outline" onClick={() => setExpandedLogs(!expandedLogs)}>查看执行过程</Button>
          <Button onClick={onViewResults} disabled={busy}>查看推荐结果</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ResultsPage({
  session,
  selectedModuleId,
  onSelectModule,
  selectedProducts,
  estimatedTotal,
  onQuickAction,
  onAddToCart,
  onProceedToCartReview,
  expandedLogs,
  setExpandedLogs,
  mcpStatus,
  workerStatus,
  hostedInstruction,
  onRefresh,
  onSearchModule,
  busy
}: {
  session: SessionState;
  selectedModuleId: string;
  onSelectModule: (moduleId: string) => void;
  selectedProducts: ProductCandidate[];
  estimatedTotal: number;
  onQuickAction: (action: QuickAction) => void;
  onAddToCart: (product: ProductCandidate) => void;
  onProceedToCartReview: () => void;
  expandedLogs: boolean;
  setExpandedLogs: (value: boolean) => void;
  mcpStatus: MpcStatus | null;
  workerStatus: HostedWorkerStatus | null;
  hostedInstruction: string;
  onRefresh: () => void;
  onSearchModule: (moduleId: string) => void;
  busy: boolean;
}) {
  const hostedMode = isHostedMode(mcpStatus);
  const hasRealDetailUrl = (detailUrl: string) => Boolean(detailUrl && detailUrl.trim() && detailUrl !== "https://www.taobao.com/");
  const addToCartStateForProduct = (productId: string) => {
    const task = session.hosted_tasks.find(
      (entry) => entry.task_type === "add_to_cart" && entry.product_id === productId
    );
    const selected = session.selected_items.some((item) => item.product_id === productId);

    if (selected || task?.status === "completed") {
      return "success" as const;
    }
    if (task?.status === "pending" || task?.status === "running") {
      return "running" as const;
    }
    if (task?.status === "failed") {
      return "failed" as const;
    }
    return "idle" as const;
  };

  const renderProductImage = (product: ProductCandidate) => {
    if (product.image_url && product.image_url.trim()) {
      return (
        <img
          src={product.image_url}
          alt={product.title}
          className="h-44 w-full rounded-[22px] object-cover"
        />
      );
    }

    return (
      <div className="flex h-44 w-full items-center justify-center rounded-[22px] bg-secondary/50 text-sm text-muted-foreground">
        暂无商品图片
      </div>
    );
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-5">
        <Card className="section-card">
          <CardContent className="space-y-5 px-6 py-6">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-[24px] bg-secondary/50 px-4 py-4">
              <div>
                <p className="label-text">当前推荐模块</p>
                <p className="mt-2 text-xl font-semibold">
                  {session.shopping_plan.modules.find((item) => item.module_id === selectedModuleId)?.module_name ?? "推荐结果"}
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
                <div className="rounded-[18px] bg-white px-4 py-3 shadow-sm">
                  <p className="text-xs text-muted-foreground">模块预算</p>
                  <p className="mt-1 text-base font-semibold">
                    {formatCurrency(session.shopping_plan.modules.find((item) => item.module_id === selectedModuleId)?.budget_allocation ?? 0)}
                  </p>
                </div>
                <div className="rounded-[18px] bg-white px-4 py-3 shadow-sm">
                  <p className="text-xs text-muted-foreground">已选商品</p>
                  <p className="mt-1 text-base font-semibold">{session.selected_items.length} 件</p>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {session.shopping_plan.modules.map((module) => (
                <button
                  key={module.module_id}
                  className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                    selectedModuleId === module.module_id ? "bg-foreground text-white shadow-sm" : "border border-border/80 bg-white text-foreground hover:border-primary/25"
                  }`}
                  onClick={() => onSelectModule(module.module_id)}
                >
                  {module.module_name}
                </button>
              ))}
            </div>
            <div className="grid gap-4">
              {selectedProducts.map((product) => (
                <div key={product.product_id} className="grid gap-5 rounded-[28px] border border-border/80 bg-white p-4 shadow-card md:grid-cols-[184px_1fr]">
                  {renderProductImage(product)}
                  <div className="flex flex-col justify-between gap-4">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge>{product.recommendation_type}</Badge>
                        {product.shop_badges.map((badge) => (
                          <Badge key={badge} variant="outline">{badge}</Badge>
                        ))}
                      </div>
                      <h3 className="mt-3 line-clamp-2 text-[17px] font-semibold leading-7">{product.title}</h3>
                      <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                        <Store className="h-4 w-4" />
                        {product.shop_name}
                      </div>
                      <p className="mt-4 text-[30px] font-semibold tracking-tight text-[#f25d23]">{formatCurrency(product.price)}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {product.highlights.map((item) => (
                          <span key={item} className="rounded-full bg-[#fff4ef] px-3 py-1 text-xs font-medium text-[#d9480f]">
                            {item}
                          </span>
                        ))}
                      </div>
                      <div className="mt-4 rounded-[18px] bg-secondary/35 px-4 py-3">
                        <p className="text-xs font-medium text-foreground">推荐理由</p>
                        <p className="mt-1 text-sm leading-7 text-muted-foreground">{product.fit_reason}</p>
                      </div>
                      <p className="mt-3 text-xs leading-6 text-muted-foreground">
                        风险提示：当前为搜索结果摘要，未自动打开详情页，建议点开淘宝详情页确认规格与适配性
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-3">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!hasRealDetailUrl(product.detail_url)}
                        onClick={() => {
                          if (!hasRealDetailUrl(product.detail_url)) {
                            return;
                          }
                          window.open(product.detail_url, "_blank", "noopener,noreferrer");
                        }}
                      >
                        查看淘宝详情
                      </Button>
                      <Button
                        size="sm"
                        disabled={busy || addToCartStateForProduct(product.product_id) === "running" || addToCartStateForProduct(product.product_id) === "success"}
                        onClick={() => onAddToCart(product)}
                      >
                        {addToCartStateForProduct(product.product_id) === "running" ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <ShoppingCart className="mr-2 h-4 w-4" />
                        )}
                        {addToCartStateForProduct(product.product_id) === "running"
                          ? "加入购物车中"
                          : addToCartStateForProduct(product.product_id) === "success"
                            ? "加入购物车成功"
                            : addToCartStateForProduct(product.product_id) === "failed"
                              ? "重新加入购物车"
                              : "加入购物车"}
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
              {selectedProducts.length === 0 ? (
                <div className="rounded-[28px] border border-dashed border-border/80 bg-white p-8 shadow-sm">
                  <p className="text-lg font-semibold">{hostedMode ? "当前模块还在等待宿主回填结果" : "当前模块暂未返回可展示商品"}</p>
                  <p className="mt-3 text-sm leading-7 text-muted-foreground">
                    {hostedMode
                      ? "当前模式会把淘宝任务交给 Codex 宿主执行。你可以先刷新宿主结果，或查看右侧队列了解当前进度。"
                      : "当前模块还没有返回推荐。你可以只针对这个模块单独再搜一次，避免一次性触发过多搜索动作。"}
                  </p>
                  <div className="mt-4 flex flex-wrap gap-3">
                    {!hostedMode ? (
                      <Button onClick={() => onSearchModule(selectedModuleId)} disabled={busy || !selectedModuleId}>
                        {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                        仅搜索当前模块
                      </Button>
                    ) : null}
                    <Button variant="outline" onClick={onRefresh}>{hostedMode ? "刷新宿主结果" : "刷新执行结果"}</Button>
                  </div>
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-5 xl:sticky xl:top-6">
        <Card className="section-card">
          <CardHeader>
            <CardTitle>当前摘要</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <InfoBlock label="场景" value="新车选购" />
            <InfoBlock label="已选商品" value={`${session.selected_items.length} 件`} />
            <InfoBlock label="预计总价" value={formatCurrency(estimatedTotal)} />
            <InfoBlock
              label="执行模式"
              value={getExecutionModeLabel(mcpStatus)}
            />
            <Button
              className="w-full"
              disabled={session.selected_items.length === 0 || busy}
              onClick={onProceedToCartReview}
            >
              <ArrowRight className="mr-2 h-4 w-4" />
              进入下单购买
            </Button>
          </CardContent>
        </Card>

        <Card className="section-card">
          <CardHeader>
            <CardTitle>快捷调整</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {quickActions.map((action) => (
              <Button key={action} variant="outline" size="sm" disabled={busy} onClick={() => onQuickAction(action)}>
                <Wand2 className="mr-2 h-4 w-4" />
                {action}
              </Button>
            ))}
          </CardContent>
        </Card>

        <Card className="section-card">
          <CardHeader>
            <CardTitle>{hostedMode ? "执行状态" : "执行摘要"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="panel-muted p-4 text-sm text-muted-foreground">
              <div className="flex items-center gap-2 font-medium text-foreground">
                <Settings2 className="h-4 w-4" />
                {hostedMode ? "已切换到 Codex 宿主代理执行" : "已切换到 Qoder CLI 直连执行"}
              </div>
              <p className="mt-2 leading-6">{mcpStatus?.message ?? "正在检测 MCP 工具状态"}</p>
            </div>
            {hostedMode ? (
              <>
                <div className={`rounded-[22px] p-4 text-sm ${
                  workerStatus?.online ? "bg-sky-50 text-sky-700" : "bg-amber-50 text-amber-800"
                }`}>
                  {workerStatus?.online
                    ? `宿主代理队列在线，状态：${workerStatus.state}${workerStatus.last_result ? `。最近回填：${workerStatus.last_result}` : ""}`
                    : "宿主代理队列当前离线。若任务长时间停留在 pending，请运行 npm run worker:codex -- watch"}
                </div>
                <div className="grid gap-3">
                  {session.hosted_tasks.slice(0, 6).map((task) => (
                    <div key={task.task_id} className="rounded-[18px] border border-border/80 bg-white p-3 text-sm shadow-sm">
                      <p className="font-medium">{task.title}</p>
                      <p className="mt-1 text-muted-foreground">{task.status.toUpperCase()} · {task.result_summary ?? task.description}</p>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="grid gap-3">
                {session.tool_logs.slice(0, 6).map((log) => (
                  <div key={log.id} className="rounded-[18px] border border-border/80 bg-white p-3 text-sm shadow-sm">
                    <p className="font-medium">{log.module_name ? `[${log.module_name}] ` : ""}{log.tool_name}</p>
                    <p className="mt-1 text-muted-foreground">{log.output_summary}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{log.status.toUpperCase()} · {log.duration_ms}ms</p>
                  </div>
                ))}
              </div>
            )}
            <details open={expandedLogs} onToggle={(event) => setExpandedLogs((event.target as HTMLDetailsElement).open)} className="subtle-card p-4">
              <summary className="cursor-pointer text-sm font-medium">{hostedMode ? "查看宿主日志" : "查看执行日志"}</summary>
              <div className="mt-3 space-y-3">
                {session.tool_logs.slice(0, 12).map((log) => (
                  <div key={log.id} className="rounded-[18px] border border-border/80 bg-white p-3 text-sm shadow-sm">
                    <p className="font-medium">{log.module_name ? `[${log.module_name}] ` : ""}{log.tool_name}</p>
                    <p className="mt-1 text-muted-foreground">{log.output_summary}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{log.status.toUpperCase()} · {log.duration_ms}ms</p>
                  </div>
                ))}
              </div>
            </details>
            <Button variant="outline" onClick={onRefresh}>{hostedMode ? "刷新宿主结果" : "刷新执行结果"}</Button>
            {hostedMode && hostedInstruction ? <HostedInstructionCard instruction={hostedInstruction} compact /> : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function HostedInstructionCard({ instruction, compact = false }: { instruction: string; compact?: boolean }) {
  async function copyInstruction() {
    await navigator.clipboard.writeText(instruction);
  }

  return (
    <Card className={compact ? "subtle-card" : "section-card"}>
      <CardHeader>
        <CardTitle>{compact ? "当前宿主任务说明" : "Codex 宿主执行说明"}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          这段说明可直接交给 Codex 宿主执行当前待处理淘宝任务，并按约定回填结果。
        </p>
        <div className="max-h-72 overflow-auto rounded-[20px] bg-secondary/40 p-4 text-xs leading-6 text-foreground whitespace-pre-wrap">
          {instruction}
        </div>
        <Button variant="outline" size="sm" onClick={copyInstruction}>复制宿主执行说明</Button>
      </CardContent>
    </Card>
  );
}

function CartReviewPage({
  items,
  total,
  onBack
}: {
  items: Array<{
    product_id: string;
    module_id: string;
    title: string;
    price: number;
    image_url?: string;
    detail_url?: string;
    shop_name?: string;
    module_name?: string;
    selected_spec?: string;
    cart_source?: "taobao" | "demo";
    cart_note?: string;
  }>;
  total: number;
  onBack: () => void;
}) {
  const hasRealDetailUrl = (detailUrl?: string) => Boolean(detailUrl && detailUrl.trim() && detailUrl !== "https://www.taobao.com/");
  const hasTaobaoCartItems = items.some((item) => item.cart_source !== "demo");

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <Card className="section-card">
        <CardHeader>
          <CardTitle>确认下单清单</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {items.length === 0 ? (
            <div className="rounded-[22px] border border-dashed border-border/80 bg-white p-8 shadow-sm">
              <p className="text-lg font-semibold">当前还没有加入购物车的商品</p>
              <p className="mt-3 text-sm leading-7 text-muted-foreground">
                你可以先返回推荐页继续加购，再回到这里统一确认下单清单。
              </p>
            </div>
          ) : (
            items.map((item) => (
              <div key={item.product_id} className="grid gap-4 rounded-[26px] border border-border/80 bg-white p-4 shadow-card md:grid-cols-[160px_1fr]">
                {item.image_url ? (
                  <img src={item.image_url} alt={item.title} className="h-40 w-full rounded-[20px] object-cover" />
                ) : (
                  <div className="flex h-40 w-full items-center justify-center rounded-[20px] bg-secondary/40 text-sm text-muted-foreground">
                    暂无商品图片
                  </div>
                )}
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge>{item.module_name ?? "已选商品"}</Badge>
                    <Badge variant="outline">{item.cart_source === "demo" ? "演示购物车" : "淘宝购物车"}</Badge>
                  </div>
                  <h3 className="text-lg font-semibold leading-8">{item.title}</h3>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Store className="h-4 w-4" />
                    {item.shop_name ?? "淘宝店铺"}
                  </div>
                  <div className="grid gap-2 text-sm text-muted-foreground">
                    <p>已选规格：{item.selected_spec ?? "默认可选规格（以淘宝购物车页为准）"}</p>
                    <p>商品金额：{formatCurrency(item.price)}</p>
                    {item.cart_note ? <p>说明：{item.cart_note}</p> : null}
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!hasRealDetailUrl(item.detail_url)}
                      onClick={() => {
                        if (!hasRealDetailUrl(item.detail_url)) {
                          return;
                        }
                        window.open(item.detail_url, "_blank", "noopener,noreferrer");
                      }}
                    >
                      查看商品页
                    </Button>
                  </div>
                </div>
              </div>
            ))
          )}
          <div className="flex gap-3">
            <Button variant="outline" onClick={onBack}>返回上一步继续加购</Button>
            <Button
              disabled={items.length === 0 || !hasTaobaoCartItems}
              onClick={() => window.open("https://cart.taobao.com/cart.htm", "_blank", "noopener,noreferrer")}
            >
              <ShoppingCart className="mr-2 h-4 w-4" />
              {hasTaobaoCartItems ? "打开淘宝购物车结算" : "当前仅有演示购物车商品"}
            </Button>
          </div>
          <div className="panel-muted p-4 text-sm text-muted-foreground">
            当前页展示的是本产品已加入购物车的商品清单。标记为“淘宝购物车”的商品表示真实加购已成功；标记为“演示购物车”的商品表示真实加购失败后已自动回退到产品内演示清单。
            购物车删除能力正在单独评估，只会在确认不会影响其他商品时接入。
          </div>
        </CardContent>
      </Card>

      <Card className="section-card xl:sticky xl:top-6">
        <CardHeader>
          <CardTitle>下单摘要</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <InfoBlock label="已加购商品" value={`${items.length} 件`} />
          <InfoBlock label="商品总价" value={formatCurrency(total)} />
          <InfoBlock label="当前状态" value={items.length > 0 ? "可前往淘宝购物车结算" : "请先从推荐页加入商品"} />
        </CardContent>
      </Card>
    </div>
  );
}

function ConfirmRefinePage({
  summary,
  onBack,
  onConfirm
}: {
  summary: string[];
  onBack: () => void;
  onConfirm: () => void;
}) {
  return (
    <Card className="section-card">
      <CardHeader>
        <CardTitle>确认调整结果</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {summary.map((item) => (
          <div key={item} className="panel-muted px-4 py-3 text-sm text-muted-foreground">
            {item}
          </div>
        ))}
        <div className="flex gap-3">
          <Button variant="outline" onClick={onBack}>返回当前推荐</Button>
          <Button onClick={onConfirm}>确认并查看更新后的推荐结果</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function EditableChoiceField({
  label,
  value,
  options,
  onSelect
}: {
  label: string;
  value: string;
  options: string[];
  onSelect: (value: string) => void;
}) {
  return (
    <div className="info-grid-card">
      <p className="label-text">{label}</p>
      <p className="mt-2 text-base font-semibold">{value}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            className={`rounded-full px-3 py-1.5 text-xs transition ${
              option === value ? "bg-primary text-white" : "border border-border bg-white text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => onSelect(option)}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

function EditableTagField({
  label,
  selected,
  options,
  emptyLabel,
  onToggle
}: {
  label: string;
  selected: string[];
  options: string[];
  emptyLabel: string;
  onToggle: (value: string) => void;
}) {
  return (
    <div className="info-grid-card">
      <p className="label-text">{label}</p>
      <p className="mt-2 text-base font-semibold">{selected.join("、") || emptyLabel}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {options.map((option) => {
          const active = selected.includes(option);
          return (
            <button
              key={option}
              type="button"
              className={`rounded-full px-3 py-1.5 text-xs transition ${
                active ? "bg-primary text-white" : "border border-border bg-white text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => onToggle(option)}
            >
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function EditableBudgetField({
  label,
  value,
  onChange
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="info-grid-card">
      <p className="label-text">{label}</p>
      <p className="mt-2 text-base font-semibold">{formatCurrency(value)}</p>
      <input
        type="number"
        min={300}
        step={100}
        value={value}
        onChange={(event) => onChange(Math.max(300, Number(event.target.value) || 300))}
        className="mt-3 h-11 w-full rounded-[16px] border border-border bg-white px-3 text-sm outline-none transition focus:border-primary"
      />
    </div>
  );
}

function InfoBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-grid-card">
      <p className="label-text">{label}</p>
      <p className="mt-2 text-sm font-medium leading-6">{value}</p>
    </div>
  );
}
