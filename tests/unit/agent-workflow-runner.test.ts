import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createAgentDecision } from "@/lib/agent/decision-engine";
import { buildAgentCompletionReport } from "@/lib/agent/completion-review";
import { reviewModuleCandidates } from "@/lib/agent/candidate-reviewer";
import {
  advanceAgentWorkflow,
  improveAgentCompletionQuality,
  recoverAgentCompletionGaps
} from "@/lib/agent/workflow-runner";
import { recoverAgentWorkflowForExecutor, recoverAgentWorkflows } from "@/lib/agent/workflow-recovery";
import { applyCompletedRuntimeJob, applyFailedRuntimeJob, enqueueModuleSearchJob } from "@/lib/runtime/jobs";
import { localRuntimeRepository, resetLocalRuntimeForTests } from "@/lib/runtime/local-repository";
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
    source: "淘宝本地执行器测试",
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
      await applyCompletedRuntimeJob(job!.id, device, {
        summary: "测试执行器完成候选回填",
        candidates: candidates(moduleId, moduleName)
      });
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
    await applyCompletedRuntimeJob(firstJob!.id, device, {
      summary: "首轮只返回一个高质量候选",
      candidates: [firstCandidate]
    });

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
    await applyCompletedRuntimeJob(secondJob!.id, device, {
      summary: "第二轮补齐档位候选",
      candidates: secondRound
    });

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
      await applyCompletedRuntimeJob(nextJob!.id, device, {
        summary: "完成补搜合并测试的剩余模块",
        candidates: candidates(nextModuleId, nextModuleName)
      });
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
    await applyCompletedRuntimeJob(firstJob!.id, device, {
      summary: "首轮形成一个候选",
      candidates: [preservedCandidate]
    });

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

    await applyCompletedRuntimeJob(queuedJob!.id, device, {
      summary: "用户确认后完成增量补搜",
      candidates: candidates(targetModule.module_id, targetModule.module_name)
    });
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
    });

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
    });
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
