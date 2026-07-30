import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { ApiRouteError } from "@/lib/api/responses";
import { isPostgresRuntimeEnabled, query } from "@/lib/runtime/database";

interface LocalRateLimitEntry {
  count: number;
  windowStartedAt: number;
  blockedUntil: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __sceneCartRateLimits: Map<string, LocalRateLimitEntry> | undefined;
}

function localRateLimits() {
  if (!globalThis.__sceneCartRateLimits) {
    globalThis.__sceneCartRateLimits = new Map();
  }
  return globalThis.__sceneCartRateLimits;
}

export function resetRateLimitsForTests() {
  globalThis.__sceneCartRateLimits = undefined;
}

function requestAddress(request: NextRequest) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || "unknown";
}

function identifierHash(request: NextRequest, action: string, subject: string) {
  return createHash("sha256")
    .update(`${action}:${requestAddress(request)}:${subject.trim().toLowerCase()}`)
    .digest("hex");
}

async function consumePostgresLimit(
  keyHash: string,
  limit: number,
  windowMs: number,
  blockMs: number
) {
  const result = await query<{ attempt_count: number; blocked_until: Date | null }>(
    `INSERT INTO security_rate_limits(key_hash, attempt_count, window_started_at, blocked_until, updated_at)
     VALUES($1, 1, NOW(), NULL, NOW())
     ON CONFLICT(key_hash) DO UPDATE SET
       attempt_count = CASE
         WHEN security_rate_limits.window_started_at <= NOW() - ($2::text || ' milliseconds')::interval
           OR (security_rate_limits.blocked_until IS NOT NULL AND security_rate_limits.blocked_until <= NOW()) THEN 1
         ELSE security_rate_limits.attempt_count + 1
       END,
       window_started_at = CASE
         WHEN security_rate_limits.window_started_at <= NOW() - ($2::text || ' milliseconds')::interval
           OR (security_rate_limits.blocked_until IS NOT NULL AND security_rate_limits.blocked_until <= NOW()) THEN NOW()
         ELSE security_rate_limits.window_started_at
       END,
       blocked_until = CASE
         WHEN security_rate_limits.blocked_until > NOW() THEN security_rate_limits.blocked_until
         WHEN security_rate_limits.window_started_at <= NOW() - ($2::text || ' milliseconds')::interval
           OR (security_rate_limits.blocked_until IS NOT NULL AND security_rate_limits.blocked_until <= NOW()) THEN NULL
         WHEN security_rate_limits.attempt_count + 1 > $3 THEN NOW() + ($4::text || ' milliseconds')::interval
         ELSE NULL
       END,
       updated_at = NOW()
     RETURNING attempt_count, blocked_until`,
    [keyHash, windowMs, limit, blockMs]
  );
  const row = result.rows[0];
  return row.blocked_until ? new Date(row.blocked_until).getTime() : 0;
}

function consumeLocalLimit(keyHash: string, limit: number, windowMs: number, blockMs: number) {
  const entries = localRateLimits();
  const now = Date.now();
  const existing = entries.get(keyHash);
  if (!existing || now - existing.windowStartedAt >= windowMs) {
    entries.set(keyHash, { count: 1, windowStartedAt: now, blockedUntil: 0 });
    return 0;
  }
  if (existing.blockedUntil > now) return existing.blockedUntil;
  if (existing.blockedUntil > 0) {
    entries.set(keyHash, { count: 1, windowStartedAt: now, blockedUntil: 0 });
    return 0;
  }
  existing.count += 1;
  if (existing.count > limit) existing.blockedUntil = now + blockMs;
  return existing.blockedUntil;
}

export async function clearAuthRateLimit(
  request: NextRequest,
  action: "login" | "register",
  subject: string
) {
  const keyHash = identifierHash(request, action, subject);
  if (isPostgresRuntimeEnabled()) {
    await query("DELETE FROM security_rate_limits WHERE key_hash = $1", [keyHash]);
    return;
  }
  localRateLimits().delete(keyHash);
}

export async function enforceAuthRateLimit(
  request: NextRequest,
  input: {
    action: "login" | "register";
    subject: string;
    limit?: number;
    windowMs?: number;
    blockMs?: number;
  }
) {
  const limit = input.limit ?? (input.action === "login" ? 10 : 5);
  const windowMs = input.windowMs ?? (input.action === "login" ? 15 * 60_000 : 60 * 60_000);
  const blockMs = input.blockMs ?? 15 * 60_000;
  const keyHash = identifierHash(request, input.action, input.subject);
  const blockedUntil = isPostgresRuntimeEnabled()
    ? await consumePostgresLimit(keyHash, limit, windowMs, blockMs)
    : consumeLocalLimit(keyHash, limit, windowMs, blockMs);

  if (blockedUntil > Date.now()) {
    const retryAfterSeconds = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000));
    throw new ApiRouteError(
      `尝试次数过多，请在 ${retryAfterSeconds} 秒后重试`,
      429,
      "rate_limited"
    );
  }
}
