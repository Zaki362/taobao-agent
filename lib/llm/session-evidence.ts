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

export function sessionLlmSummary(calls: SessionLlmCall[]) {
  return {
    calls: calls.length,
    connected: calls.filter((call) => call.mode === "connected").length,
    fallback: calls.filter((call) => call.mode === "fallback").length,
    latest: calls.at(-1)
  };
}
