import { NextRequest } from "next/server";
import { ApiRouteError, apiOk, apiRouteError } from "@/lib/api/responses";
import { API_INPUT_LIMITS, boundedStringArray, readJsonObject } from "@/lib/api/validation";
import { getRuntimeRepository } from "@/lib/runtime";
import { authenticateExecutorToken, bearerToken, DEFAULT_JOB_LEASE_MS } from "@/lib/runtime/jobs";
import { assertExecutorProtocol, EXECUTOR_PROTOCOL_VERSION } from "@/lib/runtime/executor-protocol";
import type { ExecutorClaimScope } from "@/lib/runtime/types";
import {
  recoverAgentWorkflowForExecutor,
  type WorkflowRecoveryResult
} from "@/lib/agent/workflow-recovery";

export async function POST(request: NextRequest) {
  try {
    assertExecutorProtocol(request);
    const device = await authenticateExecutorToken(bearerToken(request));
    if (!device) throw new ApiRouteError("invalid executor token", 401, "invalid_executor_token");
    const body = await readJsonObject(request, API_INPUT_LIMITS.executorBodyBytes);
    const transport = body.transport;
    if (transport !== undefined && transport !== "http_mcp" && transport !== "native_cli") {
      throw new ApiRouteError("invalid executor transport", 400, "invalid_executor_transport");
    }
    const claimScope: ExecutorClaimScope | undefined = transport
      ? {
          transport,
          available_tools: boundedStringArray(body.available_tools, "available_tools", {
            maxItems: 32,
            maxItemLength: 80,
            fallback: []
          })
        }
      : undefined;
    const repository = getRuntimeRepository();
    if (device.status === "authentication_required") {
      await repository.heartbeatDevice(device.id, "authentication_required");
      return apiOk({
        job: null,
        recovery: { recovered: false, reason: "authentication_required" },
        executor_state: "authentication_required",
        protocol_version: EXECUTOR_PROTOCOL_VERSION
      });
    }
    if (device.status === "mcp_unavailable") {
      await repository.heartbeatDevice(device.id, "mcp_unavailable");
      return apiOk({
        job: null,
        recovery: { recovered: false, reason: "mcp_unavailable" },
        executor_state: "mcp_unavailable",
        protocol_version: EXECUTOR_PROTOCOL_VERSION
      });
    }
    const activeDevice = await repository.heartbeatDevice(device.id, "online");
    if (!activeDevice) throw new ApiRouteError("executor device unavailable", 401, "invalid_executor_token");
    let job = await repository.claimJob(
      activeDevice,
      DEFAULT_JOB_LEASE_MS,
      EXECUTOR_PROTOCOL_VERSION,
      claimScope
    );
    let recovery: WorkflowRecoveryResult = { recovered: false };
    if (!job) {
      try {
        recovery = await recoverAgentWorkflowForExecutor(activeDevice);
      } catch (error) {
        recovery = {
          recovered: false,
          reason: "recovery_failed",
          error_message: error instanceof Error ? error.message.slice(0, 300) : "workflow recovery failed"
        };
      }
    }
    if (!job && recovery.recovered) {
      job = await repository.claimJob(
        activeDevice,
        DEFAULT_JOB_LEASE_MS,
        EXECUTOR_PROTOCOL_VERSION,
        claimScope
      );
    }
    if (job) {
      await repository.appendEvent({
        user_id: job.user_id,
        session_id: job.session_id,
        job_id: job.id,
        event_type: "job.claimed",
        payload: {
          device_id: activeDevice.id,
          device_name: activeDevice.name,
          attempt: job.attempts,
          lease_token: job.lease_token,
          protocol_version: EXECUTOR_PROTOCOL_VERSION,
          transport: claimScope?.transport ?? "legacy_http_mcp"
        }
      });
    }
    return apiOk({ job, recovery, executor_state: activeDevice.status, protocol_version: EXECUTOR_PROTOCOL_VERSION });
  } catch (error) {
    return apiRouteError(error, "failed to claim executor job");
  }
}
