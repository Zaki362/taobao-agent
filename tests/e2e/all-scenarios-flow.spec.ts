import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { getScenarioConfig } from "../../lib/scenarios";
import type { ScenarioId } from "../../lib/session/types";
import protocol from "../../lib/runtime/executor-protocol.json";

const appOrigin = "http://127.0.0.1:3100";
const recommendationTypes = ["稳妥推荐", "性价比推荐", "升级推荐"] as const;

type ScenarioCase = {
  id: Exclude<ScenarioId, "new-car">;
  exampleIndex: number;
};

type ExecutorJob = {
  id: string;
  job_type: "module_search" | "add_to_cart";
  payload: Record<string, unknown>;
};

type PlannedState = {
  scene_brief: { scenario_id: ScenarioId };
  shopping_plan: {
    modules: Array<{
      module_id: string;
      module_name: string;
      typical_item_types: string[];
    }>;
  };
  module_candidates: Record<string, unknown[]>;
  agent_runtime: { workflow_status: string };
  completion_report?: {
    status: string;
    covered_module_ids: string[];
    uncovered_module_ids: string[];
  };
};

const scenarioCases: ScenarioCase[] = [
  { id: "camping", exampleIndex: 2 },
  { id: "room-decor", exampleIndex: 0 },
  { id: "dorm-move-in", exampleIndex: 0 },
  { id: "moving-setup", exampleIndex: 1 }
];

function executorHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "X-SceneCart-Executor-Protocol": protocol.version
  };
}

function verifiedSearchResultFor(job: ExecutorJob, itemType: string, scenarioName: string) {
  const moduleId = String(job.payload.module_id);
  const moduleName = String(job.payload.module_name);
  const moduleBudget = Math.max(100, Number(job.payload.budget) || 300);
  const candidates = recommendationTypes.map((recommendationType, index) => ({
    product_id: `${job.id}-${index + 1}`,
    title: `${scenarioName} ${itemType} ${moduleName} E2E 候选 ${index + 1}`,
    price: Math.round(moduleBudget * (0.28 + index * 0.12) * 100) / 100,
    source: "淘宝",
    shop_name: `SceneCart E2E 测试店 ${index + 1}`,
    // Keep browser verification completely isolated from external image hosts.
    image_url: "",
    detail_url: `https://item.taobao.com/item.htm?id=${encodeURIComponent(`${job.id}${index + 1}`)}`,
    shop_badges: ["旗舰店"],
    highlights: [itemType, "durable fixture executor 回填"],
    risk_notes: ["E2E 隔离候选，不执行真实淘宝详情或加购操作"],
    fit_reason: `用于验证${scenarioName}的${moduleName}模块完整执行链路。`,
    recommendation_type: recommendationType,
    module_id: moduleId
  }));

  return {
    summary: `${scenarioName} E2E fixture executor 已完成候选回填`,
    candidates,
    evidence: {
      schema: "scenecart.taobao-mcp-search-evidence/v1",
      source: "taobao-mcp",
      tool: "search_products",
      source_app: "SceneCartAllScenariosE2EFixture",
      job_id: job.id,
      module_id: moduleId,
      workflow_run_id: String(job.payload.workflow_run_id ?? ""),
      keyword: String(job.payload.keyword ?? ""),
      captured_at: new Date().toISOString(),
      cache_hit: false,
      raw_result_count: candidates.length
    }
  };
}

async function registerFixtureExecutor(page: Page, scenarioId: ScenarioId) {
  const email = `${scenarioId}-${Date.now()}@example.com`;
  const registered = await page.request.post("/api/auth/register", {
    headers: { Origin: appOrigin },
    data: { email, password: "e2e-secure-password" }
  });
  expect(registered.status(), await registered.text()).toBe(201);

  const deviceResponse = await page.request.post("/api/executor/devices", {
    headers: { Origin: appOrigin },
    data: {
      name: `${getScenarioConfig(scenarioId).name} E2E fixture executor`,
      capabilities: ["module_search"]
    }
  });
  expect(deviceResponse.status(), await deviceResponse.text()).toBe(201);
  const { device_token: deviceToken } = await deviceResponse.json() as { device_token: string };
  const heartbeat = await page.request.post("/api/executor/heartbeat", {
    headers: executorHeaders(deviceToken),
    data: { executor_state: "online" }
  });
  expect(heartbeat.ok(), await heartbeat.text()).toBe(true);
  return deviceToken;
}

async function runScenarioExecutor(
  api: APIRequestContext,
  token: string,
  scenarioId: ScenarioId,
  shouldStop: () => boolean,
  observedJobs: ExecutorJob[]
) {
  const scenario = getScenarioConfig(scenarioId);
  const headers = executorHeaders(token);

  while (!shouldStop()) {
    let response;
    try {
      response = await api.post("/api/executor/jobs/claim", {
        headers,
        data: {},
        timeout: 5_000
      });
    } catch {
      if (shouldStop()) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
      continue;
    }

    expect(response.ok(), await response.text()).toBe(true);
    const { job } = await response.json() as { job: ExecutorJob | null };
    if (!job) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }

    // These tests never grant or exercise the real add-to-cart capability.
    expect(job.job_type).toBe("module_search");
    const sceneBrief = job.payload.scene_brief as { scenario_id?: string } | undefined;
    expect(sceneBrief?.scenario_id).toBe(scenarioId);

    const moduleId = String(job.payload.module_id ?? "");
    const module = scenario.base_template_modules.find((item) => item.module_id === moduleId);
    expect(module, `unknown ${scenarioId} module: ${moduleId}`).toBeTruthy();
    const keyword = String(job.payload.keyword ?? "");
    const matchedItemType = module!.typical_item_types.find((itemType) => keyword === itemType);
    expect(
      matchedItemType,
      `${scenarioId}/${moduleId} keyword "${keyword}" must be one of ${module!.typical_item_types.join(", ")}`
    ).toBeTruthy();

    observedJobs.push(job);
    const resolved = await api.post(`/api/executor/jobs/${job.id}/resolve`, {
      headers,
      data: {
        status: "completed",
        result: verifiedSearchResultFor(job, matchedItemType!, scenario.name)
      }
    });
    expect(resolved.ok(), await resolved.text()).toBe(true);
  }
}

for (const scenarioCase of scenarioCases) {
  const scenario = getScenarioConfig(scenarioCase.id);

  test(`${scenario.id} reaches scenario-specific recommendations through the durable fixture executor`, async ({ page }) => {
    const deviceToken = await registerFixtureExecutor(page, scenario.id);
    let stopExecutor = false;
    const observedJobs: ExecutorJob[] = [];
    let executor: Promise<void> | undefined;

    try {
      await page.goto("/");
      await page.getByRole("button", {
        name: `${scenario.name} ${scenario.short_description}`,
        exact: true
      }).click();

      const examplePrompt = scenario.example_prompts[scenarioCase.exampleIndex];
      await page.getByRole("button", { name: examplePrompt, exact: true }).click();
      await expect(page.getByRole("heading", { name: scenario.confirm_scene_title })).toBeVisible();
      await page.getByRole("button", { name: "确认无误，生成购买路线" }).click();
      await expect(page.getByRole("heading", { name: scenario.confirm_plan_title })).toBeVisible();

      const sessionId = await page.evaluate(() => {
        const raw = window.localStorage.getItem("scenecart-dashboard-state");
        if (!raw) return "";
        return String((JSON.parse(raw) as { sessionId?: string }).sessionId ?? "");
      });
      expect(sessionId).not.toBe("");

      const plannedResponse = await page.request.get(`/api/session/state?session_id=${sessionId}`);
      expect(plannedResponse.ok(), await plannedResponse.text()).toBe(true);
      const plannedState = await plannedResponse.json() as PlannedState;
      expect(plannedState.scene_brief.scenario_id).toBe(scenario.id);
      expect(plannedState.shopping_plan.modules.length).toBeGreaterThan(0);
      expect(plannedState.shopping_plan.modules.every((module) =>
        scenario.base_template_modules.some((template) =>
          template.module_id === module.module_id &&
          template.typical_item_types.some((itemType) => module.typical_item_types.includes(itemType))
        )
      )).toBe(true);

      executor = runScenarioExecutor(
        page.request,
        deviceToken,
        scenario.id,
        () => stopExecutor,
        observedJobs
      );
      await page.getByRole("button", { name: "就按这个方案开始找商品" }).click();
      await expect(page.getByText("Agent 正在行动", { exact: true })).toBeVisible();

      await expect.poll(async () => {
        const stateResponse = await page.request.get(`/api/session/state?session_id=${sessionId}`);
        const state = await stateResponse.json() as PlannedState;
        return state.agent_runtime.workflow_status;
      }, { timeout: 120_000, intervals: [250, 500, 1_000] }).toBe("completed");

      await expect(page.getByRole("button", { name: "查看推荐结果" })).toBeEnabled();
      await page.getByRole("button", { name: "查看推荐结果" }).click();

      const completedResponse = await page.request.get(`/api/session/state?session_id=${sessionId}`);
      const completedState = await completedResponse.json() as PlannedState;
      const moduleIds = completedState.shopping_plan.modules.map((module) => module.module_id);
      expect(completedState.scene_brief.scenario_id).toBe(scenario.id);
      expect(completedState.completion_report).toMatchObject({
        status: "ready",
        covered_module_ids: expect.arrayContaining(moduleIds),
        uncovered_module_ids: []
      });
      expect(moduleIds.every((moduleId) => completedState.module_candidates[moduleId]?.length > 0)).toBe(true);
      expect(new Set(observedJobs.map((job) => String(job.payload.module_id)))).toEqual(new Set(moduleIds));

      for (const module of completedState.shopping_plan.modules) {
        await expect(page.getByRole("tab", { name: new RegExp(`^${module.module_name}\\s+\\d+$`) })).toBeVisible();
      }
      await expect(page.getByText(new RegExp(`${scenario.name}.*E2E 候选`)).first()).toBeVisible();
      await expect(page.getByText(/本次淘宝 MCP ·/).first()).toBeVisible();
      await expect(page.getByRole("heading", { name: "我的购物清单" })).toBeVisible();

      const jobsResponse = await page.request.get(`/api/runtime/jobs?session_id=${sessionId}`);
      const { jobs } = await jobsResponse.json() as { jobs: Array<{ job_type: string }> };
      expect(jobs.length).toBeGreaterThanOrEqual(moduleIds.length);
      expect(jobs.every((job) => job.job_type === "module_search")).toBe(true);
    } finally {
      stopExecutor = true;
      await executor;
    }
  });
}
