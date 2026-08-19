import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authRepository, queryMock } = vi.hoisted(() => ({
  authRepository: {
    findAuthSession: vi.fn(),
    findUserById: vi.fn(),
    touchAuthSession: vi.fn()
  },
  queryMock: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] })
}));

vi.mock("@/lib/runtime", () => ({
  getRuntimeRepository: () => authRepository
}));

vi.mock("@/lib/runtime/database", () => ({
  query: queryMock,
  withTransaction: vi.fn()
}));

import {
  AUTH_SESSION_TOUCH_INTERVAL_MS,
  authenticateToken
} from "@/lib/auth/service";
import { hashOpaqueToken } from "@/lib/auth/crypto";
import {
  localRuntimeRepository,
  resetLocalRuntimeForTests
} from "@/lib/runtime/local-repository";
import { postgresRuntimeRepository } from "@/lib/runtime/postgres-repository";
import type { AuthSessionRecord, RuntimeUser } from "@/lib/runtime/types";

const NOW = new Date("2026-08-19T08:00:00.000Z");
const TOKEN = "session-token-for-touch-tests";
const TOKEN_HASH = hashOpaqueToken(TOKEN);
const USER: RuntimeUser = {
  id: "user-auth-touch",
  email: "touch@example.com",
  password_hash: "unused",
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString()
};

function session(lastSeenAt: string): AuthSessionRecord {
  return {
    id: "session-auth-touch",
    user_id: USER.id,
    token_hash: TOKEN_HASH,
    expires_at: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
    created_at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
    last_seen_at: lastSeenAt
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  authRepository.findAuthSession.mockReset();
  authRepository.findUserById.mockReset();
  authRepository.touchAuthSession.mockReset().mockResolvedValue(undefined);
  queryMock.mockClear();
  resetLocalRuntimeForTests();
});

afterEach(() => {
  resetLocalRuntimeForTests();
  vi.useRealTimers();
});

describe("authentication session touch throttling", () => {
  it("does not persist last_seen_at again inside the ten-minute window", async () => {
    const current = session(new Date(NOW.getTime() - 5 * 60 * 1000).toISOString());
    authRepository.findAuthSession.mockResolvedValue(current);
    authRepository.findUserById.mockResolvedValue(USER);

    await expect(authenticateToken(TOKEN)).resolves.toEqual({ user: USER, session: current });
    expect(authRepository.touchAuthSession).not.toHaveBeenCalled();
  });

  it("persists stale sessions at the boundary and passes the repository guard window", async () => {
    authRepository.findAuthSession.mockResolvedValue(
      session(new Date(NOW.getTime() - AUTH_SESSION_TOUCH_INTERVAL_MS).toISOString())
    );
    authRepository.findUserById.mockResolvedValue(USER);

    await expect(authenticateToken(TOKEN)).resolves.not.toBeNull();
    expect(authRepository.touchAuthSession).toHaveBeenCalledWith(
      TOKEN_HASH,
      AUTH_SESSION_TOUCH_INTERVAL_MS
    );
  });

  it("does not touch a revoked, expired, or orphaned session", async () => {
    authRepository.findAuthSession.mockResolvedValueOnce(null);
    await expect(authenticateToken(TOKEN)).resolves.toBeNull();
    expect(authRepository.findUserById).not.toHaveBeenCalled();

    authRepository.findAuthSession.mockResolvedValueOnce(session(NOW.toISOString()));
    authRepository.findUserById.mockResolvedValueOnce(null);
    await expect(authenticateToken(TOKEN)).resolves.toBeNull();
    expect(authRepository.touchAuthSession).not.toHaveBeenCalled();
  });

  it("keeps the local repository on the same throttle contract", async () => {
    const recent = session(new Date(NOW.getTime() - 5 * 60 * 1000).toISOString());
    await localRuntimeRepository.createAuthSession(recent);

    await localRuntimeRepository.touchAuthSession(TOKEN_HASH, AUTH_SESSION_TOUCH_INTERVAL_MS);
    expect((await localRuntimeRepository.findAuthSession(TOKEN_HASH))?.last_seen_at)
      .toBe(recent.last_seen_at);

    vi.setSystemTime(new Date(NOW.getTime() + 6 * 60 * 1000));
    await localRuntimeRepository.touchAuthSession(TOKEN_HASH, AUTH_SESSION_TOUCH_INTERVAL_MS);
    expect((await localRuntimeRepository.findAuthSession(TOKEN_HASH))?.last_seen_at)
      .toBe(new Date(NOW.getTime() + 6 * 60 * 1000).toISOString());
  });

  it("uses an atomic PostgreSQL condition so concurrent instances cannot refresh twice", async () => {
    await postgresRuntimeRepository.touchAuthSession(TOKEN_HASH, AUTH_SESSION_TOUCH_INTERVAL_MS);

    expect(queryMock).toHaveBeenCalledOnce();
    const [statement, parameters] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(statement).toContain("expires_at > NOW()");
    expect(statement).toContain("last_seen_at <= NOW() -");
    expect(parameters).toEqual([TOKEN_HASH, AUTH_SESSION_TOUCH_INTERVAL_MS]);
  });
});
