import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { localRuntimeRepository, resetLocalRuntimeForTests } from "@/lib/runtime/local-repository";
import {
  applyCompletedRuntimeJob as applyCompletedRuntimeJobRaw,
  applyFailedRuntimeJob as applyFailedRuntimeJobRaw,
  authenticateExecutorToken,
  enqueueAddToCartJob as enqueueAddToCartJobRaw,
  enqueueModuleSearchJob as enqueueModuleSearchJobRaw,
  reconcileAuthenticationFailureHoldsForDevice,
  reconcileCompletedRuntimeJob,
  releaseAuthenticationFailureHoldForUser,
  registerExecutorDevice,
  shouldContinueWorkflowAfterCompletion
} from "@/lib/runtime/jobs";
import { decideNextAgentAction } from "@/lib/agent/decision-engine";
import { createRuntimeJobFixture } from "@/tests/fixtures/runtime-job";
import { createSessionFixture } from "@/tests/fixtures/session";
import type { ExecutorDevice } from "@/lib/runtime/types";

const device: ExecutorDevice = {
  id: "device-test",
  user_id: "user-test",
  name: "test executor",
  token_hash: "digest",
  capabilities: ["module_search", "add_to_cart"],
  status: "online",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString()
};

async function enqueueModuleSearchJob(
  state: Parameters<typeof enqueueModuleSearchJobRaw>[0],
  input: Parameters<typeof enqueueModuleSearchJobRaw>[1]
) {
  await localRuntimeRepository.saveSession(state);
  return enqueueModuleSearchJobRaw(state, input);
}

async function enqueueAddToCartJob(
  state: Parameters<typeof enqueueAddToCartJobRaw>[0],
  input: Parameters<typeof enqueueAddToCartJobRaw>[1]
) {
  await localRuntimeRepository.saveSession(state);
  return enqueueAddToCartJobRaw(state, input);
}

async function applyCompletedRuntimeJob(
  jobId: string,
  executorDevice: ExecutorDevice,
  result: Record<string, unknown>,
  leaseToken?: string
) {
  const job = await localRuntimeRepository.getJob(jobId);
  return applyCompletedRuntimeJobRaw(jobId, executorDevice, result, leaseToken ?? job?.lease_token ?? "");
}

async function applyFailedRuntimeJob(
  jobId: string,
  executorDevice: ExecutorDevice,
  errorMessage: string,
  options: Parameters<typeof applyFailedRuntimeJobRaw>[3] = {}
) {
  const job = await localRuntimeRepository.getJob(jobId);
  return applyFailedRuntimeJobRaw(jobId, executorDevice, errorMessage, {
    ...options,
    leaseToken: options.leaseToken ?? job?.lease_token
  });
}

function liveTaobaoSearchResult(input: {
  jobId: string;
  moduleId: string;
  workflowRunId: string;
  keyword: string;
  capturedAt?: string;
  transport?: "http_mcp" | "native_cli";
}) {
  return {
    summary: `已通过淘宝工具搜索“${input.keyword}”`,
    candidates: [{
      product_id: "843402079981",
      title: "车载手机支架",
      price: 73.8,
      source: "淘宝",
      shop_name: "测试旗舰店",
      image_url: "https://img.alicdn.com/item.jpg",
      detail_url: "https://click.simba.taobao.com/cc_im?id=843402079981",
      shop_badges: ["旗舰店"],
      highlights: [
        "来自淘宝实时搜索",
        "匹配模块搜索意图",
        "命中AI检索重点",
        "价格更贴近模块预算",
        "稳固夹持"
      ],
      risk_notes: ["请打开详情页确认规格"],
      fit_reason: "来自本次淘宝搜索",
      recommendation_type: "稳妥推荐" as const,
      module_id: input.moduleId
    }],
    evidence: {
      schema: "scenecart.taobao-mcp-search-evidence/v1",
      source: "taobao-mcp",
      tool: "search_products",
      source_app: "SceneCartAI",
      job_id: input.jobId,
      module_id: input.moduleId,
      workflow_run_id: input.workflowRunId,
      keyword: input.keyword,
      captured_at: input.capturedAt ?? new Date().toISOString(),
      cache_hit: false,
      raw_result_count: 48,
      ...(input.transport ? { transport: input.transport } : {})
    }
  };
}

function liveTaobaoDetailResult(input: {
  jobId: string;
  searchJobId: string;
  moduleId: string;
  workflowRunId: string;
  productId?: string;
  detailUrl?: string;
  capturedAt?: string;
  status?: "verified" | "unavailable";
}) {
  const productId = input.productId ?? "843402079981";
  const detailUrl = input.detailUrl ?? `https://item.taobao.com/item.htm?id=${productId}`;
  const base = {
    schema: "scenecart.taobao-mcp-product-detail-evidence/v1",
    source: "taobao-mcp",
    status: input.status ?? "verified",
    tool: "navigate_to_url+read_page_content",
    tools_used: input.status === "unavailable" ? [] : ["navigate_to_url", "read_page_content"],
    source_app: "SceneCartAI",
    job_id: input.jobId,
    search_job_id: input.searchJobId,
    module_id: input.moduleId,
    workflow_run_id: input.workflowRunId,
    product_id: productId,
    detail_url: detailUrl,
    captured_at: input.capturedAt ?? new Date().toISOString()
  };
  return {
    detail_evidence: input.status === "unavailable"
      ? { ...base, unavailable_reason: "淘宝桌面版缺少 read_page_content 工具" }
      : {
          ...base,
          summary: {
            page_title: "车载手机支架 - 淘宝网",
            page_url: `https://item.taobao.com/item.htm?id=${productId}`,
            visible_text_sha256: "a".repeat(64),
            matched_facts: ["稳固夹持"],
            displayed_price_texts: ["￥73.80"]
          }
        }
  };
}

async function preparePreferredDetailJob(
  label: string,
  options: { claimDetail?: boolean } = {}
) {
  await localRuntimeRepository.createDevice(device);
  const sessionId = `session-detail-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const state = createSessionFixture({ session_id: sessionId, owner_id: device.user_id });
  const workflowRunId = `workflow-detail-${label}`;
  state.agent_runtime.workflow_run_id = workflowRunId;
  const module = state.shopping_plan.modules[0];
  const keyword = module.search_strategy!.primary_keyword;
  const searchJob = await enqueueModuleSearchJob(state, {
    moduleId: module.module_id,
    moduleName: module.module_name,
    keyword
  });
  await localRuntimeRepository.saveSession(state);
  await localRuntimeRepository.claimJob(device, 30_000);
  const searchCompletion = await applyCompletedRuntimeJob(searchJob.id, device, liveTaobaoSearchResult({
    jobId: searchJob.id,
    moduleId: module.module_id,
    workflowRunId,
    keyword
  }));
  const detailJob = await localRuntimeRepository.getJob(searchCompletion.follow_up_job_id!);
  if (options.claimDetail !== false) {
    await localRuntimeRepository.claimJob(device, 30_000);
  }
  return { sessionId, module, workflowRunId, searchJob, detailJob: detailJob! };
}

describe("durable job queue contract", () => {
  beforeEach(() => {
    resetLocalRuntimeForTests();
  });

  it("deduplicates jobs and completes a claimed job idempotently", async () => {
    await localRuntimeRepository.createDevice(device);
    const input = {
      id: "job-first",
      user_id: device.user_id,
      session_id: "session-test",
      job_type: "module_search" as const,
      idempotency_key: "search:session:module:keyword",
      payload: { keyword: "新能源车 行车记录仪" }
    };
    const first = await createRuntimeJobFixture(input);
    const duplicate = await createRuntimeJobFixture({ ...input, id: "job-duplicate" });
    expect(duplicate.id).toBe(first.id);

    const claimed = await localRuntimeRepository.claimJob(device, 30_000);
    expect(claimed?.status).toBe("leased");
    const running = await localRuntimeRepository.renewJobLease(
      first.id,
      device.id,
      claimed!.lease_token!,
      30_000
    );
    expect(running?.status).toBe("running");

    const completed = await localRuntimeRepository.completeJob(first.id, device.id, { results: [] }, running!.lease_token!);
    const replay = await localRuntimeRepository.completeJob(first.id, device.id, { results: [] }, running!.lease_token!);
    const duplicateAfterCompletion = await createRuntimeJobFixture({ ...input, id: "job-after-completion" });
    expect(completed.alreadyCompleted).toBe(false);
    expect(replay.alreadyCompleted).toBe(true);
    expect(duplicateAfterCompletion.id).toBe(first.id);
    expect(duplicateAfterCompletion.status).toBe("completed");
  });

  it("does not disclose a completed job result to another executor device", async () => {
    const otherDevice = { ...device, id: "device-result-intruder", token_hash: "digest-intruder" };
    await localRuntimeRepository.createDevice(device);
    await localRuntimeRepository.createDevice(otherDevice);
    const created = await createRuntimeJobFixture({
      id: "job-private-completed-result",
      user_id: device.user_id,
      session_id: "session-private-completed-result",
      job_type: "module_search",
      idempotency_key: "private-completed-result",
      payload: {}
    });
    const claimed = await localRuntimeRepository.claimJob(device, 30_000);
    await localRuntimeRepository.completeJob(
      created.id,
      device.id,
      { secret_result: "owner-only" },
      claimed!.lease_token!
    );

    await expect(localRuntimeRepository.completeJob(created.id, otherDevice.id, {}, claimed!.lease_token!))
      .rejects.toThrow("job lease owner mismatch");
    await expect(localRuntimeRepository.failJob(created.id, otherDevice.id, "replay", claimed!.lease_token!))
      .rejects.toThrow("job lease owner mismatch");
  });

  it("does not let active product detail jobs consume workflow recovery slots", async () => {
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const blockedId = `session-detail-recovery-blocked-${nonce}`;
    const recoverableId = `session-recovery-behind-detail-${nonce}`;
    const blocked = createSessionFixture({
      session_id: blockedId,
      owner_id: device.user_id
    });
    const recoverable = createSessionFixture({
      session_id: recoverableId,
      owner_id: device.user_id
    });
    try {
      blocked.agent_runtime.auto_continue = true;
      blocked.agent_runtime.workflow_status = "waiting_for_tools";
      blocked.agent_runtime.workflow_run_id = `workflow-detail-recovery-blocked-${nonce}`;
      blocked.agent_runtime.last_transition_at = "2020-01-01T00:00:00.000Z";
      const blockedModule = blocked.shopping_plan.modules[0];
      const blockedCandidate = liveTaobaoSearchResult({
        jobId: `search-detail-recovery-blocked-${nonce}`,
        moduleId: blockedModule.module_id,
        workflowRunId: blocked.agent_runtime.workflow_run_id,
        keyword: blockedModule.search_strategy!.primary_keyword
      }).candidates[0];
      blocked.module_candidates[blockedModule.module_id] = [blockedCandidate];
      const blockedSearchJobId = `search-detail-recovery-blocked-${nonce}`;
      const blockedDetailJobId = `job-detail-recovery-blocked-${nonce}`;
      const blockedTaskAt = new Date().toISOString();
      blocked.hosted_tasks.unshift({
        task_id: blockedSearchJobId,
        runtime_job_id: blockedSearchJobId,
        executor: "local_executor",
        task_type: "module_search",
        session_id: blocked.session_id,
        status: "completed",
        title: "已完成恢复测试搜索",
        description: "为当前首选商品创建精确详情来源链。",
        module_id: blockedModule.module_id,
        module_name: blockedModule.module_name,
        created_at: blockedTaskAt,
        updated_at: blockedTaskAt,
        payload: {
          keyword: blockedModule.search_strategy!.primary_keyword,
          workflow_run_id: blocked.agent_runtime.workflow_run_id,
          preferred_product_detail_job_id: blockedDetailJobId,
          preferred_product_id: blockedCandidate.product_id
        }
      });
      await localRuntimeRepository.saveSession(blocked);
      await createRuntimeJobFixture({
        id: blockedDetailJobId,
        user_id: device.user_id,
        session_id: blocked.session_id,
        job_type: "product_detail",
        idempotency_key: `detail-recovery-blocked-${nonce}`,
        payload: {
          search_job_id: blockedSearchJobId,
          workflow_run_id: blocked.agent_runtime.workflow_run_id,
          module_id: blockedModule.module_id,
          product_id: blockedCandidate.product_id,
          detail_url: blockedCandidate.detail_url
        }
      });

      recoverable.agent_runtime.auto_continue = true;
      recoverable.agent_runtime.workflow_status = "running";
      recoverable.agent_runtime.last_transition_at = "2021-01-01T00:00:00.000Z";
      await localRuntimeRepository.saveSession(recoverable);

      expect((await localRuntimeRepository.listWorkflowRecoveryCandidates(device.user_id, 1))
        .map((state) => state.session_id)).toEqual([recoverable.session_id]);
    } finally {
      await Promise.all([blockedId, recoverableId].map((sessionId) =>
        fs.unlink(path.join(process.cwd(), ".data", "sessions", `${sessionId}.json`)).catch(() => undefined)
      ));
    }
  });

  it("does not let a stale same-product detail job block recovery for the latest search", async () => {
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sessionId = `session-stale-detail-recovery-${nonce}`;
    const state = createSessionFixture({ session_id: sessionId, owner_id: device.user_id });
    try {
      state.agent_runtime.auto_continue = true;
      state.agent_runtime.workflow_status = "waiting_for_tools";
      state.agent_runtime.workflow_run_id = `workflow-stale-detail-recovery-${nonce}`;
      state.agent_runtime.last_transition_at = "2020-06-01T00:00:00.000Z";
      const module = state.shopping_plan.modules[0];
      const candidate = liveTaobaoSearchResult({
        jobId: `search-current-${nonce}`,
        moduleId: module.module_id,
        workflowRunId: state.agent_runtime.workflow_run_id,
        keyword: module.search_strategy!.primary_keyword
      }).candidates[0];
      const currentSearchJobId = `search-current-${nonce}`;
      const currentDetailJobId = `detail-current-${nonce}`;
      const staleSearchJobId = `search-stale-${nonce}`;
      const staleDetailJobId = `detail-stale-${nonce}`;
      const taskAt = new Date().toISOString();
      state.module_candidates[module.module_id] = [candidate];
      state.hosted_tasks.unshift({
        task_id: currentSearchJobId,
        runtime_job_id: currentSearchJobId,
        executor: "local_executor",
        task_type: "module_search",
        session_id: state.session_id,
        status: "completed",
        title: "最新同商品搜索",
        description: "恢复必须绑定最新搜索来源。",
        module_id: module.module_id,
        module_name: module.module_name,
        created_at: taskAt,
        updated_at: taskAt,
        payload: {
          keyword: module.search_strategy!.primary_keyword,
          workflow_run_id: state.agent_runtime.workflow_run_id,
          preferred_product_detail_job_id: currentDetailJobId,
          preferred_product_id: candidate.product_id
        }
      });
      await localRuntimeRepository.saveSession(state);
      await createRuntimeJobFixture({
        id: staleDetailJobId,
        user_id: device.user_id,
        session_id: state.session_id,
        job_type: "product_detail",
        idempotency_key: `stale-detail-recovery-${nonce}`,
        payload: {
          search_job_id: staleSearchJobId,
          workflow_run_id: state.agent_runtime.workflow_run_id,
          module_id: module.module_id,
          product_id: candidate.product_id,
          detail_url: candidate.detail_url
        }
      });

      expect((await localRuntimeRepository.listWorkflowRecoveryCandidates(device.user_id, 100))
        .map((candidateState) => candidateState.session_id)).toContain(sessionId);
    } finally {
      await fs.unlink(path.join(process.cwd(), ".data", "sessions", `${sessionId}.json`)).catch(() => undefined);
    }
  });

  it("keeps queued jobs untouched while the responsive worker is waiting for Taobao MCP", async () => {
    await localRuntimeRepository.createDevice(device);
    const pending = await createRuntimeJobFixture({
      id: "job-waiting-for-mcp",
      user_id: device.user_id,
      session_id: "session-waiting-for-mcp",
      job_type: "module_search",
      idempotency_key: "waiting-for-mcp",
      payload: { keyword: "车载充电器" }
    });

    const reconnecting = await localRuntimeRepository.heartbeatDevice(device.id, "mcp_unavailable");
    expect(reconnecting?.status).toBe("mcp_unavailable");
    expect(await localRuntimeRepository.claimJob(reconnecting!, 30_000)).toBeNull();
    expect(await localRuntimeRepository.getJob(pending.id)).toMatchObject({
      status: "pending",
      attempts: 0
    });

    const online = await localRuntimeRepository.heartbeatDevice(device.id, "online");
    expect((await localRuntimeRepository.claimJob(online!, 30_000))?.id).toBe(pending.id);
  });

  it("persists a server-validated proof for a live Taobao MCP result", async () => {
    await localRuntimeRepository.createDevice(device);
    const sessionId = `session-live-evidence-${Date.now()}`;
    const state = createSessionFixture({ session_id: sessionId, owner_id: device.user_id });
    state.agent_runtime.workflow_run_id = "workflow-live-evidence";
    const module = state.shopping_plan.modules[0];
    const keyword = module.search_strategy!.primary_keyword;
    const job = await enqueueModuleSearchJob(state, {
      moduleId: module.module_id,
      moduleName: module.module_name,
      keyword
    });
    await localRuntimeRepository.saveSession(state);
    await localRuntimeRepository.claimJob(device, 30_000);

    const searchCompletion = await applyCompletedRuntimeJob(job.id, device, liveTaobaoSearchResult({
      jobId: job.id,
      moduleId: module.module_id,
      workflowRunId: "workflow-live-evidence",
      keyword
    }));
    expect(searchCompletion.follow_up_job_id).toBeTruthy();
    expect(await shouldContinueWorkflowAfterCompletion({
      job: searchCompletion.job,
      alreadyCompleted: searchCompletion.alreadyCompleted,
      followUpJobId: searchCompletion.follow_up_job_id
    })).toBe(false);

    const detailJob = await localRuntimeRepository.getJob(searchCompletion.follow_up_job_id!);
    expect(detailJob).toMatchObject({
      job_type: "product_detail",
      payload: {
        search_job_id: job.id,
        module_id: module.module_id,
        workflow_run_id: "workflow-live-evidence",
        product_id: "843402079981"
      }
    });
    const factTerms = detailJob?.payload.fact_terms as string[];
    expect(factTerms[0]).toBe(keyword);
    expect(factTerms).toContain("稳固夹持");
    expect(factTerms).not.toEqual(expect.arrayContaining([
      "来自淘宝实时搜索",
      "匹配模块搜索意图",
      "命中AI检索重点",
      "价格更贴近模块预算"
    ]));
    expect(await localRuntimeRepository.claimJob(device, 30_000)).toMatchObject({ id: detailJob!.id });
    const detailCompletion = await applyCompletedRuntimeJob(detailJob!.id, device, liveTaobaoDetailResult({
      jobId: detailJob!.id,
      searchJobId: job.id,
      moduleId: module.module_id,
      workflowRunId: "workflow-live-evidence",
      detailUrl: String(detailJob!.payload.detail_url)
    }));
    expect(await shouldContinueWorkflowAfterCompletion({
      job: detailCompletion.job,
      alreadyCompleted: detailCompletion.alreadyCompleted,
      followUpJobId: detailCompletion.follow_up_job_id
    })).toBe(true);

    const restored = await localRuntimeRepository.getSession(sessionId, device.user_id);
    const task = restored?.hosted_tasks.find((entry) => entry.task_id === job.id);
    expect(task?.payload.taobao_mcp_evidence).toMatchObject({
      source: "taobao-mcp",
      tool: "search_products",
      source_app: "SceneCartAI",
      job_id: job.id,
      module_id: module.module_id,
      workflow_run_id: "workflow-live-evidence",
      keyword,
      cache_hit: false,
      raw_result_count: 48
    });
    expect(restored?.module_candidates[module.module_id]).toHaveLength(1);
    expect(restored?.module_candidates[module.module_id][0].detail_evidence).toMatchObject({
      status: "verified",
      job_id: detailJob!.id,
      search_job_id: job.id,
      product_id: "843402079981",
      recommendation_reason: expect.stringContaining("页面可见信号")
    });
    const events = await localRuntimeRepository.listEvents(sessionId, 0, device.user_id);
    expect(events.find((event) => event.event_type === "job.completed" && event.job_id === job.id)?.payload.evidence).toMatchObject({
      job_id: job.id,
      source: "taobao-mcp",
      raw_result_count: 48
    });

    await fs.unlink(path.join(process.cwd(), ".data", "sessions", `${sessionId}.json`)).catch(() => undefined);
  });

  it("continues after a native-CLI search without queuing an HTTP-only detail job", async () => {
    await localRuntimeRepository.createDevice(device);
    const sessionId = `session-native-cli-evidence-${Date.now()}`;
    const workflowRunId = "workflow-native-cli-evidence";
    const state = createSessionFixture({ session_id: sessionId, owner_id: device.user_id });
    state.agent_runtime.workflow_run_id = workflowRunId;
    const module = state.shopping_plan.modules[0];
    const keyword = module.search_strategy!.primary_keyword;
    const job = await enqueueModuleSearchJob(state, {
      moduleId: module.module_id,
      moduleName: module.module_name,
      keyword
    });
    await localRuntimeRepository.saveSession(state);
    await expect(localRuntimeRepository.claimJob(device, 30_000, "5", {
      transport: "native_cli",
      available_tools: ["search_products", "list_available_pages"]
    })).resolves.toMatchObject({ id: job.id, job_type: "module_search" });

    const completion = await applyCompletedRuntimeJob(job.id, device, liveTaobaoSearchResult({
      jobId: job.id,
      moduleId: module.module_id,
      workflowRunId,
      keyword,
      transport: "native_cli"
    }));

    expect(completion.follow_up_job_id).toBeUndefined();
    await expect(shouldContinueWorkflowAfterCompletion({
      job: completion.job,
      alreadyCompleted: completion.alreadyCompleted,
      followUpJobId: completion.follow_up_job_id
    })).resolves.toBe(true);
    expect((await localRuntimeRepository.listJobs(sessionId, device.user_id))
      .filter((candidate) => candidate.job_type === "product_detail")).toEqual([]);
    expect((await localRuntimeRepository.getSession(sessionId, device.user_id))
      ?.hosted_tasks.find((task) => task.task_id === job.id)?.payload.taobao_mcp_evidence)
      .toMatchObject({ transport: "native_cli" });

    await fs.unlink(path.join(process.cwd(), ".data", "sessions", `${sessionId}.json`)).catch(() => undefined);
  });

  it("keeps search candidates and continues when preferred detail evidence is unavailable", async () => {
    const prepared = await preparePreferredDetailJob("unavailable");
    const completion = await applyCompletedRuntimeJob(
      prepared.detailJob.id,
      device,
      liveTaobaoDetailResult({
        jobId: prepared.detailJob.id,
        searchJobId: prepared.searchJob.id,
        moduleId: prepared.module.module_id,
        workflowRunId: prepared.workflowRunId,
        detailUrl: String(prepared.detailJob.payload.detail_url),
        status: "unavailable"
      })
    );
    const restored = await localRuntimeRepository.getSession(prepared.sessionId, device.user_id);
    expect(restored?.module_candidates[prepared.module.module_id]).toHaveLength(1);
    expect(restored?.module_candidates[prepared.module.module_id][0].detail_evidence).toMatchObject({
      status: "unavailable",
      unavailable_reason: "详情页内容暂未完整返回",
      recommendation_reason: expect.stringContaining("真实淘宝搜索摘要")
    });
    expect(await shouldContinueWorkflowAfterCompletion({
      job: completion.job,
      alreadyCompleted: completion.alreadyCompleted,
      followUpJobId: completion.follow_up_job_id
    })).toBe(true);
  });

  it("projects product-detail evidence to a strict safe DTO before persisting it", async () => {
    const prepared = await preparePreferredDetailJob("privacy-projection");
    const sentinel = "PRIVATE-RAW-PAGE-CONTENT-MUST-NOT-PERSIST";
    const result = liveTaobaoDetailResult({
      jobId: prepared.detailJob.id,
      searchJobId: prepared.searchJob.id,
      moduleId: prepared.module.module_id,
      workflowRunId: prepared.workflowRunId,
      detailUrl: String(prepared.detailJob.payload.detail_url)
    }) as ReturnType<typeof liveTaobaoDetailResult> & Record<string, unknown>;
    result.raw_page_content = sentinel;
    Object.assign(result.detail_evidence, { raw_page_content: sentinel });
    if ("summary" in result.detail_evidence && result.detail_evidence.summary) {
      Object.assign(result.detail_evidence.summary, { visible_text_excerpt: sentinel });
    }

    await applyCompletedRuntimeJob(prepared.detailJob.id, device, result);

    const storedJob = await localRuntimeRepository.getJob(prepared.detailJob.id);
    const storedSession = await localRuntimeRepository.getSession(prepared.sessionId, device.user_id);
    expect(JSON.stringify(storedJob)).not.toContain(sentinel);
    expect(JSON.stringify(storedSession)).not.toContain(sentinel);
    expect(storedJob?.result).toEqual({
      detail_evidence: expect.objectContaining({ status: "verified" })
    });
  });

  it("cancels an unclaimed preferred-detail job when the module is searched again", async () => {
    const prepared = await preparePreferredDetailJob("pending-supersede", { claimDetail: false });
    const state = await localRuntimeRepository.getSession(prepared.sessionId, device.user_id);
    expect(state).not.toBeNull();

    const nextSearch = await enqueueModuleSearchJob(state!, {
      moduleId: prepared.module.module_id,
      moduleName: prepared.module.module_name,
      keyword: `${prepared.module.search_strategy!.primary_keyword} 补搜`
    });
    await localRuntimeRepository.saveSession(state!);

    expect(nextSearch.id).not.toBe(prepared.searchJob.id);
    expect(await localRuntimeRepository.getJob(prepared.detailJob.id)).toMatchObject({
      status: "cancelled"
    });
    const oldSearchTask = state!.hosted_tasks.find((task) => task.task_id === prepared.searchJob.id);
    expect(oldSearchTask?.payload.preferred_product_detail_job_id).toBeUndefined();
    expect(oldSearchTask?.payload.preferred_product_id).toBeUndefined();
    expect((await localRuntimeRepository.listEvents(prepared.sessionId, 0, device.user_id)).find((event) =>
      event.event_type === "job.product_detail_superseded" && event.job_id === prepared.detailJob.id
    )?.payload).toMatchObject({
      cancelled: true,
      superseding_search_job_id: nextSearch.id
    });
  });

  it("binds same-product detail evidence to the exact latest search and detail jobs", async () => {
    const prepared = await preparePreferredDetailJob("same-product-research");
    const state = await localRuntimeRepository.getSession(prepared.sessionId, device.user_id);
    expect(state).not.toBeNull();
    const nextKeyword = `${prepared.module.search_strategy!.primary_keyword} 补搜`;
    const nextSearch = await enqueueModuleSearchJob(state!, {
      moduleId: prepared.module.module_id,
      moduleName: prepared.module.module_name,
      keyword: nextKeyword
    });
    await localRuntimeRepository.saveSession(state!);

    expect(await localRuntimeRepository.getJob(prepared.detailJob.id)).toMatchObject({ status: "leased" });
    expect(await localRuntimeRepository.claimJob(device, 30_000)).toMatchObject({ id: nextSearch.id });
    const nextSearchCompletion = await applyCompletedRuntimeJob(nextSearch.id, device, liveTaobaoSearchResult({
      jobId: nextSearch.id,
      moduleId: prepared.module.module_id,
      workflowRunId: prepared.workflowRunId,
      keyword: nextKeyword
    }));
    const nextDetail = await localRuntimeRepository.getJob(nextSearchCompletion.follow_up_job_id!);
    expect(nextDetail).toMatchObject({
      job_type: "product_detail",
      status: "pending",
      payload: {
        search_job_id: nextSearch.id,
        product_id: prepared.detailJob.payload.product_id,
        detail_url: prepared.detailJob.payload.detail_url
      }
    });
    expect(nextDetail?.id).not.toBe(prepared.detailJob.id);

    const rebound = await localRuntimeRepository.getSession(prepared.sessionId, device.user_id);
    const currentTask = rebound?.hosted_tasks.find((task) => task.task_id === nextSearch.id);
    const oldTask = rebound?.hosted_tasks.find((task) => task.task_id === prepared.searchJob.id);
    expect(currentTask?.payload).toMatchObject({
      preferred_product_detail_job_id: nextDetail!.id,
      preferred_product_id: prepared.detailJob.payload.product_id
    });
    expect(oldTask?.payload.preferred_product_detail_job_id).toBeUndefined();
    expect(await shouldContinueWorkflowAfterCompletion({
      job: prepared.detailJob,
      alreadyCompleted: false
    })).toBe(false);

    await expect(applyCompletedRuntimeJob(
      prepared.detailJob.id,
      device,
      liveTaobaoDetailResult({
        jobId: prepared.detailJob.id,
        searchJobId: prepared.searchJob.id,
        moduleId: prepared.module.module_id,
        workflowRunId: prepared.workflowRunId,
        detailUrl: String(prepared.detailJob.payload.detail_url)
      })
    )).rejects.toThrow("当前搜索任务");
    await expect(applyFailedRuntimeJob(
      prepared.detailJob.id,
      device,
      "late detail failure",
      { retryable: false }
    )).rejects.toThrow("stale product detail callback");
    expect(await localRuntimeRepository.getJob(prepared.detailJob.id)).toMatchObject({ status: "leased" });

    expect(await localRuntimeRepository.claimJob(device, 30_000)).toMatchObject({ id: nextDetail!.id });
    const currentCompletion = await applyCompletedRuntimeJob(nextDetail!.id, device, liveTaobaoDetailResult({
      jobId: nextDetail!.id,
      searchJobId: nextSearch.id,
      moduleId: prepared.module.module_id,
      workflowRunId: prepared.workflowRunId,
      detailUrl: String(nextDetail!.payload.detail_url)
    }));
    expect(await shouldContinueWorkflowAfterCompletion({
      job: currentCompletion.job,
      alreadyCompleted: currentCompletion.alreadyCompleted
    })).toBe(true);
    expect((await localRuntimeRepository.getSession(prepared.sessionId, device.user_id))
      ?.module_candidates[prepared.module.module_id][0].detail_evidence).toMatchObject({
      job_id: nextDetail!.id,
      search_job_id: nextSearch.id,
      product_id: prepared.detailJob.payload.product_id
    });
  });

  it("rejects a stale detail failure callback without changing job or workflow state", async () => {
    const prepared = await preparePreferredDetailJob("stale-failure");
    const state = await localRuntimeRepository.getSession(prepared.sessionId, device.user_id);
    expect(state).not.toBeNull();
    state!.module_candidates[prepared.module.module_id][0] = {
      ...state!.module_candidates[prepared.module.module_id][0],
      product_id: "new-preferred-product",
      detail_url: "https://item.taobao.com/item.htm?id=new-preferred-product"
    };
    await localRuntimeRepository.saveSession(state!);

    await expect(applyFailedRuntimeJob(
      prepared.detailJob.id,
      device,
      "read_page_content failed",
      { retryable: false }
    )).rejects.toThrow("stale product detail callback");
    expect(await localRuntimeRepository.getJob(prepared.detailJob.id)).toMatchObject({
      status: "leased"
    });
    const restored = await localRuntimeRepository.getSession(prepared.sessionId, device.user_id);
    expect(restored?.module_candidates[prepared.module.module_id][0].product_id).toBe("new-preferred-product");
    expect(restored?.module_candidates[prepared.module.module_id][0].detail_evidence).toBeUndefined();
  });

  it.each([
    {
      name: "lookalike detail domain",
      mutate: (result: ReturnType<typeof liveTaobaoDetailResult>) => {
        result.detail_evidence.detail_url = "https://item.taobao.com.evil.example/item.htm?id=843402079981";
      },
      error: "Job 上下文不一致"
    },
    {
      name: "lookalike page domain",
      mutate: (result: ReturnType<typeof liveTaobaoDetailResult>) => {
        if ("summary" in result.detail_evidence) {
          result.detail_evidence.summary.page_url = "https://item.taobao.com.evil.example/item.htm?id=843402079981";
        }
      },
      error: "字段摘要无效"
    },
    {
      name: "wrong product",
      mutate: (result: ReturnType<typeof liveTaobaoDetailResult>) => {
        result.detail_evidence.product_id = "another-product";
      },
      error: "Job 上下文不一致"
    },
    {
      name: "wrong module",
      mutate: (result: ReturnType<typeof liveTaobaoDetailResult>) => {
        result.detail_evidence.module_id = "another-module";
      },
      error: "Job 上下文不一致"
    },
    {
      name: "wrong workflow",
      mutate: (result: ReturnType<typeof liveTaobaoDetailResult>) => {
        result.detail_evidence.workflow_run_id = "another-workflow";
      },
      error: "Job 上下文不一致"
    },
    {
      name: "wrong parent search job",
      mutate: (result: ReturnType<typeof liveTaobaoDetailResult>) => {
        result.detail_evidence.search_job_id = "another-search-job";
      },
      error: "Job 上下文不一致"
    },
    {
      name: "expired capture time",
      mutate: (result: ReturnType<typeof liveTaobaoDetailResult>) => {
        result.detail_evidence.captured_at = "2000-01-01T00:00:00.000Z";
      },
      error: "证据时间无效"
    },
    {
      name: "oversized page summary",
      mutate: (result: ReturnType<typeof liveTaobaoDetailResult>) => {
        if ("summary" in result.detail_evidence) {
          result.detail_evidence.summary.page_title = "x".repeat(301);
        }
      },
      error: "字段摘要无效"
    },
    {
      name: "fact not bounded by server payload",
      mutate: (result: ReturnType<typeof liveTaobaoDetailResult>) => {
        if ("summary" in result.detail_evidence) {
          result.detail_evidence.summary.matched_facts = ["伪造的顶级适配结论"];
        }
      },
      error: "字段摘要无效"
    }
  ])("rejects forged preferred detail evidence with $name", async ({ mutate, error }) => {
    const prepared = await preparePreferredDetailJob(`invalid-${Math.random().toString(36).slice(2)}`);
    const result = liveTaobaoDetailResult({
      jobId: prepared.detailJob.id,
      searchJobId: prepared.searchJob.id,
      moduleId: prepared.module.module_id,
      workflowRunId: prepared.workflowRunId,
      detailUrl: String(prepared.detailJob.payload.detail_url)
    });
    mutate(result);
    await expect(applyCompletedRuntimeJob(prepared.detailJob.id, device, result)).rejects.toThrow(error);
    expect(await localRuntimeRepository.getJob(prepared.detailJob.id)).toMatchObject({ status: "leased" });
  });

  it("rejects a late detail callback after a re-search changes the current preferred product", async () => {
    const prepared = await preparePreferredDetailJob("stale-preferred");
    const state = await localRuntimeRepository.getSession(prepared.sessionId, device.user_id);
    state!.module_candidates[prepared.module.module_id][0] = {
      ...state!.module_candidates[prepared.module.module_id][0],
      product_id: "new-preferred-product",
      detail_url: "https://item.taobao.com/item.htm?id=new-preferred-product"
    };
    await localRuntimeRepository.saveSession(state!);
    await expect(applyCompletedRuntimeJob(
      prepared.detailJob.id,
      device,
      liveTaobaoDetailResult({
        jobId: prepared.detailJob.id,
        searchJobId: prepared.searchJob.id,
        moduleId: prepared.module.module_id,
        workflowRunId: prepared.workflowRunId,
        detailUrl: String(prepared.detailJob.payload.detail_url)
      })
    )).rejects.toThrow("不再匹配当前 AI 首选");
    const restored = await localRuntimeRepository.getSession(prepared.sessionId, device.user_id);
    expect(restored?.module_candidates[prepared.module.module_id][0].detail_evidence).toBeUndefined();
  });

  it.each([
    {
      name: "mismatched job context",
      mutate: (result: ReturnType<typeof liveTaobaoSearchResult>) => {
        result.evidence.keyword = "伪造搜索词";
      },
      error: "Job 上下文不一致"
    },
    {
      name: "future capture time",
      mutate: (result: ReturnType<typeof liveTaobaoSearchResult>) => {
        result.evidence.captured_at = "2999-01-01T00:00:00.000Z";
      },
      error: "证据时间无效"
    },
    {
      name: "non-Taobao candidate source",
      mutate: (result: ReturnType<typeof liveTaobaoSearchResult>) => {
        result.candidates[0].source = "模型生成";
      },
      error: "候选来源、模块或详情链接无效"
    },
    {
      name: "candidate from another module",
      mutate: (result: ReturnType<typeof liveTaobaoSearchResult>) => {
        result.candidates[0].module_id = "another-module";
      },
      error: "候选来源、模块或详情链接无效"
    },
    {
      name: "lookalike product domain",
      mutate: (result: ReturnType<typeof liveTaobaoSearchResult>) => {
        result.candidates[0].detail_url = "https://item.taobao.com.evil.example/item.htm?id=843402079981";
      },
      error: "候选来源、模块或详情链接无效"
    },
    {
      name: "cached-result claim",
      mutate: (result: ReturnType<typeof liveTaobaoSearchResult>) => {
        result.evidence.cache_hit = true;
      },
      error: "证据结构无效"
    },
    {
      name: "raw count smaller than returned candidates",
      mutate: (result: ReturnType<typeof liveTaobaoSearchResult>) => {
        result.evidence.raw_result_count = 0;
      },
      error: "结果数量无效"
    }
  ])("rejects versioned MCP evidence with $name", async ({ mutate, error }) => {
    await localRuntimeRepository.createDevice(device);
    const sessionId = `session-invalid-evidence-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const state = createSessionFixture({ session_id: sessionId, owner_id: device.user_id });
    state.agent_runtime.workflow_run_id = "workflow-invalid-evidence";
    const module = state.shopping_plan.modules[0];
    const keyword = module.search_strategy!.primary_keyword;
    const job = await enqueueModuleSearchJob(state, {
      moduleId: module.module_id,
      moduleName: module.module_name,
      keyword
    });
    await localRuntimeRepository.saveSession(state);
    await localRuntimeRepository.claimJob(device, 30_000);
    const result = liveTaobaoSearchResult({
      jobId: job.id,
      moduleId: module.module_id,
      workflowRunId: "workflow-invalid-evidence",
      keyword
    });
    mutate(result);

    await expect(applyCompletedRuntimeJob(job.id, device, result)).rejects.toThrow(error);
    expect((await localRuntimeRepository.getJob(job.id))?.status).not.toBe("completed");

    await fs.unlink(path.join(process.cwd(), ".data", "sessions", `${sessionId}.json`)).catch(() => undefined);
  });

  it("grants only search capability when device registration omits an explicit scope", async () => {
    const registered = await registerExecutorDevice("least-privilege-user", "least privilege device");
    expect(registered.device.capabilities).toEqual(["module_search"]);
    const auditEvents = await localRuntimeRepository.listAuditEvents("least-privilege-user");
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      event_type: "executor.device_registered",
      payload: {
        device_id: registered.device.id,
        capabilities: ["module_search"]
      }
    });
    expect(await localRuntimeRepository.listAuditEvents("other-user")).toEqual([]);
    expect((await localRuntimeRepository.updateDeviceCapabilities(
      registered.device.id,
      "other-user",
      ["module_search", "add_to_cart"]
    ))).toBeNull();
    expect((await localRuntimeRepository.updateDeviceCapabilities(
      registered.device.id,
      "least-privilege-user",
      ["module_search", "add_to_cart"]
    ))?.capabilities).toEqual(["module_search", "add_to_cart"]);
  });

  it("pauses job claiming on auth drop and leaves the failed search terminal after login recovery", async () => {
    await localRuntimeRepository.createDevice(device);
    const state = createSessionFixture({
      session_id: `session-auth-recovery-${Date.now()}`,
      owner_id: device.user_id
    });
    const module = state.shopping_plan.modules[0];
    await enqueueModuleSearchJob(state, {
      moduleId: module.module_id,
      moduleName: module.module_name,
      keyword: module.search_strategy?.primary_keyword || module.search_keyword || module.module_name
    });
    await localRuntimeRepository.saveSession(state);

    const claimed = await localRuntimeRepository.claimJob(device, 30_000);
    expect(claimed).not.toBeNull();
    await applyFailedRuntimeJob(
      claimed!.id,
      device,
      "[auth_required] Taobao desktop session expired",
      { retryable: false }
    );
    await createRuntimeJobFixture({
      id: "job-waiting-during-auth-drop",
      user_id: device.user_id,
      session_id: state.session_id,
      job_type: "module_search",
      idempotency_key: `waiting-during-auth-drop:${state.session_id}`,
      payload: { keyword: "不应在登录恢复前领取" }
    });

    const pausedDevice = await localRuntimeRepository.heartbeatDevice(device.id, "authentication_required");
    expect(pausedDevice?.status).toBe("authentication_required");
    expect(await localRuntimeRepository.claimJob(pausedDevice!, 30_000)).toBeNull();

    const onlineDevice = await localRuntimeRepository.heartbeatDevice(device.id, "online");
    expect((await localRuntimeRepository.getJob(claimed!.id))?.status).toBe("failed");
    const recoveredState = await localRuntimeRepository.getSession(state.session_id, device.user_id);
    expect(recoveredState?.hosted_tasks.find((task) => task.task_id === claimed!.id)).toMatchObject({
      status: "failed",
      error_message: expect.stringContaining("[auth_required]")
    });
    expect(recoveredState?.agent_runtime).toMatchObject({
      workflow_status: "paused",
      auto_continue: false,
      current_module_id: module.module_id
    });
    expect((await localRuntimeRepository.claimJob(onlineDevice!, 30_000))?.id)
      .toBe("job-waiting-during-auth-drop");
  });

  it("accepts a persisted auth callback after lease expiry and never returns the action to the queue", async () => {
    await localRuntimeRepository.createDevice(device);
    const state = createSessionFixture({
      session_id: `session-auth-callback-${Date.now()}`,
      owner_id: device.user_id
    });
    const module = state.shopping_plan.modules[0];
    const job = await enqueueModuleSearchJob(state, {
      moduleId: module.module_id,
      moduleName: module.module_name,
      keyword: module.search_strategy?.primary_keyword || module.search_keyword || module.module_name
    });
    await localRuntimeRepository.saveSession(state);

    const claimed = await localRuntimeRepository.claimJob(device, 1);
    expect(claimed?.id).toBe(job.id);
    await localRuntimeRepository.appendEvent({
      user_id: job.user_id,
      session_id: job.session_id,
      job_id: job.id,
      event_type: "job.claimed",
      payload: {
        device_id: device.id,
        device_name: device.name,
        attempt: claimed!.attempts,
        lease_token: claimed!.lease_token
      }
    });
    const pausedDevice = await localRuntimeRepository.heartbeatDevice(
      device.id,
      "authentication_required"
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await localRuntimeRepository.recoverExpiredJobs()).toBe(1);
    expect(await localRuntimeRepository.getJob(job.id)).toMatchObject({
      status: "pending",
      attempts: 1,
      lease_owner_id: undefined
    });

    const failed = await applyFailedRuntimeJob(
      job.id,
      pausedDevice!,
      "[auth_required] 淘宝未登录，请先登录淘宝账号",
      {
        retryable: false,
        authenticationFailureCallback: true,
        leaseToken: claimed!.lease_token
      }
    );
    expect(failed).toMatchObject({
      id: job.id,
      status: "failed",
      attempts: 1,
      lease_owner_id: undefined,
      error_message: expect.stringContaining("[auth_required]")
    });
    await expect(applyFailedRuntimeJob(
      job.id,
      pausedDevice!,
      "[auth_required] 淘宝未登录，请先登录淘宝账号",
      {
        retryable: false,
        authenticationFailureCallback: true,
        leaseToken: claimed!.lease_token
      }
    )).resolves.toMatchObject({ id: job.id, status: "failed", attempts: 1 });

    const onlineDevice = await localRuntimeRepository.heartbeatDevice(device.id, "online");
    expect(await localRuntimeRepository.claimJob(onlineDevice!, 30_000)).toBeNull();
    expect(await localRuntimeRepository.getJob(job.id)).toMatchObject({ status: "failed" });
    const events = await localRuntimeRepository.listEvents(state.session_id, 0, device.user_id);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event_type: "job.authentication_failure_callback_applied",
        job_id: job.id,
        payload: expect.objectContaining({
          executor_device_id: device.id,
          recovered_from_status: "pending"
        })
      }),
      expect.objectContaining({
        event_type: "job.authentication_failure_callback_confirmed",
        job_id: job.id,
        payload: expect.objectContaining({ replayed: true })
      })
    ]));
  });

  it("keeps a server auth hold across callback-ledger loss and a Worker restart until explicit user retry", async () => {
    const runtimeFile = path.join(
      process.cwd(),
      ".data",
      "tests",
      `auth-hold-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    );
    const previousPersist = process.env.SCENECART_LOCAL_RUNTIME_PERSIST;
    const previousPath = process.env.SCENECART_LOCAL_RUNTIME_PATH;
    process.env.SCENECART_LOCAL_RUNTIME_PERSIST = "true";
    process.env.SCENECART_LOCAL_RUNTIME_PATH = runtimeFile;
    const sessionId = `session-auth-hold-crash-${Date.now()}`;
    const sessionPath = path.join(process.cwd(), ".data", "sessions", `${sessionId}.json`);

    try {
      resetLocalRuntimeForTests();
      await localRuntimeRepository.createDevice(device);
      const state = createSessionFixture({ session_id: sessionId, owner_id: device.user_id });
      const module = state.shopping_plan.modules[0];
      const job = await enqueueModuleSearchJob(state, {
        moduleId: module.module_id,
        moduleName: module.module_name,
        keyword: module.search_strategy?.primary_keyword || module.search_keyword || module.module_name
      });
      await localRuntimeRepository.saveSession(state);
      const claimed = await localRuntimeRepository.claimJob(device, 30_000);

      // This is the special heartbeat's atomic runtime write. Simulate the
      // Worker crashing immediately afterwards: no local callback ledger and
      // no opportunity to persist the Session reconciliation yet.
      await localRuntimeRepository.holdAuthenticationJob(
        job.id,
        device,
        "[auth_required] 淘宝未登录，请先登录淘宝账号",
        claimed!.lease_token!
      );
      resetLocalRuntimeForTests();

      const restartedDevice = await localRuntimeRepository.findDeviceByToken(device.token_hash);
      expect(restartedDevice?.status).toBe("authentication_required");
      expect(await localRuntimeRepository.hasActiveAuthenticationFailureHold(device.id)).toBe(true);
      const refusedOnline = await localRuntimeRepository.heartbeatDevice(device.id, "online");
      expect(refusedOnline?.status).toBe("authentication_required");
      expect(await localRuntimeRepository.claimJob({ ...device, status: "online" }, 30_000)).toBeNull();

      // The first restart heartbeat repairs the cross-file local Session cut,
      // making the pause and its explicit actions visible on the website.
      await reconcileAuthenticationFailureHoldsForDevice(device.id);
      globalThis.__AUTOPREP_SESSION_STORE__?.delete(sessionId);
      const repaired = await localRuntimeRepository.getSession(sessionId, device.user_id);
      expect(repaired?.hosted_tasks.find((task) => task.task_id === job.id)).toMatchObject({
        status: "failed",
        error_message: expect.stringContaining("[auth_required]")
      });
      expect(repaired?.agent_runtime).toMatchObject({
        workflow_status: "paused",
        auto_continue: false,
        current_module_id: module.module_id
      });
      expect((await localRuntimeRepository.getJob(job.id))?.attempts).toBe(1);

      await expect(createRuntimeJobFixture({
        id: job.id,
        user_id: job.user_id,
        session_id: job.session_id,
        job_type: job.job_type,
        idempotency_key: job.idempotency_key,
        payload: job.payload,
        max_attempts: job.max_attempts
      })).rejects.toThrow("explicit user release");

      expect(await releaseAuthenticationFailureHoldForUser(
        job.id,
        device.user_id,
        "user_retry"
      )).toBe(true);
      const revived = await createRuntimeJobFixture({
        id: job.id,
        user_id: job.user_id,
        session_id: job.session_id,
        job_type: job.job_type,
        idempotency_key: job.idempotency_key,
        payload: job.payload,
        max_attempts: job.max_attempts
      });
      expect(revived).toMatchObject({ status: "pending", attempts: 0, lease_token: undefined });
      const onlineAfterUserRetry = await localRuntimeRepository.heartbeatDevice(device.id, "online");
      expect(onlineAfterUserRetry?.status).toBe("online");
      expect((await localRuntimeRepository.claimJob(onlineAfterUserRetry!, 30_000))?.id).toBe(job.id);
    } finally {
      resetLocalRuntimeForTests();
      if (previousPersist === undefined) delete process.env.SCENECART_LOCAL_RUNTIME_PERSIST;
      else process.env.SCENECART_LOCAL_RUNTIME_PERSIST = previousPersist;
      if (previousPath === undefined) delete process.env.SCENECART_LOCAL_RUNTIME_PATH;
      else process.env.SCENECART_LOCAL_RUNTIME_PATH = previousPath;
      await fs.unlink(runtimeFile).catch(() => undefined);
      await fs.unlink(sessionPath).catch(() => undefined);
    }
  });

  it("does not let another device replay an expired lease while the claiming device awaits login callback", async () => {
    const secondDevice: ExecutorDevice = {
      ...device,
      id: "device-auth-replay-block-second",
      name: "second executor",
      token_hash: "second-executor-digest"
    };
    await localRuntimeRepository.createDevice(device);
    await localRuntimeRepository.createDevice(secondDevice);
    const job = await createRuntimeJobFixture({
      id: "job-auth-replay-block",
      user_id: device.user_id,
      session_id: "session-auth-replay-block",
      job_type: "module_search",
      idempotency_key: "auth-replay-block",
      payload: { keyword: "auth replay block" },
      max_attempts: 2
    });
    const claimed = await localRuntimeRepository.claimJob(device, 1);
    await localRuntimeRepository.appendEvent({
      user_id: job.user_id,
      session_id: job.session_id,
      job_id: job.id,
      event_type: "job.claimed",
      payload: {
        device_id: device.id,
        device_name: device.name,
        attempt: claimed!.attempts,
        lease_token: claimed!.lease_token
      }
    });
    const pausedDevice = await localRuntimeRepository.heartbeatDevice(
      device.id,
      "authentication_required"
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    await localRuntimeRepository.recoverExpiredJobs();

    expect((await localRuntimeRepository.getJob(job.id))?.status).toBe("pending");
    expect(await localRuntimeRepository.claimJob(secondDevice, 30_000)).toBeNull();

    await applyFailedRuntimeJob(
      job.id,
      pausedDevice!,
      "[auth_required] 淘宝未登录，请先登录淘宝账号",
      {
        retryable: false,
        authenticationFailureCallback: true,
        leaseToken: claimed!.lease_token
      }
    );
    expect((await localRuntimeRepository.getJob(job.id))?.status).toBe("failed");
  });

  it("replays reconciliation durably when the first local Session write fails", async () => {
    await localRuntimeRepository.createDevice(device);
    const sessionId = `session-auth-reconcile-write-${Date.now()}`;
    const sessionPath = path.join(process.cwd(), ".data", "sessions", `${sessionId}.json`);
    const state = createSessionFixture({ session_id: sessionId, owner_id: device.user_id });
    const module = state.shopping_plan.modules[0];
    const job = await enqueueModuleSearchJob(state, {
      moduleId: module.module_id,
      moduleName: module.module_name,
      keyword: module.search_strategy?.primary_keyword || module.search_keyword || module.module_name
    });
    await localRuntimeRepository.saveSession(state);
    const claimed = await localRuntimeRepository.claimJob(device, 30_000);
    const pausedDevice = await localRuntimeRepository.heartbeatDevice(
      device.id,
      "authentication_required"
    );

    const originalRename = fsSync.renameSync;
    let injected = false;
    const renameSpy = vi.spyOn(fsSync, "renameSync").mockImplementation(((source, destination) => {
      if (!injected && path.resolve(String(destination)) === sessionPath) {
        injected = true;
        throw new Error("injected Session rename failure");
      }
      return originalRename(source, destination);
    }) as typeof fsSync.renameSync);
    try {
      await expect(applyFailedRuntimeJob(
        job.id,
        pausedDevice!,
        "[auth_required] 淘宝未登录，请先登录淘宝账号",
        {
          retryable: false,
          authenticationFailureCallback: true,
          leaseToken: claimed!.lease_token
        }
      )).rejects.toThrow("injected Session rename failure");
    } finally {
      renameSpy.mockRestore();
    }

    expect((await localRuntimeRepository.getJob(job.id))?.status).toBe("failed");
    expect((await localRuntimeRepository.getSession(sessionId, device.user_id))?.hosted_tasks
      .find((task) => task.task_id === job.id)?.status).toBe("pending");

    await expect(applyFailedRuntimeJob(
      job.id,
      pausedDevice!,
      "[auth_required] 淘宝未登录，请先登录淘宝账号",
      {
        retryable: false,
        authenticationFailureCallback: true,
        leaseToken: claimed!.lease_token
      }
    )).resolves.toMatchObject({ id: job.id, status: "failed" });

    globalThis.__AUTOPREP_SESSION_STORE__?.delete(sessionId);
    const reloaded = await localRuntimeRepository.getSession(sessionId, device.user_id);
    expect(reloaded?.hosted_tasks.find((task) => task.task_id === job.id)?.status).toBe("failed");
    expect(reloaded?.agent_runtime).toMatchObject({
      workflow_status: "paused",
      auto_continue: false,
      current_module_id: module.module_id
    });
    await fs.unlink(sessionPath).catch(() => undefined);
  });

  it("rejects forged auth callbacks without an auth-paused matching executor", async () => {
    await localRuntimeRepository.createDevice(device);
    const job = await createRuntimeJobFixture({
      id: "job-forged-auth-callback",
      user_id: device.user_id,
      session_id: "session-forged-auth-callback",
      job_type: "add_to_cart",
      idempotency_key: "forged-auth-callback",
      payload: { product_id: "item-1" }
    });
    const claimed = await localRuntimeRepository.claimJob(device, 30_000);

    await expect(applyFailedRuntimeJob(
      job.id,
      device,
      "[auth_required] 淘宝未登录，请先登录淘宝账号",
      {
        retryable: false,
        authenticationFailureCallback: true,
        leaseToken: claimed!.lease_token
      }
    )).rejects.toThrow("invalid authentication failure callback");

    const pausedDevice = await localRuntimeRepository.heartbeatDevice(
      device.id,
      "authentication_required"
    );
    await expect(applyFailedRuntimeJob(
      job.id,
      pausedDevice!,
      "network timeout",
      {
        retryable: false,
        authenticationFailureCallback: true,
        leaseToken: claimed!.lease_token
      }
    )).rejects.toThrow("invalid authentication failure callback");
    expect((await localRuntimeRepository.getJob(job.id))?.status).toBe("leased");
  });

  it("terminalizes an expired add-to-cart auth failure without replaying the mutation", async () => {
    await localRuntimeRepository.createDevice(device);
    const job = await createRuntimeJobFixture({
      id: "job-auth-cart-no-replay",
      user_id: device.user_id,
      session_id: "session-auth-cart-no-replay",
      job_type: "add_to_cart",
      idempotency_key: "auth-cart-no-replay",
      payload: { product_id: "item-auth-cart" }
    });
    const claimed = await localRuntimeRepository.claimJob(device, 1);
    await localRuntimeRepository.appendEvent({
      user_id: job.user_id,
      session_id: job.session_id,
      job_id: job.id,
      event_type: "job.claimed",
      payload: {
        device_id: device.id,
        device_name: device.name,
        attempt: claimed!.attempts,
        lease_token: claimed!.lease_token
      }
    });
    const pausedDevice = await localRuntimeRepository.heartbeatDevice(
      device.id,
      "authentication_required"
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    await localRuntimeRepository.recoverExpiredJobs();

    await expect(applyFailedRuntimeJob(
      job.id,
      pausedDevice!,
      "[auth_required] 淘宝未登录，请先登录淘宝账号",
      {
        retryable: false,
        authenticationFailureCallback: true,
        leaseToken: claimed!.lease_token
      }
    )).resolves.toMatchObject({
      id: job.id,
      job_type: "add_to_cart",
      status: "failed",
      attempts: 1
    });

    const onlineDevice = await localRuntimeRepository.heartbeatDevice(device.id, "online");
    expect(await localRuntimeRepository.claimJob(onlineDevice!, 30_000)).toBeNull();
    expect((await localRuntimeRepository.getJob(job.id))?.attempts).toBe(1);
  });

  it("releases a callback-less cart hold only after verified login and never replays add_to_cart", async () => {
    await localRuntimeRepository.createDevice(device);
    const job = await createRuntimeJobFixture({
      id: "job-cart-hold-recovery",
      user_id: device.user_id,
      session_id: "session-cart-hold-recovery",
      job_type: "add_to_cart",
      idempotency_key: "cart-hold-recovery",
      payload: { product_id: "item-cart-hold-recovery" }
    });
    const claimed = await localRuntimeRepository.claimJob(device, 30_000);
    await localRuntimeRepository.holdAuthenticationJob(
      job.id,
      device,
      "[auth_required] 淘宝未登录，请先登录淘宝账号",
      claimed!.lease_token!
    );

    expect((await localRuntimeRepository.heartbeatDevice(device.id, "online"))?.status)
      .toBe("authentication_required");
    expect(await localRuntimeRepository.hasActiveAuthenticationFailureHold(device.id)).toBe(true);

    const recovery = await reconcileAuthenticationFailureHoldsForDevice(device.id, {
      releaseCartAfterVerifiedLogin: true
    });
    expect(recovery.active).toBe(false);
    const online = await localRuntimeRepository.heartbeatDevice(device.id, "online");
    expect(online?.status).toBe("online");
    expect(await localRuntimeRepository.claimJob(online!, 30_000)).toBeNull();
    expect(await localRuntimeRepository.getJob(job.id)).toMatchObject({
      status: "failed",
      attempts: 1,
      max_attempts: 1
    });
  });

  it("never automatically retries a user-confirmed add-to-cart attempt", async () => {
    await localRuntimeRepository.createDevice(device);
    const state = createSessionFixture({
      session_id: `session-cart-single-attempt-${Date.now()}`,
      owner_id: device.user_id
    });
    const module = state.shopping_plan.modules[0];
    const job = await enqueueAddToCartJob(state, {
      productId: "item-single-attempt",
      title: "单次加购商品",
      moduleId: module.module_id,
      moduleName: module.module_name
    });
    await localRuntimeRepository.saveSession(state);
    expect(job.max_attempts).toBe(1);

    await localRuntimeRepository.claimJob(device, 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await localRuntimeRepository.recoverExpiredJobs()).toBe(1);
    expect(await localRuntimeRepository.getJob(job.id)).toMatchObject({
      status: "failed",
      attempts: 1,
      max_attempts: 1
    });
    expect(await localRuntimeRepository.claimJob(device, 30_000)).toBeNull();
  });

  it("rejects a delayed callback from an earlier lease after explicit Job revival", async () => {
    await localRuntimeRepository.createDevice(device);
    const input = {
      id: "job-auth-generation",
      user_id: device.user_id,
      session_id: "session-auth-generation",
      job_type: "add_to_cart" as const,
      idempotency_key: "auth-generation",
      payload: { product_id: "item-auth-generation" }
    };
    const job = await createRuntimeJobFixture(input);
    const firstClaim = await localRuntimeRepository.claimJob(device, 30_000);
    const pausedFirstDevice = await localRuntimeRepository.heartbeatDevice(
      device.id,
      "authentication_required"
    );
    await applyFailedRuntimeJob(
      job.id,
      pausedFirstDevice!,
      "[auth_required] 淘宝未登录，请先登录淘宝账号",
      {
        retryable: false,
        authenticationFailureCallback: true,
        leaseToken: firstClaim!.lease_token
      }
    );

    const revived = await createRuntimeJobFixture(input);
    expect(revived).toMatchObject({ status: "pending", attempts: 0 });
    expect(revived.lease_token).toBeUndefined();
    await expect(applyFailedRuntimeJob(
      job.id,
      pausedFirstDevice!,
      "[auth_required] 淘宝未登录，请先登录淘宝账号",
      {
        retryable: false,
        authenticationFailureCallback: true,
        leaseToken: firstClaim!.lease_token
      }
    )).resolves.toMatchObject({ status: "pending", lease_token: undefined });
    expect((await localRuntimeRepository.getJob(job.id))?.status).toBe("pending");

    const onlineDevice = await localRuntimeRepository.heartbeatDevice(device.id, "online");
    const secondClaim = await localRuntimeRepository.claimJob(onlineDevice!, 30_000);
    expect(secondClaim?.lease_token).not.toBe(firstClaim?.lease_token);
    const pausedSecondDevice = await localRuntimeRepository.heartbeatDevice(
      device.id,
      "authentication_required"
    );
    await expect(applyFailedRuntimeJob(
      job.id,
      pausedSecondDevice!,
      "[auth_required] 淘宝未登录，请先登录淘宝账号",
      {
        retryable: false,
        authenticationFailureCallback: true,
        leaseToken: firstClaim!.lease_token
      }
    )).resolves.toMatchObject({
      status: "leased",
      lease_token: secondClaim!.lease_token
    });
    expect(await localRuntimeRepository.getJob(job.id)).toMatchObject({
      status: "leased",
      lease_token: secondClaim!.lease_token
    });
  });

  it("acknowledges an old released callback after a newer device hold overwrites the Job hash", async () => {
    const firstDevice: ExecutorDevice = {
      ...device,
      id: "device-auth-history-first",
      token_hash: "auth-history-first"
    };
    const secondDevice: ExecutorDevice = {
      ...device,
      id: "device-auth-history-second",
      token_hash: "auth-history-second"
    };
    await localRuntimeRepository.createDevice(firstDevice);
    await localRuntimeRepository.createDevice(secondDevice);
    const input = {
      id: "job-auth-history",
      user_id: device.user_id,
      session_id: "session-auth-history",
      job_type: "add_to_cart" as const,
      idempotency_key: "auth-history",
      payload: { product_id: "item-auth-history" }
    };
    const job = await createRuntimeJobFixture(input);
    const firstClaim = await localRuntimeRepository.claimJob(firstDevice, 30_000);
    await localRuntimeRepository.holdAuthenticationJob(
      job.id,
      firstDevice,
      "[auth_required] 淘宝未登录，请先登录淘宝账号",
      firstClaim!.lease_token!
    );
    expect(await releaseAuthenticationFailureHoldForUser(
      job.id,
      device.user_id,
      "user_retry"
    )).toBe(true);

    await createRuntimeJobFixture(input);
    const secondOnline = await localRuntimeRepository.heartbeatDevice(secondDevice.id, "online");
    const secondClaim = await localRuntimeRepository.claimJob(secondOnline!, 30_000);
    await localRuntimeRepository.holdAuthenticationJob(
      job.id,
      secondDevice,
      "[auth_required] 淘宝未登录，请先登录淘宝账号",
      secondClaim!.lease_token!
    );
    expect(await releaseAuthenticationFailureHoldForUser(
      job.id,
      device.user_id,
      "partial_results_accepted"
    )).toBe(true);

    const pausedFirstDevice = await localRuntimeRepository.heartbeatDevice(
      firstDevice.id,
      "authentication_required"
    );
    await expect(applyFailedRuntimeJob(
      job.id,
      pausedFirstDevice!,
      "[auth_required] 淘宝未登录，请先登录淘宝账号",
      {
        retryable: false,
        authenticationFailureCallback: true,
        leaseToken: firstClaim!.lease_token
      }
    )).resolves.toMatchObject({
      id: job.id,
      status: "failed",
      lease_token: secondClaim!.lease_token
    });
    expect(await localRuntimeRepository.isAuthenticationFailureHoldReleased(
      job.id,
      firstDevice.id,
      firstClaim!.lease_token!
    )).toBe(true);
  });

  it("restores local device tokens and queued jobs after a process-style reset", async () => {
    const runtimeFile = path.join(
      process.cwd(),
      ".data",
      "tests",
      `local-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    );
    const previousPersist = process.env.SCENECART_LOCAL_RUNTIME_PERSIST;
    const previousPath = process.env.SCENECART_LOCAL_RUNTIME_PATH;
    process.env.SCENECART_LOCAL_RUNTIME_PERSIST = "true";
    process.env.SCENECART_LOCAL_RUNTIME_PATH = runtimeFile;

    try {
      resetLocalRuntimeForTests();
      const registered = await registerExecutorDevice("durable-user", "durable device");
      await createRuntimeJobFixture({
        id: "durable-job",
        user_id: "durable-user",
        session_id: "durable-session",
        job_type: "module_search",
        idempotency_key: "durable-job-key",
        payload: { keyword: "新能源车 应急用品" }
      });
      const persisted = await fs.readFile(runtimeFile, "utf8");
      expect(persisted).not.toContain(registered.token);

      resetLocalRuntimeForTests();

      expect(await authenticateExecutorToken(registered.token)).toMatchObject({
        id: registered.device.id,
        status: "offline",
        capabilities: ["module_search"]
      });
      expect(await localRuntimeRepository.getJob("durable-job")).toMatchObject({
        status: "pending",
        idempotency_key: "durable-job-key"
      });
    } finally {
      resetLocalRuntimeForTests();
      if (previousPersist === undefined) delete process.env.SCENECART_LOCAL_RUNTIME_PERSIST;
      else process.env.SCENECART_LOCAL_RUNTIME_PERSIST = previousPersist;
      if (previousPath === undefined) delete process.env.SCENECART_LOCAL_RUNTIME_PATH;
      else process.env.SCENECART_LOCAL_RUNTIME_PATH = previousPath;
      await fs.unlink(runtimeFile).catch(() => undefined);
    }
  });

  it("returns an expired lease to the pending queue", async () => {
    await localRuntimeRepository.createDevice(device);
    await createRuntimeJobFixture({
      id: "job-expiring",
      user_id: device.user_id,
      session_id: "session-test",
      job_type: "module_search",
      idempotency_key: "expiring-job",
      payload: {},
      max_attempts: 3
    });
    await localRuntimeRepository.claimJob(device, 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await localRuntimeRepository.recoverExpiredJobs()).toBe(1);
    expect((await localRuntimeRepository.getJob("job-expiring"))?.status).toBe("pending");
  });

  it("rejects a stale executor after an expired lease is reassigned", async () => {
    const replacementDevice = {
      ...device,
      id: "device-replacement",
      token_hash: "replacement-digest"
    };
    await localRuntimeRepository.createDevice(device);
    await localRuntimeRepository.createDevice(replacementDevice);
    await createRuntimeJobFixture({
      id: "job-reassigned",
      user_id: device.user_id,
      session_id: "session-test",
      job_type: "module_search",
      idempotency_key: "reassigned-job",
      payload: {},
      max_attempts: 3
    });

    const originalLease = await localRuntimeRepository.claimJob(device, 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const reassigned = await localRuntimeRepository.claimJob(replacementDevice, 30_000);

    expect(reassigned?.id).toBe("job-reassigned");
    expect(await localRuntimeRepository.renewJobLease(
      "job-reassigned",
      device.id,
      originalLease!.lease_token!,
      30_000
    )).toBeNull();
    await expect(localRuntimeRepository.completeJob(
      "job-reassigned",
      device.id,
      { results: [] },
      originalLease!.lease_token!
    ))
      .rejects.toThrow("job lease owner mismatch");
    await expect(localRuntimeRepository.completeJob(
      "job-reassigned",
      replacementDevice.id,
      { results: [] },
      reassigned!.lease_token!
    ))
      .resolves.toMatchObject({ alreadyCompleted: false });
  });

  it("rejects a stale callback from an earlier lease generation on the same device", async () => {
    await localRuntimeRepository.createDevice(device);
    await createRuntimeJobFixture({
      id: "job-same-device-new-lease",
      user_id: device.user_id,
      session_id: "session-same-device-new-lease",
      job_type: "module_search",
      idempotency_key: "same-device-new-lease",
      payload: {},
      max_attempts: 3
    });
    const oldLease = await localRuntimeRepository.claimJob(device, 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newLease = await localRuntimeRepository.claimJob(device, 30_000);

    expect(newLease?.id).toBe(oldLease?.id);
    expect(newLease?.lease_token).not.toBe(oldLease?.lease_token);
    expect(await localRuntimeRepository.renewJobLease(
      newLease!.id,
      device.id,
      oldLease!.lease_token!,
      30_000
    )).toBeNull();
    expect(await localRuntimeRepository.renewJobLease(
      newLease!.id,
      device.id,
      newLease!.lease_token!,
      30_000
    )).toMatchObject({ status: "running" });
    await expect(localRuntimeRepository.completeJob(
      newLease!.id,
      device.id,
      { stale: true },
      oldLease!.lease_token!
    )).rejects.toThrow("job lease token mismatch");
    await expect(localRuntimeRepository.failJob(
      newLease!.id,
      device.id,
      "stale failure",
      oldLease!.lease_token!
    )).rejects.toThrow("job lease token mismatch");
    await expect(localRuntimeRepository.completeJob(
      newLease!.id,
      device.id,
      { current: true },
      newLease!.lease_token!
    )).resolves.toMatchObject({ alreadyCompleted: false });
  });

  it("only cancels work before an executor has claimed it", async () => {
    await localRuntimeRepository.createDevice(device);
    const pending = await createRuntimeJobFixture({
      id: "job-cancellable",
      user_id: device.user_id,
      session_id: "session-test",
      job_type: "module_search",
      idempotency_key: "cancellable-job",
      payload: {}
    });
    expect((await localRuntimeRepository.cancelJob(pending.id, device.user_id))?.status).toBe("cancelled");

    await createRuntimeJobFixture({
      id: "job-already-claimed",
      user_id: device.user_id,
      session_id: "session-test",
      job_type: "module_search",
      idempotency_key: "claimed-job",
      payload: {}
    });
    await localRuntimeRepository.claimJob(device, 30_000);
    expect(await localRuntimeRepository.cancelJob("job-already-claimed", device.user_id)).toBeNull();
  });

  it("claims only jobs supported by the device capability set", async () => {
    const searchOnlyDevice = { ...device, id: "search-only-device", capabilities: ["module_search"] as const };
    await localRuntimeRepository.createDevice({
      ...searchOnlyDevice,
      capabilities: [...searchOnlyDevice.capabilities]
    });
    await createRuntimeJobFixture({
      id: "cart-higher-priority",
      user_id: device.user_id,
      session_id: "session-capability",
      job_type: "add_to_cart",
      idempotency_key: "capability-cart",
      payload: {},
      priority: 200
    });
    await createRuntimeJobFixture({
      id: "search-lower-priority",
      user_id: device.user_id,
      session_id: "session-capability",
      job_type: "module_search",
      idempotency_key: "capability-search",
      payload: {},
      priority: 100
    });

    expect((await localRuntimeRepository.claimJob({
      ...searchOnlyDevice,
      capabilities: [...searchOnlyDevice.capabilities]
    }, 30_000))?.id).toBe("search-lower-priority");
    expect((await localRuntimeRepository.getJob("cart-higher-priority"))?.status).toBe("pending");
  });

  it("does not retry a terminal executor configuration error", async () => {
    await localRuntimeRepository.createDevice(device);
    const state = createSessionFixture({ session_id: "session-terminal-error" });
    const module = state.shopping_plan.modules[0];
    const job = await enqueueModuleSearchJob(state, {
      moduleId: module.module_id,
      moduleName: module.module_name,
      keyword: module.search_strategy!.primary_keyword
    });
    await localRuntimeRepository.saveSession(state);
    await localRuntimeRepository.claimJob(device, 30_000);

    const failed = await applyFailedRuntimeJob(
      job.id,
      device,
      "Qoder CLI 未登录",
      { retryable: false }
    );

    expect(failed.status).toBe("failed");
    expect(failed.attempts).toBe(1);
    expect(await localRuntimeRepository.claimJob(device, 30_000)).toBeNull();

    const failedState = await localRuntimeRepository.getSession(state.session_id, device.user_id);
    expect(failedState?.agent_runtime).toMatchObject({
      workflow_status: "paused",
      auto_continue: false,
      current_module_id: module.module_id
    });
    expect(failedState?.agent_runtime.workflow_message).toContain("重新登录后可从当前进度继续");
    const retried = await enqueueModuleSearchJob(failedState!, {
      moduleId: module.module_id,
      moduleName: module.module_name,
      keyword: module.search_strategy!.primary_keyword
    });
    await localRuntimeRepository.saveSession(failedState!);

    expect(retried.id).toBe(job.id);
    expect(retried.status).toBe("pending");
    expect(retried.attempts).toBe(0);
    expect(failedState?.hosted_tasks.find((task) => task.task_id === job.id)?.status).toBe("pending");
    expect((await localRuntimeRepository.claimJob(device, 30_000))?.id).toBe(job.id);

    await fs.unlink(path.join(process.cwd(), ".data", "sessions", `${state.session_id}.json`)).catch(() => undefined);
  });

  it("rejects a live versionless search result before the Job becomes completed", async () => {
    await localRuntimeRepository.createDevice(device);
    const sessionId = `session-versionless-live-${Date.now()}`;
    const state = createSessionFixture({ session_id: sessionId });
    const module = state.shopping_plan.modules[0];
    const job = await enqueueModuleSearchJob(state, {
      moduleId: module.module_id,
      moduleName: module.module_name,
      keyword: module.search_strategy!.primary_keyword
    });
    await localRuntimeRepository.saveSession(state);
    await localRuntimeRepository.claimJob(device, 30_000);

    await expect(applyCompletedRuntimeJob(job.id, device, {
      summary: "搜索完成但没有合格候选",
      candidates: []
    })).rejects.toThrow("缺少 v1 完整证据");
    expect((await localRuntimeRepository.getJob(job.id))?.status).not.toBe("completed");

    await fs.unlink(path.join(process.cwd(), ".data", "sessions", `${sessionId}.json`)).catch(() => undefined);
  });

  it("reconciles an already-completed legacy result without granting a current MCP proof", async () => {
    await localRuntimeRepository.createDevice(device);
    const sessionId = `session-legacy-reconcile-${Date.now()}`;
    const state = createSessionFixture({ session_id: sessionId });
    const module = state.shopping_plan.modules[0];
    const job = await enqueueModuleSearchJob(state, {
      moduleId: module.module_id,
      moduleName: module.module_name,
      keyword: module.search_strategy!.primary_keyword
    });
    await localRuntimeRepository.saveSession(state);
    const claimed = await localRuntimeRepository.claimJob(device, 30_000);
    await localRuntimeRepository.completeJob(job.id, device.id, {
      summary: "协议升级前已经完成的空搜索",
      candidates: []
    }, claimed!.lease_token!);

    expect(await reconcileCompletedRuntimeJob(job.id)).toBe(true);
    expect(await reconcileCompletedRuntimeJob(job.id)).toBe(false);
    const restored = await localRuntimeRepository.getSession(sessionId, device.user_id);

    expect(restored?.module_search_traces[module.module_id].status).toBe("failed");
    expect(restored?.hosted_tasks.find((task) => task.task_id === job.id)?.payload.taobao_mcp_evidence)
      .toBeUndefined();
    expect(decideNextAgentAction(restored!).action).toBe("skip_module");

    await fs.unlink(path.join(process.cwd(), ".data", "sessions", `${sessionId}.json`)).catch(() => undefined);
  });

  it("allows the isolated interview demo marker without granting a current MCP proof", async () => {
    const previousDemo = process.env.SCENECART_INTERVIEW_DEMO;
    process.env.SCENECART_INTERVIEW_DEMO = "true";
    const sessionId = `session-isolated-demo-${Date.now()}`;
    try {
      await localRuntimeRepository.createDevice(device);
      const state = createSessionFixture({ session_id: sessionId });
      const module = state.shopping_plan.modules[0];
      const job = await enqueueModuleSearchJob(state, {
        moduleId: module.module_id,
        moduleName: module.module_name,
        keyword: module.search_strategy!.primary_keyword
      });
      await localRuntimeRepository.saveSession(state);
      await localRuntimeRepository.claimJob(device, 30_000);

      await expect(applyCompletedRuntimeJob(job.id, device, {
        execution_mode: "interview_demo",
        summary: "隔离演示历史快照；未执行实时淘宝搜索",
        candidates: []
      })).resolves.toMatchObject({ alreadyCompleted: false });
      const restored = await localRuntimeRepository.getSession(sessionId, device.user_id);
      expect(restored?.hosted_tasks.find((task) => task.task_id === job.id)).toMatchObject({
        status: "completed",
        payload: expect.not.objectContaining({ taobao_mcp_evidence: expect.anything() })
      });
    } finally {
      if (previousDemo === undefined) delete process.env.SCENECART_INTERVIEW_DEMO;
      else process.env.SCENECART_INTERVIEW_DEMO = previousDemo;
      await fs.unlink(path.join(process.cwd(), ".data", "sessions", `${sessionId}.json`)).catch(() => undefined);
    }
  });
});
