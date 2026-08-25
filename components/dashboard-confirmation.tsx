"use client";

import { useEffect, useState } from "react";
import { ArrowRight, CheckCircle2, ChevronLeft, Loader2, Search, WalletCards } from "lucide-react";
import {
  AgentBrief,
  EditableBudgetField,
  EditableChoiceField,
  EditableTagField
} from "@/components/dashboard-common";
import { buildSceneInputFromBrief } from "@/components/dashboard-helpers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PriorityStyle, SessionState } from "@/lib/session/types";
import { getScenarioConfig } from "@/lib/scenarios";
import { formatCurrency } from "@/lib/utils";
import type { AgentDirectiveProfile } from "@/lib/agent/directives";
import { API_INPUT_LIMITS } from "@/lib/api/input-limits";

function toggleMultiValue(list: string[], value: string) {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function getPriorityTone(priority: number) {
  if (priority <= 1) return "优先购买";
  if (priority === 2) return "建议购买";
  if (priority === 3) return "按需补充";
  return "后续考虑";
}

function getPriorityVariant(priority: number) {
  if (priority <= 1) return "success" as const;
  if (priority === 2) return "secondary" as const;
  return "outline" as const;
}

function getBudgetReason(module: SessionState["shopping_plan"]["modules"][number], totalBudget: number) {
  const ratio = totalBudget > 0 ? Math.round((module.budget_allocation / totalBudget) * 100) : 0;
  if (module.priority <= 1) return `高频且影响基础使用，优先保障，约占总预算 ${ratio}%。`;
  if (module.priority === 2) return `兼顾实用与体验，在核心需求后安排，约占 ${ratio}%。`;
  if (module.priority === 3) return `有明确使用场景再购买，暂留约 ${ratio}% 预算。`;
  return `非首阶段必需，预算充足时再考虑，约占 ${ratio}%。`;
}

const agentProfileOptions: Array<{ profile: AgentDirectiveProfile; title: string; description: string }> = [
  { profile: "conservative", title: "稳妥", description: "优先稳定结果，减少额外补搜" },
  { profile: "balanced", title: "平衡", description: "结果不足时自动补搜一次" },
  { profile: "exploratory", title: "探索", description: "扩大搜索范围，寻找更多候选" }
];

function profileFromDirectives(directives: SessionState["shopping_plan"]["agent_directives"]): AgentDirectiveProfile {
  if (directives.autonomy_level === "保守执行") return "conservative";
  if (directives.autonomy_level === "探索执行") return "exploratory";
  return "balanced";
}

export function ConfirmScenePage({
  scene,
  onSceneChange,
  onSceneInputChange,
  onBack,
  onConfirm,
  busy,
  statusMessage
}: {
  scene: SessionState["scene_brief"];
  onSceneChange: (scene: SessionState["scene_brief"]) => void;
  onSceneInputChange: (value: string) => void;
  onBack: () => void;
  onConfirm: () => void;
  busy: boolean;
  statusMessage: string;
  expandedModel: boolean;
  setExpandedModel: (value: boolean) => void;
}) {
  const scenario = getScenarioConfig(scene.scenario_id);
  const options = scenario.field_option_sets;
  const excludedSummary = scene.avoid_items.length > 0 ? `暂不考虑${scene.avoid_items.slice(0, 2).join("、")}` : "没有额外排除项";
  const updateScene = (patch: Partial<SessionState["scene_brief"]>) => {
    const next = { ...scene, ...patch };
    onSceneChange(next);
    onSceneInputChange(buildSceneInputFromBrief(next));
  };

  return (
    <div className="workflow-content space-y-4">
      <AgentBrief
        compact
        eyebrow="我对需求的理解"
        title={`${scene.vehicle_type} · ${scene.user_stage}，预算 ${formatCurrency(scene.budget)}`}
        description={`${statusMessage} 我会以「${scene.priority_style}」作为取舍标准，${excludedSummary}。`}
      />
      <Card className="section-card w-full">
        <CardHeader className="px-6 pt-7 md:px-8 md:pt-8">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="label-text">需要你确认</p>
              <CardTitle className="mt-2 text-2xl">{scenario.confirm_scene_title}</CardTitle>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">点击任一选项即可修正，我会使用更新后的信息重新组织方案。</p>
            </div>
            <Badge variant="success"><CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />可直接编辑</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-6 px-6 pb-7 pt-6 md:px-8 md:pb-8">
          <div className="grid gap-4 md:grid-cols-2">
            <EditableChoiceField label={scenario.field_labels.vehicle_type} value={scene.vehicle_type} options={options.vehicle_type ?? [scene.vehicle_type]} onSelect={(value) => updateScene({ vehicle_type: value })} />
            <EditableBudgetField label={scenario.field_labels.budget} value={scene.budget} onChange={(value) => updateScene({ budget: value })} />
            <EditableChoiceField label={scenario.field_labels.priority_style} value={scene.priority_style} options={options.priority_style ?? [scene.priority_style]} onSelect={(value) => updateScene({ priority_style: value as PriorityStyle })} />
            <EditableChoiceField label={scenario.field_labels.user_stage} value={scene.user_stage} options={options.user_stage ?? [scene.user_stage]} onSelect={(value) => updateScene({ user_stage: value })} />
            <EditableTagField label={scenario.field_labels.avoid_items} selected={scene.avoid_items} options={options.avoid_items ?? []} emptyLabel="暂无排除项" onToggle={(value) => updateScene({ avoid_items: toggleMultiValue(scene.avoid_items, value) })} />
            <EditableTagField label={scenario.field_labels.already_have} selected={scene.already_have} options={options.already_have ?? []} emptyLabel="暂无已有物品" onToggle={(value) => updateScene({ already_have: toggleMultiValue(scene.already_have, value) })} />
          </div>
          <div className="flex flex-col-reverse gap-3 border-t border-border/60 pt-5 sm:flex-row sm:justify-between">
            <Button variant="ghost" onClick={onBack}><ChevronLeft className="h-4 w-4" />返回修改原需求</Button>
            <Button data-demo-target="scene:confirm" onClick={onConfirm} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
              确认无误，生成购买路线
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function ConfirmPlanPage({
  session,
  onBack,
  onAdjust,
  onAgentProfileChange,
  onSearchStrategyChange,
  onConfirm,
  busy
}: {
  session: SessionState;
  onBack: () => void;
  onAdjust: () => void;
  onAgentProfileChange: (profile: AgentDirectiveProfile) => void;
  onSearchStrategyChange: (
    moduleId: string,
    payload: { primaryKeyword: string; alternateKeywords: string[] }
  ) => Promise<void>;
  onConfirm: () => void;
  busy: boolean;
  expandedModel: boolean;
  setExpandedModel: (value: boolean) => void;
}) {
  const scenario = getScenarioConfig(session.scene_brief.scenario_id);
  const modules = session.shopping_plan.modules;
  const totalAllocated = modules.reduce((sum, module) => sum + module.budget_allocation, 0);
  const topModules = modules.filter((module) => module.priority <= 2).map((module) => module.module_name).slice(0, 3);
  const refinementImpact = session.last_refinement;
  const selectedAgentProfile = profileFromDirectives(session.shopping_plan.agent_directives);
  const [draftStrategies, setDraftStrategies] = useState<Record<string, string>>({});
  const [savingModuleId, setSavingModuleId] = useState("");

  useEffect(() => {
    setDraftStrategies(Object.fromEntries(modules.map((module) => [
      module.module_id,
      module.search_strategy?.primary_keyword || module.search_keyword || ""
    ])));
  }, [session.session_id, modules]);

  async function saveSearchTask(moduleId: string) {
    const primaryKeyword = draftStrategies[moduleId]?.trim();
    const module = modules.find((item) => item.module_id === moduleId);
    if (!primaryKeyword || !module) return;
    setSavingModuleId(moduleId);
    try {
      await onSearchStrategyChange(moduleId, {
        primaryKeyword,
        alternateKeywords: module.search_strategy?.alternate_keywords ?? []
      });
    } finally {
      setSavingModuleId("");
    }
  }

  return (
    <div className="workflow-content space-y-4">
      <AgentBrief
        compact
        eyebrow="我给出的购买路线"
        title={topModules.length > 0 ? `先解决「${topModules.join("、")}」` : "先解决最影响使用的需求"}
        description={session.shopping_plan.personalization_summary || session.shopping_plan.overall_rationale}
      />
      <Card className="section-card w-full">
      <CardHeader className="px-6 pt-7 md:px-8 md:pt-8">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="label-text">需要你确认</p>
            <CardTitle className="mt-2 text-2xl">{scenario.confirm_plan_title}</CardTitle>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              我已经把需求拆成可执行的搜索任务。你只需检查优先级和预算是否符合预期。
            </p>
          </div>
          <Badge variant="success">规划已就绪</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-6 px-6 pb-7 pt-6 md:px-8 md:pb-8">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="plan-stat-card">
            <WalletCards className="h-4 w-4 text-primary" />
            <span><span className="block text-xs text-muted-foreground">预算分配</span><strong className="mt-1 block text-base">{formatCurrency(totalAllocated)}</strong></span>
          </div>
          <div className="plan-stat-card">
            <CheckCircle2 className="h-4 w-4 text-accent" />
            <span><span className="block text-xs text-muted-foreground">优先解决</span><strong className="mt-1 block truncate text-sm">{topModules.join("、") || "已按需排序"}</strong></span>
          </div>
          <div className="plan-stat-card">
            <Search className="h-4 w-4 text-primary" />
            <span><span className="block text-xs text-muted-foreground">搜索任务</span><strong className="mt-1 block text-base">{modules.length} 组</strong></span>
          </div>
        </div>

        {refinementImpact ? (
          <div className="rounded-[20px] border border-primary/15 bg-primary/[0.045] px-4 py-3 text-sm leading-6 text-muted-foreground">
            <span className="font-semibold text-foreground">调整影响说明：</span>{refinementImpact.summary}
          </div>
        ) : null}

        <div className="grid gap-3 lg:grid-cols-2">
          {modules.map((module, index) => {
            const isAdaptiveModule = module.origin === "ai_adaptive" || !session.base_template.some((item) => item.module_id === module.module_id);
            const keyword = module.search_strategy?.primary_keyword || module.search_keyword || module.typical_item_types.slice(0, 3).join("、");
            return (
              <article key={module.module_id} className="plan-module-card">
                <div className="flex items-start gap-4">
                  <span className="module-index">{String(index + 1).padStart(2, "0")}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold text-foreground">{module.module_name}</h3>
                      <Badge variant={getPriorityVariant(module.priority)}>{getPriorityTone(module.priority)}</Badge>
                      {isAdaptiveModule ? <Badge variant="outline">AI 新增</Badge> : null}
                    </div>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">{module.description}</p>
                    <div className="mt-4 flex items-start gap-2 rounded-[16px] bg-muted/50 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
                      <Search className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                      <span><span className="font-medium text-foreground">搜索：</span>{keyword}</span>
                    </div>
                    <p className="mt-3 text-xs leading-5 text-muted-foreground">{getBudgetReason(module, session.scene_brief.budget)}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <span className="text-[11px] text-muted-foreground">预算</span>
                    <p className="mt-1 text-lg font-semibold text-primary">{formatCurrency(module.budget_allocation)}</p>
                  </div>
                </div>
              </article>
            );
          })}
        </div>

        <details className="advanced-settings-panel">
          <summary className="cursor-pointer list-none">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-foreground">高级设置</p>
                <p className="mt-1 text-xs text-muted-foreground">可选：调整 Agent 主动程度或搜索词</p>
              </div>
              <Badge variant="outline">默认无需修改</Badge>
            </div>
          </summary>
          <div className="mt-5 space-y-5 border-t border-border/60 pt-5">
            <section>
              <p className="text-sm font-semibold">Agent 自主指令</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                {agentProfileOptions.map((option) => (
                  <button
                    key={option.profile}
                    type="button"
                    disabled={busy}
                    onClick={() => onAgentProfileChange(option.profile)}
                    className={`rounded-[18px] border p-3 text-left transition ${selectedAgentProfile === option.profile ? "border-primary/30 bg-primary/[0.05]" : "border-border/75 bg-white hover:border-primary/20"}`}
                  >
                    <span className="text-sm font-semibold">{option.title}</span>
                    <span className="mt-1 block text-xs leading-5 text-muted-foreground">{option.description}</span>
                  </button>
                ))}
              </div>
            </section>

            <section>
              <p className="text-sm font-semibold">可编辑搜索任务包</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">搜索词会直接影响后续淘宝搜索；每个模块应保持不同的品类重点。</p>
              <div className="mt-3 grid gap-2">
                {modules.map((module) => (
                  <div key={module.module_id} className="flex flex-col gap-2 rounded-[18px] border border-border/70 bg-white p-3 sm:flex-row sm:items-center">
                    <span className="w-24 shrink-0 text-xs font-medium text-foreground">{module.module_name}</span>
                    <input
                      value={draftStrategies[module.module_id] ?? ""}
                      maxLength={API_INPUT_LIMITS.keywordLength}
                      onChange={(event) => setDraftStrategies((current) => ({ ...current, [module.module_id]: event.target.value }))}
                      className="h-10 min-w-0 flex-1 rounded-[14px] border border-border bg-muted/20 px-3 text-sm outline-none transition focus:border-primary"
                      aria-label={`${module.module_name}搜索词`}
                    />
                    <Button size="sm" variant="outline" disabled={busy || savingModuleId === module.module_id} onClick={() => saveSearchTask(module.module_id)}>
                      {savingModuleId === module.module_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                      保存
                    </Button>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-[18px] bg-muted/45 p-4 text-xs leading-5 text-muted-foreground">
              <p className="font-semibold text-foreground">Agent 方案自检</p>
              <p className="mt-2">{session.plan_review.summary}</p>
              <p className="mt-1">验收信号：预算总额一致、模块关键词有区分、必需模块优先。</p>
            </section>
          </div>
        </details>

        <div className="flex flex-col-reverse gap-3 border-t border-border/60 pt-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="ghost" onClick={onBack}><ChevronLeft className="h-4 w-4" />返回修改需求</Button>
            <Button variant="outline" onClick={onAdjust}>重新调整方案</Button>
          </div>
          <Button data-demo-target="plan:confirm" onClick={onConfirm} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            就按这个方案开始找商品
          </Button>
        </div>
      </CardContent>
      </Card>
    </div>
  );
}
