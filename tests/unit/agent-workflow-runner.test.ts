import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { advanceAgentWorkflow } from "@/lib/agent/workflow-runner";
import { recoverAgentWorkflowForExecutor } from "@/lib/agent/workflow-recovery";
import { applyCompletedRuntimeJob, applyFailedRuntimeJob } from "@/lib/runtime/jobs";
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
    expect(completedJobs).toBe(state.shopping_plan.modules.length);
    expect(Object.keys(restored?.module_candidates ?? {})).toHaveLength(state.shopping_plan.modules.length);
    expect(restored?.tool_logs.filter(
      (log) => log.tool_name === "local_executor" && log.status === "success"
    )).toHaveLength(state.shopping_plan.modules.length);
    expect((await localRuntimeRepository.listEvents(sessionId, 0, device.user_id, 100))
      .some((event) => event.event_type === "agent.workflow.updated" && event.payload.outcome === "completed"))
      .toBe(true);
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
});
