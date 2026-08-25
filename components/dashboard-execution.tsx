"use client";

import Image from "next/image";
import { CheckCircle2, ExternalLink, Loader2, PackageCheck, Pause, Play, ShoppingCart, Store, Trash2 } from "lucide-react";
import { HostedInstructionCard, InfoBlock } from "@/components/dashboard-common";
import {
  hasRealDetailUrl,
  isHostedMode,
  isQueuedExecutionMode,
  isTaobaoSearchUrl,
  isTaobaoAuthenticationPause,
  isTaobaoCartAuthenticationPause
} from "@/components/dashboard-helpers";
import { deriveShoppingListView } from "@/components/dashboard-shopping-list";
import type { DashboardShoppingListItem, HostedWorkerStatus, MpcStatus } from "@/components/dashboard-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import type { ProductCandidate, SessionState } from "@/lib/session/types";
import { normalizeTaobaoImageUrl } from "@/lib/product-image";

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
            当前为本地执行器队列模式。网页请求结束后，淘宝 Skill 搜索仍会在本机后台运行，完成结果通过执行事件自动回填。
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
  session,
  mcpStatus,
  onBack,
  onRefresh,
  onAddToCart,
  onRemoveDemoItem,
  cartingProductId,
  busy,
  removingProductId,
  errorMessage,
  onOpenProductDetail,
  onOpenTaobaoCart
}: {
  session: SessionState;
  mcpStatus: MpcStatus | null;
  onBack: () => void;
  onRefresh: () => void;
  onAddToCart: (product: ProductCandidate) => void;
  onRemoveDemoItem: (item: DashboardShoppingListItem) => void;
  cartingProductId: string;
  busy: boolean;
  removingProductId: string;
  errorMessage: string;
  onOpenProductDetail?: (item: DashboardShoppingListItem) => void;
  onOpenTaobaoCart?: () => void;
}) {
  const shoppingList = deriveShoppingListView(session);
  const items = shoppingList.listItems;
  const taobaoItemCount = shoppingList.realAddedCount;
  const demoItemCount = shoppingList.demoAddedCount;
  const listTotal = items.reduce((total, item) => total + item.price, 0);
  const waitingCount = shoppingList.awaitingCount + shoppingList.failedCount;
  const cartAuthenticationPaused = isTaobaoAuthenticationPause(session)
    || isTaobaoCartAuthenticationPause(session, mcpStatus);

  return (
    <div className="workflow-content space-y-4">
      <section className="purchase-bundle-card" aria-labelledby="cart-review-title">
        <div className="grid gap-5 p-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-end md:p-6">
          <div className="flex items-start gap-3.5">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[15px] bg-primary text-white shadow-card" aria-hidden="true">
              <PackageCheck className="h-4 w-4" />
            </span>
            <div>
              <p className="agent-brief-eyebrow">购买确认</p>
              <h1 id="cart-review-title" className="mt-1.5 text-2xl font-semibold tracking-tight md:text-[28px]">
                {items.length > 0 ? `购物清单共 ${items.length} 件` : "购物清单还是空的"}
              </h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {items.length > 0
                  ? "待处理商品不会被误标为已加购；你可以在这里逐件确认，并查看淘宝真实回填进度。"
                  : "返回推荐页采用 Agent 清单或手动选择商品。"}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-[16px] bg-white/80 px-3 py-2.5 text-center"><strong className="block text-lg">{taobaoItemCount}</strong><span className="text-[10px] text-muted-foreground">淘宝已加购</span></div>
            <div className="rounded-[16px] bg-white/80 px-3 py-2.5 text-center"><strong className="block text-lg">{shoppingList.queuedCount}</strong><span className="text-[10px] text-muted-foreground">处理中</span></div>
            <div className="rounded-[16px] bg-white/80 px-3 py-2.5 text-center"><strong className="block text-lg">{waitingCount}</strong><span className="text-[10px] text-muted-foreground">待确认</span></div>
            <div className="rounded-[16px] bg-white/80 px-3 py-2.5 text-center"><strong className="block text-lg text-primary">{formatCurrency(listTotal)}</strong><span className="text-[10px] text-muted-foreground">清单估算</span></div>
          </div>
        </div>
      </section>

      {cartAuthenticationPaused ? (
        <div role="alert" className="rounded-[20px] border border-amber-200 bg-amber-50 px-5 py-4 text-sm leading-6 text-amber-900">
          <p>淘宝登录已失效，加购保持暂停。重新登录后刷新状态，再由你显式继续。</p>
          <Button type="button" className="mt-3" size="sm" variant="outline" onClick={onRefresh} disabled={busy}>
            重新登录后刷新状态
          </Button>
        </div>
      ) : null}

      {errorMessage ? (
        <div role="alert" aria-live="assertive" className="rounded-[20px] border border-red-200 bg-red-50 px-5 py-4 text-sm leading-6 text-red-700">
          {errorMessage}
        </div>
      ) : null}

      <Card className="section-card">
        <CardHeader className="flex-row items-end justify-between gap-4">
          <div><p className="label-text">逐件确认</p><CardTitle className="mt-2">我的购物清单</CardTitle></div>
          <p className="text-xs text-muted-foreground">真实已加购金额 {formatCurrency(shoppingList.realAddedTotal)}</p>
        </CardHeader>
        <CardContent className="space-y-3">
          {items.length === 0 ? (
            <div className="rounded-[22px] border border-dashed border-border/80 bg-white p-8 shadow-sm">
              <p className="text-lg font-semibold">当前还没有待处理商品</p>
              <p className="mt-3 text-sm leading-7 text-muted-foreground">
                返回推荐页采用 Agent 建议清单，或直接从任一分类手动加购。
              </p>
            </div>
          ) : (
            items.map((item) => {
              const running = item.status === "queued" || cartingProductId === item.product_id;
              const added = item.status === "added";
              const failed = item.status === "failed";
              const imageUrl = normalizeTaobaoImageUrl(item.image_url);
              return (
              <article key={item.product_id} className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 rounded-[20px] border border-border/75 bg-white p-3 shadow-sm sm:grid-cols-[112px_1fr] sm:gap-4 sm:p-4">
                {imageUrl ? (
                  <Image
                    src={imageUrl}
                    alt={item.title}
                    width={112}
                    height={112}
                    sizes="(min-width: 640px) 112px, 72px"
                    className="h-[72px] w-[72px] rounded-[14px] object-cover sm:h-28 sm:w-28 sm:rounded-[16px]"
                    unoptimized={imageUrl.endsWith(".svg")}
                  />
                ) : (
                  <div className="flex h-[72px] w-[72px] items-center justify-center rounded-[14px] bg-secondary/40 text-center text-[10px] text-muted-foreground sm:h-28 sm:w-28 sm:rounded-[16px] sm:text-xs">
                    暂无商品图片
                  </div>
                )}
                <div className="flex min-w-0 flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="secondary">{item.module_name ?? "已选商品"}</Badge>
                    <Badge variant={added ? "success" : failed ? "danger" : "outline"}>
                      {running ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : added ? <CheckCircle2 className="mr-1 h-3 w-3" /> : null}
                      {running ? "正在加购" : added ? item.cart_source === "demo" ? "演示清单" : "淘宝已加购" : failed ? "加购失败" : "待确认加购"}
                    </Badge>
                  </div>
                  <h2 className="line-clamp-2 text-base font-semibold leading-6">{item.title}</h2>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Store className="h-4 w-4" />
                    {item.shop_name ?? "淘宝店铺"}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <strong className="text-lg text-primary">{formatCurrency(item.price)}</strong>
                    {item.bundleItem?.reason ? <span className="hidden line-clamp-1 sm:inline">{item.bundleItem.reason}</span> : null}
                    {added ? <span>规格：{item.selected_spec ?? "以淘宝购物车为准"}</span> : null}
                  </div>
                  <div className="mt-auto flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full sm:w-auto"
                      disabled={!hasRealDetailUrl(item.detail_url)}
                      onClick={() => {
                        if (!hasRealDetailUrl(item.detail_url)) {
                          return;
                        }
                        if (onOpenProductDetail) onOpenProductDetail(item);
                        else window.open(item.detail_url, "_blank", "noopener,noreferrer");
                      }}
                    >
                      {isTaobaoSearchUrl(item.detail_url) ? "在淘宝搜索" : "查看商品页"}
                    </Button>
                    {added && item.cart_source === "demo" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        data-demo-target={`cart:remove:${item.product_id}`}
                        className="w-full sm:w-auto"
                        disabled={Boolean(removingProductId)}
                        onClick={() => onRemoveDemoItem(item)}
                      >
                        <Trash2 className="h-4 w-4" />
                        {removingProductId === item.product_id ? "正在移除" : "从演示清单移除"}
                      </Button>
                    ) : added ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full sm:w-auto"
                        onClick={() => onOpenTaobaoCart
                          ? onOpenTaobaoCart()
                          : window.open("https://cart.taobao.com/cart.htm", "_blank", "noopener,noreferrer")}
                      >
                        <ExternalLink className="h-4 w-4" />
                        在淘宝购物车中管理
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        className="w-full sm:w-auto"
                        disabled={!item.candidate || running || busy || cartAuthenticationPaused}
                        onClick={() => item.candidate && onAddToCart(item.candidate)}
                      >
                        {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShoppingCart className="h-4 w-4" />}
                        {running ? "正在加购" : failed ? "重新确认加购" : "确认加入购物车"}
                      </Button>
                    )}
                  </div>
                </div>
              </article>
              );
            })
          )}
          <div className="flex flex-col-reverse gap-2 border-t border-border/60 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <Button variant="outline" onClick={onBack}>返回上一步继续加购</Button>
            <Button
              disabled={taobaoItemCount === 0}
              onClick={() => onOpenTaobaoCart
                ? onOpenTaobaoCart()
                : window.open("https://cart.taobao.com/cart.htm", "_blank", "noopener,noreferrer")}
            >
              <ShoppingCart className="h-4 w-4" />
              {taobaoItemCount > 0 ? "打开淘宝购物车核对" : demoItemCount > 0 ? "当前仅有演示清单" : "还没有真实加购商品"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
