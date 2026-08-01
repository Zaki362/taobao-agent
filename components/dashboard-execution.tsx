"use client";

import { ExternalLink, Pause, Play, ShoppingCart, Store, Trash2 } from "lucide-react";
import { HostedInstructionCard, InfoBlock } from "@/components/dashboard-common";
import { hasRealDetailUrl, isHostedMode, isQueuedExecutionMode } from "@/components/dashboard-helpers";
import { CartReviewItem, HostedWorkerStatus, MpcStatus } from "@/components/dashboard-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { SessionState } from "@/lib/session/types";

export function SearchSummaryPage({
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
  const hostedMode = isHostedMode(mcpStatus);
  const queuedMode = isQueuedExecutionMode(mcpStatus);
  const serverWorkflowActive =
    mcpStatus?.mode === "local_executor" &&
    (session.agent_runtime.workflow_status === "running" ||
      session.agent_runtime.workflow_status === "waiting_for_tools");
  const traceCount = Object.keys(session.module_search_traces ?? {}).length;
  const recentDecisions = [...session.agent_decisions].reverse().slice(0, 8);
  const canControlServerWorkflow = mcpStatus?.mode === "local_executor";
  const workflowPaused = session.agent_runtime.workflow_status === "paused";

  return (
    <Card className="section-card">
      <CardHeader>
        <CardTitle>搜索执行摘要</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-3">
          {queuedMode ? (
            <>
              <InfoBlock label="已提交任务" value={`${session.hosted_tasks.length} 个`} />
              <InfoBlock label="待执行 / 运行中" value={`${pendingCount} 个`} />
              <InfoBlock label="已回填结果" value={`${completedCount} 个`} />
            </>
          ) : (
            <>
              <InfoBlock label="已完成模块" value={`${session.shopping_plan.modules.filter((module) => (session.module_candidates[module.module_id] ?? []).length > 0).length} 个`} />
              <InfoBlock label="候选商品" value={`${Object.values(session.module_candidates).reduce((sum, list) => sum + list.length, 0)} 个`} />
              <InfoBlock label="AI 决策轨迹" value={`${traceCount} 个模块`} />
            </>
          )}
        </div>
        <div className="space-y-2">
          {searchSummary.length > 0 ? (
            searchSummary.map((item, index) => (
              <div key={`${index}-${item}`} className="panel-muted px-4 py-3 text-sm text-muted-foreground">
                {item}
              </div>
            ))
          ) : (
            <div className="panel-muted px-4 py-3 text-sm text-muted-foreground">
              搜索任务刚开始，模块结果会按顺序追加到这里。
            </div>
          )}
        </div>
        <details className="subtle-card p-4">
          <summary className="cursor-pointer text-sm font-medium">查看本轮 Agent 决策与 AI 搜索策略</summary>
          {recentDecisions.length > 0 ? (
            <div className="mt-3 space-y-2">
              {recentDecisions.map((decision) => (
                <div key={decision.decision_id} className="rounded-[16px] border border-primary/10 bg-primary/[0.035] px-3 py-2 text-xs leading-5 text-muted-foreground">
                  <p className="font-medium text-foreground">
                    {decision.module_name ? `[${decision.module_name}] ` : ""}
                    {decision.action === "search_module" ? "开始搜索" :
                      decision.action === "retry_module" ? "建议补搜" :
                        decision.action === "skip_module" ? "容错跳过" :
                          decision.action === "wait_for_tools" ? "等待工具" : "结束本轮"}
                  </p>
                  <p>{decision.reason}</p>
                  <p className="mt-1 text-[11px]">依据：{decision.source} · 置信度 {decision.confidence}</p>
                </div>
              ))}
            </div>
          ) : null}
          <div className="mt-3 rounded-[18px] border border-primary/10 bg-[#fff8f3] px-4 py-3 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">计划级执行简报</p>
            <p className="mt-2">
              搜索顺序：{session.shopping_plan.execution_strategy.module_sequence
                .map((moduleId) => session.shopping_plan.modules.find((module) => module.module_id === moduleId)?.module_name)
                .filter(Boolean)
                .join(" → ") || "按模块优先级串行执行"}
            </p>
            <p className="mt-1 text-xs leading-5">
              {session.shopping_plan.execution_strategy.search_notes[0] ?? "先返回商品摘要，再由用户决定是否进入详情。"}
            </p>
            <div className="mt-3 grid gap-2 text-xs leading-5 md:grid-cols-2">
              <p>自主级别：{session.shopping_plan.agent_directives.autonomy_level} · {session.shopping_plan.agent_directives.search_depth}</p>
              <p>失败恢复：{session.shopping_plan.agent_directives.recovery_policy}</p>
              <p>详情策略：{session.shopping_plan.agent_directives.detail_policy}</p>
              <p>确认边界：{session.shopping_plan.agent_directives.user_confirmation_points.slice(0, 2).join("；")}</p>
            </div>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {session.shopping_plan.modules.map((module) => (
              <div key={module.module_id} className="rounded-[18px] border border-border/70 bg-white px-4 py-3 text-sm shadow-sm">
                {(() => {
                  const trace = session.module_search_traces?.[module.module_id];
                  return trace ? (
                    <div className="mb-3 rounded-[14px] bg-secondary/45 px-3 py-2 text-xs leading-5 text-muted-foreground">
                      <p className="font-medium text-foreground">Agent 决策：{trace.ai_decision_summary}</p>
                      <p className="mt-1">尝试关键词：{trace.searched_keywords.join("、") || "等待执行"}</p>
                    </div>
                  ) : null;
                })()}
                <p className="font-medium">{module.module_name}</p>
                <p className="mt-2 text-muted-foreground">
                  搜索词：{module.search_strategy?.primary_keyword || module.search_keyword || module.typical_item_types.slice(0, 3).join("、")}
                </p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  备用词：{module.search_strategy?.alternate_keywords?.join("、") || "暂无备用词"}
                </p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  排序重点：{module.search_strategy?.ranking_focus?.join("、") || "适配度、预算、店铺可信度"}
                </p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  验收信号：{module.search_strategy?.must_have_signals?.join("、") || "功能明确、预算贴合、规格清楚"}
                </p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  恢复策略：{module.search_strategy?.failure_recovery || "首轮结果为空时换用更具体品类词。"}
                </p>
              </div>
            ))}
          </div>
        </details>
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
        ) : mcpStatus?.mode === "local_executor" ? (
          <div className="rounded-[22px] bg-emerald-50 p-4 text-sm text-emerald-700">
            当前为本地执行器队列模式。网页请求结束后 Qoder/Taobao 任务仍会在后台运行，完成结果通过执行事件自动回填。
          </div>
        ) : (
          <div className="rounded-[22px] bg-sky-50 p-4 text-sm text-sky-700">
            当前为 Qoder 直连执行模式。搜索、详情提取与加购动作会直接由 Qoder 调起已安装的淘宝 skill 执行，不经过宿主任务队列。
          </div>
        )}
        <details open={expandedLogs} onToggle={(event) => setExpandedLogs((event.target as HTMLDetailsElement).open)} className="subtle-card p-4">
          <summary className="cursor-pointer text-sm font-medium">查看执行轨迹</summary>
          <div className="mt-3 space-y-3">
            {queuedMode
              ? session.hosted_tasks.slice(0, 8).map((task) => (
                  <div key={task.task_id} className="rounded-[18px] border border-border/80 bg-white p-3 text-sm shadow-sm">
                    <p className="font-medium">{task.module_name ? `[${task.module_name}] ` : ""}{task.title}</p>
                    <p className="mt-1 text-muted-foreground">{task.description}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{task.status.toUpperCase()} · {task.updated_at}</p>
                  </div>
                ))
              : null}
            {session.tool_logs.length > 0 ? (
              session.tool_logs.slice(0, 12).map((log) => (
                <div key={log.id} className="rounded-[18px] border border-border/80 bg-white p-3 text-sm shadow-sm">
                  <p className="font-medium">{log.module_name ? `[${log.module_name}] ` : ""}{log.tool_name}</p>
                  <p className="mt-1 text-muted-foreground">{log.input_summary}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{log.status.toUpperCase()} · {log.duration_ms}ms</p>
                  <p className="mt-1 text-xs text-muted-foreground">{log.output_summary}</p>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">暂无工具执行日志，完成首个模块搜索后会自动出现。</p>
            )}
          </div>
        </details>
        {hostedMode && hostedInstruction ? (
          <HostedInstructionCard instruction={hostedInstruction} />
        ) : null}
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" onClick={onRefresh}>{hostedMode ? "刷新宿主结果" : "刷新执行结果"}</Button>
          <Button variant="outline" onClick={() => setExpandedLogs(!expandedLogs)}>查看执行过程</Button>
          {canControlServerWorkflow && serverWorkflowActive ? (
            <Button
              variant="outline"
              onClick={onPauseWorkflow}
              disabled={workflowControlBusy}
            >
              <Pause className="h-4 w-4" />
              {workflowControlBusy ? "正在暂停" : "完成当前模块后暂停"}
            </Button>
          ) : null}
          {canControlServerWorkflow && workflowPaused ? (
            <Button
              variant="outline"
              onClick={onResumeWorkflow}
              disabled={workflowControlBusy || busy}
            >
              <Play className="h-4 w-4" />
              {workflowControlBusy ? "正在恢复" : "从当前进度继续"}
            </Button>
          ) : null}
          <Button onClick={onViewResults} disabled={busy || serverWorkflowActive}>
            {serverWorkflowActive ? "后台仍在搜索" : workflowPaused ? "查看已有推荐" : "查看推荐结果"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function CartReviewPage({
  items,
  total,
  onBack,
  onRemoveDemoItem,
  removingProductId
}: {
  items: CartReviewItem[];
  total: number;
  onBack: () => void;
  onRemoveDemoItem: (item: CartReviewItem) => void;
  removingProductId: string;
}) {
  const hasTaobaoCartItems = items.some((item) => item.cart_source !== "demo");
  const taobaoItemCount = items.filter((item) => item.cart_source !== "demo").length;
  const demoItemCount = items.length - taobaoItemCount;

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
                    {item.cart_source === "demo" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={Boolean(removingProductId)}
                        onClick={() => onRemoveDemoItem(item)}
                      >
                        <Trash2 className="h-4 w-4" />
                        {removingProductId === item.product_id ? "正在移除" : "从演示清单移除"}
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => window.open("https://cart.taobao.com/cart.htm", "_blank", "noopener,noreferrer")}
                      >
                        <ExternalLink className="h-4 w-4" />
                        在淘宝购物车中管理
                      </Button>
                    )}
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
            演示项可以直接从本页移除；真实淘宝商品必须前往淘宝购物车管理，本产品不会伪装删除或影响购物车里的其他商品。
          </div>
        </CardContent>
      </Card>

      <Card className="section-card xl:sticky xl:top-6">
        <CardHeader>
          <CardTitle>下单摘要</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <InfoBlock label="已加购商品" value={`${items.length} 件`} />
          <InfoBlock label="淘宝真实加购" value={`${taobaoItemCount} 件`} />
          <InfoBlock label="产品内演示项" value={`${demoItemCount} 件`} />
          <InfoBlock label="清单估算总价" value={formatCurrency(total)} />
          <InfoBlock
            label="当前状态"
            value={taobaoItemCount > 0
              ? "可前往淘宝确认规格与结算"
              : demoItemCount > 0
                ? "当前只有演示清单，尚未真实加购"
                : "请先从推荐页加入商品"}
          />
        </CardContent>
      </Card>
    </div>
  );
}
