import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRouteError } from "@/lib/api/responses";
import { NextRequest } from "next/server";
import { POST as claimJob } from "@/app/api/executor/jobs/claim/route";
import { POST as heartbeat } from "@/app/api/executor/heartbeat/route";
import { POST as resolveJob } from "@/app/api/executor/jobs/[jobId]/resolve/route";
import { POST as establishStartupStandby } from "@/app/api/executor/startup/route";
import {
  assertPreviousProtocolInFlightJob,
  assertExecutorProtocol,
  EXECUTOR_PROTOCOL_HEADER,
  EXECUTOR_PROTOCOL_VERSION,
  isPreviousExecutorProtocolDrain
} from "@/lib/runtime/executor-protocol";
import type { RuntimeJob } from "@/lib/runtime/types";
import { localRuntimeRepository, resetLocalRuntimeForTests } from "@/lib/runtime/local-repository";
import { registerExecutorDevice } from "@/lib/runtime/jobs";

const originalProductMode = process.env.SCENECART_PRODUCT_MODE;

function job(overrides: Partial<RuntimeJob> = {}): RuntimeJob {
  return {
    id: "job-protocol-drain",
    session_id: "session-protocol-drain",
    job_type: "module_search",
    idempotency_key: "protocol-drain",
    payload: {},
    status: "leased",
    priority: 100,
    attempts: 1,
    max_attempts: 3,
    available_at: new Date().toISOString(),
    lease_owner_id: "device-protocol-drain",
    lease_protocol: "4",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides
  };
}

describe("executor protocol", () => {
  beforeEach(() => {
    resetLocalRuntimeForTests();
    vi.stubEnv("NODE_ENV", "test");
    process.env.SCENECART_PRODUCT_MODE = "development";
    process.env.SCENECART_EXECUTOR_V4_DRAIN_UNTIL = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  });

  afterEach(() => {
    delete process.env.SCENECART_EXECUTOR_V4_DRAIN_UNTIL;
    if (originalProductMode === undefined) delete process.env.SCENECART_PRODUCT_MODE;
    else process.env.SCENECART_PRODUCT_MODE = originalProductMode;
    vi.unstubAllEnvs();
  });

  it("accepts the current protocol version", () => {
    expect(EXECUTOR_PROTOCOL_VERSION).toBe("5");
    const request = new Request("http://localhost/api/executor/heartbeat", {
      headers: { [EXECUTOR_PROTOCOL_HEADER]: EXECUTOR_PROTOCOL_VERSION }
    });
    expect(() => assertExecutorProtocol(request)).not.toThrow();
  });

  it.each([undefined, "0", "1", "2", "3", "4"])("rejects a missing or outdated protocol with 426: %s", (version) => {
    const headers = version ? { [EXECUTOR_PROTOCOL_HEADER]: version } : undefined;
    const request = new Request("http://localhost/api/executor/heartbeat", { headers });

    expect(() => assertExecutorProtocol(request)).toThrowError(ApiRouteError);
    try {
      assertExecutorProtocol(request);
    } catch (error) {
      expect(error).toMatchObject({ status: 426, code: "executor_protocol_mismatch" });
    }
  });

  it.each([
    ["claim", claimJob, "http://localhost/api/executor/jobs/claim"],
    ["heartbeat", heartbeat, "http://localhost/api/executor/heartbeat"],
    ["startup standby", establishStartupStandby, "http://localhost/api/executor/startup"]
  ])("rejects a v4 Worker at the %s route before it can receive work", async (_name, handler, url) => {
    const oldWorkerResponse = await handler(new NextRequest(url, {
      method: "POST",
      headers: { [EXECUTOR_PROTOCOL_HEADER]: "4" }
    }));
    expect(oldWorkerResponse.status).toBe(426);
    await expect(oldWorkerResponse.json()).resolves.toMatchObject({
      code: "executor_protocol_mismatch"
    });

    const currentWorkerResponse = await handler(new NextRequest(url, {
      method: "POST",
      headers: { [EXECUTOR_PROTOCOL_HEADER]: EXECUTOR_PROTOCOL_VERSION }
    }));
    expect(currentWorkerResponse.status).not.toBe(426);
  });

  it("grandfathers only exact in-flight v4 work while keeping v4 claims closed", () => {
    const request = new Request("http://localhost/api/executor/heartbeat", {
      headers: { [EXECUTOR_PROTOCOL_HEADER]: "4" }
    });
    expect(isPreviousExecutorProtocolDrain(request)).toBe(true);
    expect(() => assertPreviousProtocolInFlightJob(job(), "device-protocol-drain")).not.toThrow();
    expect(() => assertPreviousProtocolInFlightJob(
      job({ job_type: "add_to_cart", status: "running" }),
      "device-protocol-drain"
    )).not.toThrow();
    expect(() => assertPreviousProtocolInFlightJob(
      job({ job_type: "product_detail", status: "running" }),
      "device-protocol-drain"
    )).not.toThrow();
    expect(() => assertPreviousProtocolInFlightJob(
      job({ status: "completed" }),
      "device-protocol-drain",
      { allowTerminalReplay: true }
    )).not.toThrow();

    expect(() => assertPreviousProtocolInFlightJob(
      job({ status: "pending" }),
      "device-protocol-drain"
    )).toThrowError(ApiRouteError);
    expect(() => assertPreviousProtocolInFlightJob(
      job({ lease_protocol: "5" }),
      "device-protocol-drain"
    )).toThrowError(ApiRouteError);
    expect(() => assertPreviousProtocolInFlightJob(job(), "another-device"))
      .toThrowError(ApiRouteError);
  });

  it("lets an authenticated v4 Worker renew only its already leased legacy job", async () => {
    const registration = await registerExecutorDevice(
      "user-protocol-drain",
      "protocol drain worker",
      ["module_search"]
    );
    const activeDevice = await localRuntimeRepository.heartbeatDevice(registration.device.id, "online");
    await localRuntimeRepository.createJob({
      id: "job-v4-in-flight",
      user_id: registration.device.user_id,
      session_id: "session-v4-in-flight",
      job_type: "module_search",
      idempotency_key: "v4-in-flight",
      payload: {}
    });
    const leased = await localRuntimeRepository.claimJob(activeDevice!, 30_000, "4");

    const response = await heartbeat(new NextRequest("http://localhost/api/executor/heartbeat", {
      method: "POST",
      headers: {
        authorization: `Bearer ${registration.token}`,
        "content-type": "application/json",
        [EXECUTOR_PROTOCOL_HEADER]: "4"
      },
      body: JSON.stringify({
        executor_state: "online",
        current_job_id: leased!.id
      })
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      protocol_version: "4",
      lease_renewed: true
    });
  });

  it("lets a strictly bound v4 Worker resolve its legacy job without a lease token in the payload", async () => {
    const registration = await registerExecutorDevice(
      "user-v4-legacy-result",
      "legacy result worker",
      ["module_search"]
    );
    const activeDevice = await localRuntimeRepository.heartbeatDevice(registration.device.id, "online");
    await localRuntimeRepository.createJob({
      id: "job-v4-legacy-result",
      user_id: registration.device.user_id,
      session_id: "session-v4-legacy-result",
      job_type: "module_search",
      idempotency_key: "v4-legacy-result",
      payload: {}
    });
    const leased = await localRuntimeRepository.claimJob(activeDevice!, 30_000, "4");

    const response = await resolveJob(new NextRequest(
      `http://localhost/api/executor/jobs/${leased!.id}/resolve`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${registration.token}`,
          "content-type": "application/json",
          [EXECUTOR_PROTOCOL_HEADER]: "4"
        },
        body: JSON.stringify({
          status: "failed",
          error: "legacy worker failure payload",
          retryable: false
        })
      }
    ), { params: Promise.resolve({ jobId: leased!.id }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      protocol_version: "4",
      job: { id: leased!.id, status: "failed" }
    });
  });

  it("requires the exact v5 lease token for heartbeat renewal", async () => {
    const registration = await registerExecutorDevice(
      "user-v5-heartbeat-token",
      "v5 heartbeat worker",
      ["module_search"]
    );
    const activeDevice = await localRuntimeRepository.heartbeatDevice(registration.device.id, "online");
    await localRuntimeRepository.createJob({
      id: "job-v5-heartbeat-token",
      user_id: registration.device.user_id,
      session_id: "session-v5-heartbeat-token",
      job_type: "module_search",
      idempotency_key: "v5-heartbeat-token",
      payload: {}
    });
    const leased = await localRuntimeRepository.claimJob(
      activeDevice!,
      30_000,
      EXECUTOR_PROTOCOL_VERSION
    );
    const request = (leaseToken?: string) => heartbeat(new NextRequest(
      "http://localhost/api/executor/heartbeat",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${registration.token}`,
          "content-type": "application/json",
          [EXECUTOR_PROTOCOL_HEADER]: EXECUTOR_PROTOCOL_VERSION
        },
        body: JSON.stringify({
          executor_state: "online",
          current_job_id: leased!.id,
          ...(leaseToken === undefined ? {} : { lease_token: leaseToken })
        })
      }
    ));

    const missing = await request();
    expect(missing.status).toBe(409);
    await expect(missing.json()).resolves.toMatchObject({ code: "job_lease_token_required" });

    const stale = await request("stale-lease-token");
    expect(stale.status).toBe(200);
    await expect(stale.json()).resolves.toMatchObject({ lease_renewed: false });
    expect((await localRuntimeRepository.getJob(leased!.id))?.status).toBe("leased");

    const current = await request(leased!.lease_token);
    expect(current.status).toBe(200);
    await expect(current.json()).resolves.toMatchObject({ lease_renewed: true });
    expect((await localRuntimeRepository.getJob(leased!.id))?.status).toBe("running");
  });

  it("closes the v4 drain when its explicit short deadline is absent, expired, or too far away", () => {
    const request = new Request("http://localhost/api/executor/heartbeat", {
      headers: { [EXECUTOR_PROTOCOL_HEADER]: "4" }
    });
    delete process.env.SCENECART_EXECUTOR_V4_DRAIN_UNTIL;
    expect(isPreviousExecutorProtocolDrain(request)).toBe(false);
    process.env.SCENECART_EXECUTOR_V4_DRAIN_UNTIL = new Date(Date.now() - 1_000).toISOString();
    expect(isPreviousExecutorProtocolDrain(request)).toBe(false);
    process.env.SCENECART_EXECUTOR_V4_DRAIN_UNTIL = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    expect(isPreviousExecutorProtocolDrain(request)).toBe(false);
  });

  it("does not expose a completed result through another authenticated device", async () => {
    const owner = await registerExecutorDevice("user-result-owner", "owner worker", ["module_search"]);
    const intruder = await registerExecutorDevice("user-result-intruder", "intruder worker", ["module_search"]);
    const activeOwner = await localRuntimeRepository.heartbeatDevice(owner.device.id, "online");
    await localRuntimeRepository.createJob({
      id: "job-completed-result-route-auth",
      user_id: owner.device.user_id,
      session_id: "session-completed-result-route-auth",
      job_type: "module_search",
      idempotency_key: "completed-result-route-auth",
      payload: {}
    });
    const leased = await localRuntimeRepository.claimJob(activeOwner!, 30_000);
    await localRuntimeRepository.completeJob(leased!.id, owner.device.id, {
      private_result: "must-not-leak"
    }, leased!.lease_token!);

    const response = await resolveJob(new NextRequest(
      `http://localhost/api/executor/jobs/${leased!.id}/resolve`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${intruder.token}`,
          "content-type": "application/json",
          [EXECUTOR_PROTOCOL_HEADER]: EXECUTOR_PROTOCOL_VERSION
        },
        body: JSON.stringify({ result: {} })
      }
    ), { params: Promise.resolve({ jobId: leased!.id }) });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toMatchObject({ code: "job_not_found" });
    expect(JSON.stringify(body)).not.toContain("must-not-leak");
  });

  it("lets the claiming device resolve an unowned local-development job", async () => {
    const owner = await registerExecutorDevice("user-local-development", "local worker", ["module_search"]);
    const activeOwner = await localRuntimeRepository.heartbeatDevice(owner.device.id, "online");
    await localRuntimeRepository.createJob({
      id: "job-unowned-local-development",
      session_id: "session-unowned-local-development",
      job_type: "module_search",
      idempotency_key: "unowned-local-development",
      payload: {}
    });
    const leased = await localRuntimeRepository.claimJob(
      activeOwner!,
      30_000,
      EXECUTOR_PROTOCOL_VERSION
    );

    const response = await resolveJob(new NextRequest(
      `http://localhost/api/executor/jobs/${leased!.id}/resolve`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${owner.token}`,
          "content-type": "application/json",
          [EXECUTOR_PROTOCOL_HEADER]: EXECUTOR_PROTOCOL_VERSION
        },
        body: JSON.stringify({
          status: "failed",
          error: "synthetic local failure",
          retryable: false,
          lease_token: leased!.lease_token
        })
      }
    ), { params: Promise.resolve({ jobId: leased!.id }) });

    expect(response.status).toBe(200);
    expect((await localRuntimeRepository.getJob(leased!.id))?.status).toBe("failed");
  });

  it("does not claim or resolve an unowned job in production", async () => {
    const owner = await registerExecutorDevice("user-formal-owned-only", "formal worker", ["module_search"]);
    const activeOwner = await localRuntimeRepository.heartbeatDevice(owner.device.id, "online");
    await localRuntimeRepository.createJob({
      id: "job-unowned-formal-product",
      session_id: "session-unowned-formal-product",
      job_type: "module_search",
      idempotency_key: "unowned-formal-product",
      payload: {}
    });

    vi.stubEnv("NODE_ENV", "production");
    expect(await localRuntimeRepository.claimJob(
      activeOwner!,
      30_000,
      EXECUTOR_PROTOCOL_VERSION
    )).toBeNull();

    vi.stubEnv("NODE_ENV", "test");
    const leased = await localRuntimeRepository.claimJob(
      activeOwner!,
      30_000,
      EXECUTOR_PROTOCOL_VERSION
    );
    vi.stubEnv("NODE_ENV", "production");
    const response = await resolveJob(new NextRequest(
      `http://localhost/api/executor/jobs/${leased!.id}/resolve`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${owner.token}`,
          "content-type": "application/json",
          [EXECUTOR_PROTOCOL_HEADER]: EXECUTOR_PROTOCOL_VERSION
        },
        body: JSON.stringify({
          status: "failed",
          error: "must not resolve in production",
          retryable: false,
          lease_token: leased!.lease_token
        })
      }
    ), { params: Promise.resolve({ jobId: leased!.id }) });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "job_not_found" });
    expect((await localRuntimeRepository.getJob(leased!.id))?.status).toBe("leased");
  });

  it("rejects a result callback that omits the exact lease token", async () => {
    const owner = await registerExecutorDevice("user-missing-lease-token", "owner worker", ["module_search"]);
    const activeOwner = await localRuntimeRepository.heartbeatDevice(owner.device.id, "online");
    await localRuntimeRepository.createJob({
      id: "job-missing-lease-token",
      user_id: owner.device.user_id,
      session_id: "session-missing-lease-token",
      job_type: "module_search",
      idempotency_key: "missing-lease-token",
      payload: {}
    });
    const leased = await localRuntimeRepository.claimJob(activeOwner!, 30_000, EXECUTOR_PROTOCOL_VERSION);
    const response = await resolveJob(new NextRequest(
      `http://localhost/api/executor/jobs/${leased!.id}/resolve`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${owner.token}`,
          "content-type": "application/json",
          [EXECUTOR_PROTOCOL_HEADER]: EXECUTOR_PROTOCOL_VERSION
        },
        body: JSON.stringify({ status: "completed", result: {} })
      }
    ), { params: Promise.resolve({ jobId: leased!.id }) });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "job_lease_token_required" });
    expect((await localRuntimeRepository.getJob(leased!.id))?.status).toBe("leased");
  });
});
