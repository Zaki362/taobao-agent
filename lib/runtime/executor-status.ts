import type { ExecutorCapability, ExecutorDevice } from "@/lib/runtime/types";

export const EXECUTOR_ONLINE_WINDOW_MS = 45_000;
export const EXECUTOR_CAPABILITIES: ExecutorCapability[] = ["module_search", "add_to_cart"];

export interface ExecutorCapabilitySummary {
  registered: number;
  online: number;
  available: boolean;
}

export interface ExecutorDeviceSummary {
  registered: number;
  online: number;
  mcp_unavailable: number;
  authentication_required: number;
  capabilities: Record<ExecutorCapability, ExecutorCapabilitySummary>;
}

export function isExecutorDeviceResponsive(device: ExecutorDevice, now = Date.now()) {
  if (device.status === "revoked" || !device.last_heartbeat_at) return false;
  const heartbeat = Date.parse(device.last_heartbeat_at);
  return Number.isFinite(heartbeat) && now - heartbeat < EXECUTOR_ONLINE_WINDOW_MS;
}

export function isExecutorDeviceOnline(device: ExecutorDevice, now = Date.now()) {
  return device.status === "online" && isExecutorDeviceResponsive(device, now);
}

export function summarizeExecutorDevices(
  devices: ExecutorDevice[],
  now = Date.now()
): ExecutorDeviceSummary {
  const registeredDevices = devices.filter((device) => device.status !== "revoked");
  const onlineDevices = registeredDevices.filter((device) => isExecutorDeviceOnline(device, now));
  const authenticationRequiredDevices = registeredDevices.filter(
    (device) => device.status === "authentication_required" && isExecutorDeviceResponsive(device, now)
  );
  const mcpUnavailableDevices = registeredDevices.filter(
    (device) => device.status === "mcp_unavailable" && isExecutorDeviceResponsive(device, now)
  );
  const capabilities = Object.fromEntries(
    EXECUTOR_CAPABILITIES.map((capability) => {
      const registered = registeredDevices.filter((device) => device.capabilities.includes(capability)).length;
      const online = onlineDevices.filter((device) => device.capabilities.includes(capability)).length;
      return [capability, { registered, online, available: online > 0 }];
    })
  ) as Record<ExecutorCapability, ExecutorCapabilitySummary>;

  return {
    registered: registeredDevices.length,
    online: onlineDevices.length,
    mcp_unavailable: mcpUnavailableDevices.length,
    authentication_required: authenticationRequiredDevices.length,
    capabilities
  };
}
