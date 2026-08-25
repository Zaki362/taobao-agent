import { describe, expect, it } from "vitest";
import { publicExecutionEvent, publicRuntimeJob } from "@/lib/runtime/public-dto";
import type { ExecutionEvent, RuntimeJob } from "@/lib/runtime/types";

describe("browser runtime DTOs", () => {
  it("removes lease credentials from jobs", () => {
    const job = {
      id: "job-1",
      session_id: "session-1",
      job_type: "module_search",
      idempotency_key: "key",
      payload: { nested: { lease_token: "nested-secret", keep: true } },
      status: "leased",
      priority: 1,
      attempts: 1,
      max_attempts: 3,
      available_at: "2026-01-01T00:00:00.000Z",
      lease_token: "secret",
      last_auth_failure_token_hash: "hash",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z"
    } satisfies RuntimeJob;
    expect(publicRuntimeJob(job)).not.toHaveProperty("lease_token");
    expect(publicRuntimeJob(job)).not.toHaveProperty("last_auth_failure_token_hash");
    expect(publicRuntimeJob(job).payload).toEqual({ nested: { keep: true } });
  });

  it("redacts lease credentials from event payloads", () => {
    const event = {
      id: 1,
      session_id: "session-1",
      event_type: "job.leased",
      payload: { lease_token: "secret", job_type: "module_search" },
      created_at: "2026-01-01T00:00:00.000Z"
    } satisfies ExecutionEvent;
    expect(publicExecutionEvent(event).payload).toEqual({ job_type: "module_search" });
  });
});
