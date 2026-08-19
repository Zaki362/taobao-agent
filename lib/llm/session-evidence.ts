import type { SessionLlmCall, SessionState } from "@/lib/session/types";

const MAX_SESSION_LLM_CALLS = 120;

export function appendSessionLlmCalls(
  state: Pick<SessionState, "llm_calls" | "deepseek_status">,
  ...calls: Array<SessionLlmCall | undefined>
) {
  const seen = new Set(state.llm_calls.map((call) => call.id));
  const additions: SessionLlmCall[] = [];
  for (const call of calls) {
    if (!call || seen.has(call.id)) continue;
    seen.add(call.id);
    additions.push(call);
  }
  if (additions.length === 0) return state.llm_calls;

  state.llm_calls = [...state.llm_calls, ...additions].slice(-MAX_SESSION_LLM_CALLS);
  if (additions.some((call) => call.mode === "connected")) {
    state.deepseek_status = "connected";
  }
  return state.llm_calls;
}

export function markSessionLlmCallFallback(
  state: Pick<SessionState, "llm_calls" | "deepseek_status">,
  callId: string | undefined,
  reason: string
) {
  if (!callId) return false;
  let updated = false;
  state.llm_calls = state.llm_calls.map((call) => {
    if (call.id !== callId || call.mode === "fallback") return call;
    updated = true;
    return {
      ...call,
      mode: "fallback" as const,
      reason
    };
  });
  if (updated && state.llm_calls.every((call) => call.mode === "fallback")) {
    state.deepseek_status = "mock";
  }
  return updated;
}

export function sessionLlmSummary(calls: SessionLlmCall[]) {
  return {
    calls: calls.length,
    connected: calls.filter((call) => call.mode === "connected").length,
    fallback: calls.filter((call) => call.mode === "fallback").length,
    latest: calls.at(-1)
  };
}

function percentile(values: number[], ratio: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

export function sessionLlmTelemetrySnapshot(calls: SessionLlmCall[]) {
  const grouped = new Map<SessionLlmCall["task"], SessionLlmCall[]>();
  for (const call of calls) {
    grouped.set(call.task, [...(grouped.get(call.task) ?? []), call]);
  }
  const tasks = [...grouped.entries()].map(([task, taskCalls]) => {
    const latest = taskCalls.at(-1)!;
    const durations = taskCalls.map((call) => Math.max(0, call.duration_ms));
    const totalDuration = durations.reduce((sum, duration) => sum + duration, 0);
    return {
      task,
      model: latest.model,
      calls: taskCalls.length,
      connected: taskCalls.filter((call) => call.mode === "connected").length,
      fallback: taskCalls.filter((call) => call.mode === "fallback").length,
      average_duration_ms: Math.round(totalDuration / taskCalls.length),
      p95_duration_ms: percentile(durations, 0.95),
      last_reason: latest.reason,
      last_called_at: latest.created_at
    };
  });
  return {
    calls: calls.length,
    connected: calls.filter((call) => call.mode === "connected").length,
    fallback: calls.filter((call) => call.mode === "fallback").length,
    tasks
  };
}
