import { describe, expect, it } from "vitest";
import {
  EXECUTOR_HEARTBEAT_FRESH_MS,
  MCP_STATUS_REFRESH_MS,
  executorDeviceStatusLabel,
  executorDeviceViewState,
  isTaobaoMcpReconnecting,
  shouldOfferWorkflowResume,
  shouldPresentActiveTaobaoSearch
} from "@/components/executor-status-view";
import type { MpcStatus } from "@/components/dashboard-types";

const now = Date.parse("2026-08-12T08:00:00.000Z");
const freshHeartbeat = new Date(now - 1_000).toISOString();

function localStatus(overrides: Partial<MpcStatus> = {}): MpcStatus {
  return {
    mode: "local_executor",
    search_available: false,
    cart_available: false,
    available: false,
    message: "淘宝工具暂不可用",
    permissions_scope: ["module_search"],
    executor_devices: {
      online: 0,
      registered: 1,
      mcp_unavailable: 1,
      authentication_required: 0,
      capabilities: {
        module_search: { registered: 1, online: 0, available: false },
        add_to_cart: { registered: 0, online: 0, available: false }
      }
    },
    ...overrides
  };
}

describe("executor status presentation", () => {
  it("only presents a fresh online heartbeat as online", () => {
    expect(executorDeviceViewState({ status: "online", last_heartbeat_at: freshHeartbeat }, now)).toBe("online");
    expect(executorDeviceStatusLabel("online")).toBe("在线");

    const staleHeartbeat = new Date(now - EXECUTOR_HEARTBEAT_FRESH_MS).toISOString();
    expect(executorDeviceViewState({ status: "online", last_heartbeat_at: staleHeartbeat }, now)).toBe("offline");
  });

  it("distinguishes fresh auth and Taobao MCP failures from an offline worker", () => {
    expect(executorDeviceViewState({
      status: "authentication_required",
      last_heartbeat_at: freshHeartbeat
    }, now)).toBe("authentication_required");
    expect(executorDeviceViewState({
      status: "mcp_unavailable",
      last_heartbeat_at: freshHeartbeat
    }, now)).toBe("mcp_unavailable");
    expect(executorDeviceStatusLabel("mcp_unavailable")).toBe("淘宝工具重连中");
    expect(executorDeviceViewState({ status: "mcp_unavailable" }, now)).toBe("offline");
  });

  it("treats login recovery separately from automatic MCP reconnect", () => {
    expect(isTaobaoMcpReconnecting(localStatus())).toBe(true);
    expect(isTaobaoMcpReconnecting(localStatus({
      executor_devices: {
        ...localStatus().executor_devices!,
        authentication_required: 1
      }
    }))).toBe(false);
    expect(isTaobaoMcpReconnecting(localStatus({ available: true, search_available: true }))).toBe(false);
  });

  it("keeps the local status refresh cadence at five seconds", () => {
    expect(MCP_STATUS_REFRESH_MS).toBe(5_000);
  });

  it("never presents an unavailable executor as actively comparing Taobao products", () => {
    expect(shouldPresentActiveTaobaoSearch(true, false, localStatus())).toBe(false);
    expect(shouldPresentActiveTaobaoSearch(true, true, localStatus({ available: true, search_available: true }))).toBe(false);
    expect(shouldPresentActiveTaobaoSearch(true, false, localStatus({ available: true, search_available: true }))).toBe(true);
  });

  it("offers resume only for a user-paused local workflow without an auth hold", () => {
    expect(shouldOfferWorkflowResume(true, false, localStatus())).toBe(true);
    expect(shouldOfferWorkflowResume(true, true, localStatus())).toBe(false);
    expect(shouldOfferWorkflowResume(false, false, localStatus())).toBe(false);
    expect(shouldOfferWorkflowResume(true, false, localStatus({ mode: "qoder_cli" }))).toBe(false);
  });
});
