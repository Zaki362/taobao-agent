export type LlmTaskName =
  | "parse_scene"
  | "personalize_template"
  | "refine_plan"
  | "review_candidates"
  | "review_plan"
  | "decide_next_action"
  | "compose_purchase_bundle"
  | "explain_product_fit";

interface LlmTaskTelemetry {
  calls: number;
  connected: number;
  fallback: number;
  total_duration_ms: number;
  durations_ms: number[];
  last_reason?: string;
  last_called_at?: string;
  model?: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __sceneCartLlmTelemetry: Map<LlmTaskName, LlmTaskTelemetry> | undefined;
}

function telemetryStore() {
  if (!globalThis.__sceneCartLlmTelemetry) {
    globalThis.__sceneCartLlmTelemetry = new Map();
  }
  return globalThis.__sceneCartLlmTelemetry;
}

export function resetLlmTelemetryForTests() {
  globalThis.__sceneCartLlmTelemetry = undefined;
}

export function recordLlmCall(input: {
  task: LlmTaskName;
  model: string;
  mode: "connected" | "mock";
  durationMs: number;
  reason?: string;
}) {
  const store = telemetryStore();
  const current = store.get(input.task) ?? {
    calls: 0,
    connected: 0,
    fallback: 0,
    total_duration_ms: 0,
    durations_ms: []
  };
  current.calls += 1;
  current.connected += input.mode === "connected" ? 1 : 0;
  current.fallback += input.mode === "mock" ? 1 : 0;
  current.total_duration_ms += Math.max(0, input.durationMs);
  current.durations_ms = [...current.durations_ms, Math.max(0, input.durationMs)].slice(-100);
  current.last_reason = input.reason;
  current.last_called_at = new Date().toISOString();
  current.model = input.model;
  store.set(input.task, current);
}

export function downgradeLastLlmCall(task: LlmTaskName, reason: string) {
  const store = telemetryStore();
  const current = store.get(task);
  if (!current) return;
  if (current.connected > 0) {
    current.connected -= 1;
    current.fallback += 1;
  }
  current.last_reason = reason;
  store.set(task, current);
}

function percentile(values: number[], ratio: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

export function getLlmTelemetrySnapshot() {
  const tasks = [...telemetryStore().entries()].map(([task, value]) => ({
    task,
    model: value.model ?? "unknown",
    calls: value.calls,
    connected: value.connected,
    fallback: value.fallback,
    average_duration_ms: value.calls ? Math.round(value.total_duration_ms / value.calls) : 0,
    p95_duration_ms: percentile(value.durations_ms, 0.95),
    last_reason: value.last_reason,
    last_called_at: value.last_called_at
  }));
  return {
    calls: tasks.reduce((sum, task) => sum + task.calls, 0),
    connected: tasks.reduce((sum, task) => sum + task.connected, 0),
    fallback: tasks.reduce((sum, task) => sum + task.fallback, 0),
    tasks
  };
}
