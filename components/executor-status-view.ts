import type { MpcStatus } from "@/components/dashboard-types";

export const EXECUTOR_HEARTBEAT_FRESH_MS = 45_000;
export const MCP_STATUS_REFRESH_MS = 5_000;

export type ExecutorDeviceViewState =
  | "online"
  | "authentication_required"
  | "mcp_unavailable"
  | "offline"
  | "revoked";

export type ExecutorDeviceStatusInput = {
  status: string;
  last_heartbeat_at?: string;
};

export function executorDeviceViewState(
  device: ExecutorDeviceStatusInput,
  now = Date.now()
): ExecutorDeviceViewState {
  if (device.status === "revoked") return "revoked";

  const heartbeatAt = device.last_heartbeat_at ? Date.parse(device.last_heartbeat_at) : Number.NaN;
  if (!Number.isFinite(heartbeatAt) || now - heartbeatAt >= EXECUTOR_HEARTBEAT_FRESH_MS) {
    return "offline";
  }

  if (device.status === "authentication_required") return "authentication_required";
  if (device.status === "mcp_unavailable") return "mcp_unavailable";
  return device.status === "online" ? "online" : "offline";
}

export function executorDeviceStatusLabel(state: ExecutorDeviceViewState) {
  if (state === "online") return "在线";
  if (state === "authentication_required") return "等待淘宝重新登录";
  if (state === "mcp_unavailable") return "淘宝工具重连中";
  if (state === "revoked") return "已撤销";
  return "离线";
}

export function isTaobaoMcpReconnecting(status: MpcStatus | null) {
  return status?.mode === "local_executor"
    && status.search_available === false
    && (status.executor_devices?.mcp_unavailable ?? 0) > 0
    && (status.executor_devices?.authentication_required ?? 0) === 0;
}

export function isLocalExecutorUnavailable(status: MpcStatus | null) {
  return status?.mode === "local_executor"
    && status.search_available === false;
}

export function shouldOfferWorkflowResume(
  workflowPaused: boolean,
  authenticationPaused: boolean,
  status: MpcStatus | null
) {
  if (!workflowPaused || authenticationPaused) return false;
  return status?.mode === "local_executor";
}

export function shouldPresentActiveTaobaoSearch(
  workflowActive: boolean,
  authenticationPaused: boolean,
  status: MpcStatus | null
) {
  return workflowActive
    && !authenticationPaused
    && status?.search_available !== false
    && !isLocalExecutorUnavailable(status);
}
