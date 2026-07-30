"use client";

import { useEffect, useState } from "react";
import { ChevronRight, Loader2, Sparkles } from "lucide-react";
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

export function LandingPage({ onEnterScenario }: { onEnterScenario: () => void }) {
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
