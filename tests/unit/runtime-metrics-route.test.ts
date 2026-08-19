import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createSessionFixture } from "@/tests/fixtures/session";

const {
  ensureSession,
  getRequestIdentity,
  listJobs,
  listDevices,
  listAuditEvents,
  getServiceHeartbeat
} = vi.hoisted(() => ({
  ensureSession: vi.fn(),
  getRequestIdentity: vi.fn(),
  listJobs: vi.fn(),
  listDevices: vi.fn(),
  listAuditEvents: vi.fn(),
  getServiceHeartbeat: vi.fn()
}));

vi.mock("@/lib/auth/request", () => ({ getRequestIdentity }));
vi.mock("@/lib/agent/orchestrator", () => ({ ensureSession }));
vi.mock("@/lib/runtime", () => ({
  getRuntimeRepository: () => ({
    listJobs,
    listDevices,
    listAuditEvents,
    getServiceHeartbeat
  })
}));

import { GET } from "@/app/api/runtime/metrics/route";

const NOW = new Date("2026-08-19T08:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  ensureSession.mockReset().mockResolvedValue(createSessionFixture({ session_id: "session-metrics" }));
  getRequestIdentity.mockReset().mockResolvedValue({ userId: undefined });
  listJobs.mockReset().mockResolvedValue([{
    id: "detail-pending",
    session_id: "session-metrics",
    job_type: "product_detail",
    status: "pending",
    created_at: new Date(NOW.getTime() - 10_000).toISOString()
  }]);
  listDevices.mockReset().mockResolvedValue([{
    id: "device-mcp-reconnecting",
    user_id: "local-user",
    name: "Local Worker",
    token_hash: "hash",
    capabilities: ["module_search"],
    status: "mcp_unavailable",
    last_heartbeat_at: NOW.toISOString(),
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString()
  }]);
  listAuditEvents.mockReset().mockResolvedValue([]);
  getServiceHeartbeat.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/runtime/metrics", () => {
  it("uses the local anonymous device visibility rule and exposes MCP/detail state", async () => {
    const response = await GET(new NextRequest(
      "http://localhost/api/runtime/metrics?session_id=session-metrics"
    ));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(listDevices).toHaveBeenCalledWith(undefined);
    expect(payload.devices).toMatchObject({
      online: 0,
      mcp_unavailable: 1,
      authentication_required: 0
    });
    expect(payload.jobs.by_type.product_detail).toMatchObject({
      total: 1,
      pending: 1,
      active: 0
    });
    expect(payload.health.incidents).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "executor_mcp_unavailable" })
    ]));
    expect(payload.health.incidents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "executor_offline_with_work" })
    ]));
  });
});
