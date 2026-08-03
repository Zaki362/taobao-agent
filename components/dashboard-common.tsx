"use client";

import { CheckCircle2, ShoppingBag, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";

export function StatusPage({ title, description, loading }: { title: string; description: string; loading?: boolean }) {
  return (
    <Card className="section-card mx-auto w-full max-w-4xl overflow-hidden">
      <CardContent className="relative flex min-h-[430px] flex-col items-center justify-center gap-4 px-6 py-10 text-center">
        <div className="absolute inset-x-0 top-0 h-36 bg-[radial-gradient(circle_at_center,rgba(247,123,38,0.12),transparent_66%)]" />
        <div className={`status-orb ${loading ? "status-orb-loading" : ""}`}>
          {loading ? <ShoppingBag className="h-6 w-6" /> : <CheckCircle2 className="h-6 w-6" />}
          {loading ? <Sparkles className="status-orb-spark h-4 w-4" /> : null}
        </div>
        <h2 className="relative mt-2 text-balance text-2xl font-semibold md:text-[30px]">{title}</h2>
        <p className="relative max-w-xl text-[15px] leading-7 text-muted-foreground">{description}</p>
        {loading ? (
          <div className="relative mt-3 flex items-center gap-1.5" aria-label="处理中">
            <span className="loading-dot" />
            <span className="loading-dot [animation-delay:160ms]" />
            <span className="loading-dot [animation-delay:320ms]" />
          </div>
        ) : null}
      </CardContent>
    </Card>
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
            className={`rounded-full px-3 py-1.5 text-xs transition ${
              option === value ? "bg-primary text-white" : "border border-border bg-white text-muted-foreground hover:text-foreground"
            }`}
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
              className={`rounded-full px-3 py-1.5 text-xs transition ${
                active ? "bg-primary text-white" : "border border-border bg-white text-muted-foreground hover:text-foreground"
              }`}
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
        min={300}
        step={100}
        value={value}
        onChange={(event) => onChange(Math.max(300, Number(event.target.value) || 300))}
        className="mt-3 h-11 w-full rounded-[16px] border border-border bg-white px-3 text-sm outline-none transition focus:border-primary"
      />
    </div>
  );
}
