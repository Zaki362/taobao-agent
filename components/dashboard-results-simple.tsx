"use client";

import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Loader2,
  PackageCheck,
  RefreshCw,
  Search,
  ShoppingCart,
  Sparkles,
  Store
} from "lucide-react";
import {
  findCurrentTaobaoMcpEvidence,
  hasRealDetailUrl,
  isTaobaoCartAuthenticationPause,
  isTaobaoAuthenticationPause
} from "@/components/dashboard-helpers";
import { deriveShoppingListView } from "@/components/dashboard-shopping-list";
import type {
  DashboardShoppingListItem,
  HostedWorkerStatus,
  MpcStatus,
  ShoppingListItemStatus
} from "@/components/dashboard-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ProductCandidate, SessionState } from "@/lib/session/types";
import { getScenarioConfig } from "@/lib/scenarios";
import { formatCurrency } from "@/lib/utils";

function ProductImage({ product, className = "" }: { product: ProductCandidate; className?: string }) {
  const [failed, setFailed] = useState(false);
  const imageUrl = product.image_url?.trim().replace(/^http:\/\//, "https://");

  if (!imageUrl || failed) {
    return (
      <div className={`product-image-placeholder ${className}`}>
        <ShoppingCart className="h-6 w-6 text-primary/60" />
        <span>暂无商品图片</span>
      </div>
    );
  }

  return (
    <img
      src={imageUrl}
      alt={product.title}
      className={`h-full w-full object-cover transition duration-500 hover:scale-[1.025] ${className}`}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

function BundleItemImage({ item }: { item: DashboardShoppingListItem }) {
  const [failed, setFailed] = useState(false);
  const imageUrl = item.image_url?.trim().replace(/^http:\/\//, "https://");

  if (!imageUrl || failed) {
    return (
      <span className="flex h-full w-full items-center justify-center text-primary/60">
        <ShoppingCart className="h-4 w-4" />
      </span>
    );
  }

  return <img src={imageUrl} alt="" className="h-full w-full object-cover" onError={() => setFailed(true)} />;
}

function formatEvidenceTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(value));
}

function statusLabel(status: ShoppingListItemStatus, cartSource?: "taobao" | "demo") {
  if (status === "added") return cartSource === "demo" ? "演示已加" : "淘宝已加";
  if (status === "queued") return "加购中";
  if (status === "failed") return "加购失败";
  if (status === "awaiting_confirmation") return "待加购";
  return "Agent 建议";
}

function ShoppingStatusBadge({ item }: { item: DashboardShoppingListItem }) {
  const variant = item.status === "added"
    ? "success"
    : item.status === "failed"
      ? "danger"
      : item.status === "suggested"
        ? "secondary"
        : "outline";

  return (
    <Badge variant={variant} className="shrink-0 px-2.5 py-1 text-[10px]">
      {item.status === "queued" ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
      {statusLabel(item.status, item.cart_source)}
    </Badge>
  );
}

export function ResultsPage({
  session,
  selectedModuleId,
  onSelectModule,
  selectedProducts,
  onRecoverCompletionGaps,
  onAcceptPurchaseBundle,
  onAddToCart,
  onProceedToCartReview,
  onReturnToSearchProgress,
  mcpStatus,
  onRefresh,
  onSearchModule,
  cartingProductId,
  busy
}: {
  session: SessionState;
  selectedModuleId: string;
  onSelectModule: (moduleId: string) => void;
  selectedProducts: ProductCandidate[];
  onRecoverCompletionGaps: () => void;
  onAcceptPurchaseBundle: () => void;
  onAddToCart: (product: ProductCandidate) => void;
  onProceedToCartReview: () => void;
  onReturnToSearchProgress: () => void;
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
  const selectedModule = session.shopping_plan.modules.find((item) => item.module_id === selectedModuleId)
    ?? session.shopping_plan.modules[0];
  const selectedReview = session.module_reviews?.[selectedModuleId];
  const selectedModuleWaiting = session.hosted_tasks.some(
    (task) => task.task_type === "module_search"
      && task.module_id === selectedModuleId
      && (task.status === "pending" || task.status === "running")
  );
  const completionReport = session.completion_report;
  const purchaseBundle = completionReport?.purchase_bundle;
  const shoppingList = deriveShoppingListView(session);
  const authenticationPaused = isTaobaoAuthenticationPause(session);
  const cartAuthenticationPaused = isTaobaoCartAuthenticationPause(session, mcpStatus);
  const selectedTaobaoMcpEvidence = findCurrentTaobaoMcpEvidence(session, selectedModuleId);
  const gapCount = completionReport?.uncovered_module_ids.length ?? 0;
  const bundleAddedCount = shoppingList.bundleItems.filter(
    (item) => item.status === "added" && item.cart_source !== "demo"
  ).length;
  const bundleDemoCount = shoppingList.bundleItems.filter(
    (item) => item.status === "added" && item.cart_source === "demo"
  ).length;
  const bundleQueuedCount = shoppingList.bundleItems.filter((item) => item.status === "queued").length;
  const bundleFailedCount = shoppingList.bundleItems.filter((item) => item.status === "failed").length;
  const bundleAwaitingCount = shoppingList.bundleItems.filter((item) => item.status === "awaiting_confirmation").length;
  const bundleProgress = shoppingList.bundleItems.length > 0
    ? Math.round((bundleAddedCount / shoppingList.bundleItems.length) * 100)
    : 0;

  const shoppingItemForProduct = (productId: string) =>
    shoppingList.listItems.find((item) => item.product_id === productId)
    ?? shoppingList.bundleItems.find((item) => item.product_id === productId);

  return (
    <div className="workflow-content space-y-4">
      {authenticationPaused ? (
        <div role="alert" className="rounded-[20px] border border-amber-200 bg-amber-50 px-5 py-4 text-sm leading-6 text-amber-900">
          <p className="font-semibold">淘宝登录已暂停，当前展示已保存结果</p>
          <p className="mt-1">已有候选和清单不会丢失。恢复前可以浏览商品，但不会创建新的真实搜索或加购任务。</p>
          <Button type="button" className="mt-3" size="sm" variant="outline" onClick={onReturnToSearchProgress}>
            <ArrowLeft className="h-4 w-4" />返回搜索暂停页
          </Button>
        </div>
      ) : cartAuthenticationPaused ? (
        <div role="alert" className="rounded-[20px] border border-amber-200 bg-amber-50 px-5 py-4 text-sm leading-6 text-amber-900">
          <p className="font-semibold">淘宝登录已失效，加购已暂停</p>
          <p className="mt-1">已有候选仍可浏览。重新登录后刷新状态，再由你逐件确认加购。</p>
          <Button type="button" className="mt-3" size="sm" variant="outline" onClick={onRefresh} disabled={busy}>
            <RefreshCw className="h-4 w-4" />重新登录后刷新状态
          </Button>
        </div>
      ) : null}

      <section className="purchase-bundle-card" aria-labelledby="agent-bundle-title">
        <div className="space-y-5 p-5 md:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex min-w-0 items-start gap-3.5">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[15px] bg-primary text-white shadow-card" aria-hidden="true">
                <Sparkles className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="agent-brief-eyebrow">Agent 建议清单</p>
                  {purchaseBundle ? (
                    <Badge variant={shoppingList.bundleAdopted ? "success" : "secondary"}>
                      {shoppingList.bundleAdopted ? "已采用" : "待你确认"}
                    </Badge>
                  ) : null}
                </div>
                <h1 id="agent-bundle-title" className="mt-1.5 text-2xl font-semibold leading-tight tracking-tight md:text-[28px]">
                  {purchaseBundle
                    ? `我先为你选好了 ${shoppingList.bundleItems.length} 件`
                    : "候选结果已经整理完成"}
                </h1>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                  {purchaseBundle
                    ? `按你的 ${formatCurrency(purchaseBundle.total_budget)} 总预算组合，预计 ${formatCurrency(purchaseBundle.estimated_total)}。采用后仍由你逐件确认真实加购。`
                    : "可以从下方切换分类，比较候选并逐件加入淘宝购物车。"}
                </p>
              </div>
            </div>

            {purchaseBundle ? (
              <div className="grid shrink-0 grid-cols-3 gap-2 text-center sm:min-w-[300px]">
                <div className="rounded-[16px] bg-white/80 px-3 py-2.5">
                  <span className="block text-lg font-semibold">{shoppingList.bundleItems.length}</span>
                  <span className="text-[10px] text-muted-foreground">清单商品</span>
                </div>
                <div className="rounded-[16px] bg-white/80 px-3 py-2.5">
                  <span className="block text-lg font-semibold text-emerald-700">{bundleAddedCount}</span>
                  <span className="text-[10px] text-muted-foreground">真实已加购</span>
                </div>
                <div className="rounded-[16px] bg-white/80 px-3 py-2.5">
                  <span className="block text-lg font-semibold text-primary">{formatCurrency(shoppingList.bundleTotal)}</span>
                  <span className="text-[10px] text-muted-foreground">组合估算</span>
                </div>
              </div>
            ) : null}
          </div>

          {shoppingList.bundleItems.length > 0 ? (
            <div className="grid gap-2.5 md:grid-cols-2">
              {shoppingList.bundleItems.map((item) => (
                <button
                  key={item.product_id}
                  type="button"
                  className="purchase-bundle-item text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  onClick={() => onSelectModule(item.module_id)}
                  aria-label={`查看${item.module_name ?? "对应分类"}候选：${item.title}`}
                >
                  <span className="purchase-bundle-thumb"><BundleItemImage item={item} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-[10px] font-medium text-muted-foreground">
                      <span>{item.module_name ?? "推荐分类"}</span>
                      <span aria-hidden="true">·</span>
                      <strong className="text-primary">{formatCurrency(item.price)}</strong>
                    </span>
                    <span className="mt-1 block truncate text-sm font-medium text-foreground">{item.title}</span>
                  </span>
                  <ShoppingStatusBadge item={item} />
                </button>
              ))}
            </div>
          ) : null}

          {purchaseBundle ? (
            <div className="flex flex-col gap-4 border-t border-border/60 pt-4 lg:flex-row lg:items-center lg:justify-between">
              {shoppingList.bundleAdopted ? (
                <div className="min-w-0 flex-1" aria-live="polite">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-foreground">淘宝加购进度 {bundleAddedCount}/{shoppingList.bundleItems.length}</span>
                    <span className="text-muted-foreground">
                      {bundleQueuedCount > 0 ? `${bundleQueuedCount} 件处理中 · ` : ""}
                      {bundleDemoCount > 0 ? `${bundleDemoCount} 件仅演示 · ` : ""}
                      {bundleAwaitingCount + bundleFailedCount} 件待确认
                    </span>
                  </div>
                  <div className="purchase-progress-track mt-2">
                    <div className="purchase-progress-value" style={{ width: `${bundleProgress}%` }} />
                  </div>
                </div>
              ) : (
                <p className="text-xs leading-5 text-muted-foreground">采用清单只会保存待处理商品，不会批量操作淘宝，也不会下单支付。</p>
              )}
              <div className="flex flex-col gap-2 sm:flex-row">
                {gapCount > 0 ? (
                  <Button size="sm" variant="ghost" disabled={authenticationPaused || busy} onClick={onRecoverCompletionGaps}>
                    补齐 {gapCount} 个缺失分类
                  </Button>
                ) : null}
                {shoppingList.bundleAdopted ? (
                  <Button size="sm" onClick={onProceedToCartReview} disabled={shoppingList.listItems.length === 0 || busy}>
                    查看购物清单<ArrowRight className="h-4 w-4" />
                  </Button>
                ) : (
                  <Button size="sm" onClick={onAcceptPurchaseBundle} disabled={busy || shoppingList.bundleItems.length === 0}>
                    <PackageCheck className="h-4 w-4" />采用 Agent 建议清单
                  </Button>
                )}
              </div>
            </div>
          ) : shoppingList.listItems.length > 0 ? (
            <div className="flex justify-end border-t border-border/60 pt-4">
              <Button size="sm" onClick={onProceedToCartReview}>查看购物清单<ArrowRight className="h-4 w-4" /></Button>
            </div>
          ) : null}
        </div>
      </section>

      <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center">
        <div className="module-tabs hide-scrollbar min-w-0 flex-1" role="tablist" aria-label="商品分类">
          {session.shopping_plan.modules.map((module) => {
            const count = (session.module_candidates[module.module_id] ?? []).length;
            const active = selectedModule?.module_id === module.module_id;
            return (
              <button
                key={module.module_id}
                id={`product-module-tab-${module.module_id}`}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls="product-results-panel"
                className={`module-tab ${active ? "module-tab-active" : ""}`}
                onClick={() => onSelectModule(module.module_id)}
              >
                {module.module_name}<span>{count}</span>
              </button>
            );
          })}
        </div>
        {selectedTaobaoMcpEvidence ? (
          <p
            className="shrink-0 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] font-medium text-emerald-800"
            title={`${selectedTaobaoMcpEvidence.source_app} / ${selectedTaobaoMcpEvidence.tool} / Job ${selectedTaobaoMcpEvidence.job_id} / ${selectedTaobaoMcpEvidence.raw_result_count} 条`}
          >
            本次淘宝 MCP · {formatEvidenceTime(selectedTaobaoMcpEvidence.captured_at)} · 「{selectedTaobaoMcpEvidence.keyword}」
          </p>
        ) : null}
      </div>

      <div
        id="product-results-panel"
        className="product-result-grid"
        role="tabpanel"
        aria-labelledby={selectedModule ? `product-module-tab-${selectedModule.module_id}` : undefined}
      >
        {selectedProducts.map((product, index) => {
          const shoppingItem = shoppingItemForProduct(product.product_id);
          const effectiveStatus = cartingProductId === product.product_id ? "queued" : shoppingItem?.status;
          const productCartAuthenticationPaused = cartAuthenticationPaused;
          const added = effectiveStatus === "added";
          const demoAdded = added && shoppingItem?.cart_source === "demo";
          const queued = effectiveStatus === "queued";
          const failed = effectiveStatus === "failed";
          const awaiting = effectiveStatus === "awaiting_confirmation";

          return (
            <article key={product.product_id} className={`product-result-card ${index === 0 ? "product-result-card-featured" : ""}`}>
              <div className="product-image-frame">
                {index === 0 ? <span className="product-ai-pick"><Sparkles className="h-3 w-3" />Agent 首选</span> : null}
                <ProductImage product={product} />
              </div>
              <div className="flex flex-1 flex-col p-4">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant={index === 0 ? "default" : "secondary"}>{product.recommendation_type}</Badge>
                  {shoppingItem?.origin === "bundle" ? <ShoppingStatusBadge item={shoppingItem} /> : null}
                </div>
                <h2 className="mt-3 line-clamp-2 text-[15px] font-semibold leading-6 text-foreground">{product.title}</h2>
                <div className="mt-2 hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex"><Store className="h-3.5 w-3.5" />{product.shop_name}</div>
                <p className="mt-3 text-[25px] font-semibold tracking-tight text-[#ef5b24]">{formatCurrency(product.price)}</p>
                {product.highlights.length > 0 ? (
                  <div className="mt-2.5 hidden flex-wrap gap-1.5 sm:flex">
                    {product.highlights.slice(0, 2).map((item) => <span key={item} className="product-highlight">{item}</span>)}
                  </div>
                ) : null}
                <div className="product-fit-note hidden sm:flex"><Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" /><p className="line-clamp-2"><span>适合你的原因</span>{product.fit_reason}</p></div>
                <details className="mt-2 hidden text-[11px] leading-5 text-muted-foreground sm:block">
                  <summary className="cursor-pointer font-medium text-foreground/70">购买前确认</summary>
                  <p className="mt-1">{product.risk_notes[0] ?? scenario.product_risk_style}</p>
                </details>
                <div className="mt-auto grid grid-cols-1 gap-2 pt-4 sm:grid-cols-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!hasRealDetailUrl(product.detail_url)}
                    onClick={() => hasRealDetailUrl(product.detail_url) && window.open(product.detail_url, "_blank", "noopener,noreferrer")}
                  >
                    <ExternalLink className="h-4 w-4" />淘宝详情
                  </Button>
                  <Button
                    size="sm"
                    disabled={authenticationPaused || productCartAuthenticationPaused || (busy && cartingProductId !== product.product_id) || queued || added}
                    title={authenticationPaused || productCartAuthenticationPaused
                      ? "请先恢复淘宝登录，再显式创建真实加购任务"
                      : demoAdded
                        ? "当前仅在产品内演示清单中，尚未加入淘宝购物车"
                        : undefined}
                    onClick={() => onAddToCart(product)}
                  >
                    {queued ? <Loader2 className="h-4 w-4 animate-spin" /> : added ? <CheckCircle2 className="h-4 w-4" /> : <ShoppingCart className="h-4 w-4" />}
                    {queued
                      ? "正在加购"
                      : added
                        ? demoAdded ? "演示清单" : "淘宝已加"
                        : authenticationPaused
                          ? "登录后加购"
                          : productCartAuthenticationPaused
                            ? "加购已暂停"
                            : failed
                              ? "重新加入"
                              : awaiting
                                ? "确认加购"
                                : "加入购物车"}
                  </Button>
                </div>
              </div>
            </article>
          );
        })}

        {selectedProducts.length === 0 ? (
          <div className="empty-result-card md:col-span-2 lg:col-span-3">
            <Search className="h-7 w-7 text-primary/70" />
            <h2 className="mt-4 text-lg font-semibold">{authenticationPaused ? "这个分类尚未完成真实搜索" : selectedModuleWaiting ? "这个分类仍在搜索" : "这个分类暂时没有可用商品"}</h2>
            <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">{authenticationPaused ? "恢复淘宝登录后，可以从搜索暂停页继续。" : selectedModuleWaiting ? "结果完成后会自动保存，可以稍后刷新查看。" : "只补搜当前分类，不会影响已经保存的其他候选。"}</p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {!selectedModuleWaiting ? (
                <Button onClick={() => onSearchModule(selectedModuleId, selectedReview?.suggested_keyword)} disabled={authenticationPaused || busy || !selectedModuleId}>
                  <Search className="h-4 w-4" />{authenticationPaused ? "恢复登录后搜索" : "补搜这个分类"}
                </Button>
              ) : null}
              <Button variant="outline" onClick={onRefresh}><RefreshCw className="h-4 w-4" />刷新结果</Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
