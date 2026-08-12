import { describe, expect, it } from "vitest";
import {
  isExecutorDeviceOnline,
  isExecutorDeviceResponsive,
  summarizeExecutorDevices
} from "@/lib/runtime/executor-status";
import type { ExecutorDevice } from "@/lib/runtime/types";

function device(input: Partial<ExecutorDevice> & Pick<ExecutorDevice, "id" | "capabilities">): ExecutorDevice {
  const now = new Date().toISOString();
  return {
    user_id: "user-capability-test",
    name: input.id,
    token_hash: `token-${input.id}`,
    status: "online",
    last_heartbeat_at: now,
    created_at: now,
    updated_at: now,
    ...input
  };
}

describe("executor capability status", () => {
  it("counts only fresh, non-revoked devices as available", () => {
    const now = Date.now();
    const devices = [
      device({ id: "search", capabilities: ["module_search"], last_heartbeat_at: new Date(now - 1_000).toISOString() }),
      device({ id: "cart-stale", capabilities: ["add_to_cart"], last_heartbeat_at: new Date(now - 60_000).toISOString() }),
      device({ id: "revoked", capabilities: ["module_search", "add_to_cart"], status: "revoked" })
    ];

    const summary = summarizeExecutorDevices(devices, now);
    expect(summary.registered).toBe(2);
    expect(summary.online).toBe(1);
    expect(summary.capabilities.module_search).toEqual({ registered: 1, online: 1, available: true });
    expect(summary.capabilities.add_to_cart).toEqual({ registered: 1, online: 0, available: false });
    expect(isExecutorDeviceOnline(devices[1], now)).toBe(false);
  });

  it("keeps an authentication-paused heartbeat visible without advertising shopping capability", () => {
    const now = Date.now();
    const authPaused = device({
      id: "auth-paused",
      capabilities: ["module_search", "add_to_cart"],
      status: "authentication_required",
      last_heartbeat_at: new Date(now - 1_000).toISOString()
    });

    const summary = summarizeExecutorDevices([authPaused], now);
    expect(summary).toMatchObject({
      registered: 1,
      online: 0,
      authentication_required: 1,
      capabilities: {
        module_search: { registered: 1, online: 0, available: false },
        add_to_cart: { registered: 1, online: 0, available: false }
      }
    });
    expect(isExecutorDeviceOnline(authPaused, now)).toBe(false);
    expect(isExecutorDeviceResponsive(authPaused, now)).toBe(true);
  });

  it("does not keep a stale authentication pause visible", () => {
    const now = Date.now();
    const authPaused = device({
      id: "auth-paused-stale",
      capabilities: ["module_search"],
      status: "authentication_required",
      last_heartbeat_at: new Date(now - 60_000).toISOString()
    });

    const summary = summarizeExecutorDevices([authPaused], now);
    expect(summary.authentication_required).toBe(0);
    expect(summary.online).toBe(0);
    expect(summary.capabilities.module_search.available).toBe(false);
    expect(isExecutorDeviceResponsive(authPaused, now)).toBe(false);
  });
});
