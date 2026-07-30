"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import {
  EditableBudgetField,
  EditableChoiceField,
  EditableTagField
} from "@/components/dashboard-common";
import { buildSceneInputFromBrief } from "@/components/dashboard-helpers";
import {
  alreadyHaveOptions,
  avoidItemOptions,
  preferenceOptions,
  stageOptions,
  vehicleOptions
} from "@/components/dashboard-config";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PriorityStyle, SessionState } from "@/lib/session/types";
import { formatCurrency } from "@/lib/utils";
import type { AgentDirectiveProfile } from "@/lib/agent/directives";

function toggleMultiValue(list: string[], value: string) {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function getPriorityTone(priority: number) {
  if (priority <= 1) return "优先级最高";
  if (priority === 2) return "优先级较高";
  if (priority === 3) return "优先级中等";
  return "可后置考虑";
}

function getBudgetReason(module: SessionState["shopping_plan"]["modules"][number], totalBudget: number) {
  const ratio = totalBudget > 0 ? Math.round((module.budget_allocation / totalBudget) * 100) : 0;
  const priorityLabel = getPriorityTone(module.priority);
  if (module.priority <= 1) {
    return `${priorityLabel}，需要先保障核心功能，约占总预算 ${ratio}%。`;
  }
  if (module.priority === 2) {
    return `${priorityLabel}，兼顾体验与实用，约占总预算 ${ratio}%。`;
  }
  return `${priorityLabel}，建议在前置需求满足后再投入，约占总预算 ${ratio}%。`;
}

function getPlanReviewLabel(status: SessionState["plan_review"]["status"]) {
  if (status === "ready") return "方案可执行";
  if (status === "needs_attention") return "需要留意";
  return "建议先调整";
}

function getPlanReviewBadge(status: SessionState["plan_review"]["status"]) {
  if (status === "ready") return "success" as const;
  if (status === "needs_attention") return "secondary" as const;
  return "danger" as const;
}

const agentProfileOptions: Array<{
  profile: AgentDirectiveProfile;
  title: string;
  description: string;
}> = [
  {
    profile: "conservative",
    title: "保守",
    description: "少补搜、少等待，优先稳定演示"
  },
  {
    profile: "balanced",
    title: "平衡",
    description: "默认推荐，首轮不足时补搜一次"
  },
  {
    profile: "exploratory",
    title: "探索",
    description: "更主动补搜，给 AI 更大筛选空间"
  }
];

function profileFromDirectives(directives: SessionState["shopping_plan"]["agent_directives"]): AgentDirectiveProfile {
  if (directives.autonomy_level === "保守执行") {
    return "conservative";
  }
  if (directives.autonomy_level === "探索执行") {
    return "exploratory";
  }
  return "balanced";
}

export function ConfirmScenePage({
  scene,
  onSceneChange,
  onSceneInputChange,
  onBack,
  onConfirm,
  busy,
  statusMessage,
  expandedModel,
  setExpandedModel
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
  const updateScene = (patch: Partial<SessionState["scene_brief"]>) => {
    const next = { ...scene, ...patch };
    onSceneChange(next);
    onSceneInputChange(buildSceneInputFromBrief(next));
  };

  return (
    <Card className="section-card">
      <CardHeader>
        <CardTitle>确认场景理解结果</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2">
          <EditableChoiceField
            label="车型"
            value={scene.vehicle_type}
            options={[...vehicleOptions]}
            onSelect={(value) => updateScene({ vehicle_type: value })}
          />
          <EditableBudgetField
            label="预算"
            value={scene.budget}
            onChange={(value) => updateScene({ budget: value })}
          />
          <EditableChoiceField
            label="偏好"
            value={scene.priority_style}
            options={preferenceOptions}
            onSelect={(value) => updateScene({ priority_style: value as PriorityStyle })}
          />
          <EditableChoiceField
            label="阶段"
            value={scene.user_stage}
            options={[...stageOptions]}
            onSelect={(value) => updateScene({ user_stage: value })}
          />
          <EditableTagField
            label="排除项"
            selected={scene.avoid_items}
            options={avoidItemOptions}
            emptyLabel="无"
            onToggle={(value) => updateScene({ avoid_items: toggleMultiValue(scene.avoid_items, value) })}
          />
          <EditableTagField
            label="已有物品"
            selected={scene.already_have}
            options={alreadyHaveOptions}
            emptyLabel="无"
            onToggle={(value) => updateScene({ already_have: toggleMultiValue(scene.already_have, value) })}
          />
        </div>
        <details
          open={expandedModel}
          onToggle={(event) => setExpandedModel((event.target as HTMLDetailsElement).open)}
          className="subtle-card p-4"
        >
          <summary className="cursor-pointer text-sm font-medium">查看过程</summary>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">
            已完成场景理解。系统根据你的需求提取出结构化 Scene Brief，后续会在基础模板上做个性化调整。
          </p>
        </details>
        <div className="panel-muted px-4 py-3 text-sm text-muted-foreground">{statusMessage}</div>
        <div className="flex gap-3">
          <Button variant="outline" onClick={onBack}>返回修改需求</Button>
          <Button onClick={onConfirm} disabled={busy}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowRight className="mr-2 h-4 w-4" />}
            确认需求，开始生成购物规划
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function ConfirmPlanPage({
  session,
  onBack,
  onAdjust,
  onAgentProfileChange,
  onSearchStrategyChange,
  onConfirm,
  busy,
  expandedModel,
  setExpandedModel
}: {
  session: SessionState;
  onBack: () => void;
  onAdjust: () => void;
  onAgentProfileChange: (profile: AgentDirectiveProfile) => void;
  onSearchStrategyChange: (
    moduleId: string,
    payload: {
      primaryKeyword: string;
      alternateKeywords: string[];
    }
  ) => Promise<void>;
  onConfirm: () => void;
  busy: boolean;
  expandedModel: boolean;
  setExpandedModel: (value: boolean) => void;
}) {
  const [draftStrategies, setDraftStrategies] = useState<Record<string, { primaryKeyword: string; alternateKeywords: string }>>({});
  const [savingStrategyModuleId, setSavingStrategyModuleId] = useState("");
  const totalAllocated = session.shopping_plan.modules.reduce((sum, module) => sum + module.budget_allocation, 0);
  const keywordCount = new Set(
    session.shopping_plan.modules
      .map((module) => module.search_keyword?.trim())
      .filter(Boolean)
  ).size;
  const topModules = session.shopping_plan.modules
    .filter((module) => module.priority <= 2)
    .map((module) => module.module_name)
    .slice(0, 3);
  const executionStrategy = session.shopping_plan.execution_strategy;
  const agentDirectives = session.shopping_plan.agent_directives;
  const selectedAgentProfile = profileFromDirectives(agentDirectives);
  const planReview = session.plan_review;
  const refinementImpact = session.last_refinement;
  const adaptiveModules = session.shopping_plan.modules.filter(
    (module) => module.origin === "ai_adaptive" || !session.base_template.some((item) => item.module_id === module.module_id)
  );

  useEffect(() => {
    setDraftStrategies(
      Object.fromEntries(
        session.shopping_plan.modules.map((module) => [
          module.module_id,
          {
            primaryKeyword: module.search_strategy?.primary_keyword || module.search_keyword || "",
            alternateKeywords: module.search_strategy?.alternate_keywords?.join("、") || ""
          }
        ])
      )
    );
  }, [session.session_id, session.shopping_plan.modules]);

  const updateDraftStrategy = (
    moduleId: string,
    patch: Partial<{ primaryKeyword: string; alternateKeywords: string }>
  ) => {
    setDraftStrategies((current) => ({
      ...current,
      [moduleId]: {
        primaryKeyword: current[moduleId]?.primaryKeyword ?? "",
        alternateKeywords: current[moduleId]?.alternateKeywords ?? "",
        ...patch
      }
    }));
  };

  const saveDraftStrategy = async (moduleId: string) => {
    const draft = draftStrategies[moduleId];
    if (!draft?.primaryKeyword.trim()) {
      return;
    }

    setSavingStrategyModuleId(moduleId);
    try {
      await onSearchStrategyChange(moduleId, {
        primaryKeyword: draft.primaryKeyword.trim(),
        alternateKeywords: draft.alternateKeywords
          .split(/[、,，\n]/)
          .map((item) => item.trim())
          .filter(Boolean)
      });
    } finally {
      setSavingStrategyModuleId("");
    }
  };

  return (
    <Card className="section-card">
      <CardHeader>
        <CardTitle>确认购物规划</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 rounded-[26px] border border-primary/10 bg-[#fff8f3] p-4 md:grid-cols-2 xl:grid-cols-5">
          <div>
            <p className="label-text">AI 规划模式</p>
            <p className="mt-2 text-sm font-semibold">
              {session.deepseek_status === "connected" ? "个性化规划已启用" : "保守规划已启用"}
            </p>
          </div>
          <div>
            <p className="label-text">预算校准</p>
            <p className="mt-2 text-sm font-semibold">{formatCurrency(totalAllocated)} / {formatCurrency(session.scene_brief.budget)}</p>
          </div>
          <div>
            <p className="label-text">搜索意图</p>
            <p className="mt-2 text-sm font-semibold">{keywordCount} 组差异化关键词</p>
          </div>
          <div>
            <p className="label-text">优先模块</p>
            <p className="mt-2 text-sm font-semibold">{topModules.join("、") || "已按预算排序"}</p>
          </div>
          <div>
            <p className="label-text">AI 自适应</p>
            <p className="mt-2 text-sm font-semibold">{adaptiveModules.length ? `${adaptiveModules.length} 个专项模块` : "沿用标准骨架"}</p>
          </div>
        </div>
        {adaptiveModules.length ? (
          <div className="rounded-[22px] border border-teal-200 bg-teal-50/60 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-teal-900">AI 识别到模板外的明确使用需求</p>
                <p className="mt-1 text-xs leading-6 text-teal-800/80">
                  已新增 {adaptiveModules.map((module) => module.module_name).join("、")}。这些模块受数量、品类和预算约束，并且只有你确认规划后才会进入搜索。
                </p>
              </div>
              <Badge variant="secondary">需用户确认</Badge>
            </div>
          </div>
        ) : null}
        <div className="subtle-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="label-text">Agent 自主指令</p>
              <p className="mt-2 text-sm font-semibold">
                {agentDirectives.autonomy_level} · {agentDirectives.search_depth}
              </p>
            </div>
            <Badge variant="secondary">AI 给策略边界，后端守安全边界</Badge>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            {agentProfileOptions.map((option) => {
              const selected = selectedAgentProfile === option.profile;
              return (
                <button
                  key={option.profile}
                  className={`rounded-[20px] border p-4 text-left transition ${
                    selected
                      ? "border-primary/35 bg-primary/5 shadow-card"
                      : "border-border/80 bg-white hover:border-primary/25"
                  }`}
                  disabled={busy}
                  onClick={() => onAgentProfileChange(option.profile)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold">{option.title}</p>
                    {selected ? <Badge variant="success">当前</Badge> : null}
                  </div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{option.description}</p>
                </button>
              );
            })}
          </div>
          <div className="mt-4 grid gap-3 text-xs leading-6 text-muted-foreground md:grid-cols-2">
            <p>详情策略：{agentDirectives.detail_policy}</p>
            <p>失败恢复：{agentDirectives.recovery_policy}</p>
            <p>候选重排：{agentDirectives.rerank_rules.slice(0, 2).join("；")}</p>
            <p>用户确认：{agentDirectives.user_confirmation_points.slice(0, 2).join("；")}</p>
          </div>
        </div>
        <div className="subtle-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="label-text">Agent 方案自检</p>
              <p className="mt-2 text-sm font-semibold">{planReview.summary}</p>
            </div>
            <Badge variant={getPlanReviewBadge(planReview.status)}>
              {getPlanReviewLabel(planReview.status)}
            </Badge>
          </div>
          <div className="mt-4 grid gap-3 text-xs leading-6 text-muted-foreground md:grid-cols-3">
            <p>预算判断：{planReview.budget_comment}</p>
            <p>关键词判断：{planReview.keyword_comment}</p>
            <p>模块判断：{planReview.module_comment}</p>
          </div>
          <div className="mt-4 grid gap-3 text-xs leading-6 text-muted-foreground md:grid-cols-2">
            <div>
              <p className="font-medium text-foreground">自检亮点</p>
              <p className="mt-1">{planReview.strengths.slice(0, 2).join("；")}</p>
            </div>
            <div>
              <p className="font-medium text-foreground">确认前留意</p>
              <p className="mt-1">{planReview.risks.slice(0, 2).join("；")}</p>
            </div>
          </div>
        </div>
        {refinementImpact ? (
          <div className="subtle-card border-primary/15 bg-primary/5 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="label-text">调整影响说明</p>
                <p className="mt-2 text-sm font-semibold">{refinementImpact.summary}</p>
              </div>
              <Badge variant="secondary">{refinementImpact.quick_action}</Badge>
            </div>
            <div className="mt-4 grid gap-3 text-xs leading-6 text-muted-foreground md:grid-cols-3">
              <p>需要重搜：{refinementImpact.impacted_modules.length} 个模块</p>
              <p>可复用候选：{refinementImpact.reusable_modules.length} 个模块</p>
              <p>已移除模块：{refinementImpact.removed_modules.length} 个模块</p>
            </div>
            <div className="mt-4 grid gap-2">
              {refinementImpact.module_decisions.slice(0, 6).map((decision) => (
                <div
                  key={`${decision.module_id}-${decision.decision}`}
                  className="rounded-[16px] border border-border/70 bg-white px-3 py-2 text-xs leading-6"
                >
                  <span className="font-semibold text-foreground">{decision.module_name}</span>
                  <span className="mx-2 text-muted-foreground">·</span>
                  <span>
                    {decision.decision === "needs_search"
                      ? "需要重搜"
                      : decision.decision === "removed"
                        ? "已移除"
                        : "可复用"}
                  </span>
                  <span className="ml-2 text-muted-foreground">{decision.reason}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <div className="subtle-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="label-text">AI 执行策略简报</p>
              <p className="mt-2 text-sm font-semibold">
                搜索顺序：{executionStrategy.module_sequence
                  .map((moduleId) => session.shopping_plan.modules.find((module) => module.module_id === moduleId)?.module_name)
                  .filter(Boolean)
                  .join(" → ") || "按模块优先级串行执行"}
              </p>
            </div>
            <Badge variant="secondary">模型负责策略，后端负责执行</Badge>
          </div>
          <div className="mt-4 grid gap-3 text-xs leading-6 text-muted-foreground md:grid-cols-3">
            <p>预算纪律：{executionStrategy.budget_guardrails[0] ?? "优先控制总预算，避免首购阶段过度升级。"}</p>
            <p>取舍说明：{executionStrategy.tradeoffs[0] ?? "低频模块会被后置，优先保障高频需求。"}</p>
            <p>停止规则：{executionStrategy.stop_rules[0] ?? "每个模块拿到三档候选后停止扩搜。"}</p>
          </div>
        </div>
        <div className="grid gap-4">
          {session.shopping_plan.modules.map((module) => {
            const draft = draftStrategies[module.module_id] ?? {
              primaryKeyword: module.search_strategy?.primary_keyword || module.search_keyword || "",
              alternateKeywords: module.search_strategy?.alternate_keywords?.join("、") || ""
            };
            const isSavingStrategy = savingStrategyModuleId === module.module_id;
            const isAdaptiveModule =
              module.origin === "ai_adaptive" ||
              !session.base_template.some((item) => item.module_id === module.module_id);

            return (
              <div key={module.module_id} className="subtle-card p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-semibold">{module.module_name}</p>
                      <Badge variant={isAdaptiveModule ? "success" : "secondary"}>
                        {isAdaptiveModule ? "AI 新增" : "基础模板"}
                      </Badge>
                      <Badge variant="secondary">{getPriorityTone(module.priority)}</Badge>
                    </div>
                    <p className="mt-2 max-w-2xl text-sm leading-7 text-muted-foreground">{module.description}</p>
                    <div className="mt-4 grid gap-2 text-xs leading-6 text-muted-foreground md:grid-cols-2">
                      <p>AI 筛选重点：{module.search_strategy?.ranking_focus?.join("、") || "价格、适配度、店铺可信度"}</p>
                      <p>优先包含：{module.search_strategy?.include_terms?.join("、") || module.typical_item_types.slice(0, 3).join("、")}</p>
                      <p>主动规避：{module.search_strategy?.exclude_terms?.join("、") || "暂无额外排除项"}</p>
                      <p>验收信号：{module.search_strategy?.must_have_signals?.join("、") || "功能明确、规格清楚、预算贴合"}</p>
                      <p>拒绝信号：{module.search_strategy?.reject_signals?.join("、") || "触及排除项或重复购买"}</p>
                      <p>策略说明：{module.recommendation_strategy}</p>
                      <p className="md:col-span-2">质量检查：{module.search_strategy?.quality_checks?.join("、") || "图片、详情链接、店铺、规格"}</p>
                      <p className="md:col-span-2">AI 取舍：{module.rationale}</p>
                      <p className="md:col-span-2">恢复策略：{module.search_strategy?.failure_recovery || "如果首轮结果不佳，会收缩到更明确品类词。"}</p>
                      <p className="md:col-span-2">预算说明：{getBudgetReason(module, session.scene_brief.budget)}</p>
                    </div>
                    <div className="mt-4 rounded-[22px] border border-primary/10 bg-[#fff8f3] p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="label-text">可编辑搜索任务包</p>
                          <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            AI 已生成首轮搜索词和备用词；你可以在真正搜索前微调，后端会按最新任务包执行。
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || isSavingStrategy || !draft.primaryKeyword.trim()}
                          onClick={() => saveDraftStrategy(module.module_id)}
                        >
                          {isSavingStrategy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                          保存任务包
                        </Button>
                      </div>
                      <div className="mt-3 grid gap-3 md:grid-cols-[1fr_1.2fr]">
                        <label className="text-xs font-medium text-muted-foreground">
                          首轮搜索词
                          <input
                            value={draft.primaryKeyword}
                            onChange={(event) => updateDraftStrategy(module.module_id, { primaryKeyword: event.target.value })}
                            className="mt-2 h-11 w-full rounded-[16px] border border-border bg-white px-3 text-sm text-foreground outline-none transition focus:border-primary"
                            placeholder="例如：新能源车 行车记录仪 夜视"
                            disabled={busy || isSavingStrategy}
                          />
                        </label>
                        <label className="text-xs font-medium text-muted-foreground">
                          备用搜索词（用顿号、逗号或换行分隔）
                          <textarea
                            value={draft.alternateKeywords}
                            onChange={(event) => updateDraftStrategy(module.module_id, { alternateKeywords: event.target.value })}
                            className="mt-2 min-h-11 w-full rounded-[16px] border border-border bg-white px-3 py-2 text-sm leading-6 text-foreground outline-none transition focus:border-primary"
                            placeholder="例如：车载记录仪 前后双录、记录仪 停车监控"
                            disabled={busy || isSavingStrategy}
                          />
                        </label>
                      </div>
                    </div>
                  </div>
                  <div className="min-w-[108px] rounded-[18px] bg-secondary/55 px-4 py-3 text-right">
                    <p className="text-xs text-muted-foreground">预算分配</p>
                    <p className="mt-1 text-lg font-semibold">{formatCurrency(module.budget_allocation)}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <details
          open={expandedModel}
          onToggle={(event) => setExpandedModel((event.target as HTMLDetailsElement).open)}
          className="subtle-card p-4"
        >
          <summary className="cursor-pointer text-sm font-medium">查看过程</summary>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">{session.shopping_plan.personalization_summary}</p>
          <p className="mt-2 text-sm leading-7 text-muted-foreground">{session.shopping_plan.overall_rationale}</p>
        </details>
        <div className="flex gap-3">
          <Button variant="outline" onClick={onBack}>返回修改需求</Button>
          <Button variant="outline" onClick={onAdjust}>重新调整规划</Button>
          <Button onClick={onConfirm} disabled={busy}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowRight className="mr-2 h-4 w-4" />}
            确认规划，开始搜索推荐商品
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
