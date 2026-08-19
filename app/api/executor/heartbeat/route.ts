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
import {
  assertExecutorProtocol,
  assertPreviousProtocolInFlightJob,
  EXECUTOR_PROTOCOL_VERSION,
  isPreviousExecutorProtocolDrain,
  receivedExecutorProtocol
} from "@/lib/runtime/executor-protocol";

export async function POST(request: NextRequest) {
  try {
    const drainingPreviousProtocol = isPreviousExecutorProtocolDrain(request);
    if (!drainingPreviousProtocol) assertExecutorProtocol(request);
    const body = await request.json().catch(() => ({}));
    const currentJobId = typeof body.current_job_id === "string" ? body.current_job_id : undefined;
    if (drainingPreviousProtocol && !currentJobId) {
      assertPreviousProtocolInFlightJob(null, "");
    }
    const device = await authenticateExecutorToken(bearerToken(request));
    if (!device) throw new ApiRouteError("invalid executor token", 401, "invalid_executor_token");
    const repository = getRuntimeRepository();
    const previousProtocolJob = drainingPreviousProtocol && currentJobId
      ? await repository.getJob(currentJobId)
      : null;
    if (drainingPreviousProtocol) assertPreviousProtocolInFlightJob(previousProtocolJob, device.id);
    const responseProtocolVersion = drainingPreviousProtocol
      ? receivedExecutorProtocol(request)!
      : EXECUTOR_PROTOCOL_VERSION;
    if (body.executor_state === "offline") {
      const updated = await repository.heartbeatDevice(device.id, "offline");
      if (!updated) throw new ApiRouteError("executor device unavailable", 401, "invalid_executor_token");
      return apiOk({
        device: {
          id: updated.id,
          name: updated.name,
          status: updated.status,
          capabilities: updated.capabilities,
          last_heartbeat_at: updated.last_heartbeat_at
        },
        executor_state: "offline",
        lease_renewed: false,
        protocol_version: responseProtocolVersion,
        server_time: new Date().toISOString()
      });
    }
    const executorState = body.executor_state === undefined
      ? device.status === "authentication_required" || device.status === "mcp_unavailable"
        ? device.status
        : "online"
      : body.executor_state === "online"
        ? "online"
      : body.executor_state === "mcp_unavailable"
        ? "mcp_unavailable"
      : body.executor_state === "authentication_required"
        ? "authentication_required"
        : null;
    if (!executorState) {
      throw new ApiRouteError("invalid executor state", 400, "invalid_executor_state");
    }
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
        protocol_version: responseProtocolVersion,
        server_time: new Date().toISOString()
      });
    }

    const holdState = await reconcileAuthenticationFailureHoldsForDevice(device.id, {
      releaseCartAfterVerifiedLogin:
        executorState === "online" && body.authentication_recovery_verified === true
    });
    const effectiveExecutorState = executorState !== "authentication_required" && holdState.active
      ? "authentication_required"
      : executorState;
    const updated = await repository.heartbeatDevice(device.id, effectiveExecutorState);
    if (!updated) throw new ApiRouteError("executor device unavailable", 401, "invalid_executor_token");
    const shouldRenewLease = effectiveExecutorState === "online" && Boolean(currentJobId);
    const leaseToken = shouldRenewLease
      ? drainingPreviousProtocol
        ? previousProtocolJob?.lease_token ?? ""
        : typeof body.lease_token === "string" ? body.lease_token : ""
      : "";
    if (shouldRenewLease && !leaseToken) {
      throw new ApiRouteError("missing job lease token", 409, "job_lease_token_required");
    }
    const renewedJob = shouldRenewLease
      ? await repository.renewJobLease(
        currentJobId!,
        device.id,
        leaseToken,
        DEFAULT_JOB_LEASE_MS
      )
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
      protocol_version: responseProtocolVersion,
      server_time: new Date().toISOString()
    });
  } catch (error) {
    return apiRouteError(error, "executor heartbeat failed");
  }
}
