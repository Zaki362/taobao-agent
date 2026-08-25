"use client";

import { CircleDashed, ShoppingBag, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { API_INPUT_LIMITS } from "@/lib/api/input-limits";

export function AgentBrief({
  eyebrow = "SceneCart Agent",
  title,
  description,
  highlights = [],
  loading = false,
  compact = false
}: {
  eyebrow?: string;
  title: string;
  description: string;
  highlights?: string[];
  loading?: boolean;
  compact?: boolean;
}) {
  return (
    <section
      className={`agent-brief ${compact ? "agent-brief-compact" : ""}`}
      role={loading ? "status" : undefined}
      aria-live={loading ? "polite" : undefined}
    >
      <div className="agent-brief-mark" aria-hidden="true">
        <Sparkles className="h-4 w-4" />
        {loading ? <span className="agent-brief-pulse" /> : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="agent-brief-eyebrow">{eyebrow}</p>
          {loading ? <span className="agent-live-label"><span />正在处理</span> : null}
        </div>
        <h2 className="agent-brief-title">{title}</h2>
        <p className="agent-brief-description">{description}</p>
        {highlights.length > 0 ? (
          <div className="agent-brief-highlights">
            {highlights.map((item) => <span key={item}>{item}</span>)}
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function StatusPage({ title, description, loading }: { title: string; description: string; loading?: boolean }) {
  const isPlanning = title.includes("规划") || title.includes("调整");
  const steps = isPlanning
    ? ["检查预算与优先级", "重组购买模块", "生成可确认方案"]
    : ["提取场景与约束", "识别预算和偏好", "整理成可确认需求"];

  return (
    <div className="workflow-content space-y-4">
      <AgentBrief
        eyebrow="SceneCart 正在协作"
        title={title}
        description={description}
        loading={loading}
      />
      <Card className="section-card overflow-hidden">
        <CardContent className="relative px-6 py-7 md:px-8 md:py-8">
          <div className="absolute inset-x-0 top-0 h-28 bg-[radial-gradient(circle_at_center,rgba(247,123,38,0.10),transparent_68%)]" />
          <div className="relative grid gap-3 sm:grid-cols-3">
            {steps.map((step, index) => (
              <div key={step} className={`agent-thinking-step ${index === 0 && loading ? "agent-thinking-step-active" : ""}`}>
                <span className="agent-thinking-icon">
                  {index === 0 && loading ? <ShoppingBag className="h-4 w-4" /> : <CircleDashed className="h-4 w-4" />}
                </span>
                <span>
                  <strong>{step}</strong>
                  <small>{index === 0 && loading ? "正在进行" : "接下来"}</small>
                </span>
              </div>
            ))}
          </div>
          <p className="relative mt-6 text-center text-xs text-muted-foreground">完成后不会自动跳过，你可以先检查结果再继续。</p>
        </CardContent>
      </Card>
    </div>
  );
}

export function HostedInstructionCard({ instruction, compact = false }: { instruction: string; compact?: boolean }) {
  async function copyInstruction() {
    await navigator.clipboard.writeText(instruction);
  }

  return (
    <Card className={compact ? "subtle-card" : "section-card"}>
      <CardHeader>
        <CardTitle>{compact ? "当前宿主任务说明" : "Codex 宿主执行说明"}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          这段说明可直接交给 Codex 宿主执行当前待处理淘宝任务，并按约定回填结果。
        </p>
        <div className="max-h-72 overflow-auto rounded-[20px] bg-secondary/40 p-4 text-xs leading-6 text-foreground whitespace-pre-wrap">
          {instruction}
        </div>
        <Button variant="outline" size="sm" onClick={copyInstruction}>复制宿主执行说明</Button>
      </CardContent>
    </Card>
  );
}

export function InfoBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-grid-card">
      <p className="label-text">{label}</p>
      <p className="mt-2 text-sm font-medium leading-6">{value}</p>
    </div>
  );
}

export function EditableChoiceField({
  label,
  value,
  options,
  onSelect
}: {
  label: string;
  value: string;
  options: string[];
  onSelect: (value: string) => void;
}) {
  return (
    <div className="info-grid-card">
      <p className="label-text">{label}</p>
      <p className="mt-2 text-base font-semibold">{value}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={option === value}
            className={`choice-chip ${option === value ? "choice-chip-active" : ""}`}
            onClick={() => onSelect(option)}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

export function EditableTagField({
  label,
  selected,
  options,
  emptyLabel,
  onToggle
}: {
  label: string;
  selected: string[];
  options: string[];
  emptyLabel: string;
  onToggle: (value: string) => void;
}) {
  return (
    <div className="info-grid-card">
      <p className="label-text">{label}</p>
      <p className="mt-2 text-base font-semibold">{selected.join("、") || emptyLabel}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {options.map((option) => {
          const active = selected.includes(option);
          return (
            <button
              key={option}
              type="button"
              aria-pressed={active}
              className={`choice-chip ${active ? "choice-chip-active" : ""}`}
              onClick={() => onToggle(option)}
            >
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function EditableBudgetField({
  label,
  value,
  onChange
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="info-grid-card">
      <p className="label-text">{label}</p>
      <p className="mt-2 text-base font-semibold">{formatCurrency(value)}</p>
      <input
        type="number"
        data-demo-target="scene:budget"
        min={300}
        max={API_INPUT_LIMITS.budgetMax}
        step={100}
        value={value}
        onChange={(event) => onChange(Math.min(
          API_INPUT_LIMITS.budgetMax,
          Math.max(300, Number(event.target.value) || 300)
        ))}
        className="mt-3 h-11 w-full rounded-[16px] border border-border bg-white px-3 text-sm outline-none transition focus:border-primary"
      />
    </div>
  );
}
