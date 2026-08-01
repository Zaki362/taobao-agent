import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createAgentDecision } from "@/lib/agent/decision-engine";
import { advanceAgentWorkflow } from "@/lib/agent/workflow-runner";
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
    expect(completedJobs).toBe(state.shopping_plan.modules.length);
    expect(Object.keys(restored?.module_candidates ?? {})).toHaveLength(state.shopping_plan.modules.length);
    expect(restored?.tool_logs.filter(
      (log) => log.tool_name === "local_executor" && log.status === "success"
    )).toHaveLength(state.shopping_plan.modules.length);
    expect((await localRuntimeRepository.listEvents(sessionId, 0, device.user_id, 100))
      .some((event) => event.event_type === "agent.workflow.updated" && event.payload.outcome === "completed"))
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
