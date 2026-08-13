import { beforeEach, describe, expect, it, vi } from "vitest";

const { executorSummary, requestIdentity, listDevices } = vi.hoisted(() => ({
  requestIdentity: { userId: "user-local-status-test" as string | undefined },
  listDevices: vi.fn().mockResolvedValue([]),
  executorSummary: {
    registered: 1,
    online: 0,
    mcp_unavailable: 1,
    authentication_required: 0,
    capabilities: {
      module_search: { registered: 1, online: 0, available: false },
      add_to_cart: { registered: 1, online: 0, available: false }
    }
  }
}));

vi.mock("@/lib/mcp/client", () => ({
  getConfiguredExecutionBackend: () => "local_executor",
  getExecutionBackend: () => "local_executor",
  getMcpClient: vi.fn()
}));

vi.mock("@/lib/auth/request", () => ({
  getRequestIdentity: async () => requestIdentity
}));

vi.mock("@/lib/runtime", () => ({
  getRuntimeRepository: () => ({ listDevices })
}));

vi.mock("@/lib/runtime/product-mode", () => ({
  allowDemoCartFallback: () => false,
  getProductMode: () => "production"
}));

vi.mock("@/lib/runtime/executor-status", () => ({
  summarizeExecutorDevices: () => executorSummary
}));

import { GET } from "@/app/api/mcp/status/route";

beforeEach(() => {
  requestIdentity.userId = "user-local-status-test";
  listDevices.mockClear();
  executorSummary.online = 0;
  executorSummary.mcp_unavailable = 1;
  executorSummary.authentication_required = 0;
  executorSummary.capabilities.module_search.available = false;
  executorSummary.capabilities.module_search.online = 0;
  executorSummary.capabilities.add_to_cart.available = false;
  executorSummary.capabilities.add_to_cart.online = 0;
});

describe("GET /api/mcp/status with the local executor", () => {
  it("uses all local devices for an intentionally anonymous development session", async () => {
    requestIdentity.userId = undefined;

    const response = await GET();

    expect(response.status).toBe(200);
    expect(listDevices).toHaveBeenCalledWith(undefined);
  });

  it("keeps authenticated device status scoped to the signed-in account", async () => {
    await GET();

    expect(listDevices).toHaveBeenCalledWith("user-local-status-test");
  });

  it("keeps search unavailable while a responsive Worker reconnects to Taobao MCP", async () => {
    const response = await GET();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      mode: "local_executor",
      search_available: false,
      cart_available: false,
      available: false,
      executor_devices: {
        online: 0,
        mcp_unavailable: 1,
        capabilities: {
          module_search: { available: false },
          add_to_cart: { available: false }
        }
      }
    });
    expect(payload).not.toHaveProperty("search_provider");
    expect(payload).not.toHaveProperty("taobao_union");
    expect(payload.message).toContain("持续检测");
    expect(payload.message).toContain("自动领取");
  });

  it("reports search and cart capabilities independently", async () => {
    executorSummary.online = 1;
    executorSummary.mcp_unavailable = 0;
    executorSummary.capabilities.module_search.available = true;
    executorSummary.capabilities.module_search.online = 1;

    const searchOnlyPayload = await (await GET()).json();
    expect(searchOnlyPayload).toMatchObject({
      search_available: true,
      cart_available: false,
      available: true
    });
    expect(searchOnlyPayload.permissions_scope).toEqual([
      "本地淘宝搜索",
      "本地商品详情",
      "加购需显式确认"
    ]);

    executorSummary.capabilities.add_to_cart.available = true;
    executorSummary.capabilities.add_to_cart.online = 1;

    const shoppingPayload = await (await GET()).json();
    expect(shoppingPayload.search_available).toBe(true);
    expect(shoppingPayload.cart_available).toBe(true);
    expect(shoppingPayload.message).toContain("显式确认后的真实加购均可执行");
  });
});
