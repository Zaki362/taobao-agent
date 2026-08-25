"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { flushSync } from "react-dom";
import { MousePointer2, Pause, Play, RefreshCw } from "lucide-react";
import { LandingPage, RequirementPage, TopHeader } from "@/components/dashboard-intake";
import type { DashboardNavigationDestination } from "@/components/dashboard-intake";
import { StatusPage } from "@/components/dashboard-common";
import { ConfirmPlanPage, ConfirmScenePage } from "@/components/dashboard-confirmation";
import { SearchProgressPage } from "@/components/dashboard-search-progress";
import { ResultsPage } from "@/components/dashboard-results-simple";
import { CartReviewPage } from "@/components/dashboard-execution";
import type { DashboardShoppingListItem, MpcStatus } from "@/components/dashboard-types";
import { Button } from "@/components/ui/button";
import { applyAgentDirectiveProfile, type AgentDirectiveProfile } from "@/lib/agent/directives";
import {
  DEMO_CAPTURED_AT,
  DEMO_MODULE_IDS,
  buildFrozenDemoSessionForScenario,
  withFrozenSearchProgress
} from "@/lib/demo/frozen-session";
import { pacePublicDemoTourDuration } from "@/lib/demo/tour-timing";
import type { ProductCandidate, ScenarioId, SessionState, WorkflowStage } from "@/lib/session/types";

type TourMode = "idle" | "playing" | "paused" | "completed";
type TourPhase = "explaining" | "acting";

type TourStep = {
  target: string;
  title: string;
  description: string;
  dwell: number;
  action?: "set-budget";
  interaction?: "click" | "point";
};

type CursorState = {
  visible: boolean;
  x: number;
  y: number;
  duration: number;
  pressed: boolean;
  ripple: number;
};

const PRODUCT_DETAIL_CALLOUT = "本次不演示，可以自己点击跳转到真实链接";

const TOUR_STEPS: TourStep[] = [
  {
    target: "scene:example:new-car:0",
    title: "先用真实场景示例填入需求",
    description: "点击示例只会填入输入框，不会直接发送；你仍可以修改预算、偏好或补充要求。",
    dwell: 2500
  },
  {
    target: "scene:start",
    title: "确认描述后再开始理解",
    description: "检查并补充需求后，由你点击开始理解；Demo 才会进入冻结的需求解析流程。",
    dwell: 2400
  },
  {
    target: "scene:budget",
    title: "把预算调整到 1000 元",
    description: "预算使用真实编辑器修改，场景摘要与后续规划会同步更新。",
    dwell: 2500,
    action: "set-budget"
  },
  {
    target: "scene:confirm",
    title: "确认 Agent 对需求的理解",
    description: "确认车型、阶段、偏好与排除项后，进入同一套真实规划页。",
    dwell: 2600
  },
  {
    target: "plan:confirm",
    title: "按真实规划启动搜索",
    description: "公开版只回放 2026-08-08 的脱敏快照，不会访问或操作淘宝账号。",
    dwell: 2700
  },
  {
    target: "search:view-results",
    title: "等待各模块筛选完成",
    description: "四组冻结候选会按真实搜索进度逐项回填，完成后再点击查看推荐。",
    dwell: 3000
  },
  {
    target: "results:detail:749277654435",
    title: "也可以打开商品详情进一步核对",
    description: "这里不替你打开页面；体验时可以自行点击“淘宝详情”，跳转到对应商品链接查看规格与店铺信息。",
    dwell: 2200,
    interaction: "point"
  },
  {
    target: "results:add:749277654435",
    title: "先加入安全必需商品",
    description: "自动演示代替一次确认，只写入产品内演示清单，不会产生淘宝加购。",
    dwell: 2200
  },
  {
    target: "results:module:practical-interior",
    title: "切换到车内实用分类",
    description: "分类标签、主推荐、推荐理由与右侧购物摘要都来自真实结果组件。",
    dwell: 2800
  },
  {
    target: "results:alternatives",
    title: "按需展开备选商品",
    description: "主推荐保持聚焦，备选使用产品现有的列表交互进行比较。",
    dwell: 2800
  },
  {
    target: "results:add:966069280059",
    title: "加入更合适的车内实用备选",
    description: "备选商品沿用同一套真实加购交互，并实时更新右侧购物摘要。",
    dwell: 2200
  },
  {
    target: "results:module:cleaning-care",
    title: "继续查看清洁维护分类",
    description: "每个分类都保留一个主推荐，让整套方案覆盖不同使用任务。",
    dwell: 2000
  },
  {
    target: "results:add:1058209193158",
    title: "把清洁维护商品加入清单",
    description: "组合数量与预算会立即重算，仍然只保存在当前浏览器的演示清单中。",
    dwell: 2200
  },
  {
    target: "results:module:storage-organization",
    title: "最后查看收纳整理分类",
    description: "跨分类选择后，右侧会持续汇总整套购物方案。",
    dwell: 2000
  },
  {
    target: "results:add:716549824114",
    title: "补齐最后一件收纳商品",
    description: "现在四个分类各有一件商品，可以进入最终购物清单集中核对。",
    dwell: 2400
  },
  {
    target: "results:view-cart",
    title: "进入真实购物清单",
    description: "最终页会展示 4 件商品、组合金额、演示清单标识与实际产品一致的后续操作。",
    dwell: 4200
  }
];

const FROZEN_MCP_STATUS: MpcStatus = {
  mode: "local_executor",
  configured_mode: "local_executor",
  product_mode: "development",
  demo_cart_fallback: true,
  search_available: true,
  cart_available: true,
  available: true,
  message: "公开 Demo 使用冻结执行快照",
  permissions_scope: ["module_search", "add_to_cart"],
  executor_devices: {
    online: 1,
    registered: 1,
    mcp_unavailable: 0,
    authentication_required: 0,
    capabilities: {
      module_search: { registered: 1, online: 1, available: true },
      add_to_cart: { registered: 1, online: 1, available: true }
    }
  }
};

function abortError() {
  return new DOMException("演示已暂停", "AbortError");
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function wait(duration: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = window.setTimeout(resolve, duration);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}

function targetByName(name: string) {
  return [...document.querySelectorAll<HTMLElement>("[data-demo-target]")]
    .find((element) => element.dataset.demoTarget === name);
}

async function waitForTarget(name: string, signal: AbortSignal) {
  const startedAt = performance.now();
  while (!signal.aborted && performance.now() - startedAt < 20_000) {
    const target = targetByName(name);
    const disabled = target instanceof HTMLButtonElement || target instanceof HTMLInputElement
      ? target.disabled
      : target?.getAttribute("aria-disabled") === "true";
    if (target && !disabled) return target;
    await wait(100, signal);
  }
  if (signal.aborted) throw abortError();
  throw new Error(`自动演示未找到可操作目标：${name}`);
}

function setNativeInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function budgetFromInput(value: string) {
  const match = value.match(/预算\s*(\d{3,6})/);
  const parsed = match ? Number(match[1]) : 1500;
  return Number.isFinite(parsed) ? Math.min(100_000, Math.max(300, parsed)) : 1500;
}

export function PublicDemo() {
  const [stage, setStage] = useState<WorkflowStage>("landing");
  const [selectedScenario, setSelectedScenario] = useState<ScenarioId>("new-car");
  const [sceneInput, setSceneInput] = useState("");
  const [parsedScene, setParsedScene] = useState<SessionState["scene_brief"] | null>(null);
  const [session, setSession] = useState<SessionState | null>(null);
  const [selectedModuleId, setSelectedModuleId] = useState<string>(DEMO_MODULE_IDS[0]);
  const [searchSummary, setSearchSummary] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [workflowControlBusy, setWorkflowControlBusy] = useState(false);
  const [cartingProductId, setCartingProductId] = useState("");
  const [removingProductId, setRemovingProductId] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState("我会先提取场景、预算、偏好与排除项，再请你确认。");
  const [expandedModel, setExpandedModel] = useState(false);
  const [expandedLogs, setExpandedLogs] = useState(false);
  const [tourMode, setTourMode] = useState<TourMode>("idle");
  const [tourPhase, setTourPhase] = useState<TourPhase>("explaining");
  const [activeTourStep, setActiveTourStep] = useState(0);
  const [demoNotice, setDemoNotice] = useState("");
  const [tourError, setTourError] = useState("");
  const [cursorCallout, setCursorCallout] = useState("");
  const [cursor, setCursor] = useState<CursorState>({
    visible: false,
    x: 0,
    y: 0,
    duration: 0,
    pressed: false,
    ripple: 0
  });

  const timersRef = useRef<Set<number>>(new Set());
  const fullSessionRef = useRef<SessionState | null>(null);
  const actionGenerationRef = useRef(0);
  const searchCompletedRef = useRef(0);
  const autoDispatchRef = useRef(false);
  const tourModeRef = useRef<TourMode>("idle");
  const nextTourStepRef = useRef(0);
  const tourPausedSearchRef = useRef(false);
  const tourControllerRef = useRef<AbortController | null>(null);
  const cursorElementRef = useRef<HTMLDivElement | null>(null);
  const fastModeRef = useRef(false);
  const reducedMotionRef = useRef(false);

  useEffect(() => {
    const timers = timersRef.current;
    fastModeRef.current = new URLSearchParams(window.location.search).get("demoSpeed") === "fast";
    reducedMotionRef.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    return () => {
      tourControllerRef.current?.abort();
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  useEffect(() => {
    if (!demoNotice) return;
    const timer = window.setTimeout(() => setDemoNotice(""), 5000);
    return () => window.clearTimeout(timer);
  }, [demoNotice]);

  const selectedProducts = useMemo(
    () => session?.module_candidates[selectedModuleId] ?? [],
    [selectedModuleId, session]
  );
  const pendingTasks = session?.hosted_tasks.filter((task) => task.status === "pending" || task.status === "running") ?? [];
  const completedTasks = session?.hosted_tasks.filter((task) => task.status === "completed") ?? [];

  function scaledDuration(normal: number, fast: number, stepIndex?: number) {
    if (fastModeRef.current) return fast;
    if (reducedMotionRef.current) return Math.min(120, fast * 2);
    return stepIndex === undefined ? normal : pacePublicDemoTourDuration(normal, stepIndex);
  }

  function clearActionTimers() {
    actionGenerationRef.current += 1;
    for (const timer of timersRef.current) window.clearTimeout(timer);
    timersRef.current.clear();
  }

  function scheduleAction(callback: () => void, duration: number) {
    const generation = actionGenerationRef.current;
    const timer = window.setTimeout(() => {
      timersRef.current.delete(timer);
      if (generation === actionGenerationRef.current) callback();
    }, duration);
    timersRef.current.add(timer);
  }

  function resetProductState() {
    clearActionTimers();
    setStage("landing");
    setSelectedScenario("new-car");
    setSceneInput("");
    setParsedScene(null);
    setSession(null);
    fullSessionRef.current = null;
    searchCompletedRef.current = 0;
    tourPausedSearchRef.current = false;
    setSelectedModuleId(DEMO_MODULE_IDS[0]);
    setSearchSummary([]);
    setBusy(false);
    setWorkflowControlBusy(false);
    setCartingProductId("");
    setRemovingProductId("");
    setErrorMessage("");
    setStatusMessage("我会先提取场景、预算、偏好与排除项，再请你确认。");
    setExpandedModel(false);
    setExpandedLogs(false);
  }

  function pauseTourFromPageClick(event: ReactMouseEvent<HTMLElement>) {
    if ((event.target as Element).closest("[data-demo-tour-control]")) return;
    if (autoDispatchRef.current || tourModeRef.current !== "playing") return;
    event.preventDefault();
    event.stopPropagation();
    pauseTour();
  }

  function startParsing(value?: string, scenarioId = selectedScenario) {
    const nextInput = (value ?? sceneInput).trim();
    if (nextInput.length < 6) return;
    clearActionTimers();
    setSelectedScenario(scenarioId);
    setSceneInput(nextInput);
    setErrorMessage("");
    setBusy(true);
    setStage("parsing");
    setStatusMessage("正在从描述中识别车型、预算、购买阶段与明确排除项。");
    scheduleAction(() => {
      const preview = buildFrozenDemoSessionForScenario(scenarioId, nextInput, budgetFromInput(nextInput));
      setParsedScene(preview.scene_brief);
      setBusy(false);
      setStage("confirm_scene");
      setStatusMessage("需求已经整理完成，请检查下面的信息是否准确。");
    }, scaledDuration(1050, 70));
  }

  function confirmSceneAndPlan() {
    if (!parsedScene) return;
    clearActionTimers();
    setBusy(true);
    setStage("planning");
    setStatusMessage("正在按使用频率、风险与预算，把需求拆成可执行的购买模块。");
    scheduleAction(() => {
      const nextSession = buildFrozenDemoSessionForScenario(parsedScene.scenario_id, sceneInput, parsedScene.budget);
      nextSession.scene_brief = structuredClone(parsedScene);
      nextSession.raw_input = sceneInput;
      fullSessionRef.current = structuredClone(nextSession);
      setSession(nextSession);
      setSelectedModuleId(nextSession.shopping_plan.modules[0]?.module_id ?? DEMO_MODULE_IDS[0]);
      setBusy(false);
      setStage("confirm_plan");
      setStatusMessage("购买路线已经生成，你仍可以调整 Agent 档位与每个模块的搜索词。");
    }, scaledDuration(1150, 80));
  }

  function runFrozenSearch(fullSession: SessionState, startAt = 0) {
    clearActionTimers();
    searchCompletedRef.current = startAt;
    setSession(withFrozenSearchProgress(fullSession, startAt));
    setSearchSummary(startAt > 0
      ? fullSession.shopping_plan.modules.slice(0, startAt).map((module) => `${module.module_name}：3 个冻结候选已回填`)
      : []);
    const revealNext = () => {
      const nextCount = searchCompletedRef.current + 1;
      searchCompletedRef.current = nextCount;
      const progressSession = withFrozenSearchProgress(fullSession, nextCount);
      setSession(progressSession);
      const module = fullSession.shopping_plan.modules[nextCount - 1];
      if (module) setSearchSummary((current) => [...current, `${module.module_name}：3 个冻结候选已回填`]);
      if (nextCount < fullSession.shopping_plan.modules.length) {
        scheduleAction(revealNext, scaledDuration(1750, 95));
      } else {
        fullSessionRef.current = structuredClone(progressSession);
        setBusy(false);
        setStatusMessage("全部冻结候选已回填，可以查看与真实产品一致的推荐工作台。");
      }
    };
    if (startAt < fullSession.shopping_plan.modules.length) {
      scheduleAction(revealNext, scaledDuration(1750, 95));
    }
  }

  function startSearching() {
    if (!session) return;
    const fullSession = structuredClone(fullSessionRef.current ?? session);
    fullSession.selected_items = structuredClone(session.selected_items);
    fullSessionRef.current = structuredClone(fullSession);
    setErrorMessage("");
    setBusy(true);
    setStage("searching");
    setStatusMessage("正在按确认后的任务包逐项回放冻结候选。");
    runFrozenSearch(fullSession, 0);
  }

  function pauseWorkflow() {
    if (!session) return;
    setWorkflowControlBusy(true);
    clearActionTimers();
    setSession((current) => current ? {
      ...current,
      agent_runtime: {
        ...current.agent_runtime,
        workflow_status: "paused",
        workflow_message: "搜索已由用户暂停，冻结结果保持不变"
      }
    } : current);
    scheduleAction(() => setWorkflowControlBusy(false), scaledDuration(350, 30));
  }

  function resumeWorkflow() {
    const fullSession = fullSessionRef.current;
    if (!fullSession) return;
    clearActionTimers();
    setWorkflowControlBusy(true);
    setBusy(true);
    scheduleAction(() => {
      setWorkflowControlBusy(false);
      runFrozenSearch(structuredClone(fullSession), searchCompletedRef.current);
    }, scaledDuration(350, 30));
  }

  function updateAgentProfile(profile: AgentDirectiveProfile) {
    setSession((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      applyAgentDirectiveProfile(next, profile);
      fullSessionRef.current = structuredClone(next);
      return next;
    });
  }

  async function updateSearchStrategy(
    moduleId: string,
    payload: { primaryKeyword: string; alternateKeywords: string[] }
  ) {
    setSession((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      next.shopping_plan.modules = next.shopping_plan.modules.map((module) => module.module_id === moduleId
        ? {
            ...module,
            search_keyword: payload.primaryKeyword,
            search_strategy: {
              ...(module.search_strategy ?? {
                primary_keyword: payload.primaryKeyword,
                alternate_keywords: [],
                include_terms: [],
                exclude_terms: [],
                ranking_focus: [],
                must_have_signals: [],
                reject_signals: [],
                quality_checks: [],
                price_band: "按模块预算",
                reasoning: "由用户在公开 Demo 中调整",
                failure_recovery: "使用冻结候选继续体验"
              }),
              primary_keyword: payload.primaryKeyword,
              alternate_keywords: payload.alternateKeywords
            }
          }
        : module);
      fullSessionRef.current = structuredClone(next);
      return next;
    });
    setStatusMessage("搜索任务包已在当前浏览器中更新；公开 Demo 不会提交到外部服务。");
  }

  function searchSpecificModule(moduleId: string) {
    const fullSession = fullSessionRef.current;
    if (!fullSession) return;
    setBusy(true);
    setSelectedModuleId(moduleId);
    scheduleAction(() => {
      setSession(structuredClone(fullSession));
      setBusy(false);
      setStatusMessage("该模块的冻结候选已恢复。");
    }, scaledDuration(700, 55));
  }

  function refreshFrozenState(scope: string) {
    setWorkflowControlBusy(true);
    setDemoNotice(`已从当前浏览器内重新读取${scope}冻结状态；没有访问外部服务。`);
    scheduleAction(() => {
      setSession((current) => current ? structuredClone(current) : current);
      setWorkflowControlBusy(false);
    }, scaledDuration(320, 35));
  }

  function handleFrozenNavigation(destination: DashboardNavigationDestination) {
    if (destination === "home") {
      restartManually();
      return;
    }
    const label = destination === "history" ? "执行详情" : destination === "settings" ? "执行器设置" : "登录";
    setDemoNotice(`公开 Demo 保留了真实产品的“${label}”入口，但不会离开冻结体验或访问账号服务。`);
  }

  function blockExternalProductAction(label: string) {
    setDemoNotice(`公开 Demo 保留了真实产品的“${label}”按钮，但不会打开淘宝或发出外部请求。`);
  }

  function addToDemoCart(product: ProductCandidate) {
    if (!session) return;
    setBusy(true);
    setCartingProductId(product.product_id);
    setErrorMessage("");
    setStatusMessage(`正在将 ${product.title} 加入购物车`);
    scheduleAction(() => {
      setSession((current) => {
        if (!current || current.selected_items.some((item) => item.product_id === product.product_id)) return current;
        const moduleName = current.shopping_plan.modules.find((module) => module.module_id === product.module_id)?.module_name;
        const next = {
          ...current,
          selected_items: [...current.selected_items, {
            product_id: product.product_id,
            module_id: product.module_id,
            module_name: moduleName,
            title: product.title,
            price: product.price,
            image_url: product.image_url,
            detail_url: product.detail_url,
            shop_name: product.shop_name,
            selected_spec: "以商品详情页为准",
            cart_source: "demo" as const,
            cart_note: "公开 Demo 仅写入浏览器内的演示清单，未调用淘宝加购。",
            added_at: DEMO_CAPTURED_AT
          }],
          last_action: `已加入产品内演示清单：${product.title}`
        };
        fullSessionRef.current = structuredClone(next);
        return next;
      });
      setBusy(false);
      setCartingProductId("");
      setStatusMessage(`已将 ${product.title} 加入产品内演示清单，未操作淘宝账号。`);
    }, scaledDuration(850, 65));
  }

  function removeDemoItem(item: DashboardShoppingListItem) {
    if (!session || item.cart_source !== "demo") return;
    const confirmed = autoDispatchRef.current
      || window.confirm(`确认将「${item.title}」从产品内演示清单移除吗？`);
    if (!confirmed) return;
    setBusy(true);
    setRemovingProductId(item.product_id);
    scheduleAction(() => {
      setSession((current) => {
        if (!current) return current;
        const next = {
          ...current,
          selected_items: current.selected_items.filter((selected) => selected.product_id !== item.product_id),
          last_action: `已从产品内演示清单移除：${item.title}`
        };
        fullSessionRef.current = structuredClone(next);
        return next;
      });
      setBusy(false);
      setRemovingProductId("");
    }, scaledDuration(550, 45));
  }

  async function animateTourStep(
    step: TourStep,
    stepIndex: number,
    signal: AbortSignal,
    onCommit: (target: HTMLElement) => void
  ) {
    const target = await waitForTarget(step.target, signal);
    const reduced = reducedMotionRef.current;
    const instantScroll = reduced || fastModeRef.current;
    const previousInlineScrollBehavior = document.documentElement.style.scrollBehavior;
    if (instantScroll) document.documentElement.style.scrollBehavior = "auto";
    target.scrollIntoView({ behavior: instantScroll ? "auto" : "smooth", block: "center", inline: "center" });
    if (instantScroll) document.documentElement.style.scrollBehavior = previousInlineScrollBehavior;
    await wait(scaledDuration(680, 35, stepIndex), signal);
    let rect = target.getBoundingClientRect();
    for (let sample = 0; sample < 8; sample += 1) {
      await wait(scaledDuration(55, 18, stepIndex), signal);
      const nextRect = target.getBoundingClientRect();
      const movement = Math.hypot(nextRect.left - rect.left, nextRect.top - rect.top);
      rect = nextRect;
      if (movement < 0.75) break;
    }
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const moveDuration = reduced || fastModeRef.current
      ? 0
      : pacePublicDemoTourDuration(1050, stepIndex);
    if (cursorElementRef.current) {
      cursorElementRef.current.style.transitionDuration = `${moveDuration}ms`;
      cursorElementRef.current.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      cursorElementRef.current.classList.add("public-demo-cursor-visible");
    }
    flushSync(() => {
      setCursor((current) => ({ ...current, visible: true, x, y, duration: moveDuration, pressed: false }));
    });
    await wait(Math.max(24, moveDuration) + scaledDuration(160, 80, stepIndex), signal);

    if (step.interaction === "point") {
      flushSync(() => setCursorCallout(PRODUCT_DETAIL_CALLOUT));
      target.dataset.demoPointing = "true";
      try {
        await wait(scaledDuration(1250, 55, stepIndex), signal);
        onCommit(target);
      } finally {
        delete target.dataset.demoPointing;
      }
      return;
    }

    await wait(scaledDuration(480, 25, stepIndex), signal);
    target.dataset.demoClicking = "true";
    try {
      flushSync(() => {
        setCursor((current) => ({ ...current, pressed: true, ripple: current.ripple + 1 }));
      });
      await wait(scaledDuration(180, 24, stepIndex), signal);
      autoDispatchRef.current = true;
      try {
        target.click();
        onCommit(target);
      } finally {
        autoDispatchRef.current = false;
      }
      flushSync(() => {
        setCursor((current) => ({ ...current, pressed: false }));
      });
      await wait(scaledDuration(300, 24, stepIndex), signal);
    } finally {
      autoDispatchRef.current = false;
      setCursor((current) => ({ ...current, pressed: false }));
      delete target.dataset.demoClicking;
    }
  }

  async function runTour(startIndex: number, signal: AbortSignal) {
    try {
      for (let index = startIndex; index < TOUR_STEPS.length; index += 1) {
        const step = TOUR_STEPS[index];
        if (cursorElementRef.current) cursorElementRef.current.classList.remove("public-demo-cursor-visible");
        flushSync(() => {
          setActiveTourStep(index);
          setTourPhase("explaining");
          setCursorCallout("");
          setCursor((current) => ({ ...current, visible: false, pressed: false }));
        });
        await wait(scaledDuration(2200, 50, index), signal);
        flushSync(() => setTourPhase("acting"));
        await wait(scaledDuration(260, 20, index), signal);
        await animateTourStep(step, index, signal, (target) => {
          if (step.action === "set-budget" && target instanceof HTMLInputElement) {
            setNativeInputValue(target, "1000");
          }
          nextTourStepRef.current = index + 1;
        });
        await wait(scaledDuration(step.dwell, 90, index), signal);
      }
      tourModeRef.current = "completed";
      setTourMode("completed");
      setCursorCallout("");
      setCursor((current) => ({ ...current, visible: false, pressed: false }));
    } catch (error) {
      if (isAbortError(error)) return;
      tourModeRef.current = "paused";
      setTourMode("paused");
      setTourError(error instanceof Error ? error.message : "自动演示暂时无法继续");
      setCursorCallout("");
      setCursor((current) => ({ ...current, visible: false, pressed: false }));
    }
  }

  function launchTour(event: ReactMouseEvent<HTMLButtonElement>) {
    tourControllerRef.current?.abort();
    resetProductState();
    setDemoNotice("");
    setTourError("");
    setCursorCallout("");
    setActiveTourStep(0);
    setTourPhase("explaining");
    nextTourStepRef.current = 0;
    tourModeRef.current = "playing";
    setTourMode("playing");
    const initialX = event.clientX || window.innerWidth - 160;
    const initialY = event.clientY || 36;
    if (cursorElementRef.current) {
      cursorElementRef.current.style.transitionDuration = "0ms";
      cursorElementRef.current.style.transform = `translate3d(${initialX}px, ${initialY}px, 0)`;
      cursorElementRef.current.classList.remove("public-demo-cursor-visible");
    }
    setCursor({
      visible: false,
      x: initialX,
      y: initialY,
      duration: 0,
      pressed: false,
      ripple: 0
    });
    const controller = new AbortController();
    tourControllerRef.current = controller;
    window.requestAnimationFrame(() => void runTour(0, controller.signal));
  }

  function pauseTour() {
    if (tourModeRef.current !== "playing") return;
    tourControllerRef.current?.abort();
    const canPauseFrozenSearch = stage === "searching"
      && session?.agent_runtime.workflow_status === "running"
      && searchCompletedRef.current < session.shopping_plan.modules.length;
    tourPausedSearchRef.current = canPauseFrozenSearch;
    if (canPauseFrozenSearch) pauseWorkflow();
    tourModeRef.current = "paused";
    setTourMode("paused");
    setCursorCallout("");
    setCursor((current) => ({ ...current, visible: false, pressed: false }));
  }

  function resumeTour() {
    if (tourModeRef.current !== "paused") return;
    if (nextTourStepRef.current >= TOUR_STEPS.length) return;
    const shouldResumeFrozenSearch = tourPausedSearchRef.current;
    tourPausedSearchRef.current = false;
    setDemoNotice("");
    setTourError("");
    setCursorCallout("");
    tourModeRef.current = "playing";
    setTourMode("playing");
    const controller = new AbortController();
    tourControllerRef.current = controller;
    if (shouldResumeFrozenSearch) resumeWorkflow();
    void runTour(nextTourStepRef.current, controller.signal);
  }

  function restartManually() {
    tourControllerRef.current?.abort();
    tourModeRef.current = "idle";
    setTourMode("idle");
    setDemoNotice("");
    setTourError("");
    setCursorCallout("");
    setCursor((current) => ({ ...current, visible: false, pressed: false }));
    resetProductState();
  }

  const currentTourStep = TOUR_STEPS[Math.min(activeTourStep, TOUR_STEPS.length - 1)];
  const tourIsActing = tourMode === "playing" && tourPhase === "acting";
  const cursorCalloutOnLeft = typeof window !== "undefined" && cursor.x > window.innerWidth - 320;

  return (
    <main
      className="min-h-screen"
      data-public-demo
      data-demo-tour-active={tourMode !== "idle" ? "true" : "false"}
      onClickCapture={pauseTourFromPageClick}
      onKeyDownCapture={(event) => {
        if ((event.target as Element).closest("[data-demo-tour-control]")) return;
        if (autoDispatchRef.current || tourModeRef.current !== "playing") return;
        event.preventDefault();
        event.stopPropagation();
        pauseTour();
      }}
      onWheelCapture={() => {
        if (!autoDispatchRef.current && tourModeRef.current === "playing") pauseTour();
      }}
    >
      <div className="page-shell">
        {stage !== "landing" && stage !== "scenario_select" ? (
          <TopHeader
            currentStage={stage}
            authMode="frozen-demo"
            onNavigationRequest={handleFrozenNavigation}
          />
        ) : null}

        {stage === "landing" || stage === "scenario_select" ? (
          <LandingPage
            selectedScenario={selectedScenario}
            onScenarioChange={(scenarioId) => {
              setSelectedScenario(scenarioId);
              setSceneInput("");
              setErrorMessage("");
            }}
            sceneInput={sceneInput}
            onSceneInputChange={setSceneInput}
            onStart={() => startParsing()}
            interactiveReady
            busy={busy}
            errorMessage={errorMessage}
            recentSessions={[]}
            archivedSessions={[]}
            recentSessionsLoading={false}
            resumingSessionId=""
            lifecycleSessionId=""
            onResumeSession={() => undefined}
            onArchiveSession={() => undefined}
            onRestoreSession={() => undefined}
            authMode="frozen-demo"
            onNavigationRequest={handleFrozenNavigation}
          />
        ) : null}

        {stage === "input_requirement" ? (
          <RequirementPage
            scenarioId={selectedScenario}
            sceneInput={sceneInput}
            onSceneInputChange={setSceneInput}
            onExampleClick={setSceneInput}
            onBack={restartManually}
            onContinue={() => startParsing()}
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
            onSearchStrategyChange={updateSearchStrategy}
            onConfirm={startSearching}
            busy={busy}
            expandedModel={expandedModel}
            setExpandedModel={setExpandedModel}
          />
        ) : null}

        {stage === "searching" && session ? (
          <SearchProgressPage
            session={session}
            mcpStatus={FROZEN_MCP_STATUS}
            workerStatus={null}
            searchSummary={searchSummary}
            pendingCount={pendingTasks.length}
            completedCount={completedTasks.length}
            hostedInstruction="公开 Demo 只读取浏览器内冻结快照。"
            expandedLogs={expandedLogs}
            setExpandedLogs={setExpandedLogs}
            onRefresh={() => refreshFrozenState("搜索进度")}
            onViewResults={() => setStage("review_results")}
            onUseExistingResults={() => setStage("review_results")}
            onPauseWorkflow={pauseWorkflow}
            onResumeWorkflow={resumeWorkflow}
            onResumeAfterAuthentication={resumeWorkflow}
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
            onRecoverCompletionGaps={() => refreshFrozenState("模块补齐")}
            onAddToCart={addToDemoCart}
            onProceedToCartReview={() => setStage("cart_review")}
            onReturnToSearchProgress={() => setStage("searching")}
            expandedLogs={expandedLogs}
            setExpandedLogs={setExpandedLogs}
            mcpStatus={FROZEN_MCP_STATUS}
            workerStatus={null}
            hostedInstruction="公开 Demo 只读取浏览器内冻结快照。"
            onRefresh={() => refreshFrozenState("推荐结果")}
            onSearchModule={searchSpecificModule}
            cartingProductId={cartingProductId}
            busy={busy}
          />
        ) : null}

        {stage === "cart_review" && session ? (
          <CartReviewPage
            session={session}
            mcpStatus={FROZEN_MCP_STATUS}
            onBack={() => setStage("review_results")}
            onRefresh={() => refreshFrozenState("购物清单")}
            onAddToCart={addToDemoCart}
            onRemoveDemoItem={removeDemoItem}
            cartingProductId={cartingProductId}
            busy={busy}
            removingProductId={removingProductId}
            errorMessage={errorMessage}
            onOpenTaobaoCart={() => blockExternalProductAction("打开淘宝购物车")}
          />
        ) : null}
      </div>

      <div className="public-demo-controls" data-demo-tour-control>
        {tourMode === "playing" ? (
          <Button type="button" variant="outline" size="sm" onClick={pauseTour}>
            <Pause className="h-4 w-4" />暂停演示
          </Button>
        ) : tourMode === "paused" ? (
          <Button type="button" variant="outline" size="sm" onClick={resumeTour}>
            <Play className="h-4 w-4" />继续演示
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={tourMode === "idle" ? "public-demo-launch-button" : undefined}
            onClick={launchTour}
          >
            {tourMode === "completed" ? <RefreshCw className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            {tourMode === "completed" ? "重新自动演示" : "启动自动演示"}
          </Button>
        )}
        {stage !== "landing" || tourMode === "paused" ? (
          <button type="button" className="public-demo-reset" onClick={restartManually} aria-label="重置公开 Demo">
            <RefreshCw className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      {demoNotice ? (
        <div className="public-demo-takeover" role="status">
          <MousePointer2 className="h-4 w-4 shrink-0 text-primary" />
          <span>{demoNotice}</span>
          <button type="button" onClick={() => setDemoNotice("")} aria-label="关闭提示">×</button>
        </div>
      ) : null}

      {tourMode !== "idle" ? (
        <aside
          className={`public-demo-narrator ${tourIsActing ? "public-demo-narrator-acting" : ""} ${tourMode === "completed" ? "public-demo-narrator-completed" : ""}`}
          aria-live="polite"
          data-demo-phase={tourMode === "completed" ? "completed" : tourMode === "paused" ? "paused" : tourPhase}
          data-demo-tour-control
        >
          {tourMode === "completed" ? (
            <div className="public-demo-narrator-lead">
              <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
              <strong className="font-semibold text-foreground">演示完成</strong>
              <span className="public-demo-narrator-description">冻结快照已进入真实购物清单</span>
            </div>
          ) : tourIsActing ? (
            <div className="public-demo-narrator-lead">
              <span className="h-2 w-2 shrink-0 rounded-full bg-primary" />
              <span className="public-demo-narrator-step">
                自动演示 {Math.min(activeTourStep + 1, TOUR_STEPS.length)} / {TOUR_STEPS.length}
              </span>
              <strong className="public-demo-narrator-title">{currentTourStep.title}</strong>
              <span className="public-demo-narrator-state">正在操作</span>
            </div>
          ) : (
            <>
              <div className="public-demo-narrator-lead">
                <span className="public-demo-narrator-step">
                  自动演示 {Math.min(activeTourStep + 1, TOUR_STEPS.length)} / {TOUR_STEPS.length}
                </span>
                <h2 className="public-demo-narrator-title">{currentTourStep.title}</h2>
                <span className={`public-demo-narrator-state ${tourMode === "paused" ? "public-demo-narrator-state-paused" : ""}`}>
                  {tourMode === "paused" ? "已暂停" : "先看说明"}
                </span>
              </div>
              <p className="public-demo-narrator-description">{currentTourStep.description}</p>
              {tourError ? <p className="public-demo-narrator-error">{tourError}</p> : null}
              <div className="public-demo-narrator-progress">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-500"
                  style={{ width: `${((activeTourStep + 1) / TOUR_STEPS.length) * 100}%` }}
                />
              </div>
            </>
          )}
        </aside>
      ) : null}

      <div
        ref={cursorElementRef}
        className={`public-demo-cursor ${cursor.visible ? "public-demo-cursor-visible" : ""} ${cursor.pressed ? "public-demo-cursor-pressed" : ""}`}
        style={{
          transform: `translate3d(${cursor.x}px, ${cursor.y}px, 0)`,
          transitionDuration: `${cursor.duration}ms`
        }}
        aria-hidden="true"
      >
        <span key={cursor.ripple} className="public-demo-click-ripple" />
        {cursorCallout ? (
          <span className={`public-demo-cursor-callout ${cursorCalloutOnLeft ? "public-demo-cursor-callout-left" : ""}`}>
            {cursorCallout}
          </span>
        ) : null}
        <MousePointer2 className="h-7 w-7" fill="white" strokeWidth={2.1} />
      </div>
    </main>
  );
}
