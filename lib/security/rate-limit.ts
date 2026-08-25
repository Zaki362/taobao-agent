import { createHash, randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { ApiRouteError } from "@/lib/api/responses";
import { isPostgresRuntimeEnabled, query } from "@/lib/runtime/database";

interface LocalRateLimitEntry {
  count: number;
  windowStartedAt: number;
  blockedUntil: number;
}

interface LocalConcurrencyLease {
  token: string;
  expiresAt: number;
}

interface RateLimitRule {
  keyHash: string;
  limit: number;
  windowMs: number;
  blockMs: number;
}

declare global {
  var __sceneCartRateLimits: Map<string, LocalRateLimitEntry> | undefined;
  var __sceneCartConcurrencyLeases: Map<string, LocalConcurrencyLease> | undefined;
}

function localRateLimits() {
  if (!globalThis.__sceneCartRateLimits) globalThis.__sceneCartRateLimits = new Map();
  return globalThis.__sceneCartRateLimits;
}

function localConcurrencyLeases() {
  if (!globalThis.__sceneCartConcurrencyLeases) globalThis.__sceneCartConcurrencyLeases = new Map();
  return globalThis.__sceneCartConcurrencyLeases;
}

export function resetRateLimitsForTests() {
  globalThis.__sceneCartRateLimits = undefined;
  globalThis.__sceneCartConcurrencyLeases = undefined;
}

function trustProxyHeaders() {
  if (process.env.SCENECART_TRUST_PROXY === "false") return false;
  return process.env.SCENECART_TRUST_PROXY === "true" || Boolean(process.env.VERCEL);
}

function requestAddress(request: NextRequest) {
  if (!trustProxyHeaders()) return "direct-client";
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || "unknown";
}

function identifierHash(namespace: string, scope: string, value: string) {
  return createHash("sha256")
    .update(`${namespace}:${scope}:${value.trim().toLowerCase()}`)
    .digest("hex");
}

async function consumePostgresLimit(rule: RateLimitRule) {
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
    [rule.keyHash, rule.windowMs, rule.limit, rule.blockMs]
  );
  const row = result.rows[0];
  return row.blocked_until ? new Date(row.blocked_until).getTime() : 0;
}

function consumeLocalLimit(rule: RateLimitRule) {
  const entries = localRateLimits();
  const now = Date.now();
  const existing = entries.get(rule.keyHash);
  if (!existing || now - existing.windowStartedAt >= rule.windowMs) {
    entries.set(rule.keyHash, { count: 1, windowStartedAt: now, blockedUntil: 0 });
    return 0;
  }
  if (existing.blockedUntil > now) return existing.blockedUntil;
  if (existing.blockedUntil > 0) {
    entries.set(rule.keyHash, { count: 1, windowStartedAt: now, blockedUntil: 0 });
    return 0;
  }
  existing.count += 1;
  if (existing.count > rule.limit) existing.blockedUntil = now + rule.blockMs;
  return existing.blockedUntil;
}

async function enforceRules(rules: RateLimitRule[]) {
  for (const rule of rules) {
    const blockedUntil = isPostgresRuntimeEnabled()
      ? await consumePostgresLimit(rule)
      : consumeLocalLimit(rule);
    if (blockedUntil > Date.now()) {
      const retryAfterSeconds = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000));
      throw new ApiRouteError(
        `请求过于频繁，请在 ${retryAfterSeconds} 秒后重试`,
        429,
        "rate_limited",
        { "Retry-After": String(retryAfterSeconds) }
      );
    }
  }
}

function scopedRules(
  request: NextRequest,
  namespace: string,
  identity: string | undefined,
  input: { minuteIp: number; minuteIdentity: number; dailyIp: number; dailyIdentity: number }
) {
  const address = requestAddress(request);
  const identityValue = identity?.trim() || `anonymous:${address}`;
  return [
    { keyHash: identifierHash(namespace, "minute:ip", address), limit: input.minuteIp, windowMs: 60_000, blockMs: 60_000 },
    { keyHash: identifierHash(namespace, "minute:identity", identityValue), limit: input.minuteIdentity, windowMs: 60_000, blockMs: 60_000 },
    { keyHash: identifierHash(namespace, "daily:ip", address), limit: input.dailyIp, windowMs: 24 * 60 * 60_000, blockMs: 60 * 60_000 },
    { keyHash: identifierHash(namespace, "daily:identity", identityValue), limit: input.dailyIdentity, windowMs: 24 * 60 * 60_000, blockMs: 60 * 60_000 }
  ];
}

function configuredLimit(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.min(1_000_000, Math.max(1, Math.floor(value))) : fallback;
}

export async function clearAuthRateLimit(
  _request: NextRequest,
  action: "login" | "register",
  subject: string
) {
  const keyHash = identifierHash(`auth:${action}`, "subject", subject);
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
    ipLimit?: number;
    windowMs?: number;
    blockMs?: number;
  }
) {
  const subjectLimit = input.limit ?? (input.action === "login" ? 10 : 5);
  const ipLimit = input.ipLimit ?? (input.action === "login" ? 50 : 10);
  const windowMs = input.windowMs ?? (input.action === "login" ? 15 * 60_000 : 60 * 60_000);
  const blockMs = input.blockMs ?? 15 * 60_000;
  const namespace = `auth:${input.action}`;
  await enforceRules([
    {
      keyHash: identifierHash(namespace, "ip", requestAddress(request)),
      limit: ipLimit,
      windowMs,
      blockMs
    },
    {
      keyHash: identifierHash(namespace, "subject", input.subject),
      limit: subjectLimit,
      windowMs,
      blockMs
    }
  ]);
}

export async function enforceAiRateLimit(request: NextRequest, userId: string | undefined) {
  await enforceRules(scopedRules(request, "ai-generation", userId, {
    minuteIp: configuredLimit("SCENECART_AI_RATE_LIMIT_MINUTE_IP", 30),
    minuteIdentity: configuredLimit("SCENECART_AI_RATE_LIMIT_MINUTE_ACCOUNT", 12),
    dailyIp: configuredLimit("SCENECART_AI_RATE_LIMIT_DAILY_IP", 500),
    dailyIdentity: configuredLimit("SCENECART_AI_RATE_LIMIT_DAILY_ACCOUNT", 200)
  }));
}

export async function enforceWorkflowMutationRateLimit(request: NextRequest, userId: string | undefined) {
  await enforceRules(scopedRules(request, "workflow-mutation", userId, {
    minuteIp: configuredLimit("SCENECART_WORKFLOW_RATE_LIMIT_MINUTE_IP", 120),
    minuteIdentity: configuredLimit("SCENECART_WORKFLOW_RATE_LIMIT_MINUTE_ACCOUNT", 60),
    dailyIp: configuredLimit("SCENECART_WORKFLOW_RATE_LIMIT_DAILY_IP", 2_000),
    dailyIdentity: configuredLimit("SCENECART_WORKFLOW_RATE_LIMIT_DAILY_ACCOUNT", 1_000)
  }));
}

export async function enforceEventStreamRateLimit(request: NextRequest, userId: string | undefined) {
  await enforceRules(scopedRules(request, "event-stream", userId, {
    minuteIp: configuredLimit("SCENECART_EVENT_STREAM_RATE_LIMIT_MINUTE_IP", 60),
    minuteIdentity: configuredLimit("SCENECART_EVENT_STREAM_RATE_LIMIT_MINUTE_ACCOUNT", 30),
    dailyIp: configuredLimit("SCENECART_EVENT_STREAM_RATE_LIMIT_DAILY_IP", 5_000),
    dailyIdentity: configuredLimit("SCENECART_EVENT_STREAM_RATE_LIMIT_DAILY_ACCOUNT", 2_000)
  }));
}

async function acquireConcurrencyLease(keyHash: string, token: string, leaseMs: number) {
  if (isPostgresRuntimeEnabled()) {
    const acquired = await query<{ lease_token: string }>(
      `INSERT INTO security_concurrency_leases(key_hash, lease_token, expires_at, updated_at)
       VALUES($1, $2, NOW() + ($3::text || ' milliseconds')::interval, NOW())
       ON CONFLICT(key_hash) DO UPDATE SET
         lease_token = EXCLUDED.lease_token,
         expires_at = EXCLUDED.expires_at,
         updated_at = NOW()
       WHERE security_concurrency_leases.expires_at <= NOW()
       RETURNING lease_token`,
      [keyHash, token, leaseMs]
    );
    return acquired.rowCount === 1;
  }

  const leases = localConcurrencyLeases();
  const existing = leases.get(keyHash);
  if (existing && existing.expiresAt > Date.now()) return false;
  leases.set(keyHash, { token, expiresAt: Date.now() + leaseMs });
  return true;
}

async function releaseConcurrencyLease(keyHash: string, token: string) {
  if (isPostgresRuntimeEnabled()) {
    await query(
      "DELETE FROM security_concurrency_leases WHERE key_hash = $1 AND lease_token = $2",
      [keyHash, token]
    );
    return;
  }
  const current = localConcurrencyLeases().get(keyHash);
  if (current?.token === token) localConcurrencyLeases().delete(keyHash);
}

export async function acquireEventStreamLease(
  request: NextRequest,
  userId: string | undefined,
  sessionId: string,
  maxConnections = 3
) {
  const identity = userId?.trim() || `anonymous:${requestAddress(request)}`;
  const token = randomUUID();
  for (let slot = 1; slot <= maxConnections; slot += 1) {
    const keyHash = identifierHash("event-stream-concurrency", `slot:${slot}`, `${identity}:${sessionId}`);
    if (await acquireConcurrencyLease(keyHash, token, 6 * 60_000)) {
      return async () => releaseConcurrencyLease(keyHash, token);
    }
  }
  throw new ApiRouteError(
    "当前会话的实时连接过多，请关闭重复页面后重试",
    429,
    "event_stream_concurrency_limited",
    { "Retry-After": "10" }
  );
}

export async function withAiConcurrencyLimit<T>(
  request: NextRequest,
  userId: string | undefined,
  callback: () => Promise<T>
) {
  const identity = userId?.trim() || `anonymous:${requestAddress(request)}`;
  const keyHash = identifierHash("ai-concurrency", "identity", identity);
  const token = randomUUID();
  const acquired = await acquireConcurrencyLease(keyHash, token, 5 * 60_000);
  if (!acquired) {
    throw new ApiRouteError(
      "已有智能工作流正在处理，请等待当前请求完成后重试",
      429,
      "workflow_concurrency_limited",
      { "Retry-After": "5" }
    );
  }
  try {
    return await callback();
  } finally {
    await releaseConcurrencyLease(keyHash, token).catch(() => undefined);
  }
}
