import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabasePoolForTests, query } from "@/lib/runtime/database";
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
    expect(await postgresRuntimeRepository.claimJob(device, 30_000)).toBeNull();
  });
});
