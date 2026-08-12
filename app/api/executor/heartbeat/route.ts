import { NextRequest } from "next/server";
import { ApiRouteError, apiOk, apiRouteError } from "@/lib/api/responses";
import { getRuntimeRepository } from "@/lib/runtime";
import {
  authenticateExecutorToken,
  bearerToken,
  DEFAULT_JOB_LEASE_MS,
  establishAuthenticationFailureHold,
  reconcileAuthenticationFailureHoldsForDevice
} from "@/lib/runtime/jobs";
import { assertExecutorProtocol, EXECUTOR_PROTOCOL_VERSION } from "@/lib/runtime/executor-protocol";

export async function POST(request: NextRequest) {
  try {
    assertExecutorProtocol(request);
    const device = await authenticateExecutorToken(bearerToken(request));
    if (!device) throw new ApiRouteError("invalid executor token", 401, "invalid_executor_token");
    const body = await request.json().catch(() => ({}));
    const executorState = body.executor_state === undefined
      ? device.status === "authentication_required" ? "authentication_required" : "online"
      : body.executor_state === "online"
        ? "online"
      : body.executor_state === "authentication_required"
        ? "authentication_required"
        : null;
    if (!executorState) {
      throw new ApiRouteError("invalid executor state", 400, "invalid_executor_state");
    }
    const repository = getRuntimeRepository();
    const currentJobId = typeof body.current_job_id === "string" ? body.current_job_id : undefined;
    const authenticationFailure = body.authentication_failure &&
      typeof body.authentication_failure === "object" &&
      !Array.isArray(body.authentication_failure)
      ? body.authentication_failure as Record<string, unknown>
      : null;
    if (authenticationFailure) {
      const jobId = typeof authenticationFailure.job_id === "string"
        ? authenticationFailure.job_id
        : "";
      const leaseToken = typeof authenticationFailure.lease_token === "string"
        ? authenticationFailure.lease_token
        : "";
      const errorMessage = typeof authenticationFailure.error === "string"
        ? authenticationFailure.error
        : "";
      if (
        executorState !== "authentication_required" ||
        !jobId ||
        jobId !== currentJobId ||
        !leaseToken ||
        !errorMessage
      ) {
        throw new ApiRouteError(
          "invalid authentication failure hold",
          400,
          "invalid_authentication_failure_hold"
        );
      }
      const held = await establishAuthenticationFailureHold(
        jobId,
        device,
        errorMessage,
        leaseToken
      );
      return apiOk({
        device: {
          id: held.device.id,
          name: held.device.name,
          status: held.device.status,
          capabilities: held.device.capabilities,
          last_heartbeat_at: held.device.last_heartbeat_at
        },
        executor_state: "authentication_required",
        lease_renewed: false,
        authentication_hold_persisted: true,
        authentication_hold_active: !held.authenticationFailureAcknowledged,
        authentication_failure_acknowledged: held.authenticationFailureAcknowledged,
        job: held.job,
        protocol_version: EXECUTOR_PROTOCOL_VERSION,
        server_time: new Date().toISOString()
      });
    }

    const holdState = await reconcileAuthenticationFailureHoldsForDevice(device.id, {
      releaseCartAfterVerifiedLogin:
        executorState === "online" && body.authentication_recovery_verified === true
    });
    const effectiveExecutorState = executorState === "online" && holdState.active
      ? "authentication_required"
      : executorState;
    const updated = await repository.heartbeatDevice(device.id, effectiveExecutorState);
    if (!updated) throw new ApiRouteError("executor device unavailable", 401, "invalid_executor_token");
    const renewedJob = effectiveExecutorState === "online" && currentJobId
      ? await repository.renewJobLease(currentJobId, device.id, DEFAULT_JOB_LEASE_MS)
      : null;
    return apiOk({
      device: updated ? {
        id: updated.id,
        name: updated.name,
        status: updated.status,
        capabilities: updated.capabilities,
        last_heartbeat_at: updated.last_heartbeat_at
      } : null,
      executor_state: updated?.status ?? effectiveExecutorState,
      lease_renewed: Boolean(renewedJob),
      authentication_hold_active: holdState.active,
      protocol_version: EXECUTOR_PROTOCOL_VERSION,
      server_time: new Date().toISOString()
    });
  } catch (error) {
    return apiRouteError(error, "executor heartbeat failed");
  }
}
