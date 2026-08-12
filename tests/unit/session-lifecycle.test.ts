import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { advanceAgentWorkflow } from "@/lib/agent/workflow-runner";
import { localRuntimeRepository, resetLocalRuntimeForTests } from "@/lib/runtime/local-repository";
import type { ExecutorDevice } from "@/lib/runtime/types";
import { updateShoppingSessionLifecycle } from "@/lib/session/lifecycle";
import { createSessionFixture } from "@/tests/fixtures/session";

const device: ExecutorDevice = {
  id: "lifecycle-device",
  user_id: "user-test",
  name: "lifecycle executor",
  token_hash: "lifecycle-digest",
  capabilities: ["module_search"],
  status: "online",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString()
};

const sessionFiles = new Set<string>();

describe("shopping session lifecycle", () => {
  beforeEach(async () => {
    resetLocalRuntimeForTests();
    await localRuntimeRepository.createDevice(device);
  });

  afterEach(async () => {
    await Promise.all([...sessionFiles].map((sessionId) =>
      fs.unlink(path.join(process.cwd(), ".data", "sessions", `${sessionId}.json`)).catch(() => undefined)
    ));
    sessionFiles.clear();
  });

  it("archives safely, cancels pending work, and restores without automatic execution", async () => {
    const sessionId = `session-lifecycle-${Date.now()}`;
    sessionFiles.add(sessionId);
    await localRuntimeRepository.saveSession(createSessionFixture({ session_id: sessionId }));

    const started = await advanceAgentWorkflow(sessionId, device.user_id, {
      start: true,
      trigger: "user_start"
    });
    expect(started.outcome).toBe("queued");
    const claimed = await localRuntimeRepository.claimJob(device, 30_000);
    expect(claimed?.status).toBe("leased");

    const pendingJob = await localRuntimeRepository.createJob({
      id: "lifecycle-pending-job",
      user_id: device.user_id,
      session_id: sessionId,
      job_type: "module_search",
      idempotency_key: `lifecycle-pending-${sessionId}`,
      payload: { module_id: "cleaning-care", module_name: "清洁维护" }
    });
    const stateWithPendingTask = await localRuntimeRepository.getSession(sessionId, device.user_id);
    expect(stateWithPendingTask).not.toBeNull();
    const now = new Date().toISOString();
    stateWithPendingTask!.hosted_tasks.push({
      task_id: pendingJob.id,
      session_id: sessionId,
      task_type: "module_search",
      status: "pending",
      title: "待归档搜索任务",
      description: "验证归档前取消尚未领取的任务",
      module_id: "cleaning-care",
      module_name: "清洁维护",
      created_at: now,
      updated_at: now,
      payload: pendingJob.payload,
      executor: "local_executor",
      runtime_job_id: pendingJob.id
    });
    await localRuntimeRepository.saveSession(stateWithPendingTask!);

    const archived = await updateShoppingSessionLifecycle(sessionId, "archive", device.user_id);
    expect(archived).toMatchObject({
      action: "archive",
      cancelled_pending_jobs: 1,
      active_jobs_remaining: 1
    });
    expect(archived.state.archived_at).toBeTruthy();
    expect(archived.state.agent_runtime).toMatchObject({
      workflow_status: "paused",
      auto_continue: false
    });
    expect(archived.state.agent_runtime.workflow_message).toContain("不会继续后续模块");
    expect((await localRuntimeRepository.getJob(pendingJob.id))?.status).toBe("cancelled");
    expect((await localRuntimeRepository.getJob(claimed!.id))?.status).toBe("leased");
    expect(archived.state.hosted_tasks.find((task) => task.task_id === pendingJob.id)?.status).toBe("cancelled");
    expect(await localRuntimeRepository.claimJob(device, 30_000)).toBeNull();
    expect(await localRuntimeRepository.listWorkflowRecoveryCandidates(device.user_id)).toEqual([]);
    expect((await advanceAgentWorkflow(sessionId, device.user_id, { trigger: "job_completed" })).outcome)
      .toBe("paused");

    await expect(localRuntimeRepository.createJob({
      id: "lifecycle-rejected-job",
      user_id: device.user_id,
      session_id: sessionId,
      job_type: "module_search",
      idempotency_key: `lifecycle-rejected-${sessionId}`,
      payload: {}
    })).rejects.toThrow("session archived");

    const restored = await updateShoppingSessionLifecycle(sessionId, "restore", device.user_id);
    expect(restored.state.archived_at).toBeUndefined();
    expect(restored.state.agent_runtime).toMatchObject({
      workflow_status: "paused",
      auto_continue: false
    });
    expect(restored.state.agent_runtime.workflow_message).toContain("请确认当前规划");

    const events = await localRuntimeRepository.listEvents(sessionId, 0, device.user_id, 20);
    expect(events.map((event) => event.event_type)).toEqual(
      expect.arrayContaining(["session.archived", "session.restored"])
    );
  });

  it("enforces exact account ownership", async () => {
    const sessionId = `session-lifecycle-owner-${Date.now()}`;
    sessionFiles.add(sessionId);
    await localRuntimeRepository.saveSession(createSessionFixture({ session_id: sessionId }));

    await expect(updateShoppingSessionLifecycle(sessionId, "archive", "another-user"))
      .rejects.toThrow("购物任务不存在或无权访问");
  });

  it("restores an untouched plan to planning instead of pretending search was paused", async () => {
    const sessionId = `session-lifecycle-idle-${Date.now()}`;
    sessionFiles.add(sessionId);
    await localRuntimeRepository.saveSession(createSessionFixture({ session_id: sessionId }));

    const archived = await updateShoppingSessionLifecycle(sessionId, "archive", device.user_id);
    expect(archived.state.archived_from_workflow_status).toBe("idle");
    const restored = await updateShoppingSessionLifecycle(sessionId, "restore", device.user_id);

    expect(restored.state.archived_from_workflow_status).toBeUndefined();
    expect(restored.state.agent_runtime).toMatchObject({
      workflow_status: "idle",
      auto_continue: false
    });
    expect(restored.state.agent_runtime.workflow_message).toContain("确认当前购物规划");
  });
});
