import { expect, test, type APIRequestContext } from "@playwright/test";

const recommendationTypes = ["稳妥推荐", "性价比推荐", "升级推荐"] as const;

function candidatesFor(job: { id: string; payload: Record<string, unknown> }) {
  const moduleId = String(job.payload.module_id ?? "module");
  const moduleName = String(job.payload.module_name ?? "新车用品");
  return recommendationTypes.map((recommendationType, index) => ({
    product_id: `${moduleId}-${index + 1}`,
    title: `${moduleName} E2E 真实链路候选 ${index + 1}`,
    price: 99 + index * 60,
    source: "淘宝本地执行器测试",
    shop_name: `测试旗舰店 ${index + 1}`,
    image_url: "https://img.alicdn.com/imgextra/i1/O1CN01dummy.jpg",
    detail_url: `https://item.taobao.com/item.htm?id=${encodeURIComponent(`${moduleId}${index + 1}`)}`,
    shop_badges: ["旗舰店"],
    highlights: ["适配新车阶段", "预算内候选"],
    risk_notes: ["当前为搜索结果摘要，未自动打开详情页，建议点开淘宝详情页确认规格与适配性"],
    fit_reason: `符合${moduleName}模块的预算和使用阶段。`,
    recommendation_type: recommendationType,
    module_id: moduleId
  }));
}

async function runExecutorUntilStopped(
  api: APIRequestContext,
  token: string,
  shouldStop: () => boolean
) {
  const headers = { Authorization: `Bearer ${token}` };
  while (!shouldStop()) {
    const claim = await api.post("/api/executor/jobs/claim", { headers, data: {} });
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

  const deviceResponse = await page.request.post("/api/executor/devices", {
    headers: { Origin: "http://127.0.0.1:3100" },
    data: { name: "Playwright 淘宝执行器", capabilities: ["module_search", "add_to_cart"] }
  });
  expect(deviceResponse.status()).toBe(201);
  const { device_token: deviceToken } = await deviceResponse.json() as { device_token: string };
  const heartbeatResponse = await page.request.post("/api/executor/heartbeat", {
    headers: { Authorization: `Bearer ${deviceToken}` },
    data: {}
  });
  expect(heartbeatResponse.ok()).toBeTruthy();

  const readinessResponse = await page.request.get("/api/runtime/readiness");
  expect(readinessResponse.ok()).toBeTruthy();
  const readiness = await readinessResponse.json() as {
    ready_for_production: boolean;
    operational_for_shopping: boolean;
  };
  expect(readiness.ready_for_production).toBe(false);
  expect(readiness.operational_for_shopping).toBe(false);

  let stopExecutor = false;
  const executor = runExecutorUntilStopped(page.request, deviceToken, () => stopExecutor);

  try {
    await page.getByRole("button", { name: /新车选购/ }).click();
    await page.getByRole("button", { name: "开始理解需求" }).click();
    await expect(page.getByText("确认场景理解结果")).toBeVisible();
    await page.getByRole("button", { name: "确认需求，开始生成购物规划" }).click();
    await expect(page.getByText("确认购物规划")).toBeVisible();
    await page.getByRole("button", { name: "确认规划，开始搜索推荐商品" }).click();

    await expect(page.getByRole("button", { name: "查看推荐结果" })).toBeEnabled({ timeout: 120_000 });
    await page.getByRole("button", { name: "查看推荐结果" }).click();
    await expect(page.getByText(/E2E 真实链路候选/).first()).toBeVisible();
    await expect(page.getByText("本地执行器", { exact: false }).first()).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "加入购物车" }).first().click();
    await expect(page.getByRole("button", { name: "加入购物车成功" }).first()).toBeVisible({
      timeout: 30_000
    });

    await page.getByRole("button", { name: "进入下单购买" }).click();
    await expect(page.getByText("确认下单清单")).toBeVisible();
    await expect(page.getByText(/E2E 真实链路候选/).first()).toBeVisible();

    await page.goto("/settings/executor");
    await expect(page.getByText("正式运行就绪度")).toBeVisible();
    await expect(page.getByText("仍有正式配置未完成")).toBeVisible();

    await page.goto("/hosted");
    await expect(page.getByText("Agent Runtime 2.0")).toBeVisible();
    await expect(page.getByText("运行健康诊断")).toBeVisible();
    await expect(page.getByText("本地执行器队列", { exact: false }).first()).toBeVisible();

    stopExecutor = true;
    await executor;
    const persistedSessionId = await page.evaluate(() => {
      const raw = window.localStorage.getItem("scenecart-dashboard-state");
      if (!raw) return "";
      return String((JSON.parse(raw) as { sessionId?: string }).sessionId ?? "");
    });
    expect(persistedSessionId).not.toBe("");
    const sessionsResponse = await page.request.get("/api/sessions");
    const sessionList = await sessionsResponse.json() as {
      sessions: Array<{
        session_id: string;
        shopping_plan: { modules: Array<{ module_id: string }> };
      }>;
    };
    const currentSession = sessionList.sessions.find((session) => session.session_id === persistedSessionId)!;
    expect(currentSession).toBeTruthy();
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
      headers: { Authorization: `Bearer ${deviceToken}` },
      data: {}
    });
    const { job: failedJob } = await failedClaim.json() as { job: { id: string } | null };
    expect(failedJob).not.toBeNull();
    const failedResolution = await page.request.post(`/api/executor/jobs/${failedJob!.id}/resolve`, {
      headers: { Authorization: `Bearer ${deviceToken}` },
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
    await expect(page.getByText("确认下单清单")).toBeVisible();
  } finally {
    stopExecutor = true;
    await executor;
  }
});
