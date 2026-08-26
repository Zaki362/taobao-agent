import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createAgentDecision } from "@/lib/agent/decision-engine";
import { buildAgentCompletionReport } from "@/lib/agent/completion-review";
import { reviewModuleCandidates } from "@/lib/agent/candidate-reviewer";
import { searchModule } from "@/lib/agent/orchestrator";
import {
  acceptPartialAgentResults,
  advanceAgentWorkflow,
  establishExecutorStartupStandby,
  improveAgentCompletionQuality,
  pauseAgentWorkflow,
  resumeAgentWorkflow,
  recoverAgentCompletionGaps
} from "@/lib/agent/workflow-runner";
import { recoverAgentWorkflowForExecutor, recoverAgentWorkflows } from "@/lib/agent/workflow-recovery";
import {
  applyCompletedRuntimeJob as applyCompletedRuntimeJobRaw,
  applyFailedRuntimeJob as applyFailedRuntimeJobRaw,
  enqueueModuleSearchJob,
  establishAuthenticationFailureHold
} from "@/lib/runtime/jobs";
import { localRuntimeRepository, resetLocalRuntimeForTests } from "@/lib/runtime/local-repository";
import { EXECUTOR_STARTUP_STANDBY_MESSAGE } from "@/lib/runtime/startup-standby";
import type { ExecutorDevice } from "@/lib/runtime/types";
import type { ProductCandidate } from "@/lib/session/types";
import { createSessionFixture } from "@/tests/fixtures/session";

const device: ExecutorDevice = {
  id: "workflow-device",
  user_id: "user-test",
  name: "workflow executor",
  token_hash: "workflow-token",
  capabilities: ["module_search"],
  status: "online",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString()
};

const sessionFiles = new Set<string>();

function candidates(moduleId: string, moduleName: string): ProductCandidate[] {
  return (["稳妥推荐", "性价比推荐", "升级推荐"] as const).map((type, index) => ({
    product_id: `${moduleId}-${index}`,
    title: `${moduleName} 自动续跑候选 ${index + 1}`,
    price: 99 + index * 30,
    source: "淘宝",
    shop_name: "续跑测试旗舰店",
    image_url: "https://example.com/item.jpg",
    detail_url: `https://item.taobao.com/item.htm?id=${moduleId}-${index}`,
    shop_badges: ["旗舰店"],
    highlights: [moduleName],
    risk_notes: ["测试摘要"],
    fit_reason: "符合当前模块",
    recommendation_type: type,
    module_id: moduleId
  }));
}

function verifiedSearchResult(
  job: { id: string; payload: Record<string, unknown> },
  result: { summary: string; candidates: ProductCandidate[] }
) {
  return {
    ...result,
    evidence: {
      schema: "scenecart.taobao-mcp-search-evidence/v1",
      source: "taobao-mcp",
      tool: "search_products",
      source_app: "SceneCartWorkflowUnit",
      job_id: job.id,
      module_id: String(job.payload.module_id ?? ""),
      workflow_run_id: String(job.payload.workflow_run_id ?? ""),
      keyword: String(job.payload.keyword ?? ""),
      captured_at: new Date().toISOString(),
      cache_hit: false,
      raw_result_count: result.candidates.length
    }
  };
}

async function applyCompletedRuntimeJob(
  jobId: string,
  executorDevice: ExecutorDevice,
  result: Record<string, unknown>
) {
  const currentJob = await localRuntimeRepository.getJob(jobId);
  const completion = await applyCompletedRuntimeJobRaw(
    jobId,
    executorDevice,
    result,
    currentJob?.lease_token ?? ""
  );
  if (completion.job.job_type !== "module_search" || !completion.follow_up_job_id) {
    return completion;
  }
  const detailJob = await localRuntimeRepository.claimJob(executorDevice, 30_000);
  expect(detailJob).toMatchObject({
    id: completion.follow_up_job_id,
    job_type: "product_detail"
  });
  await applyCompletedRuntimeJobRaw(detailJob!.id, executorDevice, {
    detail_evidence: {
      schema: "scenecart.taobao-mcp-product-detail-evidence/v1",
      source: "taobao-mcp",
      status: "unavailable",
      tool: "navigate_to_url+read_page_content",
      tools_used: [],
      source_app: "SceneCartWorkflowUnit",
      job_id: detailJob!.id,
      search_job_id: jobId,
      module_id: String(detailJob!.payload.module_id),
      workflow_run_id: String(detailJob!.payload.workflow_run_id),
      product_id: String(detailJob!.payload.product_id),
      detail_url: String(detailJob!.payload.detail_url),
      captured_at: new Date().toISOString(),
      unavailable_reason: "单元测试未启动淘宝详情读取工具"
    }
  }, detailJob!.lease_token ?? "");
  return completion;
}

async function applyFailedRuntimeJob(
  jobId: string,
  executorDevice: ExecutorDevice,
  errorMessage: string,
  options: Parameters<typeof applyFailedRuntimeJobRaw>[3] = {}
) {
  const currentJob = await localRuntimeRepository.getJob(jobId);
  return applyFailedRuntimeJobRaw(jobId, executorDevice, errorMessage, {
    ...options,
    leaseToken: options.leaseToken ?? currentJob?.lease_token
  });
}

async function removeSessionFile(sessionId: string) {
  await fs.unlink(path.join(process.cwd(), ".data", "sessions", `${sessionId}.json`)).catch(() => undefined);
}

describe("server-managed Agent workflow", () => {
  beforeEach(async () => {
    resetLocalRuntimeForTests();
    await localRuntimeRepository.createDevice(device);
  });

  afterEach(async () => {
    await Promise.all([...sessionFiles].map(removeSessionFile));
    sessionFiles.clear();
  });

  it("continues every planned module after executor callbacks without a browser loop", async () => {
    const sessionId = `session-workflow-${Date.now()}`;
    sessionFiles.add(sessionId);
    const state = createSessionFixture({ session_id: sessionId });
    await localRuntimeRepository.saveSession(state);

    let advance = await advanceAgentWorkflow(sessionId, device.user_id, {
      start: true,
      trigger: "user_start"
    });
    let completedJobs = 0;

    while (advance.outcome === "queued") {
      const job = await localRuntimeRepository.claimJob(device, 30_000);
      expect(job).not.toBeNull();
      const moduleId = String(job!.payload.module_id);
      const moduleName = String(job!.payload.module_name);
      await applyCompletedRuntimeJob(job!.id, device, verifiedSearchResult(job!, {
        summary: "测试执行器完成候选回填",
        candidates: candidates(moduleId, moduleName)
      }));
      completedJobs += 1;
      advance = await advanceAgentWorkflow(sessionId, device.user_id, {
        trigger: "job_completed"
      });
    }

    const restored = await localRuntimeRepository.getSession(sessionId, device.user_id);
    expect(advance.outcome).toBe("completed");
    expect(restored?.agent_runtime.workflow_status).toBe("completed");
    expect(restored?.agent_runtime.auto_continue).toBe(false);
    expect(restored?.completion_report).toMatchObject({
      status: "ready",
      critical_coverage_ratio: 1
    });
    expect(restored?.completion_report?.total_candidates).toBe(state.shopping_plan.modules.length * 3);
    expect(restored?.completion_report?.purchase_bundle?.estimated_total).toBeLessThanOrEqual(state.scene_brief.budget);
    expect(restored?.completion_report?.purchase_bundle?.items.length).toBeGreaterThan(0);
    expect(completedJobs).toBe(state.shopping_plan.modules.length);
    expect(Object.keys(restored?.module_candidates ?? {})).toHaveLength(state.shopping_plan.modules.length);
    expect(restored?.tool_logs.filter(
      (log) => log.tool_name === "local_executor" && log.status === "success"
    )).toHaveLength(state.shopping_plan.modules.length);
    expect((await localRuntimeRepository.listEvents(sessionId, 0, device.user_id, 100))
      .some((event) => event.event_type === "agent.workflow.updated" && event.payload.outcome === "completed"))
      .toBe(true);
    expect((await localRuntimeRepository.listEvents(sessionId, 0, device.user_id, 100))
      .some((event) => event.event_type === "agent.purchase_bundle.composed"))
      .toBe(true);
  });

  it("moves to the next module after an empty real search without requeueing the same module", async () => {
    const sessionId = `session-workflow-empty-${Date.now()}`;
    sessionFiles.add(sessionId);
    const state = createSessionFixture({ session_id: sessionId });
    await localRuntimeRepository.saveSession(state);

    const started = await advanceAgentWorkflow(sessionId, device.user_id, {
      start: true,
      trigger: "user_start"
    });
    expect(started.outcome).toBe("queued");
    const firstJob = await localRuntimeRepository.claimJob(device, 30_000);
    expect(firstJob).not.toBeNull();
    const firstModuleId = String(firstJob!.payload.module_id);

    await applyCompletedRuntimeJob(firstJob!.id, device, verifiedSearchResult(firstJob!, {
      summary: "淘宝搜索完成但没有可展示候选",
      candidates: []
    }));
    const continued = await advanceAgentWorkflow(sessionId, device.user_id, {
      trigger: "job_completed"
    });
    const nextJob = await localRuntimeRepository.claimJob(device, 30_000);

    expect(continued.outcome).toBe("queued");
    expect(nextJob).not.toBeNull();
    expect(nextJob?.payload.module_id).not.toBe(firstModuleId);
    const restored = await localRuntimeRepository.getSession(sessionId, device.user_id);
    expect(restored?.agent_decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "skip_module", module_id: firstModuleId })
    ]));
    expect(restored?.hosted_tasks.filter((task) => task.module_id === firstModuleId)).toHaveLength(1);
  });

  it("revives the same failed search job only after an explicit user-confirmed retry", async () => {
    const sessionId = `session-workflow-confirmed-task-retry-${Date.now()}`;
    sessionFiles.add(sessionId);
    const state = createSessionFixture({ session_id: sessionId });
    state.agent_runtime.workflow_run_id = "confirmed-retry-run";
    await localRuntimeRepository.saveSession(state);
    const module = state.shopping_plan.modules[0];

    await searchModule(sessionId, module.module_id, undefined, device.user_id);
    const failedJob = await localRuntimeRepository.claimJob(device, 30_000);
    expect(failedJob).not.toBeNull();
    const originalKeyword = String(failedJob!.payload.keyword);
    await applyFailedRuntimeJob(failedJob!.id, device, "用户可确认重试的终态失败", { retryable: false });

    await searchModule(sessionId, module.module_id, {
      keywordOverride: originalKeyword
    }, device.user_id);
    expect((await localRuntimeRepository.getJob(failedJob!.id))?.status).toBe("failed");
    expect(await localRuntimeRepository.claimJob(device, 30_000)).toBeNull();

    const retried = await searchModule(sessionId, module.module_id, {
      keywordOverride: originalKeyword,
      confirmedRetry: true
    }, device.user_id);
    const revivedJob = await localRuntimeRepository.getJob(failedJob!.id);
    const moduleTasks = retried.state.hosted_tasks.filter(
      (task) => task.task_type === "module_search" && task.module_id === module.module_id
    );

    expect(revivedJob).toMatchObject({
      id: failedJob!.id,
      status: "pending",
      attempts: 0,
      payload: {
        keyword: originalKeyword,
        workflow_run_id: "confirmed-retry-run"
      }
    });
    expect(moduleTasks).toHaveLength(1);
    expect(moduleTasks[0]).toMatchObject({
      task_id: failedJob!.id,
      status: "pending",
      error_message: undefined,
      payload: { keyword: originalKeyword }
    });
    expect((await localRuntimeRepository.claimJob(device, 30_000))?.id).toBe(failedJob!.id);
    const events = await localRuntimeRepository.listEvents(sessionId, 0, device.user_id, 100);
    expect(events.some((event) => event.event_type === "job.requeued" && event.job_id === failedJob!.id)).toBe(true);
  });

  it("atomically revives an authentication-failed search and resumes the paused workflow", async () => {
    const sessionId = `session-workflow-auth-resume-${Date.now()}`;
    sessionFiles.add(sessionId);
    const state = createSessionFixture({ session_id: sessionId });
    await localRuntimeRepository.saveSession(state);

    const started = await advanceAgentWorkflow(sessionId, device.user_id, {
      start: true,
      trigger: "user_start"
    });
    const failedJob = await localRuntimeRepository.claimJob(device, 30_000);
    expect(failedJob).not.toBeNull();
    const workflowRunId = started.state.agent_runtime.workflow_run_id;
    const failedModuleId = String(failedJob!.payload.module_id);
    const originalKeyword = String(failedJob!.payload.keyword);
    await applyFailedRuntimeJob(
      failedJob!.id,
      device,
      "[auth_required] 淘宝未登录，已打开登录页面，请先登录",
      { retryable: false }
    );

    const paused = await localRuntimeRepository.getSession(sessionId, device.user_id);
    expect(paused?.agent_runtime).toMatchObject({
      workflow_status: "paused",
      auto_continue: false,
      workflow_run_id: workflowRunId,
      current_module_id: failedModuleId
    });

    const resumed = await resumeAgentWorkflow(sessionId, device.user_id, {
      retryAuthenticationFailure: true
    });
    const revivedJob = await localRuntimeRepository.getJob(failedJob!.id);
    const moduleTasks = resumed.state.hosted_tasks.filter(
      (task) => task.task_type === "module_search" && task.module_id === failedModuleId
    );

    expect(resumed.outcome).toBe("waiting");
    expect(resumed.state.agent_runtime).toMatchObject({
      workflow_status: "waiting_for_tools",
      auto_continue: true,
      workflow_run_id: workflowRunId,
      current_module_id: failedModuleId
    });
    expect(revivedJob).toMatchObject({
      id: failedJob!.id,
      status: "pending",
      attempts: 0,
      payload: {
        module_id: failedModuleId,
        keyword: originalKeyword,
        workflow_run_id: workflowRunId
      }
    });
    expect(moduleTasks).toEqual([
      expect.objectContaining({
        task_id: failedJob!.id,
        status: "pending",
        error_message: undefined,
        payload: expect.objectContaining({
          keyword: originalKeyword,
          workflow_run_id: workflowRunId
        })
      })
    ]);
    expect(resumed.state.agent_decisions.some(
      (decision) => decision.action === "skip_module" && decision.module_id === failedModuleId
    )).toBe(false);
    expect((await localRuntimeRepository.claimJob(device, 30_000))?.id).toBe(failedJob!.id);
    expect(await localRuntimeRepository.claimJob(device, 30_000)).toBeNull();
  });

  it("idempotently resumes an authentication retry that is already queued", async () => {
    const sessionId = `session-workflow-auth-already-queued-${Date.now()}`;
    sessionFiles.add(sessionId);
    const state = createSessionFixture({ session_id: sessionId });
    await localRuntimeRepository.saveSession(state);

    await advanceAgentWorkflow(sessionId, device.user_id, {
      start: true,
      trigger: "user_start"
    });
    const failedJob = await localRuntimeRepository.claimJob(device, 30_000);
    expect(failedJob).not.toBeNull();
    const moduleId = String(failedJob!.payload.module_id);
    const keyword = String(failedJob!.payload.keyword);
    await applyFailedRuntimeJob(
      failedJob!.id,
      device,
      "[auth_required] 淘宝未登录，请先登录",
      { retryable: false }
    );

    // Reproduce the state left by the old two-request UI when the retry request
    // succeeded but the subsequent workflow-resume request never arrived.
    await searchModule(sessionId, moduleId, {
      keywordOverride: keyword,
      confirmedRetry: true
    }, device.user_id);
    const beforeResume = await localRuntimeRepository.getSession(sessionId, device.user_id);
    expect(beforeResume?.agent_runtime).toMatchObject({
      workflow_status: "paused",
      auto_continue: false
    });
    expect((await localRuntimeRepository.getJob(failedJob!.id))?.status).toBe("pending");

    const resumed = await resumeAgentWorkflow(sessionId, device.user_id, {
      retryAuthenticationFailure: true
    });
    const moduleTasks = resumed.state.hosted_tasks.filter(
      (task) => task.task_type === "module_search" && task.module_id === moduleId
    );

    expect(resumed.outcome).toBe("waiting");
    expect(moduleTasks).toEqual([
      expect.objectContaining({ task_id: failedJob!.id, status: "pending" })
    ]);
    expect((await localRuntimeRepository.claimJob(device, 30_000))?.id).toBe(failedJob!.id);
    expect(await localRuntimeRepository.claimJob(device, 30_000)).toBeNull();
    const events = await localRuntimeRepository.listEvents(sessionId, 0, device.user_id, 100);
    expect(events.filter(
      (event) => event.event_type === "job.requeued" && event.job_id === failedJob!.id
    )).toHaveLength(1);
  });

  it("advances without requeueing when an authentication retry completed while paused", async () => {
    const sessionId = `session-workflow-auth-already-completed-${Date.now()}`;
    sessionFiles.add(sessionId);
    const state = createSessionFixture({ session_id: sessionId });
    await localRuntimeRepository.saveSession(state);

    await advanceAgentWorkflow(sessionId, device.user_id, {
      start: true,
      trigger: "user_start"
    });
    const failedJob = await localRuntimeRepository.claimJob(device, 30_000);
    expect(failedJob).not.toBeNull();
    const moduleId = String(failedJob!.payload.module_id);
    const moduleName = String(failedJob!.payload.module_name);
    const keyword = String(failedJob!.payload.keyword);
    await applyFailedRuntimeJob(
      failedJob!.id,
      device,
      "[auth_required] 淘宝未登录，请先登录",
      { retryable: false }
    );
    await searchModule(sessionId, moduleId, {
      keywordOverride: keyword,
      confirmedRetry: true
    }, device.user_id);
    const retriedJob = await localRuntimeRepository.claimJob(device, 30_000);
    expect(retriedJob?.id).toBe(failedJob!.id);
    await applyCompletedRuntimeJob(failedJob!.id, device, verifiedSearchResult(failedJob!, {
      summary: "重新登录后搜索已完成",
      candidates: candidates(moduleId, moduleName)
    }));
    const completedWhilePaused = await localRuntimeRepository.getSession(sessionId, device.user_id);
    expect(completedWhilePaused?.agent_runtime).toMatchObject({
      workflow_status: "paused",
      auto_continue: false
    });

    const resumed = await resumeAgentWorkflow(sessionId, device.user_id, {
      retryAuthenticationFailure: true
    });
    const nextJob = await localRuntimeRepository.claimJob(device, 30_000);

    expect(resumed.outcome).toBe("queued");
    expect(resumed.state.hosted_tasks.filter(
      (task) => task.task_type === "module_search" && task.module_id === moduleId
    )).toEqual([
      expect.objectContaining({ task_id: failedJob!.id, status: "completed" })
    ]);
    expect((await localRuntimeRepository.getJob(failedJob!.id))?.status).toBe("completed");
    expect(nextJob?.id).not.toBe(failedJob!.id);
    expect(nextJob?.payload.module_id).not.toBe(moduleId);
    const events = await localRuntimeRepository.listEvents(sessionId, 0, device.user_id, 100);
    expect(events.filter(
      (event) => event.event_type === "job.requeued" && event.job_id === failedJob!.id
    )).toHaveLength(1);
  });

  it("rejects a forged authentication retry for an ordinary user pause", async () => {
    const sessionId = `session-workflow-forged-auth-resume-${Date.now()}`;
    sessionFiles.add(sessionId);
    const state = createSessionFixture({ session_id: sessionId });
    await localRuntimeRepository.saveSession(state);

    await advanceAgentWorkflow(sessionId, device.user_id, {
      start: true,
      trigger: "user_start"
    });
    await pauseAgentWorkflow(sessionId, device.user_id);

    await expect(resumeAgentWorkflow(sessionId, device.user_id, {
      retryAuthenticationFailure: true
    })).rejects.toMatchObject({
      code: "authentication_retry_not_available"
    });
    const restored = await localRuntimeRepository.getSession(sessionId, device.user_id);
    expect(restored?.agent_runtime).toMatchObject({
      workflow_status: "paused",
      auto_continue: false
    });
    expect(restored?.hosted_tasks.filter(
      (task) => task.task_type === "module_search" && (task.status === "pending" || task.status === "running")
    )).toHaveLength(1);
  });

  it("does not let direct confirmed_retry bypass an active authentication hold", async () => {
    const sessionId = `session-workflow-held-direct-retry-${Date.now()}`;
    sessionFiles.add(sessionId);
    const state = createSessionFixture({ session_id: sessionId });
    await localRuntimeRepository.saveSession(state);
    await advanceAgentWorkflow(sessionId, device.user_id, {
      start: true,
      trigger: "user_start"
    });
    const failedJob = await localRuntimeRepository.claimJob(device, 30_000);
    const moduleId = String(failedJob!.payload.module_id);
    const keyword = String(failedJob!.payload.keyword);
    await establishAuthenticationFailureHold(
      failedJob!.id,
      device,
      "[auth_required] 淘宝未登录，请先登录淘宝账号",
      failedJob!.lease_token!
    );

    await expect(searchModule(
      sessionId,
      moduleId,
      { keywordOverride: keyword, confirmedRetry: true },
      device.user_id
    )).rejects.toThrow("explicit user release");
    expect(await localRuntimeRepository.hasActiveAuthenticationFailureHold(device.id)).toBe(true);
    expect(await localRuntimeRepository.getJob(failedJob!.id)).toMatchObject({
      status: "failed",
      lease_token: failedJob!.lease_token
    });
  });

  it("accepts 12 preserved candidates without requeueing an authentication-failed search", async () => {
    const sessionId = `session-workflow-accept-partial-${Date.now()}`;
    sessionFiles.add(sessionId);
    const state = createSessionFixture({ session_id: sessionId });
    await localRuntimeRepository.saveSession(state);

    await advanceAgentWorkflow(sessionId, device.user_id, {
      start: true,
      trigger: "user_start"
    });
    const failedJob = await localRuntimeRepository.claimJob(device, 30_000);
    expect(failedJob).not.toBeNull();
    const failedModuleId = String(failedJob!.payload.module_id);
    const withCandidates = await localRuntimeRepository.getSession(sessionId, device.user_id);
    const coveredModules = withCandidates!.shopping_plan.modules
      .filter((module) => module.module_id !== failedModuleId)
      .slice(0, 4);
    expect(coveredModules).toHaveLength(4);
    for (const module of coveredModules) {
      withCandidates!.module_candidates[module.module_id] = candidates(module.module_id, module.module_name);
    }
    const activeTask = withCandidates!.hosted_tasks.find((task) => task.task_id === failedJob!.id)!;
    withCandidates!.hosted_tasks.unshift({
      ...structuredClone(activeTask),
      task_id: `${activeTask.task_id}-older-network-failure`,
      runtime_job_id: undefined,
      status: "failed",
      error_message: "older network timeout"
    });
    await localRuntimeRepository.saveSession(withCandidates!);

    const authenticationError = "[auth_required] 淘宝未登录，已打开登录页面，请先登录";
    await establishAuthenticationFailureHold(
      failedJob!.id,
      device,
      authenticationError,
      failedJob!.lease_token!
    );
    const jobsBeforeAcceptance = await localRuntimeRepository.listJobs(sessionId, device.user_id);

    const accepted = await acceptPartialAgentResults(sessionId, device.user_id);
    const jobsAfterAcceptance = await localRuntimeRepository.listJobs(sessionId, device.user_id);
    const failedTask = accepted.state.hosted_tasks.find((task) => task.task_id === failedJob!.id);

    expect(accepted.preservedCandidateCount).toBe(12);
    expect(Object.values(accepted.state.module_candidates).flat()).toHaveLength(12);
    expect(jobsAfterAcceptance.map((job) => job.id)).toEqual(jobsBeforeAcceptance.map((job) => job.id));
    expect(jobsAfterAcceptance).toHaveLength(1);
    expect(failedTask).toMatchObject({
      status: "failed",
      error_message: authenticationError,
      payload: {
        user_resolution: "user_skipped",
        partial_results_status: "partial_results_accepted"
      }
    });
    expect(await localRuntimeRepository.hasActiveAuthenticationFailureHold(device.id)).toBe(false);
    expect(accepted.state.agent_runtime).toMatchObject({
      workflow_status: "completed",
      auto_continue: false,
      current_module_id: undefined
    });
    expect(accepted.state.agent_runtime.workflow_message).not.toMatch(/未登录|auth_required/);
    expect(accepted.state.agent_decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "skip_module",
        module_id: failedModuleId,
        guardrail_notes: ["user_skipped", "partial_results_accepted"]
      })
    ]));
    expect(accepted.state.completion_report).toMatchObject({
      total_candidates: 12,
      skipped_module_ids: expect.arrayContaining([failedModuleId])
    });

    const pausedDevice = await localRuntimeRepository.heartbeatDevice(
      device.id,
      "authentication_required"
    );
    await expect(applyFailedRuntimeJob(
      failedJob!.id,
      pausedDevice!,
      authenticationError,
      {
        retryable: false,
        authenticationFailureCallback: true,
        leaseToken: failedJob!.lease_token
      }
    )).resolves.toMatchObject({ id: failedJob!.id, status: "failed" });
    const afterLateCallback = await localRuntimeRepository.getSession(sessionId, device.user_id);
    expect(afterLateCallback?.agent_runtime).toMatchObject({
      workflow_status: "completed",
      auto_continue: false,
      current_module_id: undefined
    });
    expect(Object.values(afterLateCallback!.module_candidates).flat()).toHaveLength(12);
    expect(afterLateCallback?.hosted_tasks.find((task) => task.task_id === failedJob!.id)?.payload)
      .toMatchObject({
        user_resolution: "user_skipped",
        partial_results_status: "partial_results_accepted"
      });

    const noAutomaticReplay = await advanceAgentWorkflow(sessionId, device.user_id, {
      trigger: "recovery"
    });
    expect(noAutomaticReplay.outcome).toBe("no_op");
    expect(await localRuntimeRepository.claimJob(device, 30_000)).toBeNull();
    const events = await localRuntimeRepository.listEvents(sessionId, 0, device.user_id, 100);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event_type: "agent.partial_results.accepted",
        payload: expect.objectContaining({
          module_id: failedModuleId,
          user_resolution: "user_skipped",
          status: "partial_results_accepted",
          preserved_candidate_count: 12
        })
      })
    ]));
  });

  it("does not repeat a completed search when confirmed_retry is forged", async () => {
    const sessionId = `session-workflow-reject-completed-retry-${Date.now()}`;
    sessionFiles.add(sessionId);
    const state = createSessionFixture({ session_id: sessionId });
    state.agent_runtime.workflow_run_id = "completed-search-run";
    await localRuntimeRepository.saveSession(state);
    const module = state.shopping_plan.modules[0];

    await searchModule(sessionId, module.module_id, undefined, device.user_id);
    const completedJob = await localRuntimeRepository.claimJob(device, 30_000);
    expect(completedJob).not.toBeNull();
    const originalKeyword = String(completedJob!.payload.keyword);
    await applyCompletedRuntimeJob(completedJob!.id, device, verifiedSearchResult(completedJob!, {
      summary: "真实搜索已完成，但没有可展示候选",
      candidates: []
    }));
    const completedState = await localRuntimeRepository.getSession(sessionId, device.user_id);
    completedState!.completion_report = buildAgentCompletionReport(completedState!);
    await localRuntimeRepository.saveSession(completedState!);

    const repeated = await searchModule(sessionId, module.module_id, {
      keywordOverride: originalKeyword,
      confirmedRetry: true
    }, device.user_id);

    expect(repeated.state.hosted_tasks.filter(
      (task) => task.task_type === "module_search" && task.module_id === module.module_id
    )).toEqual([
      expect.objectContaining({ task_id: completedJob!.id, status: "completed" })
    ]);
    expect(repeated.state.completion_report).toEqual(completedState!.completion_report);
    expect((await localRuntimeRepository.getJob(completedJob!.id))?.status).toBe("completed");
    expect(await localRuntimeRepository.claimJob(device, 30_000)).toBeNull();
    const events = await localRuntimeRepository.listEvents(sessionId, 0, device.user_id, 100);
    expect(events.some((event) => event.event_type === "job.requeued" && event.job_id === completedJob!.id)).toBe(false);
  });

  it("pauses after the active module and resumes the same workflow without losing progress", async () => {
    const sessionId = `session-workflow-pause-${Date.now()}`;
    sessionFiles.add(sessionId);
    const state = createSessionFixture({ session_id: sessionId });
    await localRuntimeRepository.saveSession(state);

    const started = await advanceAgentWorkflow(sessionId, device.user_id, {
      start: true,
      trigger: "user_start"
    });
    expect(started.outcome).toBe("queued");
    const workflowRunId = started.state.agent_runtime.workflow_run_id;
    const firstJob = await localRuntimeRepository.claimJob(device, 30_000);
    expect(firstJob).not.toBeNull();

    const paused = await pauseAgentWorkflow(sessionId, device.user_id);
    expect(paused.state.agent_runtime).toMatchObject({
      workflow_status: "paused",
      auto_continue: false,
      workflow_run_id: workflowRunId
    });
    expect(paused.state.agent_runtime.workflow_message).toContain("不会继续下一个模块");

    const firstModuleId = String(firstJob!.payload.module_id);
    await applyCompletedRuntimeJob(firstJob!.id, device, verifiedSearchResult(firstJob!, {
      summary: "暂停前的模块仍正常完成",
      candidates: candidates(firstModuleId, String(firstJob!.payload.module_name))
    }));
    const stoppedContinuation = await advanceAgentWorkflow(sessionId, device.user_id, {
      trigger: "job_completed"
    });
    expect(stoppedContinuation.outcome).toBe("no_op");
    expect(await localRuntimeRepository.claimJob(device, 30_000)).toBeNull();

    const resumed = await resumeAgentWorkflow(sessionId, device.user_id);
    expect(resumed.outcome).toBe("queued");
    expect(resumed.state.agent_runtime.workflow_run_id).toBe(workflowRunId);
    expect(resumed.state.agent_runtime.auto_continue).toBe(true);
    expect(resumed.state.module_candidates[firstModuleId]).toHaveLength(3);
    const nextJob = await localRuntimeRepository.claimJob(device, 30_000);
    expect(nextJob?.payload.module_id).not.toBe(firstModuleId);

    const events = await localRuntimeRepository.listEvents(sessionId, 0, device.user_id, 100);
    expect(events.some((event) =>
      event.event_type === "agent.workflow.updated" && event.payload.trigger === "user_pause"
    )).toBe(true);
  });

  it("keeps historical work in startup standby until the user resumes it from the page", async () => {
    const sessionId = `session-workflow-startup-standby-${Date.now()}`;
    sessionFiles.add(sessionId);
    const state = createSessionFixture({ session_id: sessionId });
    await localRuntimeRepository.saveSession(state);

    const started = await advanceAgentWorkflow(sessionId, device.user_id, {
      start: true,
      trigger: "user_start"
    });
    expect(started.outcome).toBe("queued");
    const queuedJobId = started.state.hosted_tasks.find(
      (task) => task.task_type === "module_search" && task.status === "pending"
    )?.runtime_job_id;
    expect(queuedJobId).toBeTruthy();

    const standby = await establishExecutorStartupStandby(device);
    expect(standby).toMatchObject({
      paused_workflows: 1,
      paused_session_ids: [sessionId]
    });
    const pausedState = await localRuntimeRepository.getSession(sessionId, device.user_id);
    expect(pausedState?.agent_runtime).toMatchObject({
      workflow_status: "paused",
      auto_continue: false,
      pause_reason: "executor_startup_standby"
    });
    expect(pausedState?.agent_runtime.workflow_message).toContain("点击“继续搜索”");

    pausedState!.agent_runtime.workflow_message = "Executor ready; resume this workflow from the page.";
    await localRuntimeRepository.saveSession(pausedState!);
    expect(await localRuntimeRepository.claimJob(device, 30_000)).toBeNull();
    expect((await localRuntimeRepository.getJob(queuedJobId!))?.status).toBe("pending");

    // Historical snapshots predate pause_reason. Keep their exact legacy
    // message gate until the user explicitly resumes them.
    pausedState!.agent_runtime.pause_reason = undefined;
    pausedState!.agent_runtime.workflow_message = EXECUTOR_STARTUP_STANDBY_MESSAGE;
    await localRuntimeRepository.saveSession(pausedState!);
    expect(await localRuntimeRepository.claimJob(device, 30_000)).toBeNull();

    const resumed = await resumeAgentWorkflow(sessionId, device.user_id);
    expect(resumed.outcome).toBe("waiting");
    expect(resumed.state.agent_runtime.auto_continue).toBe(true);
    expect(resumed.state.agent_runtime.pause_reason).toBeUndefined();
    await expect(localRuntimeRepository.claimJob(device, 30_000)).resolves.toMatchObject({
      id: queuedJobId,
      status: "leased"
    });

    const events = await localRuntimeRepository.listEvents(sessionId, 0, device.user_id, 100);
    expect(events.some((event) =>
      event.event_type === "agent.workflow.updated" &&
      event.payload.trigger === "executor_startup_standby"
    )).toBe(true);
  });

  it("coalesces concurrent start requests into one queued module", async () => {
    const sessionId = `session-workflow-concurrent-${Date.now()}`;
    sessionFiles.add(sessionId);
    const state = createSessionFixture({ session_id: sessionId });
    await localRuntimeRepository.saveSession(state);

    const [first, second] = await Promise.all([
      advanceAgentWorkflow(sessionId, device.user_id, { start: true, trigger: "user_start" }),
      advanceAgentWorkflow(sessionId, device.user_id, { start: true, trigger: "user_start" })
    ]);
    const restored = await localRuntimeRepository.getSession(sessionId, device.user_id);
    const activeTasks = restored?.hosted_tasks.filter(
      (task) => task.task_type === "module_search" && (task.status === "pending" || task.status === "running")
    ) ?? [];

    expect(first.outcome).toBe("queued");
    expect(second.outcome).toBe("queued");
    expect(first.state.agent_runtime.workflow_run_id).toBe(second.state.agent_runtime.workflow_run_id);
    expect(activeTasks).toHaveLength(1);
    expect(await localRuntimeRepository.claimJob(device, 30_000)).not.toBeNull();
    expect(await localRuntimeRepository.claimJob(device, 30_000)).toBeNull();
  });

  it("merges and reranks candidates across Agent-directed supplemental searches", async () => {
    const sessionId = `session-workflow-candidate-merge-${Date.now()}`;
    sessionFiles.add(sessionId);
    const state = createSessionFixture({ session_id: sessionId });
    state.shopping_plan.agent_directives.search_depth = "标准搜索";
    state.shopping_plan.agent_directives.autonomy_level = "平衡执行";
    await localRuntimeRepository.saveSession(state);

    const started = await advanceAgentWorkflow(sessionId, device.user_id, {
      start: true,
      trigger: "user_start"
    });
    expect(started.outcome).toBe("queued");
    const firstJob = await localRuntimeRepository.claimJob(device, 30_000);
    const moduleId = String(firstJob!.payload.module_id);
    const moduleName = String(firstJob!.payload.module_name);
    const firstCandidate: ProductCandidate = {
      ...candidates(moduleId, moduleName)[0],
      product_id: `${moduleId}-first-round-quality`,
      title: `${moduleName} 官方旗舰店 原厂 高清 稳定 专用`,
      price: 29,
      shop_name: "官方测试旗舰店"
    };
    await applyCompletedRuntimeJob(firstJob!.id, device, verifiedSearchResult(firstJob!, {
      summary: "首轮只返回一个高质量候选",
      candidates: [firstCandidate]
    }));

    const retry = await advanceAgentWorkflow(sessionId, device.user_id, {
      trigger: "job_completed"
    });
    expect(retry).toMatchObject({
      outcome: "queued",
      decision: { action: "retry_module", module_id: moduleId }
    });
    const secondJob = await localRuntimeRepository.claimJob(device, 30_000);
    expect(secondJob?.payload.module_id).toBe(moduleId);
    expect(secondJob?.payload.keyword).not.toBe(firstJob?.payload.keyword);
    const secondRound = candidates(moduleId, moduleName).map((candidate, index) => ({
      ...candidate,
      product_id: `${moduleId}-second-round-${index}`,
      title: `${moduleName} 补搜候选 ${index + 1}`,
      price: 139 + index * 70,
      shop_name: "补搜测试店"
    }));
    await applyCompletedRuntimeJob(secondJob!.id, device, verifiedSearchResult(secondJob!, {
      summary: "第二轮补齐档位候选",
      candidates: secondRound
    }));

    const restored = await localRuntimeRepository.getSession(sessionId, device.user_id);
    const finalCandidates = restored?.module_candidates[moduleId] ?? [];
    const trace = restored?.module_search_traces[moduleId];
    expect(finalCandidates).toHaveLength(3);
    expect(finalCandidates.some((candidate) => candidate.product_id === firstCandidate.product_id)).toBe(true);
    expect(finalCandidates.some((candidate) => candidate.product_id.startsWith(`${moduleId}-second-round-`))).toBe(true);
    expect(new Set(finalCandidates.map((candidate) => candidate.recommendation_type)).size).toBe(3);
    expect(trace?.searched_keywords).toHaveLength(2);
    expect(trace?.attempts.filter((attempt) => attempt.status === "success")).toHaveLength(2);
    expect(trace?.result_count).toBe(4);
    expect(trace?.candidate_count).toBe(3);
    expect(trace?.status).toBe("recovered");
    expect(trace?.ai_decision_summary).toContain("跨轮次合并重排");

    let continuation = await advanceAgentWorkflow(sessionId, device.user_id, {
      trigger: "job_completed"
    });
    while (continuation.outcome === "queued") {
      const nextJob = await localRuntimeRepository.claimJob(device, 30_000);
      const nextModuleId = String(nextJob!.payload.module_id);
      const nextModuleName = String(nextJob!.payload.module_name);
      await applyCompletedRuntimeJob(nextJob!.id, device, verifiedSearchResult(nextJob!, {
        summary: "完成补搜合并测试的剩余模块",
        candidates: candidates(nextModuleId, nextModuleName)
      }));
      continuation = await advanceAgentWorkflow(sessionId, device.user_id, {
        trigger: "job_completed"
      });
    }
    expect(continuation.outcome).toBe("completed");
  });

  it("preserves the existing candidate pool when a supplemental search fails", async () => {
    const sessionId = `session-workflow-candidate-retry-failure-${Date.now()}`;
    sessionFiles.add(sessionId);
    const state = createSessionFixture({ session_id: sessionId });
    state.shopping_plan.agent_directives.search_depth = "标准搜索";
    state.shopping_plan.agent_directives.autonomy_level = "平衡执行";
    await localRuntimeRepository.saveSession(state);

    await advanceAgentWorkflow(sessionId, device.user_id, {
      start: true,
      trigger: "user_start"
    });
    const firstJob = await localRuntimeRepository.claimJob(device, 30_000);
    const moduleId = String(firstJob!.payload.module_id);
    const moduleName = String(firstJob!.payload.module_name);
    const preservedCandidate = candidates(moduleId, moduleName)[0];
    await applyCompletedRuntimeJob(firstJob!.id, device, verifiedSearchResult(firstJob!, {
      summary: "首轮形成一个候选",
      candidates: [preservedCandidate]
    }));

    const retry = await advanceAgentWorkflow(sessionId, device.user_id, {
      trigger: "job_completed"
    });
    expect(retry.decision?.action).toBe("retry_module");
    const retryJob = await localRuntimeRepository.claimJob(device, 30_000);
    await applyFailedRuntimeJob(retryJob!.id, device, "补搜工具终态失败", { retryable: false });

    const restored = await localRuntimeRepository.getSession(sessionId, device.user_id);
    expect(restored?.module_candidates[moduleId].map((candidate) => candidate.product_id)).toEqual([
      preservedCandidate.product_id
    ]);
    expect(restored?.module_search_traces[moduleId]).toMatchObject({
      status: "thin",
      candidate_count: 1
    });
    expect(restored?.module_search_traces[moduleId].attempts.at(-1)).toMatchObject({
      keyword: retryJob?.payload.keyword,
      status: "error",
      result_count: 0
    });
    expect(restored?.module_search_traces[moduleId].ai_decision_summary).toContain("已保留此前的 1 个候选");

    restored!.agent_runtime.auto_continue = false;
    restored!.agent_runtime.workflow_status = "paused";
    await localRuntimeRepository.saveSession(restored!);
  });

  it("recovers only uncovered modules while preserving completed candidates", async () => {
    const sessionId = `session-workflow-recover-${Date.now()}`;
    sessionFiles.add(sessionId);
    const state = createSessionFixture({ session_id: sessionId });
    const missingModule = state.shopping_plan.modules.find((module) => !module.optional)!;
    const preservedModule = state.shopping_plan.modules.find((module) => module.module_id !== missingModule.module_id)!;

    for (const module of state.shopping_plan.modules) {
      if (module.module_id !== missingModule.module_id) {
        state.module_candidates[module.module_id] = candidates(module.module_id, module.module_name);
      }
    }
    state.agent_runtime.workflow_status = "completed";
    state.agent_decisions = [createAgentDecision({
      action: "skip_module",
      source: "policy_fallback",
      confidence: "high",
      module_id: missingModule.module_id,
      module_name: missingModule.module_name,
      reason: "上一轮工具失败",
      evidence: ["无候选"]
    })];
    state.completion_report = buildAgentCompletionReport(state);
    const preservedCandidates = state.module_candidates[preservedModule.module_id];
    state.selected_items = [{
      product_id: preservedCandidates[0].product_id,
      module_id: preservedModule.module_id,
      title: preservedCandidates[0].title,
      price: preservedCandidates[0].price,
      cart_source: "taobao",
      added_at: new Date().toISOString()
    }];
    await localRuntimeRepository.saveSession(state);

    const recovered = await recoverAgentCompletionGaps(sessionId, device.user_id);
    const restored = await localRuntimeRepository.getSession(sessionId, device.user_id);
    const queuedJob = await localRuntimeRepository.claimJob(device, 30_000);

    expect(recovered.outcome).toBe("queued");
    expect(recovered.recovered_module_ids).toEqual([missingModule.module_id]);
    expect(queuedJob?.payload.module_id).toBe(missingModule.module_id);
    expect(restored?.module_candidates[preservedModule.module_id]).toEqual(preservedCandidates);
    expect(restored?.selected_items.map((item) => item.product_id)).toEqual([preservedCandidates[0].product_id]);
    expect(restored?.completion_report).toBeUndefined();
    expect(restored?.agent_decisions.some(
      (decision) => decision.action === "skip_module" && decision.module_id === missingModule.module_id
    )).toBe(false);
    expect((await localRuntimeRepository.listEvents(sessionId, 0, device.user_id, 100)).some(
      (event) => event.event_type === "agent.completion.recovery_confirmed"
    )).toBe(true);
  });

  it("starts a fresh recovery run after a real terminal search failure without deleting task history", async () => {
    const sessionId = `session-workflow-recover-failed-task-${Date.now()}`;
    sessionFiles.add(sessionId);
    const state = createSessionFixture({ session_id: sessionId });
    await localRuntimeRepository.saveSession(state);

    const started = await advanceAgentWorkflow(sessionId, device.user_id, {
      start: true,
      trigger: "user_start"
    });
    expect(started.outcome).toBe("queued");
    const failedJob = await localRuntimeRepository.claimJob(device, 30_000);
    expect(failedJob).not.toBeNull();
    const failedModuleId = String(failedJob!.payload.module_id);
    const originalWorkflowRunId = String(failedJob!.payload.workflow_run_id);
    expect(originalWorkflowRunId).toBe(started.state.agent_runtime.workflow_run_id);

    await applyFailedRuntimeJob(failedJob!.id, device, "E2E 同类的真实终态搜索失败", { retryable: false });
    let continuation = await advanceAgentWorkflow(sessionId, device.user_id, {
      trigger: "job_failed"
    });
    while (continuation.outcome === "queued") {
      const nextJob = await localRuntimeRepository.claimJob(device, 30_000);
      expect(nextJob).not.toBeNull();
      const moduleId = String(nextJob!.payload.module_id);
      expect(moduleId).not.toBe(failedModuleId);
      await applyCompletedRuntimeJob(nextJob!.id, device, verifiedSearchResult(nextJob!, {
        summary: "完成失败模块之外的剩余搜索",
        candidates: candidates(moduleId, String(nextJob!.payload.module_name))
      }));
      continuation = await advanceAgentWorkflow(sessionId, device.user_id, {
        trigger: "job_completed"
      });
    }

    expect(continuation.outcome).toBe("completed");
    const completed = await localRuntimeRepository.getSession(sessionId, device.user_id);
    const failedTaskBeforeRecovery = completed?.hosted_tasks.find((task) => task.task_id === failedJob!.id);
    expect(failedTaskBeforeRecovery).toMatchObject({
      status: "failed",
      module_id: failedModuleId,
      payload: { workflow_run_id: originalWorkflowRunId }
    });
    expect(completed?.module_search_traces[failedModuleId]).toMatchObject({
      status: "failed",
      attempts: [expect.objectContaining({ status: "error" })]
    });
    expect(completed?.completion_report?.uncovered_module_ids).toContain(failedModuleId);

    const recovered = await recoverAgentCompletionGaps(sessionId, device.user_id);
    const recoveredState = await localRuntimeRepository.getSession(sessionId, device.user_id);
    const recoveryJob = await localRuntimeRepository.claimJob(device, 30_000);
    const failedModuleTasks = recoveredState?.hosted_tasks.filter(
      (task) => task.task_type === "module_search" && task.module_id === failedModuleId
    ) ?? [];
    const preservedFailedTask = failedModuleTasks.find((task) => task.task_id === failedJob!.id);
    const newRecoveryTask = failedModuleTasks.find((task) => task.task_id !== failedJob!.id);

    expect(recovered.outcome).toBe("queued");
    expect(recovered.recovered_module_ids).toEqual([failedModuleId]);
    expect(recoveryJob).toMatchObject({
      id: newRecoveryTask?.task_id,
      payload: { module_id: failedModuleId }
    });
    expect(recoveryJob?.id).not.toBe(failedJob!.id);
    expect(recoveryJob?.payload.workflow_run_id).toBe(recoveredState?.agent_runtime.workflow_run_id);
    expect(recoveryJob?.payload.workflow_run_id).not.toBe(originalWorkflowRunId);
    expect(failedModuleTasks).toHaveLength(2);
    expect(preservedFailedTask).toMatchObject({
      status: "failed",
      error_message: "E2E 同类的真实终态搜索失败",
      payload: {
        workflow_run_id: originalWorkflowRunId,
        recovery_superseded_reason: "user_confirmed_gap_recovery"
      }
    });
    expect(newRecoveryTask).toMatchObject({
      status: "pending",
      payload: { workflow_run_id: recoveredState?.agent_runtime.workflow_run_id }
    });
    expect(recoveredState?.module_search_traces[failedModuleId]).toMatchObject({
      attempts: [expect.objectContaining({ status: "skipped" })]
    });
    expect(recoveredState?.completion_report).toBeUndefined();
    const recoveryEvent = (await localRuntimeRepository.listEvents(sessionId, 0, device.user_id, 100))
      .find((event) => event.event_type === "agent.completion.recovery_confirmed");
    expect(recoveryEvent?.payload).toMatchObject({
      previous_workflow_run_id: originalWorkflowRunId,
      superseded_task_ids: [failedJob!.id]
    });
  });

  it("starts a confirmed incremental search for thin modules without deleting existing candidates", async () => {
    const sessionId = `session-workflow-improve-thin-${Date.now()}`;
    sessionFiles.add(sessionId);
    const state = createSessionFixture({ session_id: sessionId });
    const targetModule = state.shopping_plan.modules[0];

    for (const module of state.shopping_plan.modules) {
      state.module_candidates[module.module_id] = candidates(module.module_id, module.module_name);
      state.module_reviews[module.module_id] = reviewModuleCandidates(
        state,
        module,
        state.module_candidates[module.module_id]
      );
    }
    const preservedCandidates = state.module_candidates[targetModule.module_id].slice(0, 1);
    state.module_candidates[targetModule.module_id] = preservedCandidates;
    state.module_reviews[targetModule.module_id] = reviewModuleCandidates(state, targetModule, preservedCandidates);
    const primaryKeyword = targetModule.search_strategy?.primary_keyword || targetModule.search_keyword || targetModule.module_name;
    state.module_search_traces[targetModule.module_id] = {
      module_id: targetModule.module_id,
      module_name: targetModule.module_name,
      status: "thin",
      primary_keyword: primaryKeyword,
      searched_keywords: [primaryKeyword],
      attempts: [{
        keyword: primaryKeyword,
        reason: "首轮候选偏薄",
        result_count: 1,
        status: "success",
        created_at: new Date().toISOString()
      }],
      result_count: 1,
      candidate_count: 1,
      review_status: "thin",
      review_summary: state.module_reviews[targetModule.module_id].summary,
      recovery_keyword: state.module_reviews[targetModule.module_id].suggested_keyword,
      ai_decision_summary: "首轮候选偏薄",
      next_action: state.module_reviews[targetModule.module_id].next_action,
      generated_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    state.agent_runtime.workflow_status = "completed";
    state.agent_runtime.auto_continue = false;
    state.shopping_plan.agent_directives.autonomy_level = "保守执行";
    state.shopping_plan.agent_directives.search_depth = "轻量搜索";
    state.completion_report = buildAgentCompletionReport(state);
    expect(state.completion_report.thin_module_ids).toEqual([targetModule.module_id]);
    await localRuntimeRepository.saveSession(state);

    const improved = await improveAgentCompletionQuality(sessionId, device.user_id);
    const restored = await localRuntimeRepository.getSession(sessionId, device.user_id);
    const queuedJob = await localRuntimeRepository.claimJob(device, 30_000);

    expect(improved.outcome).toBe("queued");
    expect(improved.targeted_module_ids).toEqual([targetModule.module_id]);
    expect(queuedJob?.payload.module_id).toBe(targetModule.module_id);
    expect(queuedJob?.payload.keyword).not.toBe(primaryKeyword);
    expect(restored?.module_candidates[targetModule.module_id]).toEqual(preservedCandidates);
    expect(restored?.shopping_plan.agent_directives).toMatchObject({
      autonomy_level: "保守执行",
      search_depth: "轻量搜索"
    });
    expect(restored?.module_reviews[targetModule.module_id].user_confirmed_retry).toBe(true);
    expect(restored?.completion_report).toBeUndefined();
    expect((await localRuntimeRepository.listEvents(sessionId, 0, device.user_id, 100)).some(
      (event) => event.event_type === "agent.completion.quality_improvement_confirmed"
    )).toBe(true);

    await applyCompletedRuntimeJob(queuedJob!.id, device, verifiedSearchResult(queuedJob!, {
      summary: "用户确认后完成增量补搜",
      candidates: candidates(targetModule.module_id, targetModule.module_name)
    }));
    const completed = await advanceAgentWorkflow(sessionId, device.user_id, {
      trigger: "job_completed"
    });
    const finalState = await localRuntimeRepository.getSession(sessionId, device.user_id);
    expect(completed.outcome).toBe("completed");
    expect(finalState?.module_candidates[targetModule.module_id]).toHaveLength(3);
    expect(finalState?.module_candidates[targetModule.module_id].some(
      (candidate) => candidate.product_id === preservedCandidates[0].product_id
    )).toBe(true);
    expect(finalState?.module_reviews[targetModule.module_id].user_confirmed_retry).toBeUndefined();
    expect(finalState?.completion_report?.thin_module_ids).not.toContain(targetModule.module_id);
  });

  it("starts a confirmed rerun with a fresh per-run tool budget", async () => {
    const sessionId = `session-workflow-rerun-${Date.now()}`;
    sessionFiles.add(sessionId);
    const state = createSessionFixture({ session_id: sessionId });
    state.agent_runtime.used_tool_calls = state.agent_runtime.max_tool_calls;
    state.agent_runtime.workflow_status = "completed";
    state.agent_decisions = [createAgentDecision({
      action: "search_module",
      source: "plan_strategy",
      confidence: "high",
      module_id: state.shopping_plan.modules.at(-1)?.module_id,
      module_name: state.shopping_plan.modules.at(-1)?.module_name,
      reason: "上一轮未消费决策",
      evidence: ["旧运行"]
    })];
    await localRuntimeRepository.saveSession(state);

    const restarted = await advanceAgentWorkflow(sessionId, device.user_id, {
      start: true,
      trigger: "user_start"
    });
    const restored = await localRuntimeRepository.getSession(sessionId, device.user_id);
    const queuedJob = await localRuntimeRepository.claimJob(device, 30_000);

    expect(restarted.outcome).toBe("queued");
    expect(restored?.agent_runtime.used_tool_calls).toBe(1);
    expect(restored?.completion_report).toBeUndefined();
    expect(queuedJob).not.toBeNull();
    expect(queuedJob?.payload.module_id).toBe(state.shopping_plan.modules[0].module_id);
  });

  it("does not share an active workflow promise across user identities", async () => {
    const sessionId = `session-workflow-owner-${Date.now()}`;
    sessionFiles.add(sessionId);
    await localRuntimeRepository.saveSession(createSessionFixture({ session_id: sessionId }));

    const ownerAdvance = advanceAgentWorkflow(sessionId, device.user_id, {
      start: true,
      trigger: "user_start"
    });
    const foreignAdvance = advanceAgentWorkflow(sessionId, "different-user", {
      start: true,
      trigger: "user_start"
    });
    const foreignExpectation = expect(foreignAdvance).rejects.toThrow("session not found");

    await expect(ownerAdvance).resolves.toMatchObject({ outcome: "queued" });
    await foreignExpectation;
  });

  it("persists an observable error when an Agent transition is invalid", async () => {
    const sessionId = `session-workflow-error-${Date.now()}`;
    sessionFiles.add(sessionId);
    const state = createSessionFixture({ session_id: sessionId });
    state.agent_decisions = [createAgentDecision({
      action: "search_module",
      source: "plan_strategy",
      confidence: "high",
      reason: "unit test invalid decision",
      evidence: []
    })];
    state.agent_runtime.auto_continue = true;
    state.agent_runtime.workflow_status = "running";
    await localRuntimeRepository.saveSession(state);

    await expect(advanceAgentWorkflow(sessionId, device.user_id, {
      start: true,
      trigger: "user_start"
    })).rejects.toThrow("Agent 搜索决策缺少 module_id");

    const restored = await localRuntimeRepository.getSession(sessionId, device.user_id);
    expect(restored?.agent_runtime.workflow_status).toBe("error");
    expect(restored?.agent_runtime.auto_continue).toBe(false);
    expect(restored?.agent_runtime.workflow_message).toContain("缺少 module_id");
  });

  it("skips a terminal failed module and automatically queues the next module", async () => {
    const sessionId = `session-workflow-failure-${Date.now()}`;
    sessionFiles.add(sessionId);
    const state = createSessionFixture({ session_id: sessionId });
    await localRuntimeRepository.saveSession(state);

    const started = await advanceAgentWorkflow(sessionId, device.user_id, {
      start: true,
      trigger: "user_start"
    });
    expect(started.outcome).toBe("queued");
    const firstJob = await localRuntimeRepository.claimJob(device, 30_000);
    expect(firstJob).not.toBeNull();
    await applyFailedRuntimeJob(firstJob!.id, device, "terminal test failure", { retryable: false });

    const continued = await advanceAgentWorkflow(sessionId, device.user_id, {
      trigger: "job_failed"
    });
    const nextJob = await localRuntimeRepository.claimJob(device, 30_000);

    expect(continued.outcome).toBe("queued");
    expect(continued.state.agent_decisions.some((decision) =>
      decision.action === "skip_module" && decision.module_id === firstJob!.payload.module_id
    )).toBe(true);
    expect(nextJob?.payload.module_id).not.toBe(firstJob!.payload.module_id);
    expect(continued.state.agent_runtime.workflow_status).toBe("waiting_for_tools");
    expect(continued.state.tool_logs.some(
      (log) => log.tool_name === "local_executor" && log.status === "error"
    )).toBe(true);
  });

  it("replays a persisted executor result and resumes after a server interruption", async () => {
    const sessionId = `session-workflow-recovery-${Date.now()}`;
    sessionFiles.add(sessionId);
    const state = createSessionFixture({ session_id: sessionId });
    await localRuntimeRepository.saveSession(state);

    const started = await advanceAgentWorkflow(sessionId, device.user_id, {
      start: true,
      trigger: "user_start"
    });
    expect(started.outcome).toBe("queued");
    const firstJob = await localRuntimeRepository.claimJob(device, 30_000);
    expect(firstJob).not.toBeNull();
    const firstModuleId = String(firstJob!.payload.module_id);
    const firstModuleName = String(firstJob!.payload.module_name);

    // Simulate a process interruption after the durable job result was committed but
    // before Session candidates and the next Agent action were persisted.
    await localRuntimeRepository.completeJob(firstJob!.id, device.id, {
      summary: "持久化结果等待恢复",
      candidates: candidates(firstModuleId, firstModuleName)
    }, firstJob!.lease_token!);

    const recovery = await recoverAgentWorkflowForExecutor(device);
    const restored = await localRuntimeRepository.getSession(sessionId, device.user_id);
    const nextJob = await localRuntimeRepository.claimJob(device, 30_000);

    expect(recovery).toMatchObject({
      recovered: true,
      session_id: sessionId,
      reason: "completed_result"
    });
    expect(restored?.module_candidates[firstModuleId]).toHaveLength(3);
    expect(restored?.hosted_tasks.find((task) => task.task_id === firstJob!.id)?.status).toBe("completed");
    expect(nextJob?.payload.module_id).not.toBe(firstModuleId);
    expect(restored?.agent_runtime.workflow_status).toBe("waiting_for_tools");
  });

  it("recovers a persisted result from a server scan without an executor callback", async () => {
    const sessionId = `session-workflow-cron-recovery-${Date.now()}`;
    sessionFiles.add(sessionId);
    const state = createSessionFixture({ session_id: sessionId });
    await localRuntimeRepository.saveSession(state);

    const started = await advanceAgentWorkflow(sessionId, device.user_id, {
      start: true,
      trigger: "user_start"
    });
    expect(started.outcome).toBe("queued");
    const firstJob = await localRuntimeRepository.claimJob(device, 30_000);
    expect(firstJob).not.toBeNull();
    const firstModuleId = String(firstJob!.payload.module_id);
    const firstModuleName = String(firstJob!.payload.module_name);
    await localRuntimeRepository.completeJob(firstJob!.id, device.id, {
      summary: "等待服务端扫描恢复",
      candidates: candidates(firstModuleId, firstModuleName)
    }, firstJob!.lease_token!);
    const interrupted = await localRuntimeRepository.getSession(sessionId, device.user_id);
    interrupted!.hosted_tasks = interrupted!.hosted_tasks.filter((task) => task.task_id !== firstJob!.id);
    await localRuntimeRepository.saveSession(interrupted!);

    const healthySessionId = `session-workflow-healthy-${Date.now()}`;
    sessionFiles.add(healthySessionId);
    const healthy = createSessionFixture({ session_id: healthySessionId });
    const healthyModule = healthy.shopping_plan.modules[0];
    await enqueueModuleSearchJob(healthy, {
      moduleId: healthyModule.module_id,
      moduleName: healthyModule.module_name,
      keyword: healthyModule.search_keyword ?? healthyModule.module_name
    });
    healthy.agent_runtime.auto_continue = true;
    healthy.agent_runtime.workflow_status = "waiting_for_tools";
    healthy.agent_runtime.last_transition_at = "2020-01-01T00:00:00.000Z";
    await localRuntimeRepository.saveSession(healthy);

    const recovery = await recoverAgentWorkflows({ limit: 1 });
    const restored = await localRuntimeRepository.getSession(sessionId, device.user_id);
    const nextJob = (await localRuntimeRepository.listJobs(sessionId, device.user_id))
      .find((job) => job.status === "pending");

    expect(recovery.scanned).toBe(1);
    expect(recovery.recovered).toBe(1);
    expect(recovery.items.find((item) => item.session_id === sessionId)).toMatchObject({
      session_id: sessionId,
      reason: "completed_result"
    });
    expect(restored?.module_candidates[firstModuleId]).toHaveLength(3);
    expect(restored?.hosted_tasks.find((task) => task.task_id === firstJob!.id)?.status).toBe("completed");
    expect(nextJob?.payload.module_id).not.toBe(firstModuleId);
  });

  it("continues scanning when one recoverable session is malformed", async () => {
    const brokenSessionId = `session-workflow-broken-recovery-${Date.now()}`;
    const validSessionId = `session-workflow-valid-recovery-${Date.now()}`;
    sessionFiles.add(brokenSessionId);
    sessionFiles.add(validSessionId);

    const broken = createSessionFixture({ session_id: brokenSessionId });
    broken.agent_runtime.auto_continue = true;
    broken.agent_runtime.workflow_status = "running";
    broken.agent_runtime.last_transition_at = "2020-01-01T00:00:00.000Z";
    broken.agent_decisions = [createAgentDecision({
      action: "search_module",
      source: "plan_strategy",
      confidence: "high",
      reason: "malformed recovery decision",
      evidence: []
    })];
    await localRuntimeRepository.saveSession(broken);

    const valid = createSessionFixture({ session_id: validSessionId });
    valid.agent_runtime.auto_continue = true;
    valid.agent_runtime.workflow_status = "running";
    valid.agent_runtime.last_transition_at = "2021-01-01T00:00:00.000Z";
    await localRuntimeRepository.saveSession(valid);

    const recovery = await recoverAgentWorkflows({ limit: 2, maxRecoveries: 2 });
    const brokenResult = recovery.items.find((item) => item.session_id === brokenSessionId);
    const validResult = recovery.items.find((item) => item.session_id === validSessionId);

    expect(brokenResult).toMatchObject({ recovered: false, reason: "recovery_failed" });
    expect(brokenResult?.error_message).toContain("缺少 module_id");
    expect(validResult).toMatchObject({ recovered: true, reason: "missing_continuation" });
    expect((await localRuntimeRepository.getSession(brokenSessionId, device.user_id))
      ?.agent_runtime.workflow_status).toBe("error");
    expect((await localRuntimeRepository.listJobs(validSessionId, device.user_id))
      .some((job) => job.status === "pending")).toBe(true);
  });
});
