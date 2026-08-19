import { expect, test, type APIRequestContext, type Request } from "@playwright/test";
import protocol from "../../lib/runtime/executor-protocol.json";

const appOrigin = "http://127.0.0.1:3100";

const executorHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "X-SceneCart-Executor-Protocol": protocol.version,
  Origin: appOrigin
});

type ExecutorJob = {
  id: string;
  job_type: "module_search" | "product_detail" | "add_to_cart";
  payload: Record<string, unknown>;
  lease_token: string;
};

function candidatesFor(job: ExecutorJob) {
  const moduleId = String(job.payload.module_id);
  const moduleName = String(job.payload.module_name);
  const budget = Math.max(100, Number(job.payload.budget) || 300);
  return (["稳妥推荐", "性价比推荐", "升级推荐"] as const).map((recommendationType, index) => ({
    product_id: `${job.id}-${index + 1}`,
    title: `${moduleName} 淘宝真实链路候选 ${index + 1}`,
    price: Math.round(budget * (0.35 + index * 0.15) * 100) / 100,
    source: "淘宝",
    shop_name: `E2E 测试旗舰店 ${index + 1}`,
    image_url: "https://img.alicdn.com/imgextra/i1/O1CN01dummy.jpg",
    detail_url: `https://item.taobao.com/item.htm?id=${encodeURIComponent(job.id)}${index + 1}`,
    shop_badges: ["旗舰店"],
    highlights: ["真实 durable executor 回填"],
    risk_notes: ["打开淘宝详情页确认规格"],
    fit_reason: `符合${moduleName}模块需求。`,
    recommendation_type: recommendationType,
    module_id: moduleId
  }));
}

function verifiedSearchResultFor(job: ExecutorJob, summary: string) {
  const candidates = candidatesFor(job);
  return {
    summary,
    candidates,
    evidence: {
      schema: "scenecart.taobao-mcp-search-evidence/v1",
      source: "taobao-mcp",
      tool: "search_products",
      source_app: "SceneCartAuthResumeE2E",
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

function unavailableDetailResultFor(job: ExecutorJob) {
  return {
    detail_evidence: {
      schema: "scenecart.taobao-mcp-product-detail-evidence/v1",
      source: "taobao-mcp",
      status: "unavailable",
      tool: "navigate_to_url+read_page_content",
      tools_used: ["navigate_to_url"],
      source_app: "SceneCartAuthResumeE2EFixture",
      job_id: job.id,
      search_job_id: String(job.payload.search_job_id ?? ""),
      module_id: String(job.payload.module_id ?? ""),
      workflow_run_id: String(job.payload.workflow_run_id ?? ""),
      product_id: String(job.payload.product_id ?? ""),
      detail_url: String(job.payload.detail_url ?? ""),
      captured_at: new Date().toISOString(),
      unavailable_reason: "登录恢复 E2E 不访问真实淘宝详情页"
    }
  };
}

async function resolveDetailFollowUp(api: APIRequestContext, headers: Record<string, string>) {
  const claim = await api.post("/api/executor/jobs/claim", { headers, data: {} });
  expect(claim.ok(), await claim.text()).toBe(true);
  const { job } = await claim.json() as { job: ExecutorJob | null };
  expect(job?.job_type).toBe("product_detail");
  const resolved = await api.post(`/api/executor/jobs/${job!.id}/resolve`, {
    headers,
    data: {
      status: "completed",
      lease_token: job!.lease_token,
      result: unavailableDetailResultFor(job!)
    }
  });
  expect(resolved.ok(), await resolved.text()).toBe(true);
}

test("Taobao login loss pauses the page and resumes the same durable job atomically", async ({ page }) => {
  const email = `auth-resume-${Date.now()}@example.com`;
  const register = await page.request.post("/api/auth/register", {
    headers: { Origin: appOrigin },
    data: { email, password: "e2e-secure-password" }
  });
  expect(register.status(), await register.text()).toBe(201);

  const deviceResponse = await page.request.post("/api/executor/devices", {
    headers: { Origin: appOrigin },
    data: { name: "认证恢复 E2E 执行器", capabilities: ["module_search", "add_to_cart"] }
  });
  expect(deviceResponse.status(), await deviceResponse.text()).toBe(201);
  const { device_token: deviceToken } = await deviceResponse.json() as { device_token: string };
  const headers = executorHeaders(deviceToken);
  expect((await page.request.post("/api/executor/heartbeat", {
    headers,
    data: { executor_state: "online" }
  })).ok()).toBe(true);

  const rawInput = "刚提新能源 SUV，预算 3000，优先购买安全和实用的新车用品，不需要装饰品。";
  const plannedResponse = await page.request.post("/api/scene/plan", {
    headers: { Origin: appOrigin },
    data: { raw_input: rawInput, scenario_id: "new-car", parse_deepseek_mode: "mock" }
  });
  expect(plannedResponse.ok(), await plannedResponse.text()).toBe(true);
  const { session_id: sessionId } = await plannedResponse.json() as { session_id: string };

  const started = await page.request.post("/api/agent/run", {
    headers: { Origin: appOrigin },
    data: { session_id: sessionId }
  });
  expect(started.ok(), await started.text()).toBe(true);

  const firstClaim = await page.request.post("/api/executor/jobs/claim", { headers, data: {} });
  const { job: firstJob } = await firstClaim.json() as { job: ExecutorJob | null };
  expect(firstJob).not.toBeNull();
  const firstResolved = await page.request.post(`/api/executor/jobs/${firstJob!.id}/resolve`, {
    headers,
    data: {
      status: "completed",
      lease_token: firstJob!.lease_token,
      result: verifiedSearchResultFor(firstJob!, "登录失效前已完成一次真实搜索")
    }
  });
  expect(firstResolved.ok(), await firstResolved.text()).toBe(true);
  await resolveDetailFollowUp(page.request, headers);

  const failedClaim = await page.request.post("/api/executor/jobs/claim", { headers, data: {} });
  const { job: failedJob } = await failedClaim.json() as { job: ExecutorJob | null };
  expect(failedJob).not.toBeNull();
  const failedResolution = await page.request.post(`/api/executor/jobs/${failedJob!.id}/resolve`, {
    headers,
    data: {
      status: "failed",
      lease_token: failedJob!.lease_token,
      error: "[auth_required] 淘宝未登录，已打开登录页面，请先登录淘宝账号",
      retryable: false
    }
  });
  expect(failedResolution.ok(), await failedResolution.text()).toBe(true);
  const authRequiredHeartbeat = await page.request.post("/api/executor/heartbeat", {
    headers,
    data: { executor_state: "authentication_required" }
  });
  expect(authRequiredHeartbeat.ok(), await authRequiredHeartbeat.text()).toBe(true);

  const pausedResponse = await page.request.get(`/api/session/state?session_id=${sessionId}`);
  const pausedState = await pausedResponse.json() as {
    scene_brief: Record<string, unknown> & { scenario_id: "new-car" };
    deepseek_status: "connected" | "mock";
    shopping_plan: { modules: Array<{ module_id: string }> };
    module_candidates: Record<string, unknown[]>;
    agent_runtime: {
      workflow_status: string;
      auto_continue: boolean;
      workflow_message: string;
      current_module_id?: string;
    };
  };
  expect(pausedState.agent_runtime).toMatchObject({
    workflow_status: "paused",
    auto_continue: false,
    current_module_id: failedJob!.payload.module_id
  });
  expect(Object.values(pausedState.module_candidates).flat().length).toBeGreaterThan(0);

  await page.goto("/");
  await page.evaluate(({ rawInput, sessionId, pausedState }) => {
    window.localStorage.setItem("scenecart-dashboard-state", JSON.stringify({
      stage: "searching",
      selectedScenario: "new-car",
      sceneInput: rawInput,
      parsedScene: pausedState.scene_brief,
      parseDeepSeekMode: pausedState.deepseek_status,
      sessionId,
      selectedModuleId: pausedState.shopping_plan.modules[0]?.module_id ?? "",
      expandedLogs: false,
      expandedModel: false,
      statusMessage: pausedState.agent_runtime.workflow_message,
      searchSummary: []
    }));
  }, { rawInput, sessionId, pausedState });
  await page.goto("/?resume=1");

  await expect(page.getByRole("heading", { name: "淘宝登录已失效，真实搜索已安全暂停" })).toBeVisible();
  await expect(page.getByRole("button", { name: "重新登录后继续搜索" })).toBeVisible();
  await expect(page.getByRole("button", { name: "用已有部分结果进入选购" })).toBeVisible();

  const onlineHeartbeat = await page.request.post("/api/executor/heartbeat", {
    headers,
    data: { executor_state: "online" }
  });
  expect(onlineHeartbeat.ok(), await onlineHeartbeat.text()).toBe(true);

  const resumeRequests: Request[] = [];
  let legacyModuleSearchRequests = 0;
  const trackResumeRequests = (request: Request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && pathname === "/api/agent/resume") resumeRequests.push(request);
    if (request.method() === "POST" && pathname === "/api/modules/search") legacyModuleSearchRequests += 1;
  };
  page.on("request", trackResumeRequests);
  const resumeResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/agent/resume"
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "重新登录后继续搜索" }).click();
  const resumeResponse = await resumeResponsePromise;
  expect(resumeResponse.ok(), await resumeResponse.text()).toBe(true);
  page.off("request", trackResumeRequests);

  expect(resumeRequests).toHaveLength(1);
  expect(resumeRequests[0].postDataJSON()).toMatchObject({
    session_id: sessionId,
    confirmed: true,
    retry_authentication_failure: true
  });
  expect(legacyModuleSearchRequests).toBe(0);

  const revivedClaim = await page.request.post("/api/executor/jobs/claim", { headers, data: {} });
  const { job: revivedJob } = await revivedClaim.json() as { job: ExecutorJob | null };
  expect(revivedJob?.id).toBe(failedJob!.id);
  const revivedResolved = await page.request.post(`/api/executor/jobs/${revivedJob!.id}/resolve`, {
    headers,
    data: {
      status: "completed",
      lease_token: revivedJob!.lease_token,
      result: verifiedSearchResultFor(revivedJob!, "重新登录后恢复同一搜索")
    }
  });
  const revivedPayload = await revivedResolved.json() as {
    continuation: { outcome: string; error: string | null } | null;
  };
  expect(revivedResolved.ok(), JSON.stringify(revivedPayload)).toBe(true);
  expect(revivedPayload.continuation).toBeNull();
  await resolveDetailFollowUp(page.request, headers);

  const continuedClaim = await page.request.post("/api/executor/jobs/claim", { headers, data: {} });
  const { job: continuedJob } = await continuedClaim.json() as { job: ExecutorJob | null };
  expect(continuedJob).not.toBeNull();
  expect(continuedJob?.id).not.toBe(failedJob!.id);

  // Exercise the alternative user choice on the next queued search: accept the
  // candidates already collected instead of restoring/replaying this failure.
  const secondFailure = await page.request.post(`/api/executor/jobs/${continuedJob!.id}/resolve`, {
    headers,
    data: {
      status: "failed",
      lease_token: continuedJob!.lease_token,
      error: "[auth_required] 淘宝未登录，请先登录淘宝账号",
      retryable: false
    }
  });
  expect(secondFailure.ok(), await secondFailure.text()).toBe(true);
  expect((await page.request.post("/api/executor/heartbeat", {
    headers,
    data: { executor_state: "authentication_required" }
  })).ok()).toBe(true);
  await expect(page.getByRole("button", { name: "用已有部分结果进入选购" })).toBeVisible();

  const unconfirmedAcceptance = await page.request.post("/api/agent/accept-partial-results", {
    headers: { Origin: appOrigin },
    data: { session_id: sessionId, confirmed: false }
  });
  expect(unconfirmedAcceptance.status()).toBe(400);

  const jobsBeforeAcceptanceResponse = await page.request.get(`/api/runtime/jobs?session_id=${sessionId}`);
  const jobsBeforeAcceptance = await jobsBeforeAcceptanceResponse.json() as { jobs: ExecutorJob[] };
  const preservedBeforeAcceptance = await page.request.get(`/api/session/state?session_id=${sessionId}`);
  const preservedCandidateCount = Object.values(
    (await preservedBeforeAcceptance.json() as { module_candidates: Record<string, unknown[]> }).module_candidates
  ).flat().length;
  const acceptanceRequests: Request[] = [];
  let acceptanceLegacySearchRequests = 0;
  let acceptanceResumeRequests = 0;
  const trackAcceptanceRequests = (request: Request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== "POST") return;
    if (pathname === "/api/agent/accept-partial-results") acceptanceRequests.push(request);
    if (pathname === "/api/modules/search") acceptanceLegacySearchRequests += 1;
    if (pathname === "/api/agent/resume") acceptanceResumeRequests += 1;
  };
  page.on("request", trackAcceptanceRequests);
  const acceptanceResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    new URL(response.url()).pathname === "/api/agent/accept-partial-results"
  );
  await page.getByRole("button", { name: "用已有部分结果进入选购" }).click();
  const acceptanceResponse = await acceptanceResponsePromise;
  expect(acceptanceResponse.ok(), await acceptanceResponse.text()).toBe(true);
  page.off("request", trackAcceptanceRequests);

  expect(acceptanceRequests).toHaveLength(1);
  expect(acceptanceRequests[0].postDataJSON()).toMatchObject({
    session_id: sessionId,
    confirmed: true
  });
  expect(acceptanceLegacySearchRequests).toBe(0);
  expect(acceptanceResumeRequests).toBe(0);
  const jobsAfterAcceptanceResponse = await page.request.get(`/api/runtime/jobs?session_id=${sessionId}`);
  const jobsAfterAcceptance = await jobsAfterAcceptanceResponse.json() as { jobs: ExecutorJob[] };
  expect(jobsAfterAcceptance.jobs.map((job) => job.id)).toEqual(
    jobsBeforeAcceptance.jobs.map((job) => job.id)
  );

  const acceptedStateResponse = await page.request.get(`/api/session/state?session_id=${sessionId}`);
  const acceptedState = await acceptedStateResponse.json() as {
    module_candidates: Record<string, unknown[]>;
    agent_runtime: { workflow_status: string; auto_continue: boolean; workflow_message: string };
    hosted_tasks: Array<{
      task_id: string;
      status: string;
      error_message?: string;
      payload: Record<string, unknown>;
    }>;
  };
  expect(Object.values(acceptedState.module_candidates).flat()).toHaveLength(preservedCandidateCount);
  expect(acceptedState.agent_runtime).toMatchObject({
    workflow_status: "completed",
    auto_continue: false
  });
  expect(acceptedState.agent_runtime.workflow_message).not.toMatch(/未登录|auth_required/);
  expect(acceptedState.hosted_tasks.find((task) => task.task_id === continuedJob!.id)).toMatchObject({
    status: "failed",
    error_message: expect.stringContaining("auth_required"),
    payload: {
      user_resolution: "user_skipped",
      partial_results_status: "partial_results_accepted"
    }
  });
  await expect(page.getByRole("heading", { name: "我的购物清单" })).toBeVisible();
  await expect(page.getByText(/淘宝真实链路候选/).first()).toBeVisible();
  await expect(page.getByText(/本次淘宝 MCP ·/).first()).toBeVisible();
  await expect(page.getByText("淘宝登录已失效，加购已暂停", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "加购已暂停" }).first()).toBeDisabled();

  expect((await page.request.post("/api/executor/heartbeat", {
    headers,
    data: { executor_state: "online" }
  })).ok()).toBe(true);
  await page.getByRole("button", { name: "重新登录后刷新状态" }).click();
  const addButton = page.getByRole("button", { name: "加入购物车" }).first();
  await expect(addButton).toBeEnabled();
  const explicitCartResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    new URL(response.url()).pathname === "/api/cart/add"
  );
  page.once("dialog", (dialog) => dialog.accept());
  await addButton.click();
  const explicitCartResponse = await explicitCartResponsePromise;
  expect(explicitCartResponse.ok(), await explicitCartResponse.text()).toBe(true);
  await expect(page.getByRole("button", { name: "正在加购" }).first()).toBeVisible();
  const jobsAfterExplicitCartResponse = await page.request.get(`/api/runtime/jobs?session_id=${sessionId}`);
  const jobsAfterExplicitCart = await jobsAfterExplicitCartResponse.json() as {
    jobs: Array<ExecutorJob & { status: string }>;
  };
  expect(jobsAfterExplicitCart.jobs.filter((job) => job.job_type === "add_to_cart")).toEqual([
    expect.objectContaining({ status: "pending" })
  ]);
});
