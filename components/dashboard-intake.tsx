"use client";

import { useEffect, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowRight,
  BedDouble,
  Boxes,
  CarFront,
  ChevronRight,
  Clock3,
  GraduationCap,
  History,
  Loader2,
  PackageCheck,
  SendHorizontal,
  Settings2,
  ShoppingBag,
  Sparkles,
  TentTree
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ProductGuideLink } from "@/components/product-guide-link";
import { API_INPUT_LIMITS } from "@/lib/api/input-limits";
import { Textarea } from "@/components/ui/textarea";
import {
  clearWorkflowStorageForOwner,
  scenarioOptions,
  stageLabels,
} from "@/components/dashboard-config";
import { getScenarioConfig } from "@/lib/scenarios";
import { ScenarioId, WorkflowStage } from "@/lib/session/types";
import type { ShoppingSessionSummary } from "@/lib/session/summaries";
import { formatCurrency } from "@/lib/utils";

const scenarioIcons = {
  "new-car": CarFront,
  camping: TentTree,
  "room-decor": BedDouble,
  "dorm-move-in": GraduationCap,
  "moving-setup": Boxes
} satisfies Record<ScenarioId, typeof CarFront>;

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <ShoppingBag className="h-4 w-4" strokeWidth={2.2} />
    </span>
  );
}

function SceneSpirit({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? "scene-spirit scene-spirit-compact" : "scene-spirit"} aria-hidden="true">
      {!compact ? <span className="spirit-message">先规划，再挑选</span> : null}
      <span className="spirit-orbit spirit-orbit-left">预算</span>
      <span className="spirit-orbit spirit-orbit-right">偏好</span>
      <span className="spirit-spark spirit-spark-left">✦</span>
      <span className="spirit-spark spirit-spark-right">✦</span>
      <div className="spirit-body">
        <div className="spirit-antenna">
          <Sparkles className="h-3.5 w-3.5" />
        </div>
        <div className="spirit-face">
          <span className="spirit-eye" />
          <span className="spirit-smile" />
          <span className="spirit-eye" />
        </div>
        <div className="spirit-bag">
          <ShoppingBag className="h-5 w-5" strokeWidth={2.1} />
        </div>
      </div>
    </div>
  );
}

const workflowPhases: Array<{ label: string; stages: WorkflowStage[] }> = [
  { label: "理解", stages: ["input_requirement", "parsing", "confirm_scene"] },
  { label: "规划", stages: ["planning", "confirm_plan", "refining"] },
  { label: "搜索", stages: ["searching"] },
  { label: "推荐", stages: ["review_results", "carting", "cart_review"] }
];

export type DashboardNavigationDestination = "home" | "history" | "settings" | "login";

export function TopHeader({
  currentStage,
  authMode = "live",
  onNavigationRequest,
  showProductGuideLink = true
}: {
  currentStage: WorkflowStage;
  authMode?: "live" | "frozen-demo";
  onNavigationRequest?: (destination: DashboardNavigationDestination) => void;
  showProductGuideLink?: boolean;
}) {
  const [authenticated, setAuthenticated] = useState(false);
  const [authenticationRequired, setAuthenticationRequired] = useState(false);
  const [accountId, setAccountId] = useState("");
  const activePhaseIndex = Math.max(0, workflowPhases.findIndex((phase) => phase.stages.includes(currentStage)));

  useEffect(() => {
    if (authMode === "frozen-demo") return;
    fetch("/api/auth/me")
      .then((response) => response.json())
      .then((payload) => {
        setAuthenticated(payload.authenticated === true);
        setAuthenticationRequired(payload.authentication_required === true);
        setAccountId(typeof payload.user?.id === "string" ? payload.user.id : "");
      })
      .catch(() => undefined);
  }, [authMode]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    clearWorkflowStorageForOwner(
      window.localStorage,
      accountId ? `user:${accountId}` : authenticationRequired ? undefined : "anonymous"
    );
    window.location.assign(authenticationRequired ? "/login" : "/");
  }

  return (
    <header className="workflow-header">
      <button
        type="button"
        className="flex min-w-0 items-center gap-3 text-left"
        onClick={() => onNavigationRequest ? onNavigationRequest("home") : window.location.assign("/")}
      >
        <BrandMark />
        <span>
          <span className="block text-[15px] font-semibold leading-none tracking-tight">SceneCart</span>
          <span className="mt-1 hidden text-[11px] text-muted-foreground sm:block">场景化购物助手</span>
        </span>
      </button>
      <div className="workflow-rail" aria-label={`当前步骤：${stageLabels[currentStage]}`}>
        {workflowPhases.map((phase, index) => (
          <span
            key={phase.label}
            className={`workflow-rail-step ${index === activePhaseIndex ? "workflow-rail-step-active" : ""} ${index < activePhaseIndex ? "workflow-rail-step-done" : ""}`}
          >
            <i>{index < activePhaseIndex ? "✓" : index + 1}</i>
            <b>{phase.label}</b>
          </span>
        ))}
      </div>
      <span className="workflow-stage-pill lg:hidden">{stageLabels[currentStage]}</span>
      <nav className="ml-auto flex items-center gap-1.5">
        {showProductGuideLink ? <ProductGuideLink compactOnMobile /> : null}
        <a
          href={onNavigationRequest ? "/demo" : "/hosted"}
          className="header-icon-link"
          title="执行详情"
          aria-label="执行详情"
          onClick={(event) => {
            if (!onNavigationRequest) return;
            event.preventDefault();
            onNavigationRequest("history");
          }}
        >
          <History className="h-4 w-4" />
        </a>
        <a
          href={onNavigationRequest ? "/demo" : "/settings/executor"}
          className="header-icon-link"
          title="执行器设置"
          aria-label="执行器设置"
          onClick={(event) => {
            if (!onNavigationRequest) return;
            event.preventDefault();
            onNavigationRequest("settings");
          }}
        >
          <Settings2 className="h-4 w-4" />
        </a>
        {authenticationRequired ? (
          authenticated ? (
            <button type="button" onClick={logout} className="header-text-link">退出</button>
          ) : (
            <a
              href={onNavigationRequest ? "/demo" : "/login"}
              className="header-text-link"
              onClick={(event) => {
                if (!onNavigationRequest) return;
                event.preventDefault();
                onNavigationRequest("login");
              }}
            >登录</a>
          )
        ) : null}
      </nav>
    </header>
  );
}

export function LandingPage({
  selectedScenario,
  onScenarioChange,
  sceneInput,
  onSceneInputChange,
  onStart,
  interactiveReady,
  busy,
  errorMessage,
  recentSessions,
  archivedSessions,
  recentSessionsLoading,
  resumingSessionId,
  lifecycleSessionId,
  onResumeSession,
  onArchiveSession,
  onRestoreSession,
  authMode = "live",
  onNavigationRequest,
  showProductGuideLink = true
}: {
  selectedScenario: ScenarioId;
  onScenarioChange: (scenarioId: ScenarioId) => void;
  sceneInput: string;
  onSceneInputChange: (value: string) => void;
  onStart: () => void;
  interactiveReady: boolean;
  busy: boolean;
  errorMessage: string;
  recentSessions: ShoppingSessionSummary[];
  archivedSessions: ShoppingSessionSummary[];
  recentSessionsLoading: boolean;
  resumingSessionId: string;
  lifecycleSessionId: string;
  onResumeSession: (session: ShoppingSessionSummary) => void;
  onArchiveSession: (session: ShoppingSessionSummary) => void;
  onRestoreSession: (session: ShoppingSessionSummary) => void;
  authMode?: "live" | "frozen-demo";
  onNavigationRequest?: (destination: DashboardNavigationDestination) => void;
  showProductGuideLink?: boolean;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [authenticationRequired, setAuthenticationRequired] = useState(false);
  const [accountEmail, setAccountEmail] = useState("");
  const [accountId, setAccountId] = useState("");
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const canStart = sceneInput.trim().length >= 6 && interactiveReady && !busy;
  const scenario = getScenarioConfig(selectedScenario);

  useEffect(() => {
    if (authMode === "frozen-demo") return;
    fetch("/api/auth/me")
      .then((response) => response.json())
      .then((payload) => {
        setAuthenticated(payload.authenticated === true);
        setAuthenticationRequired(payload.authentication_required === true);
        setAccountEmail(typeof payload.user?.email === "string" ? payload.user.email : "");
        setAccountId(typeof payload.user?.id === "string" ? payload.user.id : "");
      })
      .catch(() => undefined);
  }, [authMode]);

  async function logout() {
    setAccountMenuOpen(false);
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    clearWorkflowStorageForOwner(window.localStorage, accountId ? `user:${accountId}` : undefined);
    window.location.assign("/login");
  }

  return (
    <div className="landing-shell">
      <header className="landing-nav">
        <a
          href={onNavigationRequest ? "/demo" : "/"}
          className="flex items-center gap-3"
          onClick={(event) => {
            if (!onNavigationRequest) return;
            event.preventDefault();
            onNavigationRequest("home");
          }}
        >
          <BrandMark />
          <span className="text-[15px] font-semibold tracking-tight">SceneCart</span>
          <span className="hidden text-xs text-muted-foreground sm:inline">场景化购物助手</span>
        </a>
        <nav className="flex items-center gap-1.5">
          {showProductGuideLink ? <ProductGuideLink compactOnMobile /> : null}
          <a
            href={onNavigationRequest ? "/demo" : "#recent-tasks"}
            className="header-icon-link"
            title="最近任务"
            aria-label="最近任务"
            onClick={(event) => {
              if (!onNavigationRequest) return;
              event.preventDefault();
              onNavigationRequest("history");
            }}
          >
            <History className="h-4 w-4" />
          </a>
          <a
            href={onNavigationRequest ? "/demo" : "/settings/executor"}
            className="header-icon-link"
            title="设置"
            aria-label="设置"
            onClick={(event) => {
              if (!onNavigationRequest) return;
              event.preventDefault();
              onNavigationRequest("settings");
            }}
          >
            <Settings2 className="h-4 w-4" />
          </a>
          {authenticationRequired ? (
            authenticated ? (
              <div className="relative">
                <button
                  type="button"
                  className="header-text-link"
                  aria-label="账户菜单"
                  aria-haspopup="menu"
                  aria-expanded={accountMenuOpen}
                  onClick={() => setAccountMenuOpen((open) => !open)}
                >
                  账户
                </button>
                {accountMenuOpen ? (
                  <div
                    role="menu"
                    aria-label="账户菜单"
                    className="absolute right-0 top-11 z-50 w-64 rounded-[20px] border border-border/70 bg-white p-2 shadow-xl"
                  >
                    <div className="px-3 py-2">
                      <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">当前账户</p>
                      <p className="mt-1 truncate text-sm font-medium text-foreground" title={accountEmail || "已登录"}>
                        {accountEmail || "已登录"}
                      </p>
                    </div>
                    <a
                      href={onNavigationRequest ? "/demo" : "/settings/executor"}
                      role="menuitem"
                      className="flex h-10 items-center rounded-[14px] px-3 text-sm text-foreground transition hover:bg-muted"
                      onClick={(event) => {
                        if (!onNavigationRequest) return;
                        event.preventDefault();
                        onNavigationRequest("settings");
                      }}
                    >
                      执行器设置
                    </a>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={logout}
                      className="flex h-10 w-full items-center rounded-[14px] px-3 text-left text-sm text-red-600 transition hover:bg-red-50"
                    >
                      退出登录
                    </button>
                  </div>
                ) : null}
              </div>
            ) : (
              <a
                href={onNavigationRequest ? "/demo" : "/login"}
                className="header-text-link"
                onClick={(event) => {
                  if (!onNavigationRequest) return;
                  event.preventDefault();
                  onNavigationRequest("login");
                }}
              >登录</a>
            )
          ) : null}
        </nav>
      </header>

      <section className="landing-hero">
        <SceneSpirit />
        <div className="mx-auto max-w-3xl text-center">
          <h1 className="landing-title">把一句需求，变成买得明白的方案</h1>
          <p className="landing-subtitle">
            描述场景、预算和偏好，Agent 会先规划，再帮你找到合适商品。
          </p>
        </div>

        <div className="scene-input-wrap">
          <div className="scene-input-shell">
            <Textarea
              id="scene-requirement-input"
              ref={inputRef}
              value={sceneInput}
              maxLength={API_INPUT_LIMITS.sceneInputLength}
              aria-label="描述你的购物场景"
              placeholder={scenario.input_placeholder}
              onChange={(event) => onSceneInputChange(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canStart) {
                  event.preventDefault();
                  onStart();
                }
              }}
              className="min-h-[88px] resize-none border-0 bg-transparent px-1 py-1 text-[15px] leading-7 shadow-none focus:border-0 focus:shadow-none md:text-[16px]"
            />
            <div className="mt-4 flex flex-col gap-3 border-t border-border/65 pt-4 sm:flex-row sm:items-center sm:justify-between">
              <button
                type="button"
                onClick={() => inputRef.current?.focus()}
                className="inline-flex items-center gap-2 text-xs font-medium text-muted-foreground transition hover:text-foreground"
                aria-label={scenario.name}
              >
                {(() => {
                  const SceneIcon = scenarioIcons[selectedScenario];
                  return <SceneIcon className="h-4 w-4 text-primary" />;
                })()}
                {scenario.name} · 已选择
              </button>
              <Button
                size="lg"
                onClick={onStart}
                disabled={!canStart}
                className="w-full sm:w-auto"
                aria-label={scenario.start_button_text}
                data-demo-target="scene:start"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <SendHorizontal className="h-4 w-4" />}
                让 Agent 开始理解
              </Button>
            </div>
          </div>
          {errorMessage ? (
            <div className="mt-3 rounded-[18px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {errorMessage}
            </div>
          ) : null}
        </div>

        <div className="scenario-picker" aria-label="选择购物场景">
          {scenarioOptions.map((option) => {
            const SceneIcon = scenarioIcons[option.id];
            const active = selectedScenario === option.id;
            return (
              <button
                key={option.id}
                type="button"
                disabled={!option.enabled || busy}
                onClick={() => onScenarioChange(option.id)}
                className={`scenario-picker-item ${active ? "scenario-picker-item-active" : ""}`}
                aria-pressed={active}
              >
                <span className="scenario-picker-icon"><SceneIcon className="h-4 w-4" /></span>
                <span className="min-w-0 text-left">
                  <strong className="block text-sm font-semibold">{option.label}</strong>
                  <span className="sr-only">{option.description}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="example-grid" aria-label="示例购物场景">
          {scenario.example_prompts.slice(0, 3).map((example, index) => (
            <button
              key={example}
              type="button"
              data-demo-target={`scene:example:${selectedScenario}:${index}`}
              disabled={!interactiveReady || busy}
              aria-controls="scene-requirement-input"
              onClick={() => {
                onSceneInputChange(example);
                window.requestAnimationFrame(() => {
                  const input = inputRef.current;
                  if (!input) return;
                  input.focus();
                  input.setSelectionRange(example.length, example.length);
                });
              }}
              className="example-prompt"
            >
              <span className="min-w-0 flex-1">
                <span className="block line-clamp-2 text-sm leading-5 text-foreground/80">{example}</span>
              </span>
              <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/70" />
            </button>
          ))}
        </div>
      </section>

      {recentSessionsLoading || recentSessions.length > 0 || archivedSessions.length > 0 ? (
        <details id="recent-tasks" className="recent-tasks-panel group">
          <summary className="recent-tasks-summary">
            <span>
              <span className="label-text">最近购物任务</span>
              <strong>继续未完成的方案</strong>
            </span>
            <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              {recentSessions.length} 个进行中
              <ChevronRight className="h-4 w-4 transition group-open:rotate-90" />
            </span>
          </summary>

          <div className="recent-tasks-content">
          {recentSessionsLoading ? (
            <div className="mt-5 flex min-h-24 items-center justify-center rounded-[22px] border border-dashed border-border bg-muted/25 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              正在读取最近任务
            </div>
          ) : (
            <div className="mt-5 grid gap-3 lg:grid-cols-2">
              {recentSessions.map((session) => {
                const progress = session.module_count > 0
                  ? Math.round((session.covered_module_count / session.module_count) * 100)
                  : 0;
                const isResuming = resumingSessionId === session.session_id;
                const isUpdatingLifecycle = lifecycleSessionId === session.session_id;
                return (
                  <article key={session.session_id} className="recent-task-card">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge>{session.scene_label}</Badge>
                          <span className="text-xs text-muted-foreground">{session.status_label}</span>
                        </div>
                        <p className="mt-3 line-clamp-2 text-sm font-medium leading-6 text-foreground">{session.requirement}</p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={Boolean(resumingSessionId || lifecycleSessionId)}
                        onClick={() => onResumeSession(session)}
                      >
                        {isResuming ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                        继续
                      </Button>
                    </div>
                    <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
                      <span>{formatCurrency(session.budget)}</span>
                      <span>{session.covered_module_count}/{session.module_count} 模块</span>
                      <span>{session.candidate_count} 个候选</span>
                      <span className="ml-auto inline-flex items-center gap-1.5">
                        <Clock3 className="h-3.5 w-3.5" />
                        {new Date(session.last_activity_at).toLocaleString("zh-CN", {
                          month: "numeric",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: false
                        })}
                      </span>
                    </div>
                    <div className="mt-3 h-1 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress}%` }} />
                    </div>
                    <div className="mt-3 flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">
                        {session.selected_item_count > 0 ? (
                          <span className="inline-flex items-center gap-1.5 text-primary">
                            <PackageCheck className="h-3.5 w-3.5" /> 已选 {session.selected_item_count} 件
                          </span>
                        ) : session.priority_style}
                      </span>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition hover:text-foreground"
                        disabled={Boolean(resumingSessionId || lifecycleSessionId)}
                        onClick={() => onArchiveSession(session)}
                      >
                        {isUpdatingLifecycle ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Archive className="h-3.5 w-3.5" />}
                        归档
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          {archivedSessions.length > 0 ? (
            <details className="mt-4 rounded-[20px] border border-border/70 bg-muted/20 px-4 py-3">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground">已归档任务（{archivedSessions.length}）</summary>
              <div className="mt-3 grid gap-2 lg:grid-cols-2">
                {archivedSessions.map((session) => (
                  <article key={session.session_id} className="flex items-center justify-between gap-3 rounded-[18px] border border-border/70 bg-white p-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{session.requirement}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{session.candidate_count} 个候选 · 已选 {session.selected_item_count} 件</p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={Boolean(lifecycleSessionId || resumingSessionId)}
                      onClick={() => onRestoreSession(session)}
                    >
                      {lifecycleSessionId === session.session_id ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArchiveRestore className="h-4 w-4" />}
                      恢复
                    </Button>
                  </article>
                ))}
              </div>
            </details>
          ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}

export function ResumeBanner({
  snapshot,
  onResume,
  onRestart
}: {
  snapshot: { stage: WorkflowStage; sceneInput: string };
  onResume: () => void;
  onRestart: () => void;
}) {
  return (
    <Card className="resume-banner">
      <CardContent className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">上次任务还没有完成</p>
          <p className="mt-1 line-clamp-1 text-xs leading-6 text-muted-foreground">
            停留在「{stageLabels[snapshot.stage]}」 · {snapshot.sceneInput}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="ghost" onClick={onRestart}>开启新任务</Button>
          <Button size="sm" onClick={onResume}>继续上次任务</Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function RequirementPage({
  scenarioId,
  sceneInput,
  onSceneInputChange,
  onExampleClick,
  onBack,
  onContinue,
  errorMessage,
  busy
}: {
  scenarioId: ScenarioId;
  sceneInput: string;
  onSceneInputChange: (value: string) => void;
  onExampleClick: (value: string) => void;
  onBack: () => void;
  onContinue: () => void;
  errorMessage: string;
  busy: boolean;
}) {
  const canContinue = sceneInput.trim().length >= 6;
  const scenario = getScenarioConfig(scenarioId);

  return (
    <Card className="section-card workflow-content">
      <CardHeader className="px-6 pt-7 md:px-8 md:pt-8">
        <div className="flex items-center gap-3">
          <SceneSpirit compact />
          <div>
            <p className="label-text">修改需求</p>
            <CardTitle className="mt-1 text-xl">再告诉我一点你的{scenario.name}需求</CardTitle>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 px-6 pb-7 pt-5 md:px-8 md:pb-8">
        <Textarea
          value={sceneInput}
          maxLength={API_INPUT_LIMITS.sceneInputLength}
          aria-label="描述你的购物场景"
          placeholder={scenario.input_placeholder}
          onChange={(event) => onSceneInputChange(event.target.value)}
          className="min-h-36 text-base"
        />
        <div className="flex flex-wrap gap-2">
          {scenario.example_prompts.map((example, index) => (
            <button key={example} type="button" className="prompt-chip" onClick={() => onExampleClick(example)}>
              示例 {index + 1}
            </button>
          ))}
        </div>
        {errorMessage ? <div className="rounded-[18px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{errorMessage}</div> : null}
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
          <Button variant="ghost" onClick={onBack}>返回首页</Button>
          <Button onClick={onContinue} disabled={busy || !canContinue}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {scenario.start_button_text}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
