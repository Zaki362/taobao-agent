"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCcw } from "lucide-react";
import { jsonFetch } from "@/components/dashboard-api";
import { HostedWorkerStatus } from "@/components/dashboard-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { isRenderableSessionState } from "@/lib/session/guards";
import { SessionState } from "@/lib/session/types";
import { formatCurrency } from "@/lib/utils";

type SessionListResponse = {
  sessions: SessionState[];
};

type RuntimeMetrics = {
  available: boolean;
  jobs: {
    total: number;
    pending: number;
    active: number;
    completed: number;
    failed: number;
    cancelled: number;
    oldest_pending_ms: number;
    average_duration_ms: number;
  };
  devices: {
    total: number;
    online: number;
    last_heartbeat_at: string | null;
  };
  llm: {
    calls: number;
    connected: number;
    fallback: number;
    tasks: Array<{
      task: string;
      average_duration_ms: number;
      p95_duration_ms: number;
    }>;
  };
};

function executionModeLabel(mode: SessionState["execution_mode"]) {
  if (mode === "qoder_cli") return "Qoder CLI 直连";
  if (mode === "local_executor") return "本地执行器队列";
  if (mode === "codex_hosted") return "Codex 宿主代理";
  return "实验性本地桥接";
}

function formatTime(value?: string | null) {
  if (!value) return "暂无";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function formatDuration(value: number) {
  if (!value) return "暂无";
  if (value < 1_000) return `${value}ms`;
  if (value < 60_000) return `${Math.round(value / 1_000)} 秒`;
  return `${Math.round(value / 60_000)} 分钟`;
}

function InfoBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-grid-card">
      <p className="label-text">{label}</p>
      <p className="mt-2 text-sm font-medium leading-6 text-foreground">{value}</p>
    </div>
  );
}

export function HostedConsole() {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionState[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [workerStatus, setWorkerStatus] = useState<HostedWorkerStatus | null>(null);
  const [runtimeMetrics, setRuntimeMetrics] = useState<RuntimeMetrics | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const selectedSession =
    sessions.find((session) => session.session_id === selectedSessionId) ?? sessions[0] ?? null;

  const summary = useMemo(() => {
    const latest = selectedSession;
    return {
      sessionCount: sessions.length,
      moduleCount: latest?.shopping_plan.modules.length ?? 0,
      candidateCount: latest ? Object.values(latest.module_candidates).reduce((sum, list) => sum + list.length, 0) : 0,
      selectedCount: latest?.selected_items.length ?? 0
    };
  }, [sessions, selectedSession]);
  const activeTaskCount = selectedSession?.hosted_tasks.filter(
    (task) => task.status === "pending" || task.status === "running"
  ).length ?? 0;

  async function loadData() {
    setBusy(true);
    setErrorMessage("");
    try {
      const [sessionData, workerData] = await Promise.all([
        jsonFetch<SessionListResponse>("/api/sessions"),
        jsonFetch<HostedWorkerStatus>("/api/hosted/worker-status").catch(() => null)
      ]);
      const nextSessions = Array.isArray(sessionData.sessions)
        ? sessionData.sessions.filter(isRenderableSessionState)
        : [];
      setSessions(nextSessions);
      setWorkerStatus(workerData);
      const metricsSessionId = nextSessions.some((session) => session.session_id === selectedSessionId)
        ? selectedSessionId
        : nextSessions[0]?.session_id;
      setRuntimeMetrics(metricsSessionId
        ? await jsonFetch<RuntimeMetrics>(`/api/runtime/metrics?session_id=${encodeURIComponent(metricsSessionId)}`).catch(() => null)
        : null);
      setSelectedSessionId((current) =>
        nextSessions.some((session) => session.session_id === current)
          ? current
          : nextSessions[0]?.session_id || ""
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "加载后端执行详情失败");
    } finally {
      setBusy(false);
    }
  }

  async function cancelTask(taskId: string) {
    if (!window.confirm("只会取消尚未被本地执行器领取的任务，确定继续吗？")) return;
    setBusy(true);
    setErrorMessage("");
    try {
      await jsonFetch(`/api/runtime/jobs/${encodeURIComponent(taskId)}/cancel`, { method: "POST" });
      await loadData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "取消任务失败");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    loadData().catch(() => undefined);
    const timer = window.setInterval(() => {
      loadData().catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <main className="min-h-screen">
      <div className="page-shell max-w-[1420px]">
        <Card className="hero-card">
          <CardContent className="flex flex-col gap-5 px-6 py-6 md:flex-row md:items-end md:justify-between md:px-8 md:py-7">
            <div className="max-w-3xl">
              <div className="flex items-center gap-2">
                <Badge>Execution Console</Badge>
                <Badge variant="outline">后端执行详情台</Badge>
              </div>
              <h1 className="mt-4 text-balance text-[32px] font-semibold leading-[1.12] tracking-tight md:text-[40px]">
                查看当前后端执行进度、场景理解与搜索细节
              </h1>
              <p className="mt-3 max-w-2xl text-[15px] leading-7 text-muted-foreground">
                这里展示的是产品后端当前会话、规划、搜索执行日志与购物清单，不再区分宿主手工回填视角。
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button
                variant="outline"
                onClick={() => {
                  router.push("/?resume=1");
                }}
              >
                返回当前进度
              </Button>
              <Button variant="outline" onClick={loadData} disabled={busy}>
                <RefreshCcw className="mr-2 h-4 w-4" />
                刷新数据
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <InfoBlock label="会话数量" value={`${summary.sessionCount} 个`} />
          <InfoBlock label="规划模块" value={`${summary.moduleCount} 个`} />
          <InfoBlock label="候选商品" value={`${summary.candidateCount} 个`} />
          <InfoBlock label="已入清单" value={`${summary.selectedCount} 件`} />
        </div>

        <div className={`rounded-[24px] px-4 py-3 text-sm ${
          activeTaskCount > 0 ? "border border-sky-200 bg-sky-50 text-sky-700" : "border border-emerald-200 bg-emerald-50 text-emerald-700"
        }`}>
          {selectedSession?.execution_mode === "local_executor"
            ? activeTaskCount > 0
              ? `持久任务队列中有 ${activeTaskCount} 个任务等待或正在由本地执行器处理，完成后会通过 SSE 自动回填。`
              : "本地执行器队列当前没有待处理任务；已完成结果均保存在当前会话。"
            : workerStatus?.online
              ? `兼容宿主 Worker 在线，状态：${workerStatus.state}，最近动作：${workerStatus.last_result ?? "暂无"}`
              : "当前会话没有运行中的后台任务。"}
        </div>

        {runtimeMetrics?.available ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <InfoBlock label="队列积压" value={`${runtimeMetrics.jobs.pending} 个待领取`} />
            <InfoBlock label="执行中" value={`${runtimeMetrics.jobs.active} 个任务`} />
            <InfoBlock label="失败 / 取消" value={`${runtimeMetrics.jobs.failed} / ${runtimeMetrics.jobs.cancelled}`} />
            <InfoBlock label="最久等待" value={formatDuration(runtimeMetrics.jobs.oldest_pending_ms)} />
            <InfoBlock
              label="本地执行器"
              value={`${runtimeMetrics.devices.online} / ${runtimeMetrics.devices.total} 在线`}
            />
          </div>
        ) : null}

        {runtimeMetrics?.available && runtimeMetrics.llm.calls > 0 ? (
          <div className="grid gap-3 md:grid-cols-3">
            <InfoBlock label="DeepSeek 成功" value={`${runtimeMetrics.llm.connected} / ${runtimeMetrics.llm.calls} 次`} />
            <InfoBlock label="模型 Fallback" value={`${runtimeMetrics.llm.fallback} 次`} />
            <InfoBlock
              label="规划平均耗时"
              value={formatDuration(
                runtimeMetrics.llm.tasks.find((task) => task.task === "personalize_template")?.average_duration_ms ?? 0
              )}
            />
          </div>
        ) : null}

        {errorMessage ? (
          <div className="rounded-[24px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {errorMessage}
          </div>
        ) : null}

        <div className="grid gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
          <Card className="section-card xl:sticky xl:top-6 xl:self-start">
            <CardHeader>
              <CardTitle>会话列表</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {sessions.length === 0 ? (
                <div className="rounded-[22px] border border-dashed border-border/80 bg-white px-4 py-6 text-sm text-muted-foreground shadow-sm">
                  当前还没有可展示的执行会话。
                </div>
              ) : (
                sessions.map((session) => (
                  <button
                    key={session.session_id}
                    className={`w-full rounded-[22px] border p-4 text-left transition ${
                      selectedSession?.session_id === session.session_id ? "border-primary/25 bg-white shadow-card" : "border-border/80 bg-white"
                    }`}
                    onClick={() => setSelectedSessionId(session.session_id)}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-medium">{session.current_scene_label}</p>
                      <Badge variant="outline">{executionModeLabel(session.execution_mode)}</Badge>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">{session.session_id}</p>
                    <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{session.raw_input}</p>
                  </button>
                ))
              )}
            </CardContent>
          </Card>

          <div className="space-y-6">
            {selectedSession ? (
              <>
                <Card className="section-card">
                  <CardHeader>
                    <CardTitle>当前需求详情</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid gap-3 md:grid-cols-2">
                      <InfoBlock label="场景" value={selectedSession.current_scene_label} />
                      <InfoBlock label="执行模式" value={executionModeLabel(selectedSession.execution_mode)} />
                      <InfoBlock label="车型" value={selectedSession.scene_brief.vehicle_type} />
                      <InfoBlock label="预算" value={formatCurrency(selectedSession.scene_brief.budget)} />
                      <InfoBlock label="阶段" value={selectedSession.scene_brief.user_stage} />
                      <InfoBlock label="偏好" value={selectedSession.scene_brief.priority_style} />
                      <InfoBlock label="已有物品" value={selectedSession.scene_brief.already_have.join("、") || "无"} />
                      <InfoBlock label="排除项" value={selectedSession.scene_brief.avoid_items.join("、") || "无"} />
                    </div>
                    <div className="panel-muted p-4 text-sm text-muted-foreground">
                      <p className="font-medium text-foreground">原始需求</p>
                      <p className="mt-2 leading-6">{selectedSession.raw_input}</p>
                    </div>
                  </CardContent>
                </Card>

                <Card className="section-card">
                  <CardHeader>
                    <CardTitle>Agent Runtime 2.0</CardTitle>
                  </CardHeader>
                  <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <InfoBlock
                      label="工具预算"
                      value={`${selectedSession.agent_runtime.used_tool_calls} / ${selectedSession.agent_runtime.max_tool_calls}`}
                    />
                    <InfoBlock label="模型决策" value={`${selectedSession.agent_runtime.model_decisions} 次`} />
                    <InfoBlock label="规则决策" value={`${selectedSession.agent_runtime.policy_decisions} 次`} />
                    <InfoBlock
                      label="最近决策源"
                      value={selectedSession.agent_runtime.last_decision_mode === "deepseek" ? "DeepSeek" : selectedSession.agent_runtime.last_decision_mode === "policy" ? "规则兜底" : "尚未执行"}
                    />
                    <InfoBlock label="活跃任务" value={`${activeTaskCount} 个`} />
                    <InfoBlock label="模型提议" value={`${selectedSession.agent_runtime.model_proposals} 次`} />
                    <InfoBlock label="Guardrail 拒绝" value={`${selectedSession.agent_runtime.model_rejections} 次`} />
                    <InfoBlock label="模型 Fallback" value={`${selectedSession.agent_runtime.model_failures} 次`} />
                  </CardContent>
                  {selectedSession.agent_runtime.last_fallback_reason ? (
                    <CardContent className="pt-0">
                      <div className="panel-muted p-4 text-xs leading-6 text-muted-foreground">
                        最近 fallback：{selectedSession.agent_runtime.last_fallback_reason}
                      </div>
                    </CardContent>
                  ) : null}
                </Card>

                <Card className="section-card">
                  <CardHeader>
                    <CardTitle>当前购物规划</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="subtle-card p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="label-text">Agent 方案自检</p>
                          <p className="mt-2 text-sm font-medium">{selectedSession.plan_review.summary}</p>
                        </div>
                        <Badge variant={selectedSession.plan_review.status === "ready" ? "success" : selectedSession.plan_review.status === "risky" ? "danger" : "secondary"}>
                          {selectedSession.plan_review.status === "ready" ? "方案可执行" : selectedSession.plan_review.status === "risky" ? "建议先调整" : "需要留意"}
                        </Badge>
                      </div>
                      <div className="mt-3 grid gap-2 text-xs leading-5 text-muted-foreground md:grid-cols-3">
                        <p>预算：{selectedSession.plan_review.budget_comment}</p>
                        <p>关键词：{selectedSession.plan_review.keyword_comment}</p>
                        <p>模块：{selectedSession.plan_review.module_comment}</p>
                      </div>
                    </div>
                    {selectedSession.last_refinement ? (
                      <div className="subtle-card border-primary/15 bg-primary/5 p-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <p className="label-text">最近一次调整影响</p>
                            <p className="mt-2 text-sm font-medium">{selectedSession.last_refinement.summary}</p>
                          </div>
                          <Badge variant="secondary">{selectedSession.last_refinement.quick_action}</Badge>
                        </div>
                        <div className="mt-3 grid gap-2 text-xs leading-5 text-muted-foreground md:grid-cols-3">
                          <p>重搜：{selectedSession.last_refinement.impacted_modules.length} 个模块</p>
                          <p>复用：{selectedSession.last_refinement.reusable_modules.length} 个模块</p>
                          <p>移除：{selectedSession.last_refinement.removed_modules.length} 个模块</p>
                        </div>
                      </div>
                    ) : null}
                    {selectedSession.shopping_plan.modules.map((module) => (
                      <div key={module.module_id} className="subtle-card p-5">
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="font-medium">{module.module_name}</p>
                              <Badge variant="secondary">优先级 {module.priority}</Badge>
                            </div>
                            <p className="mt-2 text-sm text-muted-foreground">{module.description}</p>
                            <p className="mt-2 text-xs text-muted-foreground">搜索关键词：{module.search_keyword ?? "未生成"}</p>
                            <p className="mt-1 text-xs text-muted-foreground">策略：{module.recommendation_strategy}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-xs text-muted-foreground">预算</p>
                            <p className="mt-1 font-medium">{formatCurrency(module.budget_allocation)}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>

                <div className="grid gap-6 xl:grid-cols-2">
                  <Card className="section-card xl:col-span-2">
                    <CardHeader>
                      <CardTitle>Agent 自主决策历史</CardTitle>
                    </CardHeader>
                    <CardContent className="grid gap-3 md:grid-cols-2">
                      {selectedSession.agent_decisions.length > 0 ? (
                        [...selectedSession.agent_decisions].reverse().slice(0, 10).map((decision) => (
                          <div key={decision.decision_id} className="rounded-[20px] border border-primary/10 bg-primary/[0.035] p-4 text-sm">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p className="font-medium">{decision.module_name ?? "全局决策"}</p>
                              <Badge variant="outline">{decision.action}</Badge>
                            </div>
                            <p className="mt-2 text-xs leading-5 text-muted-foreground">{decision.reason}</p>
                            <p className="mt-2 text-[11px] text-muted-foreground">
                              来源：{decision.source === "deepseek_runtime" ? "DeepSeek Runtime" : decision.source === "policy_fallback" ? "规则兜底" : decision.source} · 置信度：{decision.confidence} · {decision.consumed_at ? "已执行" : "待执行"} · {formatTime(decision.created_at)}
                            </p>
                          </div>
                        ))
                      ) : (
                        <div className="panel-muted p-4 text-sm text-muted-foreground md:col-span-2">
                          当前还没有 Agent 自主决策。开始搜索后，这里会记录每次搜索、补搜、跳过和结束判断。
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  <Card className="section-card xl:col-span-2">
                    <CardHeader>
                      <CardTitle>Agent 搜索决策轨迹</CardTitle>
                    </CardHeader>
                    <CardContent className="grid gap-3 md:grid-cols-2">
                      {Object.values(selectedSession.module_search_traces ?? {}).length > 0 ? (
                        Object.values(selectedSession.module_search_traces ?? {}).slice(0, 8).map((trace) => (
                          <div key={trace.module_id} className="rounded-[20px] border border-border/80 bg-white p-4 text-sm shadow-sm">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p className="font-medium">{trace.module_name}</p>
                              <Badge variant={trace.status === "ready" ? "success" : trace.status === "failed" ? "danger" : "secondary"}>
                                {trace.status === "ready"
                                  ? "可用"
                                  : trace.status === "recovered"
                                    ? "已补搜"
                                    : trace.status === "failed"
                                      ? "失败"
                                      : "偏薄"}
                              </Badge>
                            </div>
                            <p className="mt-2 text-xs leading-5 text-muted-foreground">{trace.ai_decision_summary}</p>
                            <div className="mt-3 grid gap-1 text-xs leading-5 text-muted-foreground">
                              <p>首轮词：{trace.primary_keyword}</p>
                              <p>尝试词：{trace.searched_keywords.join("、") || "暂无"}</p>
                              <p>候选数：{trace.candidate_count} 件</p>
                              <p>下一步：{trace.next_action}</p>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="panel-muted p-4 text-sm text-muted-foreground md:col-span-2">
                          当前会话还没有搜索决策轨迹。完成任一模块搜索后，这里会展示 Agent 的关键词尝试、补搜原因与候选池复盘。
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  <Card className="section-card">
                    <CardHeader>
                      <CardTitle>执行进度</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {selectedSession.hosted_tasks.length > 0 ? selectedSession.hosted_tasks.slice(0, 8).map((task) => (
                        <div key={task.task_id} className="rounded-[18px] border border-border/80 bg-white p-3 text-sm shadow-sm">
                          <div className="flex items-start justify-between gap-3">
                            <p className="font-medium">{task.title}</p>
                            {task.status === "pending" && selectedSession.execution_mode === "local_executor" ? (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() => cancelTask(task.task_id)}
                              >
                                取消待执行
                              </Button>
                            ) : null}
                          </div>
                          <p className="mt-1 text-muted-foreground">{task.description}</p>
                          <p className="mt-1 text-xs text-muted-foreground">{task.status.toUpperCase()} · {formatTime(task.updated_at)}</p>
                        </div>
                      )) : (
                        <div className="panel-muted p-4 text-sm text-muted-foreground">
                          当前会话没有后台执行任务。
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  <Card className="section-card">
                    <CardHeader>
                      <CardTitle>执行细节日志</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {selectedSession.tool_logs.length > 0 ? (
                        selectedSession.tool_logs.slice(0, 12).map((log) => (
                          <div key={log.id} className="rounded-[18px] border border-border/80 bg-white p-3 text-sm shadow-sm">
                            <div className="flex items-center justify-between gap-3">
                              <p className="font-medium">{log.module_name ? `[${log.module_name}] ` : ""}{log.tool_name}</p>
                              <span className="text-xs text-muted-foreground">{log.status.toUpperCase()} · {log.duration_ms}ms</span>
                            </div>
                            <p className="mt-2 text-xs text-muted-foreground">输入：{log.input_summary}</p>
                            <p className="mt-1 text-xs text-muted-foreground">输出：{log.output_summary}</p>
                          </div>
                        ))
                      ) : (
                        <div className="panel-muted p-4 text-sm text-muted-foreground">
                          当前会话还没有工具调用日志。
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </div>

                <Card className="section-card">
                  <CardHeader>
                    <CardTitle>当前购物清单</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {selectedSession.selected_items.length > 0 ? selectedSession.selected_items.map((item) => (
                      <div key={item.product_id} className="subtle-card p-4">
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="font-medium">{item.title}</p>
                              <Badge variant="outline">{item.cart_source === "demo" ? "演示购物车" : "淘宝购物车"}</Badge>
                            </div>
                            <p className="mt-2 text-sm text-muted-foreground">{item.module_name ?? "已选模块"}</p>
                            <p className="mt-1 text-xs text-muted-foreground">规格：{item.selected_spec ?? "默认规格"}</p>
                            {item.cart_note ? <p className="mt-1 text-xs text-muted-foreground">说明：{item.cart_note}</p> : null}
                          </div>
                          <p className="font-medium">{formatCurrency(item.price)}</p>
                        </div>
                      </div>
                    )) : (
                      <div className="panel-muted p-4 text-sm text-muted-foreground">
                        当前还没有加入购物清单的商品。
                      </div>
                    )}
                  </CardContent>
                </Card>
              </>
            ) : (
              <Card className="section-card">
                <CardContent className="px-6 py-8 text-sm text-muted-foreground">
                  请选择一个会话查看当前后端执行详情。
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
