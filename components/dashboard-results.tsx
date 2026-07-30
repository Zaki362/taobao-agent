"use client";

import { ArrowRight, Loader2, Settings2, ShoppingCart, Sparkles, Store, Wand2 } from "lucide-react";
import { HostedInstructionCard, InfoBlock } from "@/components/dashboard-common";
import { quickActions } from "@/components/dashboard-config";
import { getExecutionModeLabel, hasRealDetailUrl, isHostedMode } from "@/components/dashboard-helpers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { HostedWorkerStatus, MpcStatus } from "@/components/dashboard-types";
import { formatCurrency } from "@/lib/utils";
import { ProductCandidate, QuickAction, SessionState } from "@/lib/session/types";

function renderProductImage(product: ProductCandidate) {
  if (product.image_url && product.image_url.trim()) {
    return (
      <img
        src={product.image_url}
        alt={product.title}
        className="h-44 w-full rounded-[22px] object-cover"
      />
    );
  }

  return (
    <div className="flex h-44 w-full items-center justify-center rounded-[22px] bg-secondary/50 text-sm text-muted-foreground">
      暂无商品图片
    </div>
  );
}

export function ResultsPage({
  session,
  selectedModuleId,
  onSelectModule,
  selectedProducts,
  estimatedTotal,
  onQuickAction,
  onAddToCart,
  onProceedToCartReview,
  expandedLogs,
  setExpandedLogs,
  mcpStatus,
  workerStatus,
  hostedInstruction,
  onRefresh,
  onSearchModule,
  cartingProductId,
  busy
}: {
  session: SessionState;
  selectedModuleId: string;
  onSelectModule: (moduleId: string) => void;
  selectedProducts: ProductCandidate[];
  estimatedTotal: number;
  onQuickAction: (action: QuickAction) => void;
  onAddToCart: (product: ProductCandidate) => void;
  onProceedToCartReview: () => void;
  expandedLogs: boolean;
  setExpandedLogs: (value: boolean) => void;
  mcpStatus: MpcStatus | null;
  workerStatus: HostedWorkerStatus | null;
  hostedInstruction: string;
  onRefresh: () => void;
  onSearchModule: (moduleId: string, keywordOverride?: string) => void;
  cartingProductId: string;
  busy: boolean;
}) {
  const hostedMode = isHostedMode(mcpStatus);
  const addToCartStateForProduct = (productId: string) => {
    const task = session.hosted_tasks.find(
      (entry) => entry.task_type === "add_to_cart" && entry.product_id === productId
    );
    const selected = session.selected_items.some((item) => item.product_id === productId);

    if (selected || task?.status === "completed") {
      return "success" as const;
    }
    if (cartingProductId === productId || task?.status === "pending" || task?.status === "running") {
      return "running" as const;
    }
    if (task?.status === "failed") {
      return "failed" as const;
    }
    return "idle" as const;
  };

  const selectedModule = session.shopping_plan.modules.find((item) => item.module_id === selectedModuleId);
  const selectedReview = session.module_reviews?.[selectedModuleId];
  const selectedTrace = session.module_search_traces?.[selectedModuleId];
  const selectedTypeCount = new Set(selectedProducts.map((product) => product.recommendation_type)).size;
  const sceneLabel = session.current_scene_label || session.scene_brief.scene_type || "当前场景";
  const aiPlanningLabel =
    session.deepseek_status === "connected"
      ? "已结合你的需求做个性化规划"
      : "已使用保守规划方案";

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-5">
        <Card className="section-card">
          <CardContent className="space-y-5 px-6 py-6">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-[24px] bg-secondary/50 px-4 py-4">
              <div>
                <p className="label-text">当前推荐模块</p>
                <p className="mt-2 text-xl font-semibold">{selectedModule?.module_name ?? "推荐结果"}</p>
              </div>
              <div className="flex flex-wrap gap-3">
                <div className="rounded-[18px] bg-white px-4 py-3 shadow-sm">
                  <p className="text-xs text-muted-foreground">模块预算</p>
                  <p className="mt-1 text-base font-semibold">{formatCurrency(selectedModule?.budget_allocation ?? 0)}</p>
                </div>
                <div className="rounded-[18px] bg-white px-4 py-3 shadow-sm">
                  <p className="text-xs text-muted-foreground">已选商品</p>
                  <p className="mt-1 text-base font-semibold">{session.selected_items.length} 件</p>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {session.shopping_plan.modules.map((module) => (
                <button
                  key={module.module_id}
                  className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                    selectedModuleId === module.module_id ? "bg-foreground text-white shadow-sm" : "border border-border/80 bg-white text-foreground hover:border-primary/25"
                  }`}
                  onClick={() => onSelectModule(module.module_id)}
                >
                  {module.module_name}
                </button>
              ))}
            </div>
            <div className="grid gap-4">
              {selectedProducts.map((product) => {
                const cartState = addToCartStateForProduct(product.product_id);

                return (
                  <div key={product.product_id} className="grid gap-5 rounded-[28px] border border-border/80 bg-white p-4 shadow-card md:grid-cols-[184px_1fr]">
                    {renderProductImage(product)}
                    <div className="flex flex-col justify-between gap-4">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge>{product.recommendation_type}</Badge>
                          {product.shop_badges.map((badge) => (
                            <Badge key={badge} variant="outline">{badge}</Badge>
                          ))}
                        </div>
                        <h3 className="mt-3 line-clamp-2 text-[17px] font-semibold leading-7">{product.title}</h3>
                        <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                          <Store className="h-4 w-4" />
                          {product.shop_name}
                        </div>
                        <p className="mt-4 text-[30px] font-semibold tracking-tight text-[#f25d23]">{formatCurrency(product.price)}</p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {product.highlights.map((item) => (
                            <span key={item} className="rounded-full bg-[#fff4ef] px-3 py-1 text-xs font-medium text-[#d9480f]">
                              {item}
                            </span>
                          ))}
                        </div>
                        <div className="mt-4 rounded-[18px] bg-secondary/35 px-4 py-3">
                          <p className="text-xs font-medium text-foreground">推荐理由</p>
                          <p className="mt-1 text-sm leading-7 text-muted-foreground">{product.fit_reason}</p>
                        </div>
                        <p className="mt-3 text-xs leading-6 text-muted-foreground">
                          风险提示：{product.risk_notes[0] ?? "当前为搜索结果摘要，建议点开淘宝详情页确认规格与适配性"}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-3">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!hasRealDetailUrl(product.detail_url)}
                          onClick={() => {
                            if (!hasRealDetailUrl(product.detail_url)) {
                              return;
                            }
                            window.open(product.detail_url, "_blank", "noopener,noreferrer");
                          }}
                        >
                          查看淘宝详情
                        </Button>
                        <Button
                          size="sm"
                          disabled={(busy && cartingProductId !== product.product_id) || cartState === "running" || cartState === "success"}
                          onClick={() => onAddToCart(product)}
                        >
                          {cartState === "running" ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <ShoppingCart className="mr-2 h-4 w-4" />
                          )}
                          {cartState === "running"
                            ? "加入购物车中"
                            : cartState === "success"
                              ? "加入购物车成功"
                              : cartState === "failed"
                                ? "重新加入购物车"
                                : "加入购物车"}
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
              {selectedProducts.length === 0 ? (
                <div className="rounded-[28px] border border-dashed border-border/80 bg-white p-8 shadow-sm">
                  <p className="text-lg font-semibold">{hostedMode ? "当前模块还在等待宿主回填结果" : "当前模块暂未返回可展示商品"}</p>
                  <p className="mt-3 text-sm leading-7 text-muted-foreground">
                    {hostedMode
                      ? "当前模式会把淘宝任务交给 Codex 宿主执行。你可以先刷新宿主结果，或查看右侧队列了解当前进度。"
                      : "当前模块还没有返回推荐。你可以只针对这个模块单独再搜一次，避免一次性触发过多搜索动作。"}
                  </p>
                  <div className="mt-4 flex flex-wrap gap-3">
                    {selectedReview?.suggested_keyword ? (
                      <Button onClick={() => onSearchModule(selectedModuleId, selectedReview.suggested_keyword)} disabled={busy || !selectedModuleId}>
                        {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                        按 Agent 建议补搜
                      </Button>
                    ) : null}
                    {!hostedMode ? (
                      <Button onClick={() => onSearchModule(selectedModuleId)} disabled={busy || !selectedModuleId}>
                        {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                        仅搜索当前模块
                      </Button>
                    ) : null}
                    <Button variant="outline" onClick={onRefresh}>{hostedMode ? "刷新宿主结果" : "刷新执行结果"}</Button>
                  </div>
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-5 xl:sticky xl:top-6">
        <Card className="section-card">
          <CardHeader>
            <CardTitle>当前摘要</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <InfoBlock label="场景" value={sceneLabel} />
            <InfoBlock label="已选商品" value={`${session.selected_items.length} 件`} />
            <InfoBlock label="预计总价" value={formatCurrency(estimatedTotal)} />
            <InfoBlock label="执行模式" value={getExecutionModeLabel(mcpStatus)} />
            <Button
              className="w-full"
              disabled={session.selected_items.length === 0 || busy}
              onClick={onProceedToCartReview}
            >
              <ArrowRight className="mr-2 h-4 w-4" />
              进入下单购买
            </Button>
          </CardContent>
        </Card>

        <Card className="section-card">
          <CardHeader>
            <CardTitle>推荐依据</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="panel-muted p-4 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">{aiPlanningLabel}</p>
              <p className="mt-2 leading-6">
                当前模块先按规划阶段生成的搜索意图找商品，再结合预算、偏好、店铺可信度和标题适配度挑出三个档位。
              </p>
            </div>
            {selectedReview ? (
              <div className="rounded-[22px] border border-primary/10 bg-[#fff8f3] p-4 text-sm text-muted-foreground">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium text-foreground">Agent 候选池评估</p>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="secondary">
                      {selectedReview.source === "deepseek" ? "DeepSeek 复盘" : "规则评估"}
                    </Badge>
                    <Badge variant="secondary">
                      {selectedReview.status === "ready"
                        ? "可继续"
                        : selectedReview.status === "thin"
                          ? "候选偏少"
                          : selectedReview.status === "needs_refine"
                            ? "建议调整"
                            : "需确认"}
                    </Badge>
                  </div>
                </div>
                <p className="mt-2 leading-6">{selectedReview.summary}</p>
                <p className="mt-2 text-xs leading-5">下一步：{selectedReview.next_action}</p>
                {selectedReview.suggested_keyword ? (
                  <p className="mt-1 text-xs leading-5">建议补搜：{selectedReview.suggested_keyword}</p>
                ) : null}
                {selectedReview.suggested_keyword ? (
                  <Button
                    className="mt-3"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => onSearchModule(selectedModuleId, selectedReview.suggested_keyword)}
                  >
                    <Sparkles className="mr-2 h-4 w-4" />
                    按建议补搜
                  </Button>
                ) : null}
              </div>
            ) : null}
            {selectedTrace ? (
              <div className="rounded-[22px] border border-border/80 bg-white p-4 text-sm shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium text-foreground">Agent 搜索决策轨迹</p>
                  <Badge variant={selectedTrace.status === "ready" ? "success" : selectedTrace.status === "failed" ? "danger" : "secondary"}>
                    {selectedTrace.status === "ready"
                      ? "结果可用"
                      : selectedTrace.status === "recovered"
                        ? "已补搜恢复"
                        : selectedTrace.status === "failed"
                          ? "搜索失败"
                          : "候选偏薄"}
                  </Badge>
                </div>
                <p className="mt-2 leading-6 text-muted-foreground">{selectedTrace.ai_decision_summary}</p>
                <div className="mt-3 grid gap-2 text-xs leading-5 text-muted-foreground">
                  <p>首轮关键词：{selectedTrace.primary_keyword}</p>
                  <p>已尝试：{selectedTrace.searched_keywords.join("、") || "等待执行"}</p>
                  <p>下一步：{selectedTrace.next_action}</p>
                </div>
                <details className="mt-3 rounded-[16px] bg-secondary/40 px-3 py-2">
                  <summary className="cursor-pointer text-xs font-medium text-foreground">查看关键词尝试明细</summary>
                  <div className="mt-2 space-y-2">
                    {selectedTrace.attempts.map((attempt, index) => (
                      <div key={`${attempt.keyword}-${index}`} className="text-xs leading-5 text-muted-foreground">
                        <span className="font-medium text-foreground">{attempt.keyword}</span>
                        <span className="mx-1">·</span>
                        <span>{attempt.status.toUpperCase()}</span>
                        <span className="mx-1">·</span>
                        <span>{attempt.result_count} 条</span>
                        <p className="mt-1">{attempt.reason}</p>
                      </div>
                    ))}
                  </div>
                </details>
              </div>
            ) : null}
            <InfoBlock label="模块搜索词" value={selectedModule?.search_keyword ?? selectedModule?.typical_item_types.slice(0, 3).join("、") ?? "等待生成"} />
            <InfoBlock label="AI 筛选重点" value={selectedModule?.search_strategy?.ranking_focus?.join("、") ?? "适配度、预算、店铺可信度"} />
            <InfoBlock label="优先包含" value={selectedModule?.search_strategy?.include_terms?.join("、") ?? selectedModule?.typical_item_types.slice(0, 3).join("、") ?? "等待生成"} />
            <InfoBlock label="AI 验收信号" value={selectedModule?.search_strategy?.must_have_signals?.join("、") ?? "功能明确、预算贴合、规格清楚"} />
            <InfoBlock label="AI 拒绝信号" value={selectedModule?.search_strategy?.reject_signals?.join("、") ?? "排除项、重复购买、低相关"} />
            <InfoBlock label="风险提醒" value={selectedReview?.caveats?.[0] ?? "当前为搜索摘要级判断，建议点开淘宝详情确认规格。"} />
            <InfoBlock label="推荐策略" value={selectedModule?.recommendation_strategy ?? "优先筛选适合当前阶段的高频实用品"} />
            <InfoBlock label="推荐档位" value={selectedProducts.length > 0 ? `${selectedTypeCount} 类 / ${selectedProducts.length} 件候选` : "等待候选商品"} />
          </CardContent>
        </Card>

        <Card className="section-card">
          <CardHeader>
            <CardTitle>快捷调整</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {quickActions.map((action) => (
              <Button key={action} variant="outline" size="sm" disabled={busy} onClick={() => onQuickAction(action)}>
                <Wand2 className="mr-2 h-4 w-4" />
                {action}
              </Button>
            ))}
          </CardContent>
        </Card>

        <Card className="section-card">
          <CardHeader>
            <CardTitle>{hostedMode ? "执行状态" : "执行摘要"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="panel-muted p-4 text-sm text-muted-foreground">
              <div className="flex items-center gap-2 font-medium text-foreground">
                <Settings2 className="h-4 w-4" />
                {hostedMode ? "已切换到 Codex 宿主代理执行" : "已切换到 Qoder CLI 直连执行"}
              </div>
              <p className="mt-2 leading-6">{mcpStatus?.message ?? "正在检测 MCP 工具状态"}</p>
            </div>
            {hostedMode ? (
              <>
                <div className={`rounded-[22px] p-4 text-sm ${
                  workerStatus?.online ? "bg-sky-50 text-sky-700" : "bg-amber-50 text-amber-800"
                }`}>
                  {workerStatus?.online
                    ? `宿主代理队列在线，状态：${workerStatus.state}${workerStatus.last_result ? `。最近回填：${workerStatus.last_result}` : ""}`
                    : "宿主代理队列当前离线。若任务长时间停留在 pending，请运行 npm run worker:codex -- watch"}
                </div>
                <div className="grid gap-3">
                  {session.hosted_tasks.slice(0, 6).map((task) => (
                    <div key={task.task_id} className="rounded-[18px] border border-border/80 bg-white p-3 text-sm shadow-sm">
                      <p className="font-medium">{task.title}</p>
                      <p className="mt-1 text-muted-foreground">{task.status.toUpperCase()} · {task.result_summary ?? task.description}</p>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="grid gap-3">
                {session.tool_logs.length > 0 ? (
                  session.tool_logs.slice(0, 6).map((log) => (
                    <div key={log.id} className="rounded-[18px] border border-border/80 bg-white p-3 text-sm shadow-sm">
                      <p className="font-medium">{log.module_name ? `[${log.module_name}] ` : ""}{log.tool_name}</p>
                      <p className="mt-1 text-muted-foreground">{log.output_summary}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{log.status.toUpperCase()} · {log.duration_ms}ms</p>
                    </div>
                  ))
                ) : (
                  <div className="rounded-[18px] border border-dashed border-border bg-white p-4 text-sm text-muted-foreground">
                    暂无执行日志。开始搜索或加购后，这里会展示工具调用摘要。
                  </div>
                )}
              </div>
            )}
            <details open={expandedLogs} onToggle={(event) => setExpandedLogs((event.target as HTMLDetailsElement).open)} className="subtle-card p-4">
              <summary className="cursor-pointer text-sm font-medium">{hostedMode ? "查看宿主日志" : "查看执行日志"}</summary>
              <div className="mt-3 space-y-3">
                {session.tool_logs.length > 0 ? (
                  session.tool_logs.slice(0, 12).map((log) => (
                    <div key={log.id} className="rounded-[18px] border border-border/80 bg-white p-3 text-sm shadow-sm">
                      <p className="font-medium">{log.module_name ? `[${log.module_name}] ` : ""}{log.tool_name}</p>
                      <p className="mt-1 text-muted-foreground">{log.output_summary}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{log.status.toUpperCase()} · {log.duration_ms}ms</p>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">暂无可展开日志。</p>
                )}
              </div>
            </details>
            <Button variant="outline" onClick={onRefresh}>{hostedMode ? "刷新宿主结果" : "刷新执行结果"}</Button>
            {hostedMode && hostedInstruction ? <HostedInstructionCard instruction={hostedInstruction} compact /> : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
