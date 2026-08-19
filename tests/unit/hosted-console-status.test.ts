import { describe, expect, it } from "vitest";
import { executionConsoleStatus } from "@/components/hosted-console-status";
import type { MpcStatus } from "@/components/dashboard-types";

function localStatus(input: Partial<MpcStatus["executor_devices"]> = {}): MpcStatus {
  return {
    mode: "local_executor",
    search_available: false,
    cart_available: false,
    available: false,
    message: "真实状态说明",
    permissions_scope: [],
    executor_devices: {
      online: 0,
      registered: 1,
      mcp_unavailable: 0,
      authentication_required: 0,
      capabilities: {
        module_search: { registered: 1, online: 0, available: false },
        add_to_cart: { registered: 1, online: 0, available: false }
      },
      ...input
    }
  };
}

describe("hosted execution console status", () => {
  it("shows a responsive Worker as waiting for login instead of offline", () => {
    const status = executionConsoleStatus({
      executionMode: "local_executor",
      activeTaskCount: 2,
      mcpStatus: localStatus({ authentication_required: 1 }),
      workerStatus: null
    });

    expect(status).toMatchObject({
      tone: "critical",
      title: expect.stringContaining("有响应")
    });
    expect(status.title).toContain("重新登录");
  });

  it("shows MCP reconnecting separately from a Worker disconnect", () => {
    const status = executionConsoleStatus({
      executionMode: "local_executor",
      activeTaskCount: 1,
      mcpStatus: localStatus({ mcp_unavailable: 1 }),
      workerStatus: null
    });

    expect(status).toMatchObject({
      tone: "warning",
      title: expect.stringContaining("MCP 重连中")
    });
    expect(status.title).toContain("有响应");
  });

  it("only reports the real Taobao chain as available when search is available", () => {
    const mcpStatus = localStatus({ online: 1 });
    mcpStatus.search_available = true;
    mcpStatus.available = true;

    expect(executionConsoleStatus({
      executionMode: "local_executor",
      activeTaskCount: 0,
      mcpStatus,
      workerStatus: null
    })).toMatchObject({
      tone: "healthy",
      title: "真实淘宝执行链路可用"
    });
  });

  it("reports a registered but unresponsive Worker as offline", () => {
    expect(executionConsoleStatus({
      executionMode: "local_executor",
      activeTaskCount: 1,
      mcpStatus: localStatus(),
      workerStatus: null
    })).toMatchObject({
      tone: "critical",
      title: "本地执行器未响应"
    });
  });
});
