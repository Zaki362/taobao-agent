import { beforeEach, describe, expect, it, vi } from "vitest";

const { executorSummary } = vi.hoisted(() => ({
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
  getRequestIdentity: async () => ({ userId: "user-local-status-test" })
}));

vi.mock("@/lib/runtime", () => ({
  getRuntimeRepository: () => ({ listDevices: vi.fn().mockResolvedValue([]) })
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
  executorSummary.online = 0;
  executorSummary.mcp_unavailable = 1;
  executorSummary.authentication_required = 0;
  executorSummary.capabilities.module_search.available = false;
  executorSummary.capabilities.module_search.online = 0;
  executorSummary.capabilities.add_to_cart.available = false;
  executorSummary.capabilities.add_to_cart.online = 0;
});

describe("GET /api/mcp/status with the local executor", () => {
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
