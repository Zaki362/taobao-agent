"use client";

import { useEffect, useState } from "react";
import { Archive, ArchiveRestore, ArrowRight, ChevronRight, Clock3, Loader2, PackageCheck, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  requirementExamples,
  requirementPlaceholder,
  scenarioOptions,
  stageLabels,
  startButtonText
} from "@/components/dashboard-config";
import { WorkflowStage } from "@/lib/session/types";
import type { ShoppingSessionSummary } from "@/lib/session/summaries";
import { formatCurrency } from "@/lib/utils";

export function TopHeader({ currentStage }: { currentStage: string }) {
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((response) => response.json())
      .then((payload) => setAuthenticated(payload.authenticated === true))
      .catch(() => undefined);
  }, []);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.assign("/login");
  }

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
          <div className="flex flex-wrap justify-end gap-2">
            <a
              href="/hosted"
              className="inline-flex h-11 items-center justify-center rounded-full border border-border/80 bg-white px-4 text-sm font-medium text-foreground shadow-sm transition hover:border-primary/30 hover:bg-white"
            >
              后端执行台
            </a>
            <a
              href="/settings/executor"
              className="inline-flex h-11 items-center justify-center rounded-full border border-border/80 bg-white px-4 text-sm font-medium text-foreground shadow-sm transition hover:border-primary/30 hover:bg-white"
            >
              本地执行器
            </a>
            {authenticated ? (
              <button
                type="button"
                onClick={logout}
                className="inline-flex h-11 items-center justify-center rounded-full border border-border/80 bg-white px-4 text-sm font-medium text-muted-foreground shadow-sm transition hover:border-primary/30 hover:text-foreground"
              >
                退出登录
              </button>
            ) : (
              <a
                href="/login"
                className="inline-flex h-11 items-center justify-center rounded-full border border-border/80 bg-white px-4 text-sm font-medium text-muted-foreground shadow-sm transition hover:border-primary/30 hover:text-foreground"
              >
                登录
              </a>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function LandingPage({
  onEnterScenario,
  interactiveReady,
  recentSessions,
  archivedSessions,
  recentSessionsLoading,
  resumingSessionId,
  lifecycleSessionId,
  onResumeSession,
  onArchiveSession,
  onRestoreSession
}: {
  onEnterScenario: () => void;
  interactiveReady: boolean;
  recentSessions: ShoppingSessionSummary[];
  archivedSessions: ShoppingSessionSummary[];
  recentSessionsLoading: boolean;
  resumingSessionId: string;
  lifecycleSessionId: string;
  onResumeSession: (session: ShoppingSessionSummary) => void;
  onArchiveSession: (session: ShoppingSessionSummary) => void;
  onRestoreSession: (session: ShoppingSessionSummary) => void;
}) {
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
                scenario.enabled && interactiveReady
                  ? "border-primary/15 bg-white hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-card"
                  : "cursor-not-allowed border-border/70 bg-muted/45 opacity-70"
              }`}
              onClick={scenario.enabled && interactiveReady ? onEnterScenario : undefined}
              disabled={!scenario.enabled || !interactiveReady}
            >
              <div className="flex items-center justify-between">
                <p className="text-lg font-semibold">{scenario.label}</p>
                {scenario.enabled ? (
                  interactiveReady ? (
                    <ChevronRight className="h-4 w-4 text-primary" />
                  ) : (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  )
                ) : (
                  <Badge variant="outline">即将支持</Badge>
                )}
              </div>
              <p className="mt-8 text-sm text-muted-foreground">
                {scenario.enabled && !interactiveReady ? "正在准备交互..." : scenario.description}
              </p>
            </button>
          ))}
        </div>

        {recentSessionsLoading || recentSessions.length > 0 || archivedSessions.length > 0 ? (
          <div className="border-t border-border/70 pt-8">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="label-text">Recent Tasks</p>
                <h3 className="mt-2 text-xl font-semibold tracking-tight">最近购物任务</h3>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  任务保存在服务端，换浏览器后也可以从原进度继续。
                </p>
              </div>
              <Badge variant="outline">最多展示 6 条</Badge>
            </div>

            {recentSessionsLoading ? (
              <div className="mt-5 flex min-h-28 items-center justify-center rounded-[24px] border border-dashed border-border bg-muted/25 text-sm text-muted-foreground">
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
                    <article
                      key={session.session_id}
                      className="rounded-[24px] border border-border/75 bg-white p-5 shadow-sm transition hover:border-primary/25 hover:shadow-card"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge>{session.scene_label}</Badge>
                            <Badge variant="outline">{session.status_label}</Badge>
                          </div>
                          <p className="mt-3 line-clamp-2 text-[15px] font-medium leading-6 text-foreground">
                            {session.requirement}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-wrap justify-end gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={Boolean(resumingSessionId || lifecycleSessionId)}
                            onClick={() => onArchiveSession(session)}
                          >
                            {isUpdatingLifecycle ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}
                            归档
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={Boolean(resumingSessionId || lifecycleSessionId)}
                            onClick={() => onResumeSession(session)}
                          >
                            {isResuming ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                            继续任务
                            {!isResuming ? <ArrowRight className="h-4 w-4" /> : null}
                          </Button>
                        </div>
                      </div>

                      <div className="mt-4 grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                        <span>{formatCurrency(session.budget)} 预算</span>
                        <span>{session.covered_module_count}/{session.module_count} 模块</span>
                        <span>{session.candidate_count} 个候选</span>
                      </div>
                      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary transition-[width]"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1.5">
                          <Clock3 className="h-3.5 w-3.5" />
                          {new Date(session.last_activity_at).toLocaleString("zh-CN", {
                            month: "numeric",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                            hour12: false
                          })}
                        </span>
                        {session.selected_item_count > 0 ? (
                          <span className="inline-flex items-center gap-1.5 text-primary">
                            <PackageCheck className="h-3.5 w-3.5" />
                            已选 {session.selected_item_count} 件
                          </span>
                        ) : (
                          <span>{session.priority_style}</span>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}

            {archivedSessions.length > 0 ? (
              <details className="mt-5 rounded-[24px] border border-border/70 bg-muted/20 px-5 py-4">
                <summary className="cursor-pointer text-sm font-medium text-muted-foreground transition hover:text-foreground">
                  已归档任务（{archivedSessions.length}）
                </summary>
                <div className="mt-4 grid gap-3 lg:grid-cols-2">
                  {archivedSessions.map((session) => {
                    const isRestoring = lifecycleSessionId === session.session_id;
                    return (
                      <article key={session.session_id} className="rounded-[22px] border border-border/70 bg-white p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant="outline">{session.scene_label}</Badge>
                              <Badge variant="outline">已归档</Badge>
                            </div>
                            <p className="mt-3 line-clamp-2 text-sm font-medium leading-6 text-foreground">
                              {session.requirement}
                            </p>
                            <p className="mt-2 text-xs text-muted-foreground">
                              {session.candidate_count} 个候选 · 已选 {session.selected_item_count} 件
                            </p>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={Boolean(lifecycleSessionId || resumingSessionId)}
                            onClick={() => onRestoreSession(session)}
                          >
                            {isRestoring ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArchiveRestore className="h-4 w-4" />}
                            恢复
                          </Button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </details>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function ResumeBanner({
  snapshot,
  onResume,
  onRestart
}: {
  snapshot: {
    stage: WorkflowStage;
    sceneInput: string;
  };
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

export function RequirementPage({
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
  const canContinue = sceneInput.trim().length >= 6;

  return (
    <Card className="section-card">
      <CardHeader>
        <CardTitle>新车选购</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <Textarea
          value={sceneInput}
          placeholder={requirementPlaceholder}
          onChange={(event) => onSceneInputChange(event.target.value)}
          className="min-h-40 text-base"
        />
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
          <Button onClick={onContinue} disabled={busy || !canContinue}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
            {startButtonText}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
