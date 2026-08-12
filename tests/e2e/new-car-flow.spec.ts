import { expect, test, type APIRequestContext, type Page, type Request } from "@playwright/test";
import protocol from "../../lib/runtime/executor-protocol.json";

const recommendationTypes = ["稳妥推荐", "性价比推荐", "升级推荐"] as const;
const recoverySecret = "playwright-recovery-secret-with-at-least-32-characters";
const executorHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "X-SceneCart-Executor-Protocol": protocol.version
});

async function returnToLandingWithoutLocalSnapshot(page: Page) {
  await page.goto("/");
  await page.evaluate(() => {
    window.localStorage.removeItem("scenecart-dashboard-state");
  });
  await page.reload();
  const recentTasks = page.locator("#recent-tasks");
  await expect(recentTasks).toBeVisible();
  const closedRecentTasksSummary = page.locator("#recent-tasks:not([open]) > summary");
  if (await closedRecentTasksSummary.count()) {
    await closedRecentTasksSummary.click();
  }
  await expect(recentTasks).toHaveAttribute("open", "");
  await expect(recentTasks.getByText("继续未完成的方案", { exact: true })).toBeVisible();
}

function candidatesFor(job: { id: string; payload: Record<string, unknown> }) {
  const moduleId = String(job.payload.module_id ?? "module");
  const moduleName = String(job.payload.module_name ?? "新车用品");
  const moduleBudget = Math.max(1, Number(job.payload.budget) || 200);
  const ratios = moduleName.includes("安全") ? [1.2, 1.35, 1.5] : [0.25, 0.35, 0.45];
  return recommendationTypes.map((recommendationType, index) => ({
    product_id: `${moduleId}-${index + 1}`,
    title: `${moduleName} E2E 真实链路候选 ${index + 1}`,
    price: Math.round(moduleBudget * ratios[index] * 100) / 100,
    source: "淘宝",
    shop_name: `测试旗舰店 ${index + 1}`,
    image_url: "https://img.alicdn.com/imgextra/i1/O1CN01dummy.jpg",
    detail_url: `https://item.taobao.com/item.htm?id=${encodeURIComponent(`${moduleId}${index + 1}`)}`,
    shop_badges: ["旗舰店"],
    highlights: ["适配新车阶段", "真实价格样本"],
    risk_notes: ["当前为搜索结果摘要，未自动打开详情页，建议点开淘宝详情页确认规格与适配性"],
    fit_reason: `符合${moduleName}模块的预算和使用阶段。`,
    recommendation_type: recommendationType,
    module_id: moduleId
  }));
}

function verifiedSearchResultFor(job: { id: string; payload: Record<string, unknown> }) {
  const candidates = candidatesFor(job);
  return {
    summary: "E2E 本地执行器已完成淘宝候选回填",
    candidates,
    evidence: {
      schema: "scenecart.taobao-mcp-search-evidence/v1",
      source: "taobao-mcp",
      tool: "search_products",
      source_app: "SceneCartE2E",
      job_id: job.id,
      module_id: String(job.payload.module_id ?? ""),
      workflow_run_id: String(job.payload.workflow_run_id ?? ""),
      keyword: String(job.payload.keyword ?? ""),
      captured_at: new Date().toISOString(),
      cache_hit: false,
      raw_result_count: candidates.length
    }
  };
}

async function runExecutorUntilStopped(
  api: APIRequestContext,
  token: string,
  shouldStop: () => boolean,
  behavior?: {
    failFirstModuleSearch: boolean;
    failedModuleId?: string;
  }
) {
  const headers = executorHeaders(token);
  while (!shouldStop()) {
    let claim;
    try {
      claim = await api.post("/api/executor/jobs/claim", { headers, data: {}, timeout: 5_000 });
    } catch (error) {
      if (shouldStop()) return;
      // Next.js dev compilation can briefly hold the local endpoint. A real worker
      // treats this as a transient transport failure and continues polling.
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    expect(claim.ok()).toBeTruthy();
    const { job } = await claim.json() as {
      job: null | {
        id: string;
        job_type: "module_search" | "add_to_cart";
        payload: Record<string, unknown>;
      };
    };
    if (!job) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      continue;
    }

    if (job.job_type === "module_search" && behavior?.failFirstModuleSearch && !behavior.failedModuleId) {
      behavior.failedModuleId = String(job.payload.module_id ?? "");
      const failed = await api.post(`/api/executor/jobs/${job.id}/resolve`, {
        headers,
        data: {
          status: "failed",
          error: "E2E 注入一次不可重试搜索失败",
          retryable: false
        }
      });
      expect(failed.ok()).toBeTruthy();
      continue;
    }

    const result = job.job_type === "module_search"
      ? verifiedSearchResultFor(job)
      : {
          success: true,
          message: "E2E 本地执行器已完成加购",
          product_id: job.payload.product_id
        };
    const resolved = await api.post(`/api/executor/jobs/${job.id}/resolve`, {
      headers,
      data: { status: "completed", result }
    });
    expect(resolved.ok()).toBeTruthy();
  }
}

test("authenticated new-car workflow reaches recommendations through the durable executor", async ({ page }) => {
  const blockedCrossSiteRequest = await page.request.post("/api/auth/login", {
    headers: { Origin: "https://malicious.example" },
    data: { email: "blocked@example.com", password: "blocked-password" }
  });
  expect(blockedCrossSiteRequest.status()).toBe(403);

  await page.goto("/settings/executor");
  await expect(page).toHaveURL(/\/login\?next=%2Fsettings%2Fexecutor$/);
  await page.getByRole("button", { name: "还没有账号？创建账号" }).click();
  await page.getByLabel("邮箱").fill(`e2e-${Date.now()}@example.com`);
  await page.getByLabel("密码").fill("e2e-secure-password");
  await page.getByRole("button", { name: "注册并登录" }).click();
  await expect(page).toHaveURL(/\/settings\/executor$/);

  const blockedRecovery = await page.request.get("/api/internal/workflow-recovery");
  expect(blockedRecovery.status()).toBe(401);
  const authorizedRecovery = await page.request.get("/api/internal/workflow-recovery", {
    headers: { Authorization: `Bearer ${recoverySecret}` }
  });
  const authorizedRecoveryPayload = await authorizedRecovery.json();
  expect(authorizedRecovery.ok(), JSON.stringify(authorizedRecoveryPayload)).toBeTruthy();
  expect(authorizedRecoveryPayload).toMatchObject({ scanned: 0, recovered: 0 });

  const deviceResponse = await page.request.post("/api/executor/devices", {
    headers: { Origin: "http://127.0.0.1:3100" },
    data: { name: "Playwright 淘宝执行器", capabilities: ["module_search"] }
  });
  expect(deviceResponse.status()).toBe(201);
  const registeredDevice = await deviceResponse.json() as {
    device_token: string;
    device: { id: string };
  };
  const deviceToken = registeredDevice.device_token;
  const heartbeatResponse = await page.request.post("/api/executor/heartbeat", {
    headers: executorHeaders(deviceToken),
    data: {}
  });
  expect(heartbeatResponse.ok()).toBeTruthy();
  const heartbeat = await heartbeatResponse.json() as {
    device: { capabilities: string[] };
    protocol_version: string;
  };
  expect(heartbeat.device.capabilities).toEqual(["module_search"]);
  expect(heartbeat.protocol_version).toBe(protocol.version);

  await page.goto("/settings/executor");
  await expect(page.getByRole("heading", { name: "连接这台电脑上的淘宝执行器" })).toBeVisible();
  await page.getByRole("button", { name: "注册当前设备" }).click();
  await expect(page.getByRole("heading", { name: "保存一次性设备令牌" })).toBeVisible();
  await expect(page.getByText(
    "SCENECART_API_URL=http://127.0.0.1:3100 npm run executor:configure",
    { exact: true }
  )).toBeVisible();
  await expect(page.getByText("输入过程不会回显，也不会把令牌写入 shell history", { exact: false })).toBeVisible();
  const freshLandingMcpStatusResponse = page.waitForResponse((response) =>
    response.request().method() === "GET" && new URL(response.url()).pathname === "/api/mcp/status"
  );
  await page.goto("/");
  expect((await freshLandingMcpStatusResponse).ok()).toBeTruthy();

  const outdatedHeartbeat = await page.request.post("/api/executor/heartbeat", {
    headers: {
      Authorization: `Bearer ${deviceToken}`,
      "X-SceneCart-Executor-Protocol": "1"
    },
    data: {}
  });
  expect(outdatedHeartbeat.status()).toBe(426);

  const mcpStatusResponse = await page.request.get("/api/mcp/status");
  expect(mcpStatusResponse.ok()).toBeTruthy();
  const mcpStatus = await mcpStatusResponse.json() as {
    mode: string;
    available: boolean;
    executor_devices: {
      capabilities: {
        module_search: { available: boolean };
        add_to_cart: { available: boolean };
      };
    };
  };
  expect(mcpStatus.mode).toBe("local_executor");
  expect(mcpStatus.available).toBe(true);
  expect(mcpStatus.executor_devices.capabilities.module_search.available).toBe(true);
  expect(mcpStatus.executor_devices.capabilities.add_to_cart.available).toBe(false);

  const capabilityUpdate = await page.request.patch("/api/executor/devices", {
    headers: { Origin: "http://127.0.0.1:3100" },
    data: {
      device_id: registeredDevice.device.id,
      capabilities: ["module_search", "add_to_cart"]
    }
  });
  expect(capabilityUpdate.ok(), await capabilityUpdate.text()).toBeTruthy();
  const devicesAfterUpdate = await page.request.get("/api/executor/devices");
  expect(devicesAfterUpdate.ok()).toBeTruthy();
  const deviceAudit = await devicesAfterUpdate.json() as {
    audit_events: Array<{ event_type: string; payload: Record<string, unknown> }>;
  };
  expect(deviceAudit.audit_events.some((event) =>
    event.event_type === "executor.capabilities_updated" &&
    Array.isArray(event.payload.added) &&
    event.payload.added.includes("add_to_cart")
  )).toBe(true);
  const updatedMcpStatus = await page.request.get("/api/mcp/status");
  expect(updatedMcpStatus.ok()).toBeTruthy();
  expect((await updatedMcpStatus.json() as typeof mcpStatus).executor_devices.capabilities.add_to_cart.available).toBe(true);

  const readinessResponse = await page.request.get("/api/runtime/readiness");
  expect(readinessResponse.ok()).toBeTruthy();
  const readiness = await readinessResponse.json() as {
    ready_for_production: boolean;
    operational_for_shopping: boolean;
    workflow_recovery: { state: string };
    checks: Array<{ id: string; status: string }>;
  };
  expect(readiness.ready_for_production).toBe(false);
  expect(readiness.operational_for_shopping).toBe(false);
  expect(readiness.workflow_recovery.state).toBe("healthy");
  expect(readiness.checks.find((item) => item.id === "workflow_recovery")?.status).toBe("pass");

  let stopExecutor = false;
  const executorBehavior = { failFirstModuleSearch: true, failedModuleId: undefined as string | undefined };
  let executor: Promise<void> | null = null;

  try {
    await page.getByRole("button", { name: "新车选购 提车初期分阶段补齐高频车用品" }).click();
    await page.locator("textarea").fill(
      "刚提新能源 SUV，预算 3000，经常带 3 岁孩子长途出行，已有行车记录仪，希望优先准备儿童乘车安全用品。"
    );
    await page.getByRole("button", { name: "开始理解需求" }).click();
    await expect(page.getByText("确认新车选购需求")).toBeVisible();
    await page.getByRole("button", { name: "确认无误，生成购买路线" }).click();
    await expect(page.getByText("确认新车购物规划")).toBeVisible();
    await expect(page.getByText("儿童安全出行", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("AI 新增", { exact: true }).first()).toBeVisible();
    const persistedSessionId = await page.evaluate(() => {
      const raw = window.localStorage.getItem("scenecart-dashboard-state");
      if (!raw) return "";
      return String((JSON.parse(raw) as { sessionId?: string }).sessionId ?? "");
    });
    expect(persistedSessionId).not.toBe("");
    const workflowRequestCounts = { mcpStatus: 0, agentRun: 0, legacyModuleSearch: 0 };
    const trackWorkflowRequest = (request: Request) => {
      const pathname = new URL(request.url()).pathname;
      if (request.method() === "GET" && pathname === "/api/mcp/status") workflowRequestCounts.mcpStatus += 1;
      if (request.method() !== "POST") return;
      if (pathname === "/api/agent/run") workflowRequestCounts.agentRun += 1;
      if (pathname === "/api/modules/search") workflowRequestCounts.legacyModuleSearch += 1;
    };
    page.on("request", trackWorkflowRequest);
    await page.getByRole("button", { name: "就按这个方案开始找商品" }).click();

    await expect(page.getByText("Agent 正在行动", { exact: true })).toBeVisible();
    await expect.poll(async () => {
      const response = await page.request.get(`/api/session/state?session_id=${persistedSessionId}`);
      const state = await response.json() as {
        agent_runtime: { workflow_status: string };
      };
      return state.agent_runtime.workflow_status;
    }, { timeout: 30_000 }).toBe("waiting_for_tools");
    page.off("request", trackWorkflowRequest);
    expect(workflowRequestCounts).toEqual({ mcpStatus: 1, agentRun: 1, legacyModuleSearch: 0 });
    const waitingStateResponse = await page.request.get(`/api/session/state?session_id=${persistedSessionId}`);
    const waitingState = await waitingStateResponse.json() as {
      hosted_tasks: Array<{ task_type: string; status: string }>;
    };
    expect(waitingState.hosted_tasks.filter((task) =>
      task.task_type === "module_search" && (task.status === "pending" || task.status === "running")
    )).toHaveLength(1);

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "完成当前项后暂停" }).click();
    await expect(page.getByRole("button", { name: "继续搜索" })).toBeEnabled();
    const pausedResponse = await page.request.get(`/api/session/state?session_id=${persistedSessionId}`);
    const pausedState = await pausedResponse.json() as {
      agent_runtime: { workflow_status: string; auto_continue: boolean; workflow_run_id?: string };
    };
    expect(pausedState.agent_runtime).toMatchObject({ workflow_status: "paused", auto_continue: false });
    const originalWorkflowRunId = pausedState.agent_runtime.workflow_run_id;

    executor = runExecutorUntilStopped(page.request, deviceToken, () => stopExecutor, executorBehavior);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "继续搜索" }).click();
    await expect.poll(async () => {
      const response = await page.request.get(`/api/session/state?session_id=${persistedSessionId}`);
      const state = await response.json() as {
        agent_runtime: { workflow_status: string; auto_continue: boolean; workflow_run_id?: string };
      };
      return {
        autoContinue: state.agent_runtime.auto_continue,
        sameRun: state.agent_runtime.workflow_run_id === originalWorkflowRunId
      };
    }, { timeout: 30_000 }).toEqual({ autoContinue: true, sameRun: true });

    // Leave the product page after the first task is queued. The server and local executor
    // must continue the remaining modules without a browser-driven action loop.
    await page.goto("/settings/executor");
    await expect(page.getByText("正式运行就绪度")).toBeVisible();
    await expect.poll(async () => {
      const response = await page.request.get(`/api/session/state?session_id=${persistedSessionId}`);
      const state = await response.json() as {
        agent_runtime: { workflow_status: string };
      };
      return state.agent_runtime.workflow_status;
    }, { timeout: 120_000, intervals: [250, 500, 1_000] }).toBe("completed");

    const completedStateResponse = await page.request.get(`/api/session/state?session_id=${persistedSessionId}`);
    const completedState = await completedStateResponse.json() as {
      raw_input: string;
      agent_runtime: { continuation_count: number; auto_continue: boolean };
      shopping_plan: { modules: Array<{ module_id: string }> };
      module_candidates: Record<string, unknown[]>;
      completion_report: {
        status: string;
        total_modules: number;
        covered_module_ids: string[];
        uncovered_module_ids: string[];
        stop_reason: string;
        purchase_bundle: {
          estimated_total: number;
          total_budget: number;
          items: Array<{ product_id: string; module_id: string }>;
          refinement_suggestions?: Array<{ action: string; target_module_ids: string[] }>;
        };
      };
    };
    expect(completedState.agent_runtime.auto_continue).toBe(false);
    expect(completedState.agent_runtime.continuation_count).toBeGreaterThanOrEqual(
      completedState.shopping_plan.modules.length
    );
    expect(executorBehavior.failedModuleId).toBeTruthy();
    expect(Object.keys(completedState.module_candidates)).toHaveLength(completedState.shopping_plan.modules.length - 1);
    expect(completedState.completion_report.total_modules).toBe(completedState.shopping_plan.modules.length);
    expect(completedState.completion_report.status).toBe("needs_attention");
    expect(completedState.completion_report.covered_module_ids).toHaveLength(completedState.shopping_plan.modules.length - 1);
    expect(completedState.completion_report.uncovered_module_ids).toEqual([executorBehavior.failedModuleId]);
    expect(completedState.completion_report.stop_reason.length).toBeGreaterThan(0);
    expect(completedState.completion_report.purchase_bundle.estimated_total).toBeLessThanOrEqual(
      completedState.completion_report.purchase_bundle.total_budget
    );
    expect(new Set(completedState.completion_report.purchase_bundle.items.map((item) => item.module_id)).size)
      .toBe(completedState.completion_report.purchase_bundle.items.length);
    expect(completedState.completion_report.purchase_bundle.refinement_suggestions?.length).toBeGreaterThan(0);
    expect(completedState.completion_report.purchase_bundle.refinement_suggestions?.every((suggestion) =>
      suggestion.action !== "我已有行车记录仪" &&
      suggestion.target_module_ids.every((moduleId) =>
        completedState.shopping_plan.modules.some((module) => module.module_id === moduleId)
      )
    )).toBe(true);

    await page.goto("/?resume=1");
    await expect(page.getByText("Agent 正在行动", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "查看推荐结果" })).toBeEnabled();
    await page.getByRole("button", { name: "查看推荐结果" }).click();
    await expect(page.getByText("这个分类暂时没有可用商品")).toBeVisible();
    await expect(page.getByText("Agent 建议清单", { exact: true })).toBeVisible();
    await expect(page.getByText("还有可以补强的地方")).toHaveCount(0);
    await expect(page.getByText("换个思路", { exact: true })).toHaveCount(0);

    const completedSessionListResponse = await page.request.get("/api/sessions");
    const completedSessionList = await completedSessionListResponse.json() as {
      sessions: Array<{
        session_id: string;
        completion_report?: { total_modules: number; stop_reason: string };
      }>;
    };
    const completedSessionSummary = completedSessionList.sessions.find(
      (session) => session.session_id === persistedSessionId
    );
    expect(completedSessionSummary?.completion_report?.total_modules).toBe(
      completedState.shopping_plan.modules.length
    );
    expect(completedSessionSummary?.completion_report?.stop_reason.length).toBeGreaterThan(0);

    const compactSessionListResponse = await page.request.get("/api/sessions?view=summary&limit=3");
    expect(compactSessionListResponse.ok()).toBeTruthy();
    const compactSessionList = await compactSessionListResponse.json() as {
      sessions: Array<{
        session_id: string;
        resume_stage: string;
        status_label: string;
        covered_module_count: number;
        module_count: number;
        tool_logs?: unknown;
        module_candidates?: unknown;
      }>;
    };
    const compactSession = compactSessionList.sessions.find((item) => item.session_id === persistedSessionId);
    expect(compactSession).toMatchObject({
      resume_stage: "review_results",
      status_label: "推荐已生成",
      covered_module_count: completedState.shopping_plan.modules.length - 1,
      module_count: completedState.shopping_plan.modules.length
    });
    expect(compactSession).not.toHaveProperty("tool_logs");
    expect(compactSession).not.toHaveProperty("module_candidates");

    await returnToLandingWithoutLocalSnapshot(page);
    const recentTask = page.locator("article").filter({ hasText: completedState.raw_input }).first();
    await expect(recentTask).toContainText("推荐已生成");
    await recentTask.getByRole("button", { name: "继续" }).click();
    await expect(page.getByText("Agent 建议清单", { exact: true })).toBeVisible();

    const unconfirmedRecovery = await page.request.post("/api/agent/remediate", {
      headers: { Origin: "http://127.0.0.1:3100" },
      data: { session_id: persistedSessionId, confirmed: false }
    });
    expect(unconfirmedRecovery.status()).toBe(400);

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "补齐 1 个缺失分类" }).click();
    await expect.poll(async () => {
      const response = await page.request.get(`/api/session/state?session_id=${persistedSessionId}`);
      const state = await response.json() as {
        agent_runtime: { workflow_status: string };
        module_candidates: Record<string, unknown[]>;
        completion_report?: { uncovered_module_ids: string[] };
      };
      return {
        status: state.agent_runtime.workflow_status,
        covered: Object.keys(state.module_candidates).length,
        uncovered: state.completion_report?.uncovered_module_ids.length ?? -1
      };
    }, { timeout: 60_000, intervals: [250, 500, 1_000] }).toEqual({
      status: "completed",
      covered: completedState.shopping_plan.modules.length,
      uncovered: 0
    });
    await expect(page.getByText(/E2E 真实链路候选/).first()).toBeVisible();
    await expect(page.getByText(/本次淘宝 MCP ·/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "补齐 1 个缺失分类" })).toHaveCount(0);

    const bundleReadyResponse = await page.request.get(`/api/session/state?session_id=${persistedSessionId}`);
    const bundleReadyState = await bundleReadyResponse.json() as {
      completion_report: { purchase_bundle: { generated_at: string; items: Array<{ product_id: string }> } };
    };
    const unconfirmedBundle = await page.request.post("/api/session/purchase-bundle", {
      headers: { Origin: "http://127.0.0.1:3100" },
      data: {
        session_id: persistedSessionId,
        bundle_generated_at: bundleReadyState.completion_report.purchase_bundle.generated_at,
        confirmed: false
      }
    });
    expect(unconfirmedBundle.status()).toBe(400);

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "采用 Agent 建议清单" }).click();
    const adoptedBundle = page.getByRole("region", { name: /我先为你选好了/ });
    await expect(adoptedBundle.getByText("已采用", { exact: true })).toBeVisible();
    const adoptedResponse = await page.request.get(`/api/session/state?session_id=${persistedSessionId}`);
    const adoptedState = await adoptedResponse.json() as {
      bundle_adoption: { status: string; product_ids: string[]; pending_product_ids: string[] };
    };
    expect(adoptedState.bundle_adoption.status).toBe("accepted");
    expect(adoptedState.bundle_adoption.pending_product_ids).toEqual(adoptedState.bundle_adoption.product_ids);
    await expect(adoptedBundle.getByText("待加购", { exact: true })).toHaveCount(
      adoptedState.bundle_adoption.product_ids.length
    );
    await expect(adoptedBundle.getByText(`淘宝加购进度 0/${adoptedState.bundle_adoption.product_ids.length}`)).toBeVisible();
    await expect(page.getByRole("button", { name: "查看购物清单" })).toBeEnabled();

    await page.getByRole("button", { name: "查看购物清单" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: `购物清单共 ${adoptedState.bundle_adoption.product_ids.length} 件` })).toBeVisible();
    await expect(page.getByText("待确认加购", { exact: true })).toHaveCount(
      adoptedState.bundle_adoption.product_ids.length
    );
    await expect(page.getByText("真实已加购金额 ¥0", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "返回上一步继续加购" }).click();

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "确认加购" }).first().click();
    await expect(page.getByRole("button", { name: "淘宝已加" }).first()).toBeVisible({
      timeout: 30_000
    });

    await page.getByRole("button", { name: "查看购物清单" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("我的购物清单")).toBeVisible();
    await expect(page.getByText(/E2E 真实链路候选/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "在淘宝购物车中管理" }).first()).toBeVisible();

    const selectedProductId = adoptedState.bundle_adoption.product_ids[0];
    const unconfirmedRemoval = await page.request.post("/api/cart/remove", {
      headers: { Origin: "http://127.0.0.1:3100" },
      data: {
        session_id: persistedSessionId,
        product_id: selectedProductId,
        confirmed: false
      }
    });
    expect(unconfirmedRemoval.status()).toBe(400);

    const realCartRemoval = await page.request.post("/api/cart/remove", {
      headers: { Origin: "http://127.0.0.1:3100" },
      data: {
        session_id: persistedSessionId,
        product_id: selectedProductId,
        confirmed: true
      }
    });
    expect(realCartRemoval.status()).toBe(409);
    const realCartRemovalPayload = await realCartRemoval.json() as { code: string };
    expect(realCartRemovalPayload.code).toBe("taobao_cart_managed_externally");

    await page.goto("/settings/executor");
    await expect(page.getByText("正式运行就绪度")).toBeVisible();
    await expect(page.getByText("四步完成连接")).toBeVisible();
    await expect(page.getByText("1 台设备在线")).toBeVisible();
    await expect(page.getByText("仍有正式配置未完成")).toBeVisible();
    await expect(page.getByText("开发预览模式").first()).toBeVisible();
    await expect(page.getByText("允许演示加购回退")).toBeVisible();

    await page.goto("/hosted");
    await expect(page.getByText("Agent Runtime 2.0")).toBeVisible();
    await expect(page.getByText("Agent 完成质量审计")).toBeVisible();
    await expect(page.getByText("运行健康诊断")).toBeVisible();
    await expect(page.getByText("真实市场反馈")).toBeVisible();
    await expect(page.getByText(/已观察：\d+\/\d+ 个模块/)).toBeVisible();
    await expect(page.getByText("本地执行器队列", { exact: false }).first()).toBeVisible();

    const feedbackResponse = await page.request.get(`/api/session/state?session_id=${persistedSessionId}`);
    const feedbackState = await feedbackResponse.json() as {
      shopping_plan: { modules: Array<{ module_id: string; module_name: string; budget_allocation: number }> };
      module_candidates: Record<string, unknown[]>;
      market_feedback: {
        reallocation_suggestions: Array<{
          from_module_id: string;
          from_module_name: string;
          to_module_id: string;
          to_module_name: string;
          amount: number;
        }>;
      };
    };
    const budgetSuggestion = feedbackState.market_feedback.reallocation_suggestions[0];
    expect(budgetSuggestion).toBeTruthy();
    const previousPlanTotal = feedbackState.shopping_plan.modules.reduce(
      (total, module) => total + module.budget_allocation,
      0
    );
    const missingConfirmation = await page.request.post("/api/session/budget-reallocation", {
      headers: { Origin: "http://127.0.0.1:3100" },
      data: {
        session_id: persistedSessionId,
        from_module_id: budgetSuggestion.from_module_id,
        to_module_id: budgetSuggestion.to_module_id,
        confirmed: false
      }
    });
    expect(missingConfirmation.status()).toBe(400);

    await page.goto("/?resume=1");
    await expect(page.getByRole("heading", { name: /购物清单共 \d+ 件/ })).toBeVisible();
    await expect(page.getByText("换个思路", { exact: true })).toHaveCount(0);
    const confirmedReallocation = await page.request.post("/api/session/budget-reallocation", {
      headers: { Origin: "http://127.0.0.1:3100" },
      data: {
        session_id: persistedSessionId,
        from_module_id: budgetSuggestion.from_module_id,
        to_module_id: budgetSuggestion.to_module_id,
        confirmed: true
      }
    });
    expect(confirmedReallocation.ok(), await confirmedReallocation.text()).toBeTruthy();

    const reallocatedResponse = await page.request.get(`/api/session/state?session_id=${persistedSessionId}`);
    const reallocatedState = await reallocatedResponse.json() as typeof feedbackState & {
      bundle_adoption?: unknown;
      completion_report?: unknown;
    };
    expect(reallocatedState.shopping_plan.modules.reduce(
      (total, module) => total + module.budget_allocation,
      0
    )).toBe(previousPlanTotal);
    expect(reallocatedState.module_candidates[budgetSuggestion.from_module_id]).toBeUndefined();
    expect(reallocatedState.module_candidates[budgetSuggestion.to_module_id]).toBeUndefined();
    expect(Object.keys(reallocatedState.module_candidates).length).toBe(
      Object.keys(feedbackState.module_candidates).length - 2
    );
    expect(reallocatedState.bundle_adoption).toBeUndefined();
    expect(reallocatedState.completion_report).toBeUndefined();

    await page.goto("/hosted");
    await expect(page.getByText("Agent Runtime 2.0")).toBeVisible();

    stopExecutor = true;
    await executor;
    const sessionsResponse = await page.request.get("/api/sessions");
    const sessionList = await sessionsResponse.json() as {
      sessions: Array<{
        session_id: string;
        shopping_plan: {
          modules: Array<{
            module_id: string;
            module_name: string;
            typical_item_types: string[];
          }>;
        };
        market_feedback: {
          observed_modules: number;
          total_modules: number;
          user_confirmation_required: boolean;
        };
      }>;
    };
    const currentSession = sessionList.sessions.find((session) => session.session_id === persistedSessionId)!;
    expect(currentSession).toBeTruthy();
    expect(currentSession.market_feedback.observed_modules).toBeGreaterThan(0);
    expect(currentSession.market_feedback.total_modules).toBe(currentSession.shopping_plan.modules.length);
    expect(currentSession.market_feedback.user_confirmation_required).toBe(true);
    const queuedForFailure = await page.request.post("/api/agent/run", {
      headers: { Origin: "http://127.0.0.1:3100" },
      data: { session_id: currentSession.session_id }
    });
    const queuedForFailurePayload = await queuedForFailure.json() as { outcome: string };
    expect(queuedForFailure.ok(), JSON.stringify(queuedForFailurePayload)).toBeTruthy();
    expect(queuedForFailurePayload.outcome).toBe("queued");
    const pausedForFailure = await page.request.post("/api/agent/pause", {
      headers: { Origin: "http://127.0.0.1:3100" },
      data: { session_id: currentSession.session_id, confirmed: true }
    });
    expect(pausedForFailure.ok(), await pausedForFailure.text()).toBeTruthy();
    const failedClaim = await page.request.post("/api/executor/jobs/claim", {
      headers: executorHeaders(deviceToken),
      data: {}
    });
    const { job: failedJob } = await failedClaim.json() as { job: { id: string } | null };
    expect(failedJob).not.toBeNull();
    const failedResolution = await page.request.post(`/api/executor/jobs/${failedJob!.id}/resolve`, {
      headers: executorHeaders(deviceToken),
      data: { status: "failed", error: "E2E terminal executor failure", retryable: false }
    });
    expect(failedResolution.ok()).toBeTruthy();

    await page.reload();
    const retryButton = page.getByRole("button", { name: "重新入队" }).first();
    await expect(retryButton).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await retryButton.click();
    await expect(page.getByRole("button", { name: "取消待执行" }).first()).toBeVisible();

    await page.getByRole("button", { name: "返回当前进度" }).click();
    await expect(page.getByText("Agent 正在行动", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "继续搜索" })).toBeVisible();

    const unconfirmedArchive = await page.request.post("/api/session/archive", {
      headers: { Origin: "http://127.0.0.1:3100" },
      data: { session_id: persistedSessionId, action: "archive", confirmed: false }
    });
    expect(unconfirmedArchive.status()).toBe(400);

    const archiveResponse = await page.request.post("/api/session/archive", {
      headers: { Origin: "http://127.0.0.1:3100" },
      data: { session_id: persistedSessionId, action: "archive", confirmed: true }
    });
    const archiveResult = await archiveResponse.json() as {
      state: { archived_at?: string; agent_runtime: { auto_continue: boolean } };
      cancelled_pending_jobs: number;
    };
    expect(archiveResponse.ok(), JSON.stringify(archiveResult)).toBeTruthy();
    expect(archiveResult.state.archived_at).toBeTruthy();
    expect(archiveResult.state.agent_runtime.auto_continue).toBe(false);
    expect(archiveResult.cancelled_pending_jobs).toBeGreaterThanOrEqual(1);

    const activeAfterArchive = await page.request.get("/api/sessions?view=summary&limit=20");
    const activeAfterArchivePayload = await activeAfterArchive.json() as {
      sessions: Array<{ session_id: string }>;
    };
    expect(activeAfterArchivePayload.sessions.some((item) => item.session_id === persistedSessionId)).toBe(false);
    const archivedSummaryResponse = await page.request.get(
      "/api/sessions?view=summary&archive=archived&limit=20"
    );
    const archivedSummaryPayload = await archivedSummaryResponse.json() as {
      sessions: Array<{ session_id: string; status_label: string; archived_at?: string }>;
    };
    expect(archivedSummaryPayload.sessions.find((item) => item.session_id === persistedSessionId))
      .toMatchObject({ status_label: "已归档" });

    await returnToLandingWithoutLocalSnapshot(page);
    await page.getByText(/已归档任务（\d+）/).click();
    const archivedTaskCard = page.locator("article").filter({ hasText: completedState.raw_input }).first();
    await expect(archivedTaskCard.getByRole("button", { name: "恢复" })).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await archivedTaskCard.getByRole("button", { name: "恢复" }).click();
    await expect(page.getByRole("button", { name: /^(继续|继续上次任务)$/ }).first()).toBeVisible();

    const restoredStateResponse = await page.request.get(`/api/session/state?session_id=${persistedSessionId}`);
    const restoredLifecycleState = await restoredStateResponse.json() as {
      archived_at?: string;
      agent_runtime: { workflow_status: string; auto_continue: boolean };
    };
    expect(restoredLifecycleState.archived_at).toBeUndefined();
    expect(restoredLifecycleState.agent_runtime).toMatchObject({
      workflow_status: "paused",
      auto_continue: false
    });
  } finally {
    stopExecutor = true;
    await executor;
  }
});
