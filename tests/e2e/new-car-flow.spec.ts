import { expect, test, type APIRequestContext } from "@playwright/test";
import protocol from "../../lib/runtime/executor-protocol.json";

const recommendationTypes = ["稳妥推荐", "性价比推荐", "升级推荐"] as const;
const recoverySecret = "playwright-recovery-secret-with-at-least-32-characters";
const executorHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "X-SceneCart-Executor-Protocol": protocol.version
});

function candidatesFor(job: { id: string; payload: Record<string, unknown> }) {
  const moduleId = String(job.payload.module_id ?? "module");
  const moduleName = String(job.payload.module_name ?? "新车用品");
  const moduleBudget = Math.max(1, Number(job.payload.budget) || 200);
  const ratios = moduleName.includes("安全") ? [1.2, 1.35, 1.5] : [0.25, 0.35, 0.45];
  return recommendationTypes.map((recommendationType, index) => ({
    product_id: `${moduleId}-${index + 1}`,
    title: `${moduleName} E2E 真实链路候选 ${index + 1}`,
    price: Math.round(moduleBudget * ratios[index] * 100) / 100,
    source: "淘宝本地执行器测试",
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
      ? {
          summary: "E2E 本地执行器已完成淘宝候选回填",
          candidates: candidatesFor(job)
        }
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

  await page.goto("/login");
  await page.getByRole("button", { name: "还没有账号？创建账号" }).click();
  await page.getByLabel("邮箱").fill(`e2e-${Date.now()}@example.com`);
  await page.getByLabel("密码").fill("e2e-secure-password");
  await page.getByRole("button", { name: "注册并登录" }).click();
  await expect(page).toHaveURL(/\/$/);

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
  await expect(page.getByRole("heading", { name: "连接这台电脑上的 Qoder 与淘宝" })).toBeVisible();
  await page.getByRole("button", { name: "注册当前设备" }).click();
  await expect(page.getByRole("heading", { name: "保存一次性设备令牌" })).toBeVisible();
  await expect(page.getByText("npm run executor:configure", { exact: true })).toBeVisible();
  await expect(page.getByText("输入过程不会回显，也不会把令牌写入 shell history", { exact: false })).toBeVisible();
  await page.goto("/");

  const outdatedHeartbeat = await page.request.post("/api/executor/heartbeat", {
    headers: {
      Authorization: `Bearer ${deviceToken}`,
      "X-SceneCart-Executor-Protocol": "0"
    },
    data: {}
  });
  expect(outdatedHeartbeat.status()).toBe(426);

  const mcpStatusResponse = await page.request.get("/api/mcp/status");
  expect(mcpStatusResponse.ok()).toBeTruthy();
  const mcpStatus = await mcpStatusResponse.json() as {
    available: boolean;
    executor_devices: {
      capabilities: {
        module_search: { available: boolean };
        add_to_cart: { available: boolean };
      };
    };
  };
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
    await page.getByRole("button", { name: /新车选购/ }).click();
    await page.locator("textarea").fill(
      "刚提新能源 SUV，预算 3000，经常带 3 岁孩子长途出行，已有行车记录仪，希望优先准备儿童乘车安全用品。"
    );
    await page.getByRole("button", { name: "开始理解需求" }).click();
    await expect(page.getByText("确认场景理解结果")).toBeVisible();
    await page.getByRole("button", { name: "确认需求，开始生成购物规划" }).click();
    await expect(page.getByText("确认购物规划")).toBeVisible();
    await expect(page.getByText("儿童安全出行", { exact: true })).toBeVisible();
    await expect(page.getByText("AI 新增", { exact: true }).first()).toBeVisible();
    const persistedSessionId = await page.evaluate(() => {
      const raw = window.localStorage.getItem("scenecart-dashboard-state");
      if (!raw) return "";
      return String((JSON.parse(raw) as { sessionId?: string }).sessionId ?? "");
    });
    expect(persistedSessionId).not.toBe("");
    await page.getByRole("button", { name: "确认规划，开始搜索推荐商品" }).click();

    await expect(page.getByText("搜索执行摘要")).toBeVisible();
    await expect.poll(async () => {
      const response = await page.request.get(`/api/session/state?session_id=${persistedSessionId}`);
      const state = await response.json() as {
        agent_runtime: { workflow_status: string };
      };
      return state.agent_runtime.workflow_status;
    }, { timeout: 30_000 }).toBe("waiting_for_tools");

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "完成当前模块后暂停" }).click();
    await expect(page.getByRole("button", { name: "从当前进度继续" })).toBeEnabled();
    const pausedResponse = await page.request.get(`/api/session/state?session_id=${persistedSessionId}`);
    const pausedState = await pausedResponse.json() as {
      agent_runtime: { workflow_status: string; auto_continue: boolean; workflow_run_id?: string };
    };
    expect(pausedState.agent_runtime).toMatchObject({ workflow_status: "paused", auto_continue: false });
    const originalWorkflowRunId = pausedState.agent_runtime.workflow_run_id;

    executor = runExecutorUntilStopped(page.request, deviceToken, () => stopExecutor, executorBehavior);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "从当前进度继续" }).click();
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

    await page.goto("/?resume=1");
    await expect(page.getByText("搜索执行摘要")).toBeVisible();
    await expect(page.getByRole("button", { name: "查看推荐结果" })).toBeEnabled();
    await page.getByRole("button", { name: "查看推荐结果" }).click();
    await expect(page.getByText("当前模块搜索未形成可用候选")).toBeVisible();
    await expect(page.getByText("Agent 完成报告")).toBeVisible();
    await expect(page.getByText("Agent 建议购买组合")).toBeVisible();
    await expect(page.getByText("本地执行器", { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/\[[^\]]+\] local_executor/).first()).toBeVisible();
    await expect(page.getByText(/SUCCESS · 0ms/).first()).toBeVisible();

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

    const unconfirmedRecovery = await page.request.post("/api/agent/remediate", {
      headers: { Origin: "http://127.0.0.1:3100" },
      data: { session_id: persistedSessionId, confirmed: false }
    });
    expect(unconfirmedRecovery.status()).toBe(400);

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: /继续补齐 1 个缺口模块/ }).click();
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
    await expect(page.getByRole("button", { name: /继续补齐/ })).toHaveCount(0);

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
    await page.getByRole("button", { name: "采用这套组合" }).click();
    await expect(page.getByText("组合已加入产品内待处理清单")).toBeVisible();
    const adoptedResponse = await page.request.get(`/api/session/state?session_id=${persistedSessionId}`);
    const adoptedState = await adoptedResponse.json() as {
      bundle_adoption: { status: string; product_ids: string[]; pending_product_ids: string[] };
    };
    expect(adoptedState.bundle_adoption.status).toBe("accepted");
    expect(adoptedState.bundle_adoption.pending_product_ids).toEqual(adoptedState.bundle_adoption.product_ids);

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "逐件确认加购" }).first().click();
    await expect(page.getByRole("button", { name: "加入购物车成功" }).first()).toBeVisible({
      timeout: 30_000
    });
    await expect(page.getByText(/已处理 1\/\d+ 件/)).toBeVisible();

    await page.getByRole("button", { name: "进入下单购买" }).click();
    await expect(page.getByText("确认下单清单")).toBeVisible();
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
    await expect(page.getByText("确认下单清单")).toBeVisible();
    await page.getByRole("button", { name: "返回上一步继续加购" }).click();
    await page.getByRole("button", { name: budgetSuggestion.to_module_name, exact: true }).click();
    await expect(page.getByRole("button", { name: "确认调配并查看新规划" })).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "确认调配并查看新规划" }).click();
    await expect(page.getByText("确认购物规划")).toBeVisible();

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
        shopping_plan: { modules: Array<{ module_id: string }> };
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
    const retryModule = currentSession.shopping_plan.modules[0];
    const retryKeyword = `E2E 失败恢复 ${Date.now()}`;
    const queuedForFailure = await page.request.post("/api/modules/search", {
      headers: { Origin: "http://127.0.0.1:3100" },
      data: {
        session_id: currentSession.session_id,
        module_id: retryModule.module_id,
        keyword_override: retryKeyword
      }
    });
    expect(queuedForFailure.ok(), await queuedForFailure.text()).toBeTruthy();
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
    await expect(page.getByText("确认购物规划")).toBeVisible();
  } finally {
    stopExecutor = true;
    await executor;
  }
});
