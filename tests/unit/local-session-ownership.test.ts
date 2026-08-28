import { beforeEach, describe, expect, it } from "vitest";
import {
  canAccessSession,
  localRuntimeRepository,
  resetLocalRuntimeForTests
} from "@/lib/runtime/local-repository";
import { createSessionFixture } from "@/tests/fixtures/session";

describe("local session ownership", () => {
  beforeEach(() => resetLocalRuntimeForTests());

  it("requires exact ownership whenever the request is authenticated", () => {
    const owned = createSessionFixture({ owner_id: "user-a" });
    const legacyAnonymous = createSessionFixture({ owner_id: undefined });

    expect(canAccessSession(owned, "user-a")).toBe(true);
    expect(canAccessSession(owned, "user-b")).toBe(false);
    expect(canAccessSession(legacyAnonymous, "user-a")).toBe(false);
  });

  it("keeps legacy anonymous sessions available in explicit anonymous development", () => {
    const legacyAnonymous = createSessionFixture({ owner_id: undefined });
    expect(canAccessSession(legacyAnonymous)).toBe(true);
  });

  it("keeps a persisted session owner immutable", async () => {
    const owned = createSessionFixture({ session_id: "immutable-owner", owner_id: "user-a" });
    await localRuntimeRepository.saveSession(owned);

    await expect(localRuntimeRepository.saveSession({
      ...owned,
      owner_id: "user-b"
    })).rejects.toThrow("session owner mismatch");
    await expect(localRuntimeRepository.getSession(owned.session_id, "user-a"))
      .resolves.toMatchObject({ owner_id: "user-a" });
  });

  it("only creates and cancels jobs for the exact session owner", async () => {
    const owned = createSessionFixture({ session_id: "owned-job-session", owner_id: "user-a" });
    await localRuntimeRepository.saveSession(owned);

    await expect(localRuntimeRepository.createJob({
      id: "wrong-owner-job",
      user_id: "user-b",
      session_id: owned.session_id,
      job_type: "module_search",
      idempotency_key: "wrong-owner-job-key",
      payload: {}
    })).rejects.toThrow("job owner mismatch");

    const anonymousJob = await localRuntimeRepository.createJob({
      id: "anonymous-job",
      user_id: undefined,
      session_id: "anonymous-session",
      job_type: "module_search",
      idempotency_key: "anonymous-job-key",
      payload: {}
    }).catch(() => null);
    expect(anonymousJob).toBeNull();

    const job = await localRuntimeRepository.createJob({
      id: "owned-job",
      user_id: "user-a",
      session_id: owned.session_id,
      job_type: "module_search",
      idempotency_key: "owned-job-key",
      payload: {}
    });
    expect(await localRuntimeRepository.cancelJob(job.id, "user-b")).toBeNull();
    await expect(localRuntimeRepository.cancelJob(job.id, "user-a"))
      .resolves.toMatchObject({ status: "cancelled", user_id: "user-a" });
  });
});
