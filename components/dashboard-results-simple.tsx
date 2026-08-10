"use client";

import { useState } from "react";
import { ArrowRight, CheckCircle2, ExternalLink, Loader2, RefreshCw, Search, ShoppingCart, Sparkles, Store, Wand2 } from "lucide-react";
import { AgentBrief } from "@/components/dashboard-common";
import { hasRealDetailUrl } from "@/components/dashboard-helpers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { HostedWorkerStatus, MpcStatus } from "@/components/dashboard-types";
import { formatCurrency } from "@/lib/utils";
import { getScenarioConfig } from "@/lib/scenarios";
import type {
  BudgetReallocationSuggestion,
  ProductCandidate,
  QuickAction,
  SessionState
} from "@/lib/session/types";

function ProductImage({ product }: { product: ProductCandidate }) {
  const [failed, setFailed] = useState(false);
  const imageUrl = product.image_url?.trim().replace(/^http:\/\//, "https://");

  if (!imageUrl || failed) {
    return (
      <div className="product-image-placeholder">
        <ShoppingCart className="h-6 w-6 text-primary/60" />
        <span>暂无商品图片</span>
      </div>
    );
  }

  return (
    <img
      src={imageUrl}
      alt={product.title}
      className="h-full w-full object-cover transition duration-500 hover:scale-[1.025]"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

export function ResultsPage({
  session,
  selectedModuleId,
  onSelectModule,
  selectedProducts,
  estimatedTotal,
  onQuickAction,
  onApplyBudgetSuggestion,
  onRecoverCompletionGaps,
  onImproveThinCandidates,
  onAcceptPurchaseBundle,
  onAddToCart,
  onProceedToCartReview,
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
  onApplyBudgetSuggestion: (suggestion: BudgetReallocationSuggestion) => void;
  onRecoverCompletionGaps: () => void;
  onImproveThinCandidates: () => void;
  onAcceptPurchaseBundle: () => void;
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
  const scenario = getScenarioConfig(session.scene_brief.scenario_id);
  const selectedModule = session.shopping_plan.modules.find((item) => item.module_id === selectedModuleId) ?? session.shopping_plan.modules[0];
  const selectedReview = session.module_reviews?.[selectedModuleId];
  const selectedModuleWaiting = session.hosted_tasks.some(
    (task) => task.task_type === "module_search" && task.module_id === selectedModuleId && (task.status === "pending" || task.status === "running")
  );
  const selectedBudgetSuggestion = session.market_feedback.reallocation_suggestions.find(
    (suggestion) => suggestion.from_module_id === selectedModuleId || suggestion.to_module_id === selectedModuleId
  );
  const completionReport = session.completion_report;
  const purchaseBundle = completionReport?.purchase_bundle;
  const refinementSuggestions = purchaseBundle?.refinement_suggestions ?? [];
  const suggestedActions = new Set(refinementSuggestions.map((suggestion) => suggestion.action));
  const resultTypes = new Set(selectedProducts.map((product) => product.recommendation_type)).size;
  const hasCompletionGaps = Boolean(
    completionReport && (completionReport.uncovered_module_ids.length > 0 || completionReport.thin_module_ids.length > 0)
  );

  const addToCartStateForProduct = (productId: string) => {
    const task = session.hosted_tasks.find((entry) => entry.task_type === "add_to_cart" && entry.product_id === productId);
    if (session.selected_items.some((item) => item.product_id === productId) || task?.status === "completed") return "success" as const;
    if (cartingProductId === productId || task?.status === "pending" || task?.status === "running") return "running" as const;
    if (task?.status === "failed") return "failed" as const;
    return "idle" as const;
  };

  return (
    <div className="space-y-4">
      <AgentBrief
        compact
        eyebrow="Agent 已完成筛选"
        title={`我为「${selectedModule?.module_name ?? "当前模块"}」留下了 ${selectedProducts.length} 个值得看的选择`}
        description={selectedReview?.summary || completionReport?.summary || selectedModule?.rationale || scenario.results_intro_text}
        highlights={[
          `模块预算 ${formatCurrency(selectedModule?.budget_allocation ?? 0)}`,
          `${resultTypes || 0} 种推荐方向`,
          session.selected_items.length > 0 ? `已选 ${session.selected_items.length} 件` : "还未加入购物车"
        ]}
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-4">
        <Card className="section-card overflow-hidden">
          <CardContent className="px-0 pb-0">
            <div className="result-heading">
              <div>
                <p className="label-text">为你筛选的商品</p>
                <h1 className="mt-2 text-2xl font-semibold tracking-tight">{scenario.results_page_title}</h1>
                <p className="mt-2 text-sm text-muted-foreground">先看 Agent 首选，也可以切换模块比较其他方案。</p>
              </div>
              <div className="rounded-[18px] bg-white px-4 py-3 text-right shadow-sm">
                <span className="text-xs text-muted-foreground">已选</span>
                <p className="mt-1 text-lg font-semibold">{session.selected_items.length} 件</p>
              </div>
            </div>
            <div className="module-tabs hide-scrollbar">
              {session.shopping_plan.modules.map((module) => {
                const count = (session.module_candidates[module.module_id] ?? []).length;
                return (
                  <button
                    key={module.module_id}
                    type="button"
                    className={`module-tab ${selectedModule?.module_id === module.module_id ? "module-tab-active" : ""}`}
                    onClick={() => onSelectModule(module.module_id)}
                  >
                    {module.module_name}<span>{count}</span>
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-3">
          {selectedProducts.map((product, index) => {
            const cartState = addToCartStateForProduct(product.product_id);
            return (
              <article key={product.product_id} className={`product-result-card ${index === 0 ? "product-result-card-featured" : ""}`}>
                <div className="product-image-frame">
                  {index === 0 ? <span className="product-ai-pick"><Sparkles className="h-3 w-3" />Agent 首选</span> : null}
                  <ProductImage product={product} />
                </div>
                <div className="flex min-w-0 flex-1 flex-col justify-between gap-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={index === 0 ? "default" : "secondary"}>{product.recommendation_type}</Badge>
                      {product.shop_badges.slice(0, 2).map((badge) => <Badge key={badge} variant="outline">{badge}</Badge>)}
                    </div>
                    <h2 className="mt-3 line-clamp-2 text-[16px] font-semibold leading-6 text-foreground md:text-[17px]">{product.title}</h2>
                    <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><Store className="h-3.5 w-3.5" />{product.shop_name}</div>
                    <p className="mt-3 text-[27px] font-semibold tracking-tight text-[#ef5b24]">{formatCurrency(product.price)}</p>
                    {product.highlights.length > 0 ? (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {product.highlights.slice(0, 4).map((item) => <span key={item} className="product-highlight">{item}</span>)}
                      </div>
                    ) : null}
                    <div className="product-fit-note"><Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" /><p><span>为什么适合你</span>{product.fit_reason}</p></div>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">风险提示：{product.risk_notes[0] ?? scenario.product_risk_style}</p>
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!hasRealDetailUrl(product.detail_url)}
                      onClick={() => hasRealDetailUrl(product.detail_url) && window.open(product.detail_url, "_blank", "noopener,noreferrer")}
                    >
                      <ExternalLink className="h-4 w-4" />{scenario.detail_button_text}
                    </Button>
                    <Button
                      size="sm"
                      disabled={(busy && cartingProductId !== product.product_id) || cartState === "running" || cartState === "success"}
                      onClick={() => onAddToCart(product)}
                    >
                      {cartState === "running" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShoppingCart className="h-4 w-4" />}
                      {cartState === "running" ? "正在加入" : cartState === "success" ? "已加入购物车" : cartState === "failed" ? "重新加入" : scenario.cart_button_text}
                    </Button>
                  </div>
                </div>
              </article>
            );
          })}

          {selectedProducts.length === 0 ? (
            <div className="empty-result-card">
              <Search className="h-7 w-7 text-primary/70" />
              <h2 className="mt-4 text-lg font-semibold">{selectedModuleWaiting ? "这个模块仍在搜索" : "这个模块暂时没有可用商品"}</h2>
              <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">{selectedModuleWaiting ? "结果完成后会自动保存，可以稍后刷新查看。" : "可以重新搜索当前模块，不会影响其他已经完成的推荐。"}</p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {!selectedModuleWaiting ? <Button onClick={() => onSearchModule(selectedModuleId, selectedReview?.suggested_keyword)} disabled={busy || !selectedModuleId}><Search className="h-4 w-4" />重新搜索</Button> : null}
                <Button variant="outline" onClick={onRefresh}><RefreshCw className="h-4 w-4" />刷新结果</Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <aside className="space-y-4 xl:sticky xl:top-5 xl:self-start">
        <Card className="section-card">
          <CardHeader><CardTitle>我的购物清单</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-end justify-between border-b border-border/60 pb-4">
              <div><p className="text-xs text-muted-foreground">已选商品</p><p className="mt-1 text-xl font-semibold">{session.selected_items.length} 件</p></div>
              <div className="text-right"><p className="text-xs text-muted-foreground">预计总价</p><p className="mt-1 text-xl font-semibold text-[#ef5b24]">{formatCurrency(estimatedTotal)}</p></div>
            </div>
            <Button className="w-full" disabled={session.selected_items.length === 0 || busy} onClick={onProceedToCartReview}>
              进入购买确认<ArrowRight className="h-4 w-4" />
            </Button>
          </CardContent>
        </Card>

        {purchaseBundle ? (
          <Card className="section-card border-primary/15">
            <CardHeader>
              <div className="flex items-start justify-between gap-2"><CardTitle>Agent 建议清单</CardTitle><Badge variant={purchaseBundle.status === "ready" ? "success" : "secondary"}>{purchaseBundle.items.length} 件</Badge></div>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm leading-6 text-muted-foreground">{purchaseBundle.summary}</p>
              <div className="rounded-[16px] bg-[#fff5ef] px-3 py-2 text-sm"><span className="text-muted-foreground">组合价</span><strong className="float-right text-[#ef5b24]">{formatCurrency(purchaseBundle.estimated_total)}</strong></div>
              {!session.bundle_adoption ? <Button className="w-full" variant="outline" disabled={busy || purchaseBundle.items.length === 0} onClick={onAcceptPurchaseBundle}><Sparkles className="h-4 w-4" />采用这套清单</Button> : <div className="flex items-center gap-2 text-sm font-medium text-emerald-700"><CheckCircle2 className="h-4 w-4" />已采用这套清单</div>}
            </CardContent>
          </Card>
        ) : null}

        {completionReport && hasCompletionGaps ? (
          <Card className="section-card">
            <CardHeader><div className="flex items-start justify-between gap-2"><CardTitle>还有可以补强的地方</CardTitle><Badge variant="secondary">可选</Badge></div></CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm leading-6 text-muted-foreground">{completionReport.summary}</p>
              {completionReport.uncovered_module_ids.length > 0 ? <Button className="w-full" size="sm" disabled={busy} onClick={onRecoverCompletionGaps}>补齐 {completionReport.uncovered_module_ids.length} 个缺口</Button> : null}
              {completionReport.thin_module_ids.length > 0 ? <Button className="w-full" size="sm" variant="outline" disabled={busy} onClick={onImproveThinCandidates}>优化薄弱推荐</Button> : null}
            </CardContent>
          </Card>
        ) : null}

        {selectedBudgetSuggestion ? (
          <Card className="section-card">
            <CardContent className="space-y-3 px-5 py-5">
              <p className="text-sm font-semibold">预算可以更合理</p>
              <p className="text-xs leading-5 text-muted-foreground">{selectedBudgetSuggestion.reason}</p>
              <Button className="w-full" size="sm" variant="outline" disabled={busy} onClick={() => onApplyBudgetSuggestion(selectedBudgetSuggestion)}>查看新规划</Button>
            </CardContent>
          </Card>
        ) : null}

        <Card className="section-card">
          <CardHeader><CardTitle>换个思路</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <p className="pb-1 text-xs leading-5 text-muted-foreground">调整后会先生成一版新规划，确认后再重新搜索，不会直接覆盖当前结果。</p>
            {refinementSuggestions.slice(0, 1).map((suggestion) => (
              <button key={suggestion.action} type="button" disabled={busy} onClick={() => onQuickAction(suggestion.action)} className="quick-adjust-row">
                <Wand2 className="h-4 w-4 shrink-0 text-primary" /><span><strong className="block text-sm">{suggestion.action}</strong><span className="mt-1 block text-xs leading-5 text-muted-foreground">{suggestion.reason}</span></span>
              </button>
            ))}
            <div className="flex flex-wrap gap-2 pt-1">
              {scenario.quick_actions.filter((action) => !suggestedActions.has(action)).slice(0, 4).map((action) => (
                <button key={action} type="button" disabled={busy} onClick={() => onQuickAction(action)} className="prompt-chip">{action}</button>
              ))}
            </div>
            {scenario.quick_actions.filter((action) => !suggestedActions.has(action)).length > 4 ? (
              <details className="pt-2 text-xs text-muted-foreground">
                <summary className="cursor-pointer font-medium hover:text-foreground">更多调整方式</summary>
                <div className="mt-3 flex flex-wrap gap-2">
                  {scenario.quick_actions.filter((action) => !suggestedActions.has(action)).slice(4).map((action) => (
                    <button key={action} type="button" disabled={busy} onClick={() => onQuickAction(action)} className="prompt-chip">{action}</button>
                  ))}
                </div>
              </details>
            ) : null}
          </CardContent>
        </Card>
      </aside>
      </div>
    </div>
  );
}
