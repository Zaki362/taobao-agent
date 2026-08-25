import type { ExecutionEvent, RuntimeJob } from "@/lib/runtime/types";

const SENSITIVE_RUNTIME_KEYS = new Set([
  "authorization",
  "device_token",
  "last_auth_failure_token_hash",
  "lease_token",
  "token_hash"
]);

function redactRuntimeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactRuntimeValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SENSITIVE_RUNTIME_KEYS.has(key.toLowerCase()))
      .map(([key, nested]) => [key, redactRuntimeValue(nested)])
  );
}

export function publicRuntimeJob(job: RuntimeJob) {
  const {
    lease_token: _leaseToken,
    last_auth_failure_token_hash: _lastAuthFailureTokenHash,
    ...publicJob
  } = job;
  return {
    ...publicJob,
    payload: redactRuntimeValue(publicJob.payload) as Record<string, unknown>,
    result: publicJob.result
      ? redactRuntimeValue(publicJob.result) as Record<string, unknown>
      : undefined
  };
}

export function publicExecutionEvent(event: ExecutionEvent): ExecutionEvent {
  return {
    ...event,
    payload: redactRuntimeValue(event.payload) as Record<string, unknown>
  };
}
