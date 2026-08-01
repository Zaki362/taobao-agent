import { describe, expect, it } from "vitest";
import { normalizeSessionState } from "@/lib/session/store";
import { buildAgentCompletionReport } from "@/lib/agent/completion-review";
import { createSessionFixture } from "../fixtures/session";
import type { SessionState } from "@/lib/session/types";

describe("session execution runtime migration", () => {
  it("migrates legacy sessions without an execution mode to the durable local executor", () => {
    const legacy = createSessionFixture() as Partial<SessionState>;
    delete legacy.execution_mode;
    delete legacy.mcp_status;

    const normalized = normalizeSessionState(legacy as SessionState);

    expect(normalized.execution_mode).toBe("local_executor");
    expect(normalized.mcp_status).toBe("unavailable");
  });

  it("preserves an explicitly configured development compatibility mode", () => {
    const normalized = normalizeSessionState(createSessionFixture({
      execution_mode: "codex_hosted",
      mcp_status: "hosted"
    }));

    expect(normalized.execution_mode).toBe("codex_hosted");
    expect(normalized.mcp_status).toBe("hosted");
  });

  it("preserves a legacy completion report without contextual refinement suggestions", () => {
    const legacy = createSessionFixture();
    legacy.completion_report = buildAgentCompletionReport(legacy);
    delete legacy.completion_report.purchase_bundle?.refinement_suggestions;

    const normalized = normalizeSessionState(legacy);

    expect(normalized.completion_report?.purchase_bundle).toBeTruthy();
    expect(normalized.completion_report?.purchase_bundle?.refinement_suggestions).toBeUndefined();
  });
});
