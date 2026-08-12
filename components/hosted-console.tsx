"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Pause, Play, RefreshCcw } from "lucide-react";
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
    pending_by_type: {
      module_search: number;
      add_to_cart: number;
    };
  };
  devices: {
    total: number;
    online: number;
    last_heartbeat_at: string | null;
    capabilities: {
      module_search: { registered: number; online: number; available: boolean };
      add_to_cart: { registered: number; online: number; available: boolean };
    };
  };
  device_audit_events: Array<{
    id: number;
    event_type: string;
    payload: Record<string, unknown>;
    created_at: string;
  }>;
  workflow_recovery: {
    configured: boolean;
    state: "missing" | "stale" | "healthy" | "degraded" | "failed";
    status: "healthy" | "degraded" | "failed" | null;
    last_heartbeat_at: string | null;
    age_ms: number | null;
    stale_after_ms: number;
  };
  llm: {
    calls: number;
    connected: number;
    fallback: number;
    tasks: Array<{
      task: string;
      model: string;
      calls: number;
      connected: number;
      fallback: number;
      average_duration_ms: number;
      p95_duration_ms: number;
      last_reason?: string;
      last_called_at?: string;
    }>;
  };
  health: {
    status: "healthy" | "warning" | "critical";
    summary: string;
    incidents: Array<{
      code: string;
      severity: "warning" | "critical";
      title: string;
      detail: string;
      recommendation: string;
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

function marketStatusLabel(status: SessionState["market_feedback"]["status"]) {
  if (status === "under_pressure") return "预算承压";
  if (status === "opportunity") return "存在余量";
  if (status === "balanced") return "预算匹配";
  return "样本积累中";
}

function marketPressureLabel(pressure: SessionState["market_feedback"]["module_signals"][string]["pressure"]) {
  if (pressure === "over_budget") return "超出预算";
  if (pressure === "tight") return "空间偏紧";
  if (pressure === "opportunity") return "存在余量";
  if (pressure === "healthy") return "价格匹配";
  return "未观察";
}

function workflowStatusLabel(status: SessionState["agent_runtime"]["workflow_status"]) {
  if (status === "running") return "服务端推进中";
  if (status === "waiting_for_tools") return "等待本地执行器";
  if (status === "completed") return "本轮已完成";
  if (status === "paused") return "已暂停";
  if (status === "error") return "需要处理";
  return "等待用户开始";
}

function llmTaskLabel(task: string) {
  const labels: Record<string, string> = {
    parse_scene: "理解需求",
    personalize_template: "个性化规划",
    refine_plan: "方案调整",
    review_plan: "规划复核",
    review_candidates: "候选复盘",
    decide_next_action: "Agent 下一步决策",
    compose_purchase_bundle: "购买组合生成",
    explain_product_fit: "推荐理由"
  };
  return labels[task] ?? task;
}

function llmReasonLabel(reason?: string) {
  if (!reason) return "最近调用成功";
  if (reason === "timeout") return "响应超时";
  if (reason === "invalid_json") return "返回内容不是合法 JSON";
  if (reason === "empty_content") return "模型未返回内容";
  if (reason === "request_failed") return "网络请求失败";
  if (reason === "api_key_missing") return "未配置 API Key";
  if (reason === "explicitly_disabled") return "模型已被显式禁用";
  if (reason.startsWith("http_")) return `上游接口 ${reason.slice(5)}`;
  if (reason.startsWith("schema_validation_failed")) return "结构化结果未通过校验";
  if (reason.startsWith("guardrail_rejected")) return "模型提案未通过业务安全校验";
  return reason;
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
  const sessionLlmStats = useMemo(() => {
    const calls = selectedSession?.llm_calls ?? [];
    return {
      total: calls.length,
      connected: calls.filter((call) => call.mode === "connected").length,
      fallback: calls.filter((call) => call.mode === "fallback").length,
      latest: calls.at(-1)
    };
  }, [selectedSession]);

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

  async function retryTask(task: SessionState["hosted_tasks"][number]) {
    if (!selectedSession) return;
    const actionLabel = task.task_type === "add_to_cart" ? "重新尝试真实加购" : "重新执行淘宝搜索";
    if (!window.confirm(`${actionLabel}会重新进入本地执行器队列，确定继续吗？`)) return;
    setBusy(true);
    setErrorMessage("");
    try {
      if (task.task_type === "module_search" && task.module_id) {
        await jsonFetch("/api/modules/search", {
          method: "POST",
          body: JSON.stringify({
            session_id: selectedSession.session_id,
            module_id: task.module_id,
            keyword_override: typeof task.payload.keyword === "string" ? task.payload.keyword : undefined,
            confirmed_retry: true
          })
        });
      } else if (task.task_type === "add_to_cart" && task.product_id) {
        await jsonFetch("/api/cart/add", {
          method: "POST",
          body: JSON.stringify({
            session_id: selectedSession.session_id,
            product_id: task.product_id,
            confirmed: true
          })
        });
      } else {
        throw new Error("任务缺少重试所需的模块或商品信息");
      }
      await loadData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "重新入队失败");
    } finally {
      setBusy(false);
    }
  }

  async function pauseWorkflow() {
    if (!selectedSession) return;
    if (!window.confirm("当前模块完成后不会继续下一个模块，确认暂停自动搜索吗？")) return;
    setBusy(true);
    setErrorMessage("");
    try {
      await jsonFetch("/api/agent/pause", {
        method: "POST",
        body: JSON.stringify({ session_id: selectedSession.session_id, confirmed: true })
      });
      await loadData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "暂停 Agent 搜索失败");
    } finally {
      setBusy(false);
    }
  }

  async function resumeWorkflow() {
    if (!selectedSession) return;
    if (!window.confirm("将保留已有结果并从原进度继续，确认恢复自动搜索吗？")) return;
    setBusy(true);
    setErrorMessage("");
    try {
      await jsonFetch("/api/agent/resume", {
        method: "POST",
        body: JSON.stringify({ session_id: selectedSession.session_id, confirmed: true })
      });
      await loadData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "继续 Agent 搜索失败");
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
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-7">
            <InfoBlock label="队列积压" value={`${runtimeMetrics.jobs.pending} 个待领取`} />
            <InfoBlock label="执行中" value={`${runtimeMetrics.jobs.active} 个任务`} />
            <InfoBlock label="失败 / 取消" value={`${runtimeMetrics.jobs.failed} / ${runtimeMetrics.jobs.cancelled}`} />
            <InfoBlock label="最久等待" value={formatDuration(runtimeMetrics.jobs.oldest_pending_ms)} />
            <InfoBlock
              label="本地执行器"
              value={`${runtimeMetrics.devices.online} / ${runtimeMetrics.devices.total} 在线`}
            />
            <InfoBlock
              label="能力覆盖"
              value={`搜索 ${runtimeMetrics.devices.capabilities.module_search.online} · 加购 ${runtimeMetrics.devices.capabilities.add_to_cart.online}`}
            />
            <InfoBlock
              label="恢复调度"
              value={runtimeMetrics.workflow_recovery.state === "healthy"
                ? `正常 · ${formatTime(runtimeMetrics.workflow_recovery.last_heartbeat_at)}`
                : runtimeMetrics.workflow_recovery.state === "degraded"
                  ? `部分失败 · ${formatTime(runtimeMetrics.workflow_recovery.last_heartbeat_at)}`
                  : runtimeMetrics.workflow_recovery.state === "stale"
                    ? "心跳已过期"
                    : runtimeMetrics.workflow_recovery.state === "failed"
                      ? "最近执行失败"
                      : "尚未运行"}
            />
          </div>
        ) : null}

        {runtimeMetrics?.available && runtimeMetrics.llm.calls > 0 ? (
          <div className="space-y-3">
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
            <details className="rounded-[24px] border border-border/80 bg-white px-5 py-4 shadow-sm">
              <summary className="cursor-pointer list-none text-sm font-semibold text-foreground">
                查看模型调用明细
                <span className="ml-2 text-xs font-normal text-muted-foreground">按能力查看模型、延迟与回退原因</span>
              </summary>
              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                {runtimeMetrics.llm.tasks.map((task) => (
                  <div key={task.task} className="rounded-[18px] border border-border/70 bg-secondary/30 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold">{llmTaskLabel(task.task)}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{task.model}</p>
                      </div>
                      <Badge variant={task.fallback === 0 ? "success" : task.connected > 0 ? "secondary" : "danger"}>
                        成功 {task.connected} · 回退 {task.fallback}
                      </Badge>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>调用 {task.calls} 次</span>
                      <span>平均 {formatDuration(task.average_duration_ms)}</span>
                      <span>P95 {formatDuration(task.p95_duration_ms)}</span>
                      <span>最近 {formatTime(task.last_called_at)}</span>
                    </div>
                    <p className={`mt-3 text-xs leading-5 ${task.last_reason ? "text-amber-700" : "text-emerald-700"}`}>
                      {llmReasonLabel(task.last_reason)}
                    </p>
                  </div>
                ))}
              </div>
            </details>
          </div>
        ) : null}

        {runtimeMetrics?.available ? (
          <Card className={`section-card ${
            runtimeMetrics.health.status === "critical"
              ? "border-red-200"
              : runtimeMetrics.health.status === "warning"
                ? "border-amber-200"
                : "border-emerald-200"
          }`}>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle>运行健康诊断</CardTitle>
                <Badge variant={runtimeMetrics.health.status === "healthy" ? "success" : runtimeMetrics.health.status === "critical" ? "danger" : "secondary"}>
                  {runtimeMetrics.health.status === "healthy" ? "运行正常" : runtimeMetrics.health.status === "critical" ? "需要立即处理" : "需要关注"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">{runtimeMetrics.health.summary}</p>
              {runtimeMetrics.health.incidents.map((item) => (
                <div key={item.code} className={`rounded-[20px] border p-4 ${
                  item.severity === "critical"
                    ? "border-red-200 bg-red-50/70"
                    : "border-amber-200 bg-amber-50/70"
                }`}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm font-semibold">{item.title}</p>
                    <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                      item.severity === "critical" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"
                    }`}>
                      {item.severity === "critical" ? "严重" : "预警"}
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{item.detail}</p>
                  <p className="mt-2 text-xs leading-5 text-foreground/75">建议：{item.recommendation}</p>
                </div>
              ))}
            </CardContent>
          </Card>
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

                {selectedSession.completion_report ? (
                  <Card className="section-card">
                    <CardHeader>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <CardTitle>Agent 完成质量审计</CardTitle>
                          <p className="mt-2 text-sm text-muted-foreground">记录本轮为什么停止，以及真实候选是否覆盖了用户确认的方案。</p>
                        </div>
                        <Badge variant={selectedSession.completion_report.status === "ready" ? "success" : selectedSession.completion_report.status === "needs_attention" ? "danger" : "secondary"}>
                          {selectedSession.completion_report.status === "ready" ? "方案可用" : selectedSession.completion_report.status === "needs_attention" ? "仍有缺口" : "部分可用"}
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                        <InfoBlock label="规划覆盖" value={`${selectedSession.completion_report.covered_module_ids.length}/${selectedSession.completion_report.total_modules}`} />
                        <InfoBlock label="必需覆盖" value={`${selectedSession.completion_report.critical_covered_module_ids.length}/${selectedSession.completion_report.critical_module_ids.length}`} />
                        <InfoBlock label="候选总数" value={`${selectedSession.completion_report.total_candidates} 件`} />
                        <InfoBlock label="结束决策源" value={selectedSession.completion_report.source === "deepseek_runtime" ? "DeepSeek Runtime" : "规则策略"} />
                      </div>
                      <div className="rounded-[20px] border border-primary/10 bg-primary/[0.035] p-4 text-sm">
                        <p className="font-medium">{selectedSession.completion_report.summary}</p>
                        <p className="mt-2 text-xs leading-5 text-muted-foreground">停止理由：{selectedSession.completion_report.stop_reason}</p>
                      </div>
                      {selectedSession.completion_report.caveats.length > 0 ? (
                        <div className="grid gap-3 md:grid-cols-2">
                          <div className="panel-muted p-4 text-xs leading-6 text-muted-foreground">
                            <p className="font-medium text-foreground">当前缺口</p>
                            {selectedSession.completion_report.caveats.map((item) => <p key={item} className="mt-1">· {item}</p>)}
                          </div>
                          <div className="panel-muted p-4 text-xs leading-6 text-muted-foreground">
                            <p className="font-medium text-foreground">建议动作</p>
                            {selectedSession.completion_report.next_steps.map((item) => <p key={item} className="mt-1">· {item}</p>)}
                          </div>
                        </div>
                      ) : null}
                      {selectedSession.completion_report.purchase_bundle ? (
                        <div className="rounded-[20px] border border-[#f1d0c1] bg-[#fff9f5] p-4">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                              <p className="text-sm font-medium">预算安全购买组合</p>
                              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                {selectedSession.completion_report.purchase_bundle.summary}
                              </p>
                            </div>
                            <Badge variant="secondary">
                              {selectedSession.completion_report.purchase_bundle.source === "deepseek" ? "DeepSeek 提案" : "规则兜底"}
                            </Badge>
                          </div>
                          <div className="mt-4 grid gap-3 md:grid-cols-3">
                            <InfoBlock label="组合估价" value={formatCurrency(selectedSession.completion_report.purchase_bundle.estimated_total)} />
                            <InfoBlock label="预算余量" value={formatCurrency(selectedSession.completion_report.purchase_bundle.remaining_budget)} />
                            <InfoBlock
                              label="必需覆盖"
                              value={`${selectedSession.completion_report.purchase_bundle.critical_selected_module_ids.length}/${selectedSession.completion_report.purchase_bundle.critical_module_ids.length}`}
                            />
                          </div>
                          {selectedSession.bundle_adoption?.bundle_generated_at === selectedSession.completion_report.purchase_bundle.generated_at ? (
                            <div className="mt-4 rounded-[16px] border border-primary/15 bg-primary/[0.04] p-3 text-xs">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="font-medium text-foreground">用户已采纳组合</span>
                                <Badge variant={selectedSession.bundle_adoption.status === "completed" ? "success" : "secondary"}>
                                  {selectedSession.bundle_adoption.status === "completed"
                                    ? "全部处理完成"
                                    : selectedSession.bundle_adoption.status === "in_progress"
                                      ? "逐件处理中"
                                      : "等待逐件确认"}
                                </Badge>
                              </div>
                              <p className="mt-2 text-muted-foreground">
                                已加入淘宝购物车 {selectedSession.bundle_adoption.added_product_ids.length}/{selectedSession.bundle_adoption.product_ids.length} 件 · 采纳于 {new Date(selectedSession.bundle_adoption.accepted_at).toLocaleString("zh-CN", { hour12: false })}
                              </p>
                            </div>
                          ) : null}
                          <div className="mt-4 grid gap-2 md:grid-cols-2">
                            {selectedSession.completion_report.purchase_bundle.items.map((item) => (
                              <div key={item.product_id} className="rounded-[16px] border border-border/70 bg-white p-3 text-xs">
                                <div className="flex items-center justify-between gap-2 text-muted-foreground">
                                  <span>{item.module_name}</span>
                                  <span className="font-semibold text-[#e65320]">{formatCurrency(item.price)}</span>
                                </div>
                                <p className="mt-1 line-clamp-2 font-medium leading-5 text-foreground">{item.title}</p>
                                <p className="mt-1 line-clamp-2 leading-5 text-muted-foreground">{item.reason}</p>
                              </div>
                            ))}
                          </div>
                          <p className="mt-3 text-xs text-muted-foreground">组合只用于建议与审计，不会绕过用户确认自动加购。</p>
                        </div>
                      ) : null}
                    </CardContent>
                  </Card>
                ) : null}

                <Card className="section-card">
                  <CardHeader>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <CardTitle>本次会话模型凭证</CardTitle>
                        <p className="mt-2 text-sm text-muted-foreground">只记录任务、模型、耗时和降级原因，不保存 Prompt、用户原文或模型原始输出。</p>
                      </div>
                      <Badge variant={sessionLlmStats.fallback > 0 ? "secondary" : sessionLlmStats.connected > 0 ? "success" : "outline"}>
                        {sessionLlmStats.connected > 0
                          ? `${sessionLlmStats.connected}/${sessionLlmStats.total} 次真实成功`
                          : "尚无真实调用凭证"}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <InfoBlock label="会话内调用" value={`${sessionLlmStats.total} 次`} />
                    <InfoBlock label="DeepSeek 成功" value={`${sessionLlmStats.connected} 次`} />
                    <InfoBlock label="规则 Fallback" value={`${sessionLlmStats.fallback} 次`} />
                    <InfoBlock
                      label="最近能力"
                      value={sessionLlmStats.latest ? llmTaskLabel(sessionLlmStats.latest.task) : "尚未记录"}
                    />
                  </CardContent>
                  {selectedSession.llm_calls.length > 0 ? (
                    <CardContent className="pt-0">
                      <details className="rounded-[20px] border border-border/70 bg-white px-4 py-3">
                        <summary className="cursor-pointer text-sm font-medium">查看本次购物链路的模型调用</summary>
                        <div className="mt-4 space-y-2">
                          {[...selectedSession.llm_calls].reverse().slice(0, 24).map((call) => (
                            <div key={call.id} className="rounded-[16px] border border-border/60 bg-muted/25 p-3 text-xs">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="flex flex-wrap items-center gap-2">
                                  <Badge variant={call.mode === "connected" ? "success" : "secondary"}>
                                    {call.mode === "connected" ? "DeepSeek" : "规则 Fallback"}
                                  </Badge>
                                  <span className="font-medium text-foreground">{llmTaskLabel(call.task)}</span>
                                </div>
                                <span className="text-muted-foreground">{call.duration_ms}ms · {formatTime(call.created_at)}</span>
                              </div>
                              <p className="mt-2 text-muted-foreground">
                                {call.model}{call.mode === "fallback" ? ` · ${llmReasonLabel(call.reason)}` : " · 结构化结果已通过校验"}
                              </p>
                            </div>
                          ))}
                        </div>
                      </details>
                    </CardContent>
                  ) : null}
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
                    <InfoBlock label="自动推进" value={workflowStatusLabel(selectedSession.agent_runtime.workflow_status)} />
                    <InfoBlock label="服务端续跑" value={`${selectedSession.agent_runtime.continuation_count} 次状态转换`} />
                    <InfoBlock
                      label="当前模块"
                      value={selectedSession.shopping_plan.modules.find((module) => module.module_id === selectedSession.agent_runtime.current_module_id)?.module_name ?? "无"}
                    />
                    <InfoBlock label="页面关闭后" value={selectedSession.agent_runtime.auto_continue ? "仍会继续" : "不会继续执行"} />
                  </CardContent>
                  <CardContent className="pt-0">
                    <div className="rounded-[20px] border border-primary/10 bg-primary/[0.035] p-4 text-sm">
                      <p className="font-medium">{selectedSession.agent_runtime.workflow_message}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {selectedSession.agent_runtime.workflow_run_id
                          ? `运行 ID：${selectedSession.agent_runtime.workflow_run_id.slice(0, 8)} · 最近更新：${formatTime(selectedSession.agent_runtime.last_transition_at)}`
                          : "尚未创建服务端运行实例"}
                      </p>
                    </div>
                  </CardContent>
                  {selectedSession.execution_mode === "local_executor" &&
                  (selectedSession.agent_runtime.workflow_status === "running" ||
                    selectedSession.agent_runtime.workflow_status === "waiting_for_tools" ||
                    selectedSession.agent_runtime.workflow_status === "paused") ? (
                    <CardContent className="flex flex-wrap gap-3 pt-0">
                      {selectedSession.agent_runtime.workflow_status === "paused" ? (
                        <Button variant="outline" disabled={busy} onClick={resumeWorkflow}>
                          <Play className="h-4 w-4" />
                          从原进度继续
                        </Button>
                      ) : (
                        <Button variant="outline" disabled={busy} onClick={pauseWorkflow}>
                          <Pause className="h-4 w-4" />
                          完成当前模块后暂停
                        </Button>
                      )}
                    </CardContent>
                  ) : null}
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
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <CardTitle>真实市场反馈</CardTitle>
                          <p className="mt-2 text-sm text-muted-foreground">
                            Agent 根据已返回候选的实际价格校准后续搜索；预算变更只形成建议，不会静默生效。
                          </p>
                        </div>
                        <Badge variant={selectedSession.market_feedback.status === "under_pressure" ? "danger" : selectedSession.market_feedback.status === "balanced" ? "success" : "secondary"}>
                          {marketStatusLabel(selectedSession.market_feedback.status)}
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="subtle-card p-4">
                        <p className="text-sm font-medium leading-6">{selectedSession.market_feedback.summary}</p>
                        <div className="mt-3 grid gap-2 text-xs leading-5 text-muted-foreground md:grid-cols-3">
                          <p>已观察：{selectedSession.market_feedback.observed_modules}/{selectedSession.market_feedback.total_modules} 个模块</p>
                          <p>观察范围预算：{formatCurrency(selectedSession.market_feedback.observed_planned_budget)}</p>
                          <p>每模块单件参考价合计：{formatCurrency(selectedSession.market_feedback.observed_reference_total)}</p>
                        </div>
                      </div>
                      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                        {Object.values(selectedSession.market_feedback.module_signals)
                          .filter((signal) => signal.pressure !== "unobserved")
                          .map((signal) => (
                            <div key={signal.module_id} className="rounded-[20px] border border-border/80 bg-white p-4 text-sm shadow-sm">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="font-medium">{signal.module_name}</p>
                                <Badge variant={signal.pressure === "over_budget" || signal.pressure === "tight" ? "danger" : signal.pressure === "healthy" ? "success" : "secondary"}>
                                  {marketPressureLabel(signal.pressure)}
                                </Badge>
                              </div>
                              <p className="mt-2 text-xs leading-5 text-muted-foreground">{signal.summary}</p>
                              <p className="mt-2 text-xs text-muted-foreground">
                                预算 {formatCurrency(signal.budget_allocation)} · 中位价 {signal.median_price === undefined ? "暂无" : formatCurrency(signal.median_price)} · 样本 {signal.priced_candidate_count} 件
                              </p>
                            </div>
                          ))}
                      </div>
                      {selectedSession.market_feedback.reallocation_suggestions.length > 0 ? (
                        <div className="rounded-[20px] border border-amber-200/70 bg-amber-50/70 p-4 text-sm">
                          <p className="font-medium">待确认的预算建议</p>
                          <div className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground">
                            {selectedSession.market_feedback.reallocation_suggestions.map((suggestion) => (
                              <p key={`${suggestion.from_module_id}-${suggestion.to_module_id}`}>
                                可考虑从「{suggestion.from_module_name}」向「{suggestion.to_module_name}」调配 {formatCurrency(suggestion.amount)}。{suggestion.reason}
                              </p>
                            ))}
                          </div>
                          <p className="mt-2 text-xs font-medium text-amber-800">当前未修改任何已确认预算。</p>
                        </div>
                      ) : null}
                    </CardContent>
                  </Card>

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
                              来源：{decision.source === "deepseek_runtime" ? "DeepSeek Runtime" : decision.source === "market_feedback" ? "市场反馈" : decision.source === "policy_fallback" ? "规则兜底" : decision.source} · 置信度：{decision.confidence} · {decision.consumed_at ? "已执行" : "待执行"} · {formatTime(decision.created_at)}
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
                            <div className="flex flex-wrap gap-2">
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
                              {(task.status === "failed" || task.status === "cancelled") && selectedSession.execution_mode === "local_executor" ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={busy}
                                  onClick={() => retryTask(task)}
                                >
                                  重新入队
                                </Button>
                              ) : null}
                            </div>
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

                  <Card className="section-card">
                    <CardHeader>
                      <CardTitle>执行器安全审计</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {runtimeMetrics?.device_audit_events?.length ? runtimeMetrics.device_audit_events.slice(0, 8).map((event) => {
                        const action = event.event_type === "executor.device_registered"
                          ? "注册设备"
                          : event.event_type === "executor.device_revoked"
                            ? "撤销设备"
                            : "变更权限";
                        const deviceName = typeof event.payload.device_name === "string" ? event.payload.device_name : "本地执行器";
                        return (
                          <div key={event.id} className="rounded-[18px] border border-border/80 bg-white p-3 text-sm shadow-sm">
                            <div className="flex items-center justify-between gap-3">
                              <p className="font-medium">{action} · {deviceName}</p>
                              <span className="text-xs text-muted-foreground">{formatTime(event.created_at)}</span>
                            </div>
                            <p className="mt-2 text-xs text-muted-foreground">事件：{event.event_type}</p>
                          </div>
                        );
                      }) : (
                        <div className="panel-muted p-4 text-sm text-muted-foreground">当前还没有设备权限审计记录。</div>
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
