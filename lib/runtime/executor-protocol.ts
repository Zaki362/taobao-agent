import protocol from "@/lib/runtime/executor-protocol.json";
import { ApiRouteError } from "@/lib/api/responses";
import type { RuntimeJob } from "@/lib/runtime/types";

export const EXECUTOR_PROTOCOL_HEADER = "x-scenecart-executor-protocol";
export const EXECUTOR_PROTOCOL_VERSION = protocol.version;
const DRAINABLE_PREVIOUS_PROTOCOL_VERSION = "3";
const MAXIMUM_DRAIN_WINDOW_MS = 2 * 60 * 60 * 1000;

function previousProtocolDrainDeadline() {
  const raw = process.env.SCENECART_EXECUTOR_V3_DRAIN_UNTIL?.trim();
  if (!raw) return null;
  const deadline = Date.parse(raw);
  if (!Number.isFinite(deadline)) return null;
  const remaining = deadline - Date.now();
  return remaining > 0 && remaining <= MAXIMUM_DRAIN_WINDOW_MS ? deadline : null;
}

export function receivedExecutorProtocol(request: Request) {
  return request.headers.get(EXECUTOR_PROTOCOL_HEADER)?.trim();
}

export function isPreviousExecutorProtocolDrain(request: Request) {
  return EXECUTOR_PROTOCOL_VERSION === "4" &&
    receivedExecutorProtocol(request) === DRAINABLE_PREVIOUS_PROTOCOL_VERSION &&
    previousProtocolDrainDeadline() !== null;
}

export function assertPreviousProtocolInFlightJob(
  job: RuntimeJob | null,
  deviceId: string,
  options: { allowTerminalReplay?: boolean } = {}
) {
  const allowedStatuses = options.allowTerminalReplay
    ? new Set(["leased", "running", "completed", "failed"])
    : new Set(["leased", "running"]);
  if (
    job &&
    (job.job_type === "module_search" || job.job_type === "add_to_cart") &&
    job.lease_protocol === DRAINABLE_PREVIOUS_PROTOCOL_VERSION &&
    job.lease_owner_id === deviceId &&
    allowedStatuses.has(job.status)
  ) {
    return;
  }
  throw new ApiRouteError(
    "旧版执行器只允许排空升级前已领取的搜索或加购任务，请更新项目代码后重启 worker。",
    426,
    "executor_protocol_mismatch"
  );
}

export function assertExecutorProtocol(request: Request) {
  const received = receivedExecutorProtocol(request);
  if (received === EXECUTOR_PROTOCOL_VERSION) return;

  throw new ApiRouteError(
    received
      ? `本地执行器协议版本 ${received} 与服务端 ${EXECUTOR_PROTOCOL_VERSION} 不兼容，请更新项目代码后重启 worker。`
      : `本地执行器缺少协议版本，请更新项目代码后重启 worker。`,
    426,
    "executor_protocol_mismatch"
  );
}
