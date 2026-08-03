"use client";

import { Check, CircleDashed, ExternalLink, Loader2, Pause, Play, RefreshCw, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { HostedWorkerStatus, MpcStatus } from "@/components/dashboard-types";
import type { SessionState } from "@/lib/session/types";
import { getScenarioConfig } from "@/lib/scenarios";

export function SearchProgressPage({
  session,
  mcpStatus,
  searchSummary,
  onRefresh,
  onViewResults,
  onPauseWorkflow,
  onResumeWorkflow,
  busy,
  workflowControlBusy
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
  onPauseWorkflow: () => void;
  onResumeWorkflow: () => void;
  busy: boolean;
  workflowControlBusy: boolean;
}) {
  const scenario = getScenarioConfig(session.scene_brief.scenario_id);
  const modules = session.shopping_plan.modules;
  const completedModules = modules.filter((module) => (session.module_candidates[module.module_id] ?? []).length > 0);
  const candidateCount = Object.values(session.module_candidates).reduce((sum, list) => sum + list.length, 0);
  const progress = modules.length > 0 ? Math.round((completedModules.length / modules.length) * 100) : 0;
  const workflowActive = session.agent_runtime.workflow_status === "running" || session.agent_runtime.workflow_status === "waiting_for_tools";
  const workflowPaused = session.agent_runtime.workflow_status === "paused";
  const currentModule = modules.find((module) => !(session.module_candidates[module.module_id] ?? []).length);
  const executorReady = mcpStatus?.available === true;

  return (
    <Card className="section-card mx-auto w-full max-w-5xl">
      <CardHeader className="px-6 pt-7 md:px-8 md:pt-8">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="label-text">第 3 步 · 搜索商品</p>
            <CardTitle className="mt-2 text-2xl">搜索执行摘要</CardTitle>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{scenario.searching_status_text}。每个模块完成后都会自动保存。</p>
          </div>
          <Badge variant={executorReady ? "success" : "secondary"}>{executorReady ? "购物能力已连接" : "等待执行器"}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-6 px-6 pb-7 pt-6 md:px-8 md:pb-8">
        <div className="search-progress-hero">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-sm font-medium text-muted-foreground">{workflowPaused ? "搜索已暂停" : currentModule ? `正在准备「${currentModule.module_name}」` : "模块搜索已完成"}</p>
              <p className="mt-2 text-3xl font-semibold tracking-tight text-foreground">{progress}%</p>
            </div>
            <div className="flex gap-6 text-sm">
              <span><strong className="block text-lg text-foreground">{completedModules.length}</strong><span className="text-xs text-muted-foreground">已完成</span></span>
              <span><strong className="block text-lg text-foreground">{candidateCount}</strong><span className="text-xs text-muted-foreground">候选商品</span></span>
              <span><strong className="block text-lg text-foreground">{Math.max(0, modules.length - completedModules.length)}</strong><span className="text-xs text-muted-foreground">待处理</span></span>
            </div>
          </div>
          <div className="mt-5 h-2 overflow-hidden rounded-full bg-white/80">
            <div className="h-full rounded-full bg-primary transition-[width] duration-700" style={{ width: `${progress}%` }} />
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          {modules.map((module) => {
            const done = (session.module_candidates[module.module_id] ?? []).length > 0;
            const current = currentModule?.module_id === module.module_id && workflowActive;
            return (
              <div key={module.module_id} className={`module-progress-row ${current ? "module-progress-current" : ""}`}>
                <span className={`module-progress-icon ${done ? "module-progress-done" : ""}`}>
                  {done ? <Check className="h-3.5 w-3.5" /> : current ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CircleDashed className="h-3.5 w-3.5" />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">{module.module_name}</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{done ? `${(session.module_candidates[module.module_id] ?? []).length} 个候选已就绪` : current ? "正在搜索" : "等待搜索"}</p>
                </div>
              </div>
            );
          })}
        </div>

        {searchSummary.length > 0 ? (
          <p className="rounded-[18px] bg-muted/55 px-4 py-3 text-sm leading-6 text-muted-foreground">{searchSummary[searchSummary.length - 1]}</p>
        ) : null}

        <div className="flex flex-col-reverse gap-3 border-t border-border/60 pt-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={onRefresh}><RefreshCw className="h-4 w-4" />刷新进度</Button>
            <a href="/hosted" className="inline-flex h-11 items-center gap-2 rounded-full px-4 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground">
              <ExternalLink className="h-4 w-4" />执行详情
            </a>
            {mcpStatus?.mode === "local_executor" && workflowActive ? (
              <Button variant="outline" onClick={onPauseWorkflow} disabled={workflowControlBusy}>
                <Pause className="h-4 w-4" />{workflowControlBusy ? "正在暂停" : "完成当前项后暂停"}
              </Button>
            ) : null}
            {mcpStatus?.mode === "local_executor" && workflowPaused ? (
              <Button variant="outline" onClick={onResumeWorkflow} disabled={workflowControlBusy || busy}>
                <Play className="h-4 w-4" />{workflowControlBusy ? "正在继续" : "继续搜索"}
              </Button>
            ) : null}
          </div>
          <Button onClick={onViewResults} disabled={busy || workflowActive}>
            {workflowActive ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            {workflowActive ? "后台搜索中" : "查看推荐结果"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
