import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { localRuntimeRepository, resetLocalRuntimeForTests } from "@/lib/runtime/local-repository";
import { applyCompletedRuntimeJob, applyFailedRuntimeJob, enqueueModuleSearchJob, registerExecutorDevice } from "@/lib/runtime/jobs";
import { decideNextAgentAction } from "@/lib/agent/decision-engine";
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
    const first = await localRuntimeRepository.createJob(input);
    const duplicate = await localRuntimeRepository.createJob({ ...input, id: "job-duplicate" });
    expect(duplicate.id).toBe(first.id);

    const claimed = await localRuntimeRepository.claimJob(device, 30_000);
    expect(claimed?.status).toBe("leased");
    const running = await localRuntimeRepository.renewJobLease(first.id, device.id, 30_000);
    expect(running?.status).toBe("running");

    const completed = await localRuntimeRepository.completeJob(first.id, device.id, { results: [] });
    const replay = await localRuntimeRepository.completeJob(first.id, device.id, { results: [] });
    const duplicateAfterCompletion = await localRuntimeRepository.createJob({ ...input, id: "job-after-completion" });
    expect(completed.alreadyCompleted).toBe(false);
    expect(replay.alreadyCompleted).toBe(true);
    expect(duplicateAfterCompletion.id).toBe(first.id);
    expect(duplicateAfterCompletion.status).toBe("completed");
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

  it("returns an expired lease to the pending queue", async () => {
    await localRuntimeRepository.createDevice(device);
    await localRuntimeRepository.createJob({
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

  it("only cancels work before an executor has claimed it", async () => {
    await localRuntimeRepository.createDevice(device);
    const pending = await localRuntimeRepository.createJob({
      id: "job-cancellable",
      user_id: device.user_id,
      session_id: "session-test",
      job_type: "module_search",
      idempotency_key: "cancellable-job",
      payload: {}
    });
    expect((await localRuntimeRepository.cancelJob(pending.id, device.user_id))?.status).toBe("cancelled");

    await localRuntimeRepository.createJob({
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
    await localRuntimeRepository.createJob({
      id: "cart-higher-priority",
      user_id: device.user_id,
      session_id: "session-capability",
      job_type: "add_to_cart",
      idempotency_key: "capability-cart",
      payload: {},
      priority: 200
    });
    await localRuntimeRepository.createJob({
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

  it("writes an empty executor result to a terminal search trace so the Agent can continue", async () => {
    await localRuntimeRepository.createDevice(device);
    const sessionId = `session-runtime-${Date.now()}`;
    const state = createSessionFixture({ session_id: sessionId });
    const module = state.shopping_plan.modules[0];
    const job = await enqueueModuleSearchJob(state, {
      moduleId: module.module_id,
      moduleName: module.module_name,
      keyword: module.search_strategy!.primary_keyword
    });
    await localRuntimeRepository.saveSession(state);
    await localRuntimeRepository.claimJob(device, 30_000);

    const completion = await applyCompletedRuntimeJob(job.id, device, {
      summary: "搜索完成但没有合格候选",
      candidates: []
    });
    const replay = await applyCompletedRuntimeJob(job.id, device, {
      summary: "重复回执",
      candidates: []
    });
    const restored = await localRuntimeRepository.getSession(sessionId, device.user_id);

    expect(completion.alreadyCompleted).toBe(false);
    expect(replay.alreadyCompleted).toBe(true);
    expect(restored?.module_search_traces[module.module_id].status).toBe("failed");
    expect(decideNextAgentAction(restored!).action).toBe("skip_module");

    await fs.unlink(path.join(process.cwd(), ".data", "sessions", `${sessionId}.json`)).catch(() => undefined);
  });
});
