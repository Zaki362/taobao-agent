"use client";

import { ArrowRight, Check, CircleDashed, Loader2, LogIn, Pause, Play, RefreshCw, Search } from "lucide-react";
import { AgentBrief } from "@/components/dashboard-common";
import {
  isLocalExecutorUnavailable,
  isTaobaoMcpReconnecting,
  shouldOfferWorkflowResume,
  shouldPresentActiveTaobaoSearch
} from "@/components/executor-status-view";
import { isTaobaoAuthenticationPause } from "@/components/dashboard-helpers";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { HostedWorkerStatus, MpcStatus } from "@/components/dashboard-types";
import type { SessionState } from "@/lib/session/types";
import { getScenarioConfig } from "@/lib/scenarios";

export function SearchProgressPage({
  session,
  mcpStatus,
  searchSummary,
  onRefresh,
  onViewResults,
  onUseExistingResults,
  onPauseWorkflow,
  onResumeWorkflow,
  onResumeAfterAuthentication,
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
  onUseExistingResults: () => void;
  onPauseWorkflow: () => void;
  onResumeWorkflow: () => void;
  onResumeAfterAuthentication: () => void;
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
  const authenticationPaused = isTaobaoAuthenticationPause(session);
  const mcpReconnecting = isTaobaoMcpReconnecting(mcpStatus);
  const executorUnavailable = isLocalExecutorUnavailable(mcpStatus);
  const activelySearching = shouldPresentActiveTaobaoSearch(workflowActive, authenticationPaused, mcpStatus);
  const currentModule = modules.find(
    (module) => module.module_id === session.agent_runtime.current_module_id
  ) ?? modules.find((module) => !(session.module_candidates[module.module_id] ?? []).length);
  const agentTitle = authenticationPaused
    ? "淘宝登录已失效，真实搜索已安全暂停"
    : workflowPaused
      ? "搜索已暂停，已有结果不会丢失"
      : mcpReconnecting
        ? "淘宝工具重连中，搜索任务已保存"
        : executorUnavailable
          ? "等待本地执行器连接，搜索任务已保存"
          : workflowActive && currentModule
            ? `我正在比较「${currentModule.module_name}」的候选商品`
            : `我已经完成 ${completedModules.length} 个模块的搜索`;

  return (
    <div className="workflow-content space-y-4">
      <AgentBrief
        compact
        eyebrow="Agent 正在行动"
        title={agentTitle}
        description={authenticationPaused
          ? `淘宝登录态失效后已停止提交新的真实搜索。已经回填的 ${candidateCount} 个候选仍保存在当前任务中。`
          : workflowPaused
            ? `当前搜索已安全暂停。已经回填的 ${candidateCount} 个候选和待执行队列都已保存，点击继续搜索后会从断点恢复。`
            : mcpReconnecting
              ? `本地执行器正在自动检测淘宝桌面工具。当前 Session、搜索队列和已经回填的 ${candidateCount} 个候选都已保存，连接恢复后会自动继续。`
              : executorUnavailable
                ? `当前 Session、搜索队列和已经回填的 ${candidateCount} 个候选都已保存。启动本地执行器后可以继续，不需要重新填写需求。`
                : `${scenario.searching_status_text}。我会按规划逐项搜索、筛掉明显不合适的结果，再把值得看的候选交给你。`}
        loading={activelySearching}
      />
      <Card className="section-card w-full">
        <CardContent className="space-y-5 px-6 py-6 md:px-8 md:py-7">
        {authenticationPaused ? (
          <div role="alert" className="rounded-[20px] border border-amber-200 bg-amber-50 px-5 py-4 text-amber-950">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 rounded-full bg-amber-100 p-2 text-amber-700"><LogIn className="h-4 w-4" /></span>
              <div className="min-w-0 flex-1">
                <p className="font-semibold">淘宝登录已失效，真实搜索已安全暂停</p>
                <p className="mt-1 text-sm leading-6 text-amber-800">
                  {candidateCount > 0
                    ? `已经找到的 ${candidateCount} 个候选不会丢失。你可以先查看已完成模块的部分结果，也可以在淘宝桌面版重新登录并保持主界面打开后，从这个 Session 继续。`
                    : "当前还没有可用候选。请先在淘宝桌面版重新登录并保持主界面打开，再从这个 Session 继续，不需要重新填写需求。"}
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button onClick={onResumeAfterAuthentication} disabled={workflowControlBusy || busy}>
                    {workflowControlBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                    {workflowControlBusy ? "正在恢复真实搜索" : "重新登录后继续搜索"}
                  </Button>
                  {candidateCount > 0 ? (
                    <Button variant="outline" onClick={onUseExistingResults} disabled={workflowControlBusy || busy}>
                      用已有部分结果进入选购<ArrowRight className="h-4 w-4" />
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        ) : mcpReconnecting ? (
          <div role="status" className="rounded-[20px] border border-sky-200 bg-sky-50 px-5 py-4 text-sky-950">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 rounded-full bg-sky-100 p-2 text-sky-700"><RefreshCw className="h-4 w-4 animate-spin" /></span>
              <div className="min-w-0 flex-1">
                <p className="font-semibold">淘宝工具暂不可用，系统正在自动重连</p>
                <p className="mt-1 text-sm leading-6 text-sky-800">
                  {workflowPaused
                    ? "搜索任务已经保存在服务端。网页每 5 秒自动检测一次；淘宝桌面工具恢复后提示会自动消失，但搜索仍保持暂停，直到你点击继续搜索。"
                    : "搜索任务已经保存在服务端，不需要重新填写需求或重复点击继续。网页每 5 秒自动检测一次；淘宝桌面工具恢复后，这条提示会自动消失并继续执行队列。"}
                </p>
                {candidateCount > 0 ? (
                  <Button className="mt-4" variant="outline" onClick={onViewResults}>
                    查看已保存结果<ArrowRight className="h-4 w-4" />
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        ) : executorUnavailable ? (
          <div role="status" className="rounded-[18px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">
            本地执行器尚未连接，当前 Session 和搜索任务已保存。连接恢复后可从这里继续。
          </div>
        ) : null}
        <div className="search-progress-hero">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-sm font-medium text-muted-foreground">
                {authenticationPaused
                  ? "等待恢复淘宝登录"
                  : workflowPaused
                    ? "搜索已暂停"
                    : mcpReconnecting
                      ? "等待淘宝工具自动恢复"
                      : executorUnavailable
                        ? "等待本地执行器连接"
                        : workflowActive && currentModule
                          ? `正在处理「${currentModule.module_name}」`
                          : completedModules.length === modules.length
                            ? "全部分类已完成"
                            : `已完成 ${completedModules.length}/${modules.length} 个分类`}
              </p>
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
            const current = currentModule?.module_id === module.module_id && activelySearching;
            const waitingForAuthentication = authenticationPaused && session.agent_runtime.current_module_id === module.module_id;
            const waitingForMcp = mcpReconnecting && currentModule?.module_id === module.module_id;
            const waitingForExecutor = executorUnavailable && currentModule?.module_id === module.module_id;
            return (
              <div key={module.module_id} className={`module-progress-row ${current ? "module-progress-current" : ""}`}>
                <span className={`module-progress-icon ${done ? "module-progress-done" : ""}`}>
                  {done ? <Check className="h-3.5 w-3.5" /> : current ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CircleDashed className="h-3.5 w-3.5" />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">{module.module_name}</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{done ? `${(session.module_candidates[module.module_id] ?? []).length} 个候选已就绪` : waitingForAuthentication ? "等待恢复淘宝登录" : workflowPaused ? "搜索已暂停" : waitingForMcp ? "任务已保存，等待淘宝工具恢复" : waitingForExecutor ? "任务已保存，等待本地执行器" : current ? "正在比较候选" : workflowActive ? "等待处理" : "本轮未找到合适结果"}</p>
                </div>
              </div>
            );
          })}
        </div>

        {searchSummary.length > 0 ? (
          <div className="rounded-[18px] bg-muted/55 px-4 py-3 text-sm leading-6 text-muted-foreground">
            <span className="mr-2 font-medium text-foreground">刚刚完成</span>{searchSummary[searchSummary.length - 1]}
          </div>
        ) : null}

        <div className="flex flex-col-reverse gap-3 border-t border-border/60 pt-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={onRefresh}><RefreshCw className="h-4 w-4" />刷新进度</Button>
            {mcpStatus?.mode === "local_executor" && workflowActive ? (
              <Button variant="outline" onClick={onPauseWorkflow} disabled={workflowControlBusy}>
                <Pause className="h-4 w-4" />{workflowControlBusy ? "正在暂停" : "完成当前项后暂停"}
              </Button>
            ) : null}
            {shouldOfferWorkflowResume(workflowPaused, authenticationPaused, mcpStatus) ? (
              <Button variant="outline" onClick={onResumeWorkflow} disabled={workflowControlBusy || busy}>
                <Play className="h-4 w-4" />{workflowControlBusy ? "正在继续" : "继续搜索"}
              </Button>
            ) : null}
          </div>
          {!authenticationPaused ? (
            <Button
              onClick={onViewResults}
              disabled={(busy && !(executorUnavailable && candidateCount > 0)) || activelySearching || (executorUnavailable && candidateCount === 0)}
            >
              {activelySearching ? <Loader2 className="h-4 w-4 animate-spin" /> : executorUnavailable ? <RefreshCw className="h-4 w-4" /> : <Search className="h-4 w-4" />}
              {activelySearching ? "后台搜索中" : executorUnavailable && candidateCount > 0 ? "查看已有结果" : mcpReconnecting ? "等待淘宝工具恢复" : executorUnavailable ? "等待本地执行器" : "查看推荐结果"}
            </Button>
          ) : null}
        </div>
      </CardContent>
      </Card>
    </div>
  );
}
