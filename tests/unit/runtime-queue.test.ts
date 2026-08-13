import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { localRuntimeRepository, resetLocalRuntimeForTests } from "@/lib/runtime/local-repository";
import {
  applyCompletedRuntimeJob,
  applyFailedRuntimeJob,
  authenticateExecutorToken,
  enqueueAddToCartJob,
  enqueueModuleSearchJob,
  reconcileAuthenticationFailureHoldsForDevice,
  reconcileCompletedRuntimeJob,
  releaseAuthenticationFailureHoldForUser,
  registerExecutorDevice
} from "@/lib/runtime/jobs";
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

function liveTaobaoSearchResult(input: {
  jobId: string;
  moduleId: string;
  workflowRunId: string;
  keyword: string;
  capturedAt?: string;
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
      highlights: ["来自淘宝实时搜索"],
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
      raw_result_count: 48
    }
  };
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

  it("keeps queued jobs untouched while the responsive worker is waiting for Taobao MCP", async () => {
    await localRuntimeRepository.createDevice(device);
    const pending = await localRuntimeRepository.createJob({
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

    await applyCompletedRuntimeJob(job.id, device, liveTaobaoSearchResult({
      jobId: job.id,
      moduleId: module.module_id,
      workflowRunId: "workflow-live-evidence",
      keyword
    }));

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
    const events = await localRuntimeRepository.listEvents(sessionId, 0, device.user_id);
    expect(events.find((event) => event.event_type === "job.completed")?.payload.evidence).toMatchObject({
      job_id: job.id,
      source: "taobao-mcp",
      raw_result_count: 48
    });

    await fs.unlink(path.join(process.cwd(), ".data", "sessions", `${sessionId}.json`)).catch(() => undefined);
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
    await localRuntimeRepository.createJob({
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

      await expect(localRuntimeRepository.createJob({
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
      const revived = await localRuntimeRepository.createJob({
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
    const job = await localRuntimeRepository.createJob({
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
    const job = await localRuntimeRepository.createJob({
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
    const job = await localRuntimeRepository.createJob({
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
    const job = await localRuntimeRepository.createJob({
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
    const job = await localRuntimeRepository.createJob(input);
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

    const revived = await localRuntimeRepository.createJob(input);
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
    const job = await localRuntimeRepository.createJob(input);
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

    await localRuntimeRepository.createJob(input);
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
      await localRuntimeRepository.createJob({
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

  it("rejects a stale executor after an expired lease is reassigned", async () => {
    const replacementDevice = {
      ...device,
      id: "device-replacement",
      token_hash: "replacement-digest"
    };
    await localRuntimeRepository.createDevice(device);
    await localRuntimeRepository.createDevice(replacementDevice);
    await localRuntimeRepository.createJob({
      id: "job-reassigned",
      user_id: device.user_id,
      session_id: "session-test",
      job_type: "module_search",
      idempotency_key: "reassigned-job",
      payload: {},
      max_attempts: 3
    });

    await localRuntimeRepository.claimJob(device, 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const reassigned = await localRuntimeRepository.claimJob(replacementDevice, 30_000);

    expect(reassigned?.id).toBe("job-reassigned");
    expect(await localRuntimeRepository.renewJobLease("job-reassigned", device.id, 30_000)).toBeNull();
    await expect(localRuntimeRepository.completeJob("job-reassigned", device.id, { results: [] }))
      .rejects.toThrow("job lease owner mismatch");
    await expect(localRuntimeRepository.completeJob("job-reassigned", replacementDevice.id, { results: [] }))
      .resolves.toMatchObject({ alreadyCompleted: false });
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
    await localRuntimeRepository.claimJob(device, 30_000);
    await localRuntimeRepository.completeJob(job.id, device.id, {
      summary: "协议升级前已经完成的空搜索",
      candidates: []
    });

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
