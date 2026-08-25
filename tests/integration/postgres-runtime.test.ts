import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAgentDecision } from "@/lib/agent/decision-engine";
import { addToCart } from "@/lib/agent/orchestrator";
import { advanceAgentWorkflow } from "@/lib/agent/workflow-runner";
import { recoverAgentWorkflows } from "@/lib/agent/workflow-recovery";
import { closeDatabasePoolForTests, query, withWorkflowSessionLock } from "@/lib/runtime/database";
import { applyCompletedRuntimeJob, enqueueModuleSearchJob } from "@/lib/runtime/jobs";
import { postgresRuntimeRepository } from "@/lib/runtime/postgres-repository";
import { runRuntimeRetention } from "@/lib/runtime/retention";
import type { ExecutorDevice, RuntimeUser } from "@/lib/runtime/types";
import { updateShoppingSessionLifecycle } from "@/lib/session/lifecycle";
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

  it("persists the latest runtime service heartbeat with upsert semantics", async () => {
    const first = await postgresRuntimeRepository.recordServiceHeartbeat({
      service_name: "workflow_recovery",
      status: "degraded",
      metadata: { failed: 1 },
      checked_at: new Date(Date.now() - 1_000).toISOString()
    });
    const latestTime = new Date().toISOString();
    const latest = await postgresRuntimeRepository.recordServiceHeartbeat({
      service_name: "workflow_recovery",
      status: "healthy",
      metadata: { failed: 0 },
      checked_at: latestTime
    });

    expect(first.service_name).toBe("workflow_recovery");
    expect(latest).toMatchObject({ status: "healthy", metadata: { failed: 0 } });
    expect((await postgresRuntimeRepository.getServiceHeartbeat("workflow_recovery"))?.checked_at)
      .toBe(latestTime);
  });

  it("removes expired authentication and security records through the retention job", async () => {
    const authSessionId = randomUUID();
    const tokenHash = `expired-token-${randomUUID()}`;
    const rateLimitKey = `expired-rate-${randomUUID()}`;
    const concurrencyKey = `expired-concurrency-${randomUUID()}`;
    await query("DELETE FROM runtime_service_heartbeats WHERE service_name = $1", ["runtime-retention"]);
    await query(
      `INSERT INTO auth_sessions(id, user_id, token_hash, expires_at, created_at, last_seen_at)
       VALUES($1, $2, $3, NOW() - INTERVAL '1 day', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days')`,
      [authSessionId, userId, tokenHash]
    );
    await query(
      `INSERT INTO security_rate_limits(key_hash, attempt_count, window_started_at, updated_at)
       VALUES($1, 1, NOW() - INTERVAL '10 days', NOW() - INTERVAL '10 days')`,
      [rateLimitKey]
    );
    await query(
      `INSERT INTO security_concurrency_leases(key_hash, lease_token, expires_at, updated_at)
       VALUES($1, $2, NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day')`,
      [concurrencyKey, randomUUID()]
    );

    const result = await runRuntimeRetention();
    expect(result.status).toBe("completed");
    expect(result.deleted).toMatchObject({
      auth_sessions: expect.any(Number),
      rate_limits: expect.any(Number),
      concurrency_leases: expect.any(Number)
    });
    const remaining = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM (
         SELECT token_hash AS key FROM auth_sessions WHERE token_hash = $1
         UNION ALL SELECT key_hash FROM security_rate_limits WHERE key_hash = $2
         UNION ALL SELECT key_hash FROM security_concurrency_leases WHERE key_hash = $3
       ) records`,
      [tokenHash, rateLimitKey, concurrencyKey]
    );
    expect(remaining.rows[0]?.count).toBe("0");
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

    const running = await postgresRuntimeRepository.renewJobLease(
      jobId,
      deviceId,
      claimed!.lease_token!,
      30_000
    );
    expect(running?.status).toBe("running");

    const completed = await postgresRuntimeRepository.completeJob(jobId, deviceId, { results: [] }, running!.lease_token!);
    const replay = await postgresRuntimeRepository.completeJob(jobId, deviceId, { results: [] }, running!.lease_token!);
    expect(completed.alreadyCompleted).toBe(false);
    expect(replay.alreadyCompleted).toBe(true);
    await expect(postgresRuntimeRepository.completeJob(jobId, randomUUID(), {}, running!.lease_token!))
      .rejects.toThrow("job lease owner mismatch");
    await expect(postgresRuntimeRepository.failJob(jobId, randomUUID(), "replay", running!.lease_token!))
      .rejects.toThrow("job lease owner mismatch");

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

  it("atomically rejects a stale heartbeat token after the same device reclaims a job", async () => {
    const leaseGenerationJobId = randomUUID();
    await postgresRuntimeRepository.createJob({
      id: leaseGenerationJobId,
      user_id: userId,
      session_id: sessionId,
      job_type: "module_search",
      idempotency_key: `integration:${sessionId}:heartbeat-lease-generation`,
      payload: {},
      max_attempts: 3
    });
    const oldLease = await postgresRuntimeRepository.claimJob(device, 30_000);
    expect(oldLease?.id).toBe(leaseGenerationJobId);
    await query(
      "UPDATE agent_jobs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
      [leaseGenerationJobId]
    );
    const currentLease = await postgresRuntimeRepository.claimJob(device, 30_000);
    expect(currentLease?.id).toBe(leaseGenerationJobId);
    expect(currentLease?.lease_token).not.toBe(oldLease?.lease_token);

    expect(await postgresRuntimeRepository.renewJobLease(
      leaseGenerationJobId,
      device.id,
      oldLease!.lease_token!,
      30_000
    )).toBeNull();
    expect(await postgresRuntimeRepository.renewJobLease(
      leaseGenerationJobId,
      device.id,
      currentLease!.lease_token!,
      30_000
    )).toMatchObject({ status: "running", lease_token: currentLease!.lease_token });
    await postgresRuntimeRepository.completeJob(
      leaseGenerationJobId,
      device.id,
      {},
      currentLease!.lease_token!
    );
  });

  it("claims unowned PostgreSQL jobs only outside production", async () => {
    const unownedJobId = randomUUID();
    await postgresRuntimeRepository.createJob({
      id: unownedJobId,
      session_id: `session-pg-unowned-${randomUUID()}`,
      job_type: "module_search",
      idempotency_key: `integration:${sessionId}:unowned-production-guard`,
      payload: {}
    });
    try {
      vi.stubEnv("NODE_ENV", "production");
      expect(await postgresRuntimeRepository.claimJob(device, 30_000)).toBeNull();

      vi.stubEnv("NODE_ENV", "test");
      const claimed = await postgresRuntimeRepository.claimJob(device, 30_000);
      expect(claimed?.id).toBe(unownedJobId);
      await postgresRuntimeRepository.completeJob(
        unownedJobId,
        device.id,
        {},
        claimed!.lease_token!
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("lets a module-search executor claim the read-only preferred-product detail job type", async () => {
    const detailSessionId = `session-pg-detail-capability-${randomUUID()}`;
    const detailDevice: ExecutorDevice = {
      ...device,
      id: randomUUID(),
      name: "PostgreSQL product detail executor",
      token_hash: `token-${randomUUID()}`,
      capabilities: ["module_search"]
    };
    await postgresRuntimeRepository.saveSession(createSessionFixture({
      session_id: detailSessionId,
      owner_id: userId
    }));
    await postgresRuntimeRepository.createDevice(detailDevice);
    const detailJob = await postgresRuntimeRepository.createJob({
      id: randomUUID(),
      user_id: userId,
      session_id: detailSessionId,
      job_type: "product_detail",
      idempotency_key: `integration:${detailSessionId}:product-detail`,
      payload: {
        product_id: "pg-detail-product",
        detail_url: "https://item.taobao.com/item.htm?id=pg-detail-product"
      }
    });

    const claimed = await postgresRuntimeRepository.claimJob(detailDevice, 30_000);
    expect(claimed).toMatchObject({
      id: detailJob.id,
      job_type: "product_detail"
    });
    await expect(postgresRuntimeRepository.completeJob(detailJob.id, detailDevice.id, {}, claimed!.lease_token!))
      .resolves.toMatchObject({ alreadyCompleted: false });
  });

  it("rejects the previous executor after an expired PostgreSQL lease is reassigned", async () => {
    const oldDevice: ExecutorDevice = {
      ...device,
      id: randomUUID(),
      name: "Expired lease owner",
      token_hash: `token-${randomUUID()}`
    };
    const replacementDevice: ExecutorDevice = {
      ...device,
      id: randomUUID(),
      name: "Replacement lease owner",
      token_hash: `token-${randomUUID()}`
    };
    await postgresRuntimeRepository.createDevice(oldDevice);
    await postgresRuntimeRepository.createDevice(replacementDevice);
    const reassignedJobId = randomUUID();
    await postgresRuntimeRepository.createJob({
      id: reassignedJobId,
      user_id: userId,
      session_id: sessionId,
      job_type: "module_search",
      idempotency_key: `integration:${sessionId}:lease-reassignment`,
      payload: {},
      max_attempts: 3
    });
    const originalLease = await postgresRuntimeRepository.claimJob(oldDevice, 30_000);
    expect(originalLease?.id).toBe(reassignedJobId);
    await query(
      "UPDATE agent_jobs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
      [reassignedJobId]
    );

    const replacementLease = await postgresRuntimeRepository.claimJob(replacementDevice, 30_000);
    expect(replacementLease?.id).toBe(reassignedJobId);
    expect(await postgresRuntimeRepository.renewJobLease(
      reassignedJobId,
      oldDevice.id,
      originalLease!.lease_token!,
      30_000
    )).toBeNull();
    await expect(postgresRuntimeRepository.completeJob(
      reassignedJobId,
      oldDevice.id,
      { results: [] },
      originalLease!.lease_token!
    ))
      .rejects.toThrow("job lease owner mismatch");
    await expect(postgresRuntimeRepository.completeJob(
      reassignedJobId,
      replacementDevice.id,
      { results: [] },
      replacementLease!.lease_token!
    ))
      .resolves.toMatchObject({ alreadyCompleted: false });
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

  it("prevents PostgreSQL workers from creating or claiming work for archived sessions", async () => {
    const archivedSessionId = `session-pg-archive-${randomUUID()}`;
    await postgresRuntimeRepository.saveSession(createSessionFixture({
      session_id: archivedSessionId,
      owner_id: userId
    }));
    const pendingJobId = randomUUID();
    await postgresRuntimeRepository.createJob({
      id: pendingJobId,
      user_id: userId,
      session_id: archivedSessionId,
      job_type: "module_search",
      idempotency_key: `integration:${archivedSessionId}:pending`,
      payload: {}
    });

    const archived = await updateShoppingSessionLifecycle(archivedSessionId, "archive", userId);
    expect(archived.state.archived_at).toBeTruthy();
    expect(archived.cancelled_pending_jobs).toBe(1);
    expect((await postgresRuntimeRepository.getJob(pendingJobId))?.status).toBe("cancelled");
    const blockedClaimId = randomUUID();
    await query(
      `INSERT INTO agent_jobs(id, user_id, session_id, job_type, idempotency_key, payload)
       VALUES($1, $2, $3, 'module_search', $4, '{}'::jsonb)`,
      [blockedClaimId, userId, archivedSessionId, `integration:${archivedSessionId}:claim-blocked`]
    );
    expect(await postgresRuntimeRepository.claimJob(device, 30_000)).toBeNull();
    expect((await postgresRuntimeRepository.getJob(blockedClaimId))?.status).toBe("pending");
    await query("UPDATE agent_jobs SET status = 'cancelled' WHERE id = $1", [blockedClaimId]);
    await expect(postgresRuntimeRepository.createJob({
      id: randomUUID(),
      user_id: userId,
      session_id: archivedSessionId,
      job_type: "module_search",
      idempotency_key: `integration:${archivedSessionId}:rejected`,
      payload: {}
    })).rejects.toThrow("session archived");

    const restored = await updateShoppingSessionLifecycle(archivedSessionId, "restore", userId);
    expect(restored.state.archived_at).toBeUndefined();
    expect(restored.state.agent_runtime.auto_continue).toBe(false);
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
      claimed!.lease_token!,
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
    const reclaimed = await postgresRuntimeRepository.claimJob(device, 30_000);
    expect(reclaimed?.id).toBe(terminalJobId);
    await expect(postgresRuntimeRepository.completeJob(
      terminalJobId,
      deviceId,
      { results: [] },
      reclaimed!.lease_token!
    ))
      .resolves.toMatchObject({ alreadyCompleted: false });
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
    state.agent_runtime.auto_continue = true;
    state.agent_runtime.workflow_status = "running";
    state.agent_decisions = [createAgentDecision({
      action: "search_module",
      source: "plan_strategy",
      confidence: "high",
      reason: "integration test invalid decision",
      evidence: []
    })];
    await postgresRuntimeRepository.saveSession(state);

    await expect(advanceAgentWorkflow(failingSessionId, userId, {
      trigger: "recovery"
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
        source: "淘宝",
        shop_name: "并发测试旗舰店",
        image_url: "https://example.com/product.jpg",
        detail_url: "https://item.taobao.com/item.htm?id=pg-replay-product",
        shop_badges: ["旗舰店"],
        highlights: ["幂等回填"],
        risk_notes: ["集成测试数据"],
        fit_reason: "用于验证并发结果不会覆盖 Session",
        recommendation_type: "稳妥推荐",
        module_id: module.module_id
      }],
      evidence: {
        schema: "scenecart.taobao-mcp-search-evidence/v1",
        source: "taobao-mcp",
        tool: "search_products",
        source_app: "SceneCartPostgresIntegration",
        job_id: queued.id,
        module_id: String(queued.payload.module_id ?? ""),
        workflow_run_id: String(queued.payload.workflow_run_id ?? ""),
        keyword: String(queued.payload.keyword ?? ""),
        captured_at: new Date().toISOString(),
        cache_hit: false,
        raw_result_count: 1
      }
    };

    const completions = await Promise.all([
      applyCompletedRuntimeJob(queued.id, replayDevice, result, claimed!.lease_token!),
      applyCompletedRuntimeJob(queued.id, replayDevice, result, claimed!.lease_token!)
    ]);
    const detailJobId = completions.find((item) => item.follow_up_job_id)?.follow_up_job_id;
    if (detailJobId) {
      await postgresRuntimeRepository.cancelJob(detailJobId, userId);
    }
    const restored = await postgresRuntimeRepository.getSession(replaySessionId, userId);

    expect(completions.filter((item) => item.alreadyCompleted)).toHaveLength(1);
    expect(restored?.module_candidates[module.module_id]).toHaveLength(1);
    expect(restored?.hosted_tasks.find((task) => task.task_id === queued.id)?.status).toBe("completed");
    expect(restored?.tool_logs.filter((log) =>
      log.tool_name === "local_executor" && log.module_id === module.module_id
    )).toHaveLength(1);
  });

  it("serializes concurrent cart requests without losing either queued product", async () => {
    const cartSessionId = `session-pg-cart-${randomUUID()}`;
    const state = createSessionFixture({ session_id: cartSessionId, owner_id: userId });
    const module = state.shopping_plan.modules[0];
    state.module_candidates[module.module_id] = [
      {
        product_id: "pg-cart-product-a",
        title: "PostgreSQL 并发加购商品 A",
        price: 89,
        source: "淘宝本地执行器测试",
        shop_name: "并发加购旗舰店",
        image_url: "https://example.com/cart-a.jpg",
        detail_url: "https://item.taobao.com/item.htm?id=pg-cart-product-a",
        shop_badges: ["旗舰店"],
        highlights: ["并发测试"],
        risk_notes: ["集成测试数据"],
        fit_reason: "用于验证并发加购不会覆盖任务。",
        recommendation_type: "稳妥推荐",
        module_id: module.module_id
      },
      {
        product_id: "pg-cart-product-b",
        title: "PostgreSQL 并发加购商品 B",
        price: 109,
        source: "淘宝本地执行器测试",
        shop_name: "并发加购旗舰店",
        image_url: "https://example.com/cart-b.jpg",
        detail_url: "https://item.taobao.com/item.htm?id=pg-cart-product-b",
        shop_badges: ["旗舰店"],
        highlights: ["并发测试"],
        risk_notes: ["集成测试数据"],
        fit_reason: "用于验证并发加购不会覆盖任务。",
        recommendation_type: "性价比推荐",
        module_id: module.module_id
      }
    ];
    await postgresRuntimeRepository.saveSession(state);

    await Promise.all([
      addToCart(cartSessionId, "pg-cart-product-a", userId),
      addToCart(cartSessionId, "pg-cart-product-b", userId)
    ]);

    const jobs = await postgresRuntimeRepository.listJobs(cartSessionId, userId);
    try {
      const restored = await postgresRuntimeRepository.getSession(cartSessionId, userId);
      const cartTasks = restored?.hosted_tasks.filter((task) => task.task_type === "add_to_cart") ?? [];
      expect(new Set(cartTasks.map((task) => task.product_id))).toEqual(
        new Set(["pg-cart-product-a", "pg-cart-product-b"])
      );
      expect(cartTasks.every((task) => task.status === "pending" && Boolean(task.runtime_job_id))).toBe(true);

      expect(new Set(jobs.filter((job) => job.job_type === "add_to_cart").map((job) => job.payload.product_id))).toEqual(
        new Set(["pg-cart-product-a", "pg-cart-product-b"])
      );
    } finally {
      await Promise.all(jobs.map((job) => postgresRuntimeRepository.cancelJob(job.id, userId)));
    }
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
    }, firstJob!.lease_token!);
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

  it("excludes sessions that are legitimately waiting on an active product detail job", async () => {
    const blockedId = `session-pg-detail-blocked-${randomUUID()}`;
    const blocked = createSessionFixture({ session_id: blockedId, owner_id: userId });
    blocked.agent_runtime.auto_continue = true;
    blocked.agent_runtime.workflow_status = "waiting_for_tools";
    blocked.agent_runtime.workflow_run_id = `workflow-pg-detail-${randomUUID()}`;
    blocked.agent_runtime.last_transition_at = "2018-01-01T00:00:00.000Z";
    const blockedModule = blocked.shopping_plan.modules[0];
    const blockedProductId = `pg-detail-blocked-${randomUUID()}`;
    const blockedDetailUrl = `https://item.taobao.com/item.htm?id=${blockedProductId}`;
    const blockedSearchJobId = randomUUID();
    const blockedDetailJobId = randomUUID();
    blocked.module_candidates[blockedModule.module_id] = [{
      product_id: blockedProductId,
      title: "PostgreSQL active detail candidate",
      price: 99,
      source: "淘宝",
      shop_name: "详情恢复测试店",
      image_url: "https://img.alicdn.com/item.jpg",
      detail_url: blockedDetailUrl,
      shop_badges: [],
      highlights: [],
      risk_notes: [],
      fit_reason: "恢复过滤测试",
      recommendation_type: "稳妥推荐",
      module_id: blockedModule.module_id
    }];
    blocked.hosted_tasks.unshift({
      task_id: blockedSearchJobId,
      runtime_job_id: blockedSearchJobId,
      executor: "local_executor",
      task_type: "module_search",
      session_id: blocked.session_id,
      status: "completed",
      title: "PostgreSQL active detail search",
      description: "恢复过滤必须绑定当前搜索来源。",
      module_id: blockedModule.module_id,
      module_name: blockedModule.module_name,
      created_at: now,
      updated_at: now,
      payload: {
        workflow_run_id: blocked.agent_runtime.workflow_run_id,
        preferred_product_detail_job_id: blockedDetailJobId,
        preferred_product_id: blockedProductId
      }
    });
    await postgresRuntimeRepository.saveSession(blocked);
    await postgresRuntimeRepository.createJob({
      id: blockedDetailJobId,
      user_id: userId,
      session_id: blockedId,
      job_type: "product_detail",
      idempotency_key: `detail-recovery-blocked:${blockedId}`,
      payload: {
        search_job_id: blockedSearchJobId,
        workflow_run_id: blocked.agent_runtime.workflow_run_id,
        module_id: blockedModule.module_id,
        product_id: blockedProductId,
        detail_url: blockedDetailUrl
      }
    });

    const staleId = `session-pg-stale-detail-${randomUUID()}`;
    const stale = createSessionFixture({ session_id: staleId, owner_id: userId });
    stale.agent_runtime.auto_continue = true;
    stale.agent_runtime.workflow_status = "waiting_for_tools";
    stale.agent_runtime.workflow_run_id = blocked.agent_runtime.workflow_run_id;
    stale.agent_runtime.last_transition_at = "2018-06-01T00:00:00.000Z";
    const staleModule = stale.shopping_plan.modules[0];
    const sameProductId = `pg-same-product-${randomUUID()}`;
    const sameDetailUrl = `https://item.taobao.com/item.htm?id=${sameProductId}`;
    const currentSearchJobId = randomUUID();
    const currentDetailJobId = randomUUID();
    const staleSearchJobId = randomUUID();
    const staleDetailJobId = randomUUID();
    stale.module_candidates[staleModule.module_id] = [{
      product_id: sameProductId,
      title: "PostgreSQL same product after re-search",
      price: 99,
      source: "淘宝",
      shop_name: "详情恢复测试店",
      image_url: "https://img.alicdn.com/item.jpg",
      detail_url: sameDetailUrl,
      shop_badges: [],
      highlights: [],
      risk_notes: [],
      fit_reason: "同商品链接必须使用最新搜索来源",
      recommendation_type: "稳妥推荐",
      module_id: staleModule.module_id
    }];
    stale.hosted_tasks.unshift({
      task_id: currentSearchJobId,
      runtime_job_id: currentSearchJobId,
      executor: "local_executor",
      task_type: "module_search",
      session_id: stale.session_id,
      status: "completed",
      title: "PostgreSQL latest same-product search",
      description: "旧详情任务不可阻塞恢复。",
      module_id: staleModule.module_id,
      module_name: staleModule.module_name,
      created_at: now,
      updated_at: now,
      payload: {
        workflow_run_id: stale.agent_runtime.workflow_run_id,
        preferred_product_detail_job_id: currentDetailJobId,
        preferred_product_id: sameProductId
      }
    });
    await postgresRuntimeRepository.saveSession(stale);
    await postgresRuntimeRepository.createJob({
      id: staleDetailJobId,
      user_id: userId,
      session_id: staleId,
      job_type: "product_detail",
      idempotency_key: `stale-same-product-detail:${staleId}`,
      payload: {
        search_job_id: staleSearchJobId,
        workflow_run_id: stale.agent_runtime.workflow_run_id,
        module_id: staleModule.module_id,
        product_id: sameProductId,
        detail_url: sameDetailUrl
      }
    });

    const candidateId = `session-pg-recovery-after-detail-${randomUUID()}`;
    const candidate = createSessionFixture({ session_id: candidateId, owner_id: userId });
    candidate.agent_runtime.auto_continue = true;
    candidate.agent_runtime.workflow_status = "running";
    candidate.agent_runtime.last_transition_at = "2019-01-01T00:00:00.000Z";
    await postgresRuntimeRepository.saveSession(candidate);

    const recoveryIds = (await postgresRuntimeRepository.listWorkflowRecoveryCandidates(userId, 100))
      .map((state) => state.session_id);
    expect(recoveryIds).not.toContain(blockedId);
    expect(recoveryIds).toContain(staleId);
    expect(recoveryIds).toContain(candidateId);
  });
});
