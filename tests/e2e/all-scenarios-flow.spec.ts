import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { getScenarioConfig } from "../../lib/scenarios";
import type { ScenarioId } from "../../lib/session/types";
import {
  executorHeaders,
  moduleOnlyDevice,
  singleUserStorageKey,
  singleUserStorageOwner
} from "./single-user-fixture";

const recommendationTypes = ["稳妥推荐", "性价比推荐", "升级推荐"] as const;

type ScenarioCase = {
  id: Exclude<ScenarioId, "new-car">;
  exampleIndex: number;
};

type ExecutorJob = {
  id: string;
  job_type: "module_search" | "product_detail" | "add_to_cart";
  payload: Record<string, unknown>;
  lease_token: string;
};

type ExecutorObservations = {
  jobs: ExecutorJob[];
  detailOutcomes: Map<string, "verified" | "verified_empty" | "unavailable">;
  staleMismatchRejected: boolean;
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
    detail_url: `https://item.taobao.com/item.htm?id=${encodeURIComponent(`${job.id}-${index + 1}`)}`,
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

function detailEvidenceFor(
  job: ExecutorJob,
  status: "verified" | "verified_empty" | "unavailable",
  keyword: string,
  productIdOverride?: string
) {
  const detailUrl = String(job.payload.detail_url ?? "");
  const matchedFacts = status === "verified_empty" ? [] : Array.isArray(job.payload.fact_terms)
    ? job.payload.fact_terms.filter((term): term is string => typeof term === "string").slice(0, 2)
    : [];
  const base = {
    schema: "scenecart.taobao-mcp-product-detail-evidence/v1",
    source: "taobao-mcp",
    status: status === "unavailable" ? "unavailable" : "verified",
    tool: "navigate_to_url+read_page_content",
    source_app: "SceneCartAllScenariosE2EDetailFixture",
    job_id: job.id,
    search_job_id: String(job.payload.search_job_id ?? ""),
    module_id: String(job.payload.module_id ?? ""),
    workflow_run_id: String(job.payload.workflow_run_id ?? ""),
    product_id: productIdOverride ?? String(job.payload.product_id ?? ""),
    detail_url: detailUrl,
    captured_at: new Date().toISOString()
  };

  return status !== "unavailable"
    ? {
        ...base,
        tools_used: ["navigate_to_url", "read_page_content"],
        summary: {
          page_title: `${keyword} E2E 淘宝详情页`,
          page_url: detailUrl,
          visible_text_sha256: "a".repeat(64),
          matched_facts: matchedFacts,
          displayed_price_texts: ["¥399"]
        }
      }
    : {
        ...base,
        tools_used: ["navigate_to_url"],
        unavailable_reason: "E2E fixture 详情页读取超时，搜索结果继续保留"
      };
}

async function activateFixtureExecutor(page: Page, scenarioId: ScenarioId) {
  const deviceToken = moduleOnlyDevice.token;
  const heartbeat = await page.request.post("/api/executor/heartbeat", {
    headers: executorHeaders(deviceToken),
    data: { executor_state: "online" }
  });
  expect(heartbeat.ok(), `${getScenarioConfig(scenarioId).name}: ${await heartbeat.text()}`).toBe(true);
  return deviceToken;
}

async function runScenarioExecutor(
  api: APIRequestContext,
  token: string,
  scenarioId: ScenarioId,
  shouldStop: () => boolean,
  observations: ExecutorObservations
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

    // These scenario flows never create or exercise a real add-to-cart job.
    expect(job.job_type).not.toBe("add_to_cart");

    if (job.job_type === "product_detail") {
      const moduleId = String(job.payload.module_id ?? "");
      const searchJobId = String(job.payload.search_job_id ?? "");
      const searchJob = observations.jobs.find((item) => item.id === searchJobId);
      expect(searchJob?.job_type).toBe("module_search");
      const keyword = String(searchJob?.payload.keyword ?? "");
      const outcome = (["verified", "verified_empty", "unavailable"] as const)[observations.detailOutcomes.size % 3];

      if (!observations.staleMismatchRejected) {
        const staleResolution = await api.post(`/api/executor/jobs/${job.id}/resolve`, {
          headers,
          data: {
            status: "completed",
            lease_token: job.lease_token,
            result: {
              detail_evidence: detailEvidenceFor(job, "verified", keyword, "stale-product-id")
            }
          }
        });
        expect(staleResolution.ok()).toBe(false);
        observations.staleMismatchRejected = true;
      }

      const detailResolved = await api.post(`/api/executor/jobs/${job.id}/resolve`, {
        headers,
        data: {
          status: "completed",
          lease_token: job.lease_token,
          result: { detail_evidence: detailEvidenceFor(job, outcome, keyword) }
        }
      });
      expect(detailResolved.ok(), await detailResolved.text()).toBe(true);
      observations.jobs.push(job);
      observations.detailOutcomes.set(moduleId, outcome);
      continue;
    }

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

    observations.jobs.push(job);
    const resolved = await api.post(`/api/executor/jobs/${job.id}/resolve`, {
      headers,
      data: {
        status: "completed",
        lease_token: job.lease_token,
        result: verifiedSearchResultFor(job, matchedItemType!, scenario.name)
      }
    });
    expect(resolved.ok(), await resolved.text()).toBe(true);
  }
}

for (const scenarioCase of scenarioCases) {
  const scenario = getScenarioConfig(scenarioCase.id);

  test(`${scenario.id} reaches scenario-specific recommendations through the durable fixture executor`, async ({ page }) => {
    const deviceToken = await activateFixtureExecutor(page, scenario.id);
    let stopExecutor = false;
    const observations: ExecutorObservations = {
      jobs: [],
      detailOutcomes: new Map(),
      staleMismatchRejected: false
    };
    let executor: Promise<void> | undefined;

    try {
      if (scenario.id === "moving-setup") {
        await page.setViewportSize({ width: 390, height: 844 });
      }
      await page.goto("/");
      await page.getByRole("button", {
        name: `${scenario.name} ${scenario.short_description}`,
        exact: true
      }).click();

      const examplePrompt = scenario.example_prompts[scenarioCase.exampleIndex];
      await page.getByRole("button", { name: examplePrompt, exact: true }).click();
      const requirementInput = page.getByRole("textbox", { name: "描述你的购物场景" });
      await expect(requirementInput).toHaveValue(examplePrompt);
      await requirementInput.fill(`${examplePrompt}，希望优先考虑耐用和容易收纳。`);
      await page.getByRole("button", { name: scenario.start_button_text }).click();
      await expect(page.getByRole("heading", { name: scenario.confirm_scene_title })).toBeVisible();
      await page.getByRole("button", { name: "确认无误，生成购买路线" }).click();
      await expect(page.getByRole("heading", { name: scenario.confirm_plan_title })).toBeVisible();

      const sessionId = await page.evaluate(() => {
        const key = Object.keys(window.localStorage).find((item) => item.startsWith("scenecart-dashboard-state:v2:"));
        const raw = key ? window.localStorage.getItem(key) : null;
        if (!raw) return "";
        return String((JSON.parse(raw) as { state?: { sessionId?: string } }).state?.sessionId ?? "");
      });
      expect(sessionId).not.toBe("");
      const persistence = await page.evaluate((expectedKey) => {
        const raw = window.localStorage.getItem(expectedKey);
        return raw ? JSON.parse(raw) as { owner?: string } : null;
      }, singleUserStorageKey);
      expect(persistence?.owner).toBe(singleUserStorageOwner);

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
        observations
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
      expect(new Set(
        observations.jobs
          .filter((job) => job.job_type === "module_search")
          .map((job) => String(job.payload.module_id))
      )).toEqual(new Set(moduleIds));
      expect(new Set(
        observations.jobs
          .filter((job) => job.job_type === "product_detail")
          .map((job) => String(job.payload.module_id))
      )).toEqual(new Set(moduleIds));
      expect(observations.staleMismatchRejected).toBe(true);

      for (const module of completedState.shopping_plan.modules) {
        const moduleTab = page.getByRole("tab", { name: new RegExp(`^${module.module_name}\\s+\\d+$`) });
        await expect(moduleTab).toBeVisible();
        await moduleTab.click();
        const resultsPanel = page.getByRole("tabpanel");
        const resultCards = resultsPanel.locator("article");
        await expect(resultCards).toHaveCount(1);
        await expect(resultCards.first().getByText("为什么推荐它", { exact: true })).toBeVisible();
        if (scenario.id === "camping" && module.module_id === moduleIds[0]) {
          const primaryCardBox = await resultCards.first().boundingBox();
          expect(primaryCardBox).not.toBeNull();
          expect(primaryCardBox!.height).toBeLessThan(520);
          await resultCards.first().screenshot({ path: ".data/previews/scenecart-local-compact-recommendation.png" });
        }
        const alternativesToggle = resultsPanel.getByRole("button", { name: /查看 2 个备选商品/ });
        await expect(alternativesToggle).toBeVisible();
        await alternativesToggle.click();
        await expect(resultCards).toHaveCount(3);
        await expect(resultsPanel.getByRole("button", { name: /收起备选商品/ })).toBeVisible();
        const detailOutcome = observations.detailOutcomes.get(module.module_id);
        if (detailOutcome === "verified") {
          await expect(resultsPanel.getByText("AI 最推荐", { exact: true })).toHaveCount(1);
          await expect(resultCards.first().getByText("AI 最推荐", { exact: true })).toBeVisible();
          await expect(resultCards.first().getByText("本机 Worker 已读取淘宝详情页", { exact: true })).toBeVisible();
          await expect(resultCards.first().getByText("基于详情页：", { exact: true })).toBeVisible();
          const capturedAt = resultCards.first().locator("time[datetime]");
          await expect(capturedAt).toBeVisible();
          await expect(capturedAt).toContainText("提取于");
          await expect(capturedAt).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/);
          await expect(resultCards.first().getByText("详情已验证", { exact: true })).toHaveCount(0);
          await expect(resultCards.first().getByText(/已核验淘宝详情页/)).toHaveCount(0);
          await expect(resultCards.first().getByText(/具体 SKU 与成交价仍需购买前确认/)).toBeVisible();
        } else if (detailOutcome === "verified_empty") {
          await expect(resultsPanel.getByText("AI 最推荐", { exact: true })).toHaveCount(0);
          await expect(resultCards.first().getByText("搜索首选", { exact: true })).toBeVisible();
          await expect(resultCards.first().getByText("本机 Worker 已读取淘宝详情页", { exact: true })).toBeVisible();
          await expect(resultCards.first()).not.toHaveClass(/product-result-card-featured/);
          await expect(resultCards.first()).toHaveClass(/product-result-card-summary-pick/);
        } else {
          await expect(resultsPanel.getByText("AI 最推荐", { exact: true })).toHaveCount(0);
          await expect(resultCards.first().getByText("搜索摘要首选", { exact: true })).toBeVisible();
          await expect(resultCards.first().getByText(
            "仅基于搜索摘要，淘宝详情页暂不可读",
            { exact: true }
          )).toBeVisible();
          await expect(resultCards.first().getByText("搜索摘要判断：", { exact: true })).toBeVisible();
          await expect(resultCards.first().getByText("读取状态：详情页读取超时", { exact: true })).toBeVisible();
          await expect(resultCards.first().getByText("基于详情页：", { exact: true })).toHaveCount(0);
          await expect(resultCards.first()).not.toHaveClass(/product-result-card-featured/);
          await expect(resultCards.first()).toHaveClass(/product-result-card-summary-pick/);
        }
        await expect(resultCards.nth(1).getByText(/^(?:AI 最推荐|搜索首选|搜索摘要首选)$/)).toHaveCount(0);
        await expect(resultCards.nth(2).getByText(/^(?:AI 最推荐|搜索首选|搜索摘要首选)$/)).toHaveCount(0);
      }
      await expect(page.getByText(new RegExp(`${scenario.name}.*E2E 候选`)).first()).toBeVisible();
      await expect(page.getByText(/本次淘宝 MCP ·/).first()).toBeVisible();
      await expect(page.getByRole("heading", { name: "我的购物清单" })).toBeVisible();

      const jobsResponse = await page.request.get(`/api/runtime/jobs?session_id=${sessionId}`);
      const { jobs } = await jobsResponse.json() as { jobs: Array<{ job_type: string }> };
      expect(jobs.length).toBeGreaterThanOrEqual(moduleIds.length * 2);
      expect(jobs.every((job) => job.job_type === "module_search" || job.job_type === "product_detail")).toBe(true);
    } finally {
      stopExecutor = true;
      await executor;
    }
  });
}
