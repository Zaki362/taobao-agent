"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Activity, Database, RefreshCcw, ShoppingCart, Sparkles, Store } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SessionState } from "@/lib/session/types";
import { formatCurrency } from "@/lib/utils";

type SessionListResponse = {
  sessions: SessionState[];
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

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : response.statusText);
  }

  return payload as T;
}

function executionModeLabel(mode: SessionState["execution_mode"]) {
  if (mode === "qoder_cli") return "Qoder CLI 直连";
  if (mode === "codex_hosted") return "Codex 宿主代理";
  return "实验性本地桥接";
}

function formatTime(value?: string | null) {
  if (!value) return "暂无";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
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

  async function loadData() {
    setBusy(true);
    setErrorMessage("");
    try {
      const [sessionData, workerData] = await Promise.all([
        jsonFetch<SessionListResponse>("/api/sessions"),
        jsonFetch<HostedWorkerStatus>("/api/hosted/worker-status").catch(() => null)
      ]);
      setSessions(Array.isArray(sessionData.sessions) ? sessionData.sessions : []);
      setWorkerStatus(workerData);
      setSelectedSessionId((current) => current || sessionData.sessions?.[0]?.session_id || "");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "加载后端执行详情失败");
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
          workerStatus?.online ? "border border-sky-200 bg-sky-50 text-sky-700" : "border border-emerald-200 bg-emerald-50 text-emerald-700"
        }`}>
          {workerStatus?.online
            ? `后台执行器在线，状态：${workerStatus.state}，最近动作：${workerStatus.last_result ?? "暂无"}`
            : "当前主要通过产品后端直连执行。若后续切换到宿主模式，这里会显示宿主执行器状态。"}
        </div>

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
                    <CardTitle>当前购物规划</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
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
                  <Card className="section-card">
                    <CardHeader>
                      <CardTitle>执行进度</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {selectedSession.hosted_tasks.length > 0 ? selectedSession.hosted_tasks.slice(0, 8).map((task) => (
                        <div key={task.task_id} className="rounded-[18px] border border-border/80 bg-white p-3 text-sm shadow-sm">
                          <p className="font-medium">{task.title}</p>
                          <p className="mt-1 text-muted-foreground">{task.description}</p>
                          <p className="mt-1 text-xs text-muted-foreground">{task.status.toUpperCase()} · {formatTime(task.updated_at)}</p>
                        </div>
                      )) : (
                        <div className="panel-muted p-4 text-sm text-muted-foreground">
                          当前会话没有宿主任务，主要依靠后端直连执行。
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  <Card className="section-card">
                    <CardHeader>
                      <CardTitle>执行细节日志</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {selectedSession.tool_logs.slice(0, 12).map((log) => (
                        <div key={log.id} className="rounded-[18px] border border-border/80 bg-white p-3 text-sm shadow-sm">
                          <div className="flex items-center justify-between gap-3">
                            <p className="font-medium">{log.module_name ? `[${log.module_name}] ` : ""}{log.tool_name}</p>
                            <span className="text-xs text-muted-foreground">{log.status.toUpperCase()} · {log.duration_ms}ms</span>
                          </div>
                          <p className="mt-2 text-xs text-muted-foreground">输入：{log.input_summary}</p>
                          <p className="mt-1 text-xs text-muted-foreground">输出：{log.output_summary}</p>
                        </div>
                      ))}
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
