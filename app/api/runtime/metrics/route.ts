import { NextRequest } from "next/server";
import { getRequestIdentity } from "@/lib/auth/request";
import { apiOk, apiRouteError, requireString } from "@/lib/api/responses";
import { ensureSession } from "@/lib/agent/orchestrator";
import { getRuntimeRepository } from "@/lib/runtime";
import { sessionLlmTelemetrySnapshot } from "@/lib/llm/session-evidence";
import { evaluateRuntimeHealth, summarizeRuntimeJobTypes } from "@/lib/runtime/monitoring";
import { isExecutorDeviceOnline, summarizeExecutorDevices } from "@/lib/runtime/executor-status";
import {
  summarizeWorkflowRecoveryHeartbeat,
  WORKFLOW_RECOVERY_SERVICE
} from "@/lib/runtime/recovery-heartbeat";

export async function GET(request: NextRequest) {
  try {
    const identity = await getRequestIdentity();
    const sessionId = requireString(request.nextUrl.searchParams.get("session_id"), "session_id");
    const session = await ensureSession(sessionId, identity.userId);
    if (!session) return apiOk({ available: false });

    const repository = getRuntimeRepository();
    const [jobs, devices, deviceAuditEvents, recoveryHeartbeat] = await Promise.all([
      repository.listJobs(sessionId, identity.userId),
      repository.listDevices(identity.userId),
      identity.userId ? repository.listAuditEvents(identity.userId, 12) : Promise.resolve([]),
      repository.getServiceHeartbeat(WORKFLOW_RECOVERY_SERVICE)
    ]);
    const now = Date.now();
    const counts = jobs.reduce<Record<string, number>>((result, job) => {
      result[job.status] = (result[job.status] ?? 0) + 1;
      return result;
    }, {});
    const pendingJobs = jobs.filter((job) => job.status === "pending");
    const completedJobs = jobs.filter((job) => job.status === "completed" && job.completed_at);
    const detailJobs = jobs.filter((job) => job.job_type === "product_detail");
    const completedDetailJobs = detailJobs.filter((job) => job.status === "completed");
    const detailEvidenceStatus = (job: (typeof jobs)[number]) => {
      const evidence = job.result?.detail_evidence;
      return evidence && typeof evidence === "object" && !Array.isArray(evidence)
        ? (evidence as Record<string, unknown>).status
        : undefined;
    };
    const verifiedDetailJobs = completedDetailJobs.filter((job) => detailEvidenceStatus(job) === "verified");
    const unavailableDetailJobs = completedDetailJobs.filter((job) => detailEvidenceStatus(job) === "unavailable");
    const averageDurationMs = completedJobs.length
      ? Math.round(completedJobs.reduce(
          (sum, job) => sum + Math.max(0, Date.parse(job.completed_at!) - Date.parse(job.created_at)),
          0
        ) / completedJobs.length)
      : 0;
    const executorDevices = summarizeExecutorDevices(devices, now);
    const jobsByType = summarizeRuntimeJobTypes(jobs);

    const jobMetrics = {
      total: jobs.length,
      pending: counts.pending ?? 0,
      active: (counts.leased ?? 0) + (counts.running ?? 0),
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      cancelled: counts.cancelled ?? 0,
      oldest_pending_ms: pendingJobs.length
        ? Math.max(...pendingJobs.map((job) => now - Date.parse(job.created_at)))
        : 0,
      average_duration_ms: averageDurationMs,
      by_type: jobsByType,
      pending_by_type: {
        module_search: pendingJobs.filter((job) => job.job_type === "module_search").length,
        product_detail: pendingJobs.filter((job) => job.job_type === "product_detail").length,
        add_to_cart: pendingJobs.filter((job) => job.job_type === "add_to_cart").length
      }
    };
    const deviceMetrics = {
      total: executorDevices.registered,
      online: executorDevices.online,
      mcp_unavailable: executorDevices.mcp_unavailable,
      authentication_required: executorDevices.authentication_required,
      capabilities: executorDevices.capabilities,
      last_heartbeat_at: devices
        .filter((device) => isExecutorDeviceOnline(device, now))
        .map((device) => device.last_heartbeat_at)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null
    };
    const detailEvidenceMetrics = {
      total: detailJobs.length,
      verified: verifiedDetailJobs.length,
      unavailable: unavailableDetailJobs.length,
      failed: detailJobs.filter((job) => job.status === "failed" || job.status === "cancelled").length,
      last_verified_at: verifiedDetailJobs
        .map((job) => job.completed_at)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null
    };
    const llmMetrics = sessionLlmTelemetrySnapshot(session.llm_calls);
    const workflowRecovery = {
      configured: (process.env.SCENECART_CRON_SECRET?.trim().length ?? 0) >= 32,
      ...summarizeWorkflowRecoveryHeartbeat(recoveryHeartbeat, now)
    };

    return apiOk({
      available: true,
      session_id: sessionId,
      jobs: jobMetrics,
      devices: deviceMetrics,
      device_audit_events: deviceAuditEvents,
      workflow_recovery: workflowRecovery,
      detail_evidence: detailEvidenceMetrics,
      llm: llmMetrics,
      health: evaluateRuntimeHealth({
        jobs: jobMetrics,
        devices: deviceMetrics,
        detailEvidence: detailEvidenceMetrics,
        llm: llmMetrics,
        workflowRecovery,
        agentRuntime: session.agent_runtime
      }),
      generated_at: new Date(now).toISOString()
    });
  } catch (error) {
    return apiRouteError(error, "failed to read runtime metrics");
  }
}
