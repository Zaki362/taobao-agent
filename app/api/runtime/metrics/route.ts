import { NextRequest } from "next/server";
import { getRequestIdentity } from "@/lib/auth/request";
import { apiOk, apiRouteError, requireString } from "@/lib/api/responses";
import { ensureSession } from "@/lib/agent/orchestrator";
import { getRuntimeRepository } from "@/lib/runtime";
import { getLlmTelemetrySnapshot } from "@/lib/llm/telemetry";
import { evaluateRuntimeHealth } from "@/lib/runtime/monitoring";

export async function GET(request: NextRequest) {
  try {
    const identity = await getRequestIdentity();
    const sessionId = requireString(request.nextUrl.searchParams.get("session_id"), "session_id");
    const session = await ensureSession(sessionId, identity.userId);
    if (!session) return apiOk({ available: false });

    const repository = getRuntimeRepository();
    const [jobs, devices] = await Promise.all([
      repository.listJobs(sessionId, identity.userId),
      identity.userId ? repository.listDevices(identity.userId) : Promise.resolve([])
    ]);
    const now = Date.now();
    const counts = jobs.reduce<Record<string, number>>((result, job) => {
      result[job.status] = (result[job.status] ?? 0) + 1;
      return result;
    }, {});
    const pendingJobs = jobs.filter((job) => job.status === "pending");
    const completedJobs = jobs.filter((job) => job.status === "completed" && job.completed_at);
    const averageDurationMs = completedJobs.length
      ? Math.round(completedJobs.reduce(
          (sum, job) => sum + Math.max(0, Date.parse(job.completed_at!) - Date.parse(job.created_at)),
          0
        ) / completedJobs.length)
      : 0;
    const activeDevices = devices.filter((device) =>
      device.status !== "revoked" &&
      Boolean(device.last_heartbeat_at) &&
      now - Date.parse(device.last_heartbeat_at!) < 45_000
    );

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
      average_duration_ms: averageDurationMs
    };
    const deviceMetrics = {
      total: devices.filter((device) => device.status !== "revoked").length,
      online: activeDevices.length,
      last_heartbeat_at: activeDevices
        .map((device) => device.last_heartbeat_at)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null
    };
    const llmMetrics = getLlmTelemetrySnapshot();

    return apiOk({
      available: true,
      session_id: sessionId,
      jobs: jobMetrics,
      devices: deviceMetrics,
      llm: llmMetrics,
      health: evaluateRuntimeHealth({
        jobs: jobMetrics,
        devices: deviceMetrics,
        llm: llmMetrics,
        agentRuntime: session.agent_runtime
      }),
      generated_at: new Date(now).toISOString()
    });
  } catch (error) {
    return apiRouteError(error, "failed to read runtime metrics");
  }
}
