import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentDecision } from "@/lib/agent/decision-engine";
import { advanceAgentWorkflow } from "@/lib/agent/workflow-runner";
import { recoverAgentWorkflows } from "@/lib/agent/workflow-recovery";
import { closeDatabasePoolForTests, query, withWorkflowSessionLock } from "@/lib/runtime/database";
import { applyCompletedRuntimeJob, enqueueModuleSearchJob } from "@/lib/runtime/jobs";
import { postgresRuntimeRepository } from "@/lib/runtime/postgres-repository";
import type { ExecutorDevice, RuntimeUser } from "@/lib/runtime/types";
import { createSessionFixture } from "@/tests/fixtures/session";

const databaseAvailable = Boolean(process.env.DATABASE_URL);
const describeWithDatabase = databaseAvailable ? describe : describe.skip;

describeWithDatabase("PostgreSQL production runtime contract", () => {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const deviceId = randomUUID();
  const sessionId = `session-pg-${randomUUID()}`;
  const jobId = randomUUID();
  const now = new Date().toISOString();

  const user: RuntimeUser = {
    id: userId,
    email: `runtime-${userId}@example.com`,
    password_hash: "integration-test-hash",
    created_at: now,
    updated_at: now
  };
  const device: ExecutorDevice = {
    id: deviceId,
    user_id: userId,
    name: "PostgreSQL integration executor",
    token_hash: `token-${deviceId}`,
    capabilities: ["module_search", "add_to_cart"],
    status: "online",
    created_at: now,
    updated_at: now
  };

  beforeAll(async () => {
    await query("SELECT 1 FROM schema_migrations LIMIT 1");
    await postgresRuntimeRepository.createUser(user);
  });

  afterAll(async () => {
    await query("DELETE FROM app_users WHERE id = $1", [userId]).catch(() => undefined);
    await closeDatabasePoolForTests();
  });

  it("persists sessions with owner isolation", async () => {
    const state = createSessionFixture({ session_id: sessionId, owner_id: userId });
    await postgresRuntimeRepository.saveSession(state);

    expect((await postgresRuntimeRepository.getSession(sessionId, userId))?.session_id).toBe(sessionId);
    expect(await postgresRuntimeRepository.getSession(sessionId, otherUserId)).toBeNull();
    expect(await postgresRuntimeRepository.listSessions(otherUserId)).toHaveLength(0);
  });

  it("enforces queue leases, idempotency, event ordering and replay-safe completion", async () => {
    await postgresRuntimeRepository.createDevice(device);
    expect(await postgresRuntimeRepository.updateDeviceCapabilities(
      deviceId,
      otherUserId,
      ["module_search"]
    )).toBeNull();
    expect((await postgresRuntimeRepository.updateDeviceCapabilities(
      deviceId,
      userId,
      ["module_search", "add_to_cart"]
    ))?.capabilities).toEqual(["module_search", "add_to_cart"]);
    const first = await postgresRuntimeRepository.createJob({
      id: jobId,
      user_id: userId,
      session_id: sessionId,
      job_type: "module_search",
      idempotency_key: `integration:${sessionId}:search`,
      payload: { keyword: "新能源车 行车记录仪" }
    });
    const duplicate = await postgresRuntimeRepository.createJob({
      id: randomUUID(),
      user_id: userId,
      session_id: sessionId,
      job_type: "module_search",
      idempotency_key: `integration:${sessionId}:search`,
      payload: { keyword: "不应创建第二个任务" }
    });
    expect(duplicate.id).toBe(first.id);

    const claimed = await postgresRuntimeRepository.claimJob(device, 30_000);
    expect(claimed?.id).toBe(jobId);
    expect(claimed?.status).toBe("leased");
    expect(await postgresRuntimeRepository.claimJob(device, 30_000)).toBeNull();

    const running = await postgresRuntimeRepository.renewJobLease(jobId, deviceId, 30_000);
    expect(running?.status).toBe("running");

    const completed = await postgresRuntimeRepository.completeJob(jobId, deviceId, { results: [] });
    const replay = await postgresRuntimeRepository.completeJob(jobId, deviceId, { results: [] });
    expect(completed.alreadyCompleted).toBe(false);
    expect(replay.alreadyCompleted).toBe(true);

    const firstEvent = await postgresRuntimeRepository.appendEvent({
      user_id: userId,
      session_id: sessionId,
      job_id: jobId,
      event_type: "integration.started",
      payload: { sequence: 1 }
    });
    const secondEvent = await postgresRuntimeRepository.appendEvent({
      user_id: userId,
      session_id: sessionId,
      job_id: jobId,
      event_type: "integration.completed",
      payload: { sequence: 2 }
    });
    const events = await postgresRuntimeRepository.listEvents(sessionId, firstEvent.id, userId);
    expect(events.map((event) => event.id)).toEqual([secondEvent.id]);
    expect(await postgresRuntimeRepository.listEvents(sessionId, 0, otherUserId)).toHaveLength(0);
  });

  it("cancels only pending jobs owned by the current user", async () => {
    const cancellableId = randomUUID();
    await postgresRuntimeRepository.createJob({
      id: cancellableId,
      user_id: userId,
      session_id: sessionId,
      job_type: "module_search",
      idempotency_key: `integration:${sessionId}:cancel`,
      payload: {}
    });
    expect(await postgresRuntimeRepository.cancelJob(cancellableId, otherUserId)).toBeNull();
    expect((await postgresRuntimeRepository.cancelJob(cancellableId, userId))?.status).toBe("cancelled");
  });

  it("terminates non-retryable executor failures after the first attempt", async () => {
    const terminalJobId = randomUUID();
    await postgresRuntimeRepository.createJob({
      id: terminalJobId,
      user_id: userId,
      session_id: sessionId,
      job_type: "module_search",
      idempotency_key: `integration:${sessionId}:terminal-failure`,
      payload: {},
      max_attempts: 3
    });
    const claimed = await postgresRuntimeRepository.claimJob(device, 30_000);
    expect(claimed?.id).toBe(terminalJobId);

    const failed = await postgresRuntimeRepository.failJob(
      terminalJobId,
      deviceId,
      "Qoder CLI 未登录",
      3_000,
      true
    );
    expect(failed.status).toBe("failed");
    expect(failed.attempts).toBe(1);

    const retried = await postgresRuntimeRepository.createJob({
      id: randomUUID(),
      user_id: userId,
      session_id: sessionId,
      job_type: "module_search",
      idempotency_key: `integration:${sessionId}:terminal-failure`,
      payload: { retry: true },
      max_attempts: 3
    });
    expect(retried.id).toBe(terminalJobId);
    expect(retried.status).toBe("pending");
    expect(retried.attempts).toBe(0);
    expect((await postgresRuntimeRepository.claimJob(device, 30_000))?.id).toBe(terminalJobId);
  });

  it("allows only one process to advance a workflow session at a time", async () => {
    let enterFirst!: () => void;
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enterFirst = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withWorkflowSessionLock(sessionId, async () => {
      await query("SELECT 1");
      enterFirst();
      await firstRelease;
      return "first";
    });
    await firstEntered;

    const competing = await withWorkflowSessionLock(sessionId, async () => "second");
    expect(competing).toEqual({ acquired: false });

    releaseFirst();
    await expect(first).resolves.toEqual({ acquired: true, value: "first" });
    await expect(withWorkflowSessionLock(sessionId, async () => "after-release"))
      .resolves.toEqual({ acquired: true, value: "after-release" });
  });

  it("rolls back a broken transition and persists a terminal workflow error afterward", async () => {
    const failingSessionId = `session-pg-workflow-failure-${randomUUID()}`;
    const state = createSessionFixture({ session_id: failingSessionId, owner_id: userId });
    state.agent_decisions = [createAgentDecision({
      action: "search_module",
      source: "plan_strategy",
      confidence: "high",
      reason: "integration test invalid decision",
      evidence: []
    })];
    await postgresRuntimeRepository.saveSession(state);

    await expect(advanceAgentWorkflow(failingSessionId, userId, {
      start: true,
      trigger: "user_start"
    })).rejects.toThrow("Agent 搜索决策缺少 module_id");

    const restored = await postgresRuntimeRepository.getSession(failingSessionId, userId);
    expect(restored?.agent_runtime.workflow_status).toBe("error");
    expect(restored?.agent_runtime.auto_continue).toBe(false);
    expect(restored?.agent_runtime.workflow_message).toContain("缺少 module_id");
    expect(restored?.agent_runtime.workflow_run_id).toBeUndefined();
    expect((await postgresRuntimeRepository.listEvents(failingSessionId, 0, userId))
      .some((event) =>
        event.event_type === "agent.workflow.updated" &&
        event.payload.workflow_status === "error"
      )).toBe(true);
  });

  it("serializes duplicate executor callbacks without overwriting the Session snapshot", async () => {
    const replaySessionId = `session-pg-result-replay-${randomUUID()}`;
    const replayDevice: ExecutorDevice = {
      ...device,
      id: randomUUID(),
      name: "PostgreSQL replay executor",
      token_hash: `token-${randomUUID()}`
    };
    await postgresRuntimeRepository.createDevice(replayDevice);

    const state = createSessionFixture({ session_id: replaySessionId, owner_id: userId });
    const module = state.shopping_plan.modules[0];
    const queued = await enqueueModuleSearchJob(state, {
      moduleId: module.module_id,
      moduleName: module.module_name,
      keyword: module.search_keyword ?? module.search_strategy?.primary_keyword ?? module.module_name
    });
    await postgresRuntimeRepository.saveSession(state);
    const claimed = await postgresRuntimeRepository.claimJob(replayDevice, 30_000);
    expect(claimed?.id).toBe(queued.id);

    const result = {
      summary: "并发回填测试完成",
      candidates: [{
        product_id: "pg-replay-product",
        title: "PostgreSQL 幂等候选商品",
        price: 129,
        source: "淘宝本地执行器测试",
        shop_name: "并发测试旗舰店",
        image_url: "https://example.com/product.jpg",
        detail_url: "https://item.taobao.com/item.htm?id=pg-replay-product",
        shop_badges: ["旗舰店"],
        highlights: ["幂等回填"],
        risk_notes: ["集成测试数据"],
        fit_reason: "用于验证并发结果不会覆盖 Session",
        recommendation_type: "稳妥推荐",
        module_id: module.module_id
      }]
    };

    const completions = await Promise.all([
      applyCompletedRuntimeJob(queued.id, replayDevice, result),
      applyCompletedRuntimeJob(queued.id, replayDevice, result)
    ]);
    const restored = await postgresRuntimeRepository.getSession(replaySessionId, userId);

    expect(completions.filter((item) => item.alreadyCompleted)).toHaveLength(1);
    expect(restored?.module_candidates[module.module_id]).toHaveLength(1);
    expect(restored?.hosted_tasks.find((task) => task.task_id === queued.id)?.status).toBe("completed");
    expect(restored?.tool_logs.filter((log) =>
      log.tool_name === "local_executor" && log.module_id === module.module_id
    )).toHaveLength(1);
  });

  it("recovers an orphaned completed job without re-executing the external tool", async () => {
    const recoverySessionId = `session-pg-cron-recovery-${randomUUID()}`;
    const recoveryDevice: ExecutorDevice = {
      ...device,
      id: randomUUID(),
      name: "PostgreSQL recovery executor",
      token_hash: `token-${randomUUID()}`
    };
    await postgresRuntimeRepository.createDevice(recoveryDevice);
    await postgresRuntimeRepository.saveSession(createSessionFixture({
      session_id: recoverySessionId,
      owner_id: userId
    }));

    const started = await advanceAgentWorkflow(recoverySessionId, userId, {
      start: true,
      trigger: "user_start"
    });
    expect(started.outcome).toBe("queued");
    const firstJob = await postgresRuntimeRepository.claimJob(recoveryDevice, 30_000);
    expect(firstJob?.session_id).toBe(recoverySessionId);
    const moduleId = String(firstJob!.payload.module_id);
    await postgresRuntimeRepository.completeJob(firstJob!.id, recoveryDevice.id, {
      summary: "PostgreSQL orphan recovery",
      candidates: [{
        product_id: "pg-recovery-product",
        title: "PostgreSQL 恢复候选",
        price: 88,
        source: "淘宝本地执行器测试",
        shop_name: "恢复测试旗舰店",
        image_url: "https://example.com/recovery.jpg",
        detail_url: "https://item.taobao.com/item.htm?id=pg-recovery-product",
        shop_badges: ["旗舰店"],
        highlights: ["恢复测试"],
        risk_notes: ["集成测试数据"],
        fit_reason: "用于验证服务端恢复",
        recommendation_type: "性价比推荐",
        module_id: moduleId
      }]
    });
    const interrupted = await postgresRuntimeRepository.getSession(recoverySessionId, userId);
    interrupted!.hosted_tasks = interrupted!.hosted_tasks.filter((task) => task.task_id !== firstJob!.id);
    await postgresRuntimeRepository.saveSession(interrupted!);

    const recovery = await recoverAgentWorkflows({ userId, limit: 25, maxRecoveries: 25 });
    const restored = await postgresRuntimeRepository.getSession(recoverySessionId, userId);
    const jobs = await postgresRuntimeRepository.listJobs(recoverySessionId, userId);

    expect(recovery.items.find((item) => item.session_id === recoverySessionId)).toMatchObject({
      recovered: true,
      reason: "completed_result"
    });
    expect(restored?.module_candidates[moduleId]).toHaveLength(1);
    expect(restored?.hosted_tasks.find((task) => task.task_id === firstJob!.id)?.status).toBe("completed");
    expect(jobs.filter((job) => job.id === firstJob!.id)).toHaveLength(1);
    expect(jobs.some((job) => job.status === "pending" && job.id !== firstJob!.id)).toBe(true);
  });

  it("finds an old recovery candidate beyond the general 100-session listing window", async () => {
    const candidateId = `session-pg-old-recovery-${randomUUID()}`;
    const candidate = createSessionFixture({ session_id: candidateId, owner_id: userId });
    candidate.agent_runtime.auto_continue = true;
    candidate.agent_runtime.workflow_status = "running";
    candidate.agent_runtime.last_transition_at = "2020-01-01T00:00:00.000Z";
    await postgresRuntimeRepository.saveSession(candidate);

    const fillerIds = Array.from({ length: 105 }, () => `session-pg-filler-${randomUUID()}`);
    await query(
      `INSERT INTO shopping_sessions(id, user_id, state)
       SELECT filler_id, $1, jsonb_set($2::jsonb, '{session_id}', to_jsonb(filler_id))
       FROM unnest($3::text[]) AS filler_id`,
      [
        userId,
        JSON.stringify(createSessionFixture({ session_id: "session-pg-filler-template", owner_id: userId })),
        fillerIds
      ]
    );

    const candidates = await postgresRuntimeRepository.listWorkflowRecoveryCandidates(userId, 1);
    expect(candidates.map((state) => state.session_id)).toEqual([candidateId]);
  });
});
