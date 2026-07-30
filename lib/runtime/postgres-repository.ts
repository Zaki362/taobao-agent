import type { PoolClient } from "pg";
import { query, withTransaction } from "@/lib/runtime/database";
import type {
  AuthSessionRecord,
  CreateRuntimeJobInput,
  ExecutionEvent,
  ExecutorDevice,
  RuntimeJob,
  RuntimeRepository,
  RuntimeUser
} from "@/lib/runtime/types";
import type { SessionState } from "@/lib/session/types";
import { normalizeSessionState } from "@/lib/session/store";

function iso(value: Date | string | null | undefined) {
  if (!value) return undefined;
  return new Date(value).toISOString();
}

function normalizeUser(row: Record<string, unknown>): RuntimeUser {
  return {
    id: String(row.id),
    email: String(row.email),
    password_hash: String(row.password_hash),
    created_at: iso(row.created_at as Date)!,
    updated_at: iso(row.updated_at as Date)!
  };
}

function normalizeAuthSession(row: Record<string, unknown>): AuthSessionRecord {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    token_hash: String(row.token_hash),
    expires_at: iso(row.expires_at as Date)!,
    created_at: iso(row.created_at as Date)!,
    last_seen_at: iso(row.last_seen_at as Date)!
  };
}

function normalizeDevice(row: Record<string, unknown>): ExecutorDevice {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    name: String(row.name),
    token_hash: String(row.token_hash),
    capabilities: Array.isArray(row.capabilities) ? row.capabilities as ExecutorDevice["capabilities"] : [],
    status: row.status as ExecutorDevice["status"],
    last_heartbeat_at: iso(row.last_heartbeat_at as Date),
    created_at: iso(row.created_at as Date)!,
    updated_at: iso(row.updated_at as Date)!
  };
}

function normalizeJob(row: Record<string, unknown>): RuntimeJob {
  return {
    id: String(row.id),
    user_id: row.user_id ? String(row.user_id) : undefined,
    session_id: String(row.session_id),
    job_type: row.job_type as RuntimeJob["job_type"],
    idempotency_key: String(row.idempotency_key),
    payload: (row.payload ?? {}) as Record<string, unknown>,
    status: row.status as RuntimeJob["status"],
    priority: Number(row.priority),
    attempts: Number(row.attempts),
    max_attempts: Number(row.max_attempts),
    available_at: iso(row.available_at as Date)!,
    lease_owner_id: row.lease_owner_id ? String(row.lease_owner_id) : undefined,
    lease_expires_at: iso(row.lease_expires_at as Date),
    result: row.result ? row.result as Record<string, unknown> : undefined,
    error_message: row.error_message ? String(row.error_message) : undefined,
    created_at: iso(row.created_at as Date)!,
    updated_at: iso(row.updated_at as Date)!,
    completed_at: iso(row.completed_at as Date)
  };
}

function normalizeEvent(row: Record<string, unknown>): ExecutionEvent {
  return {
    id: Number(row.id),
    user_id: row.user_id ? String(row.user_id) : undefined,
    session_id: String(row.session_id),
    job_id: row.job_id ? String(row.job_id) : undefined,
    event_type: String(row.event_type),
    payload: (row.payload ?? {}) as Record<string, unknown>,
    created_at: iso(row.created_at as Date)!
  };
}

async function selectJobForUpdate(client: PoolClient, jobId: string) {
  const result = await client.query("SELECT * FROM agent_jobs WHERE id = $1 FOR UPDATE", [jobId]);
  if (!result.rowCount) throw new Error("job not found");
  return normalizeJob(result.rows[0]);
}

export const postgresRuntimeRepository: RuntimeRepository = {
  async getSession(sessionId, userId) {
    const values: unknown[] = [sessionId];
    const ownerClause = userId ? "AND user_id = $2" : "";
    if (userId) values.push(userId);
    const result = await query<{ state: SessionState }>(
      `SELECT state FROM shopping_sessions WHERE id = $1 ${ownerClause}`,
      values
    );
    return result.rows[0]?.state ? normalizeSessionState(result.rows[0].state) : null;
  },

  async saveSession(state) {
    await query(
      `INSERT INTO shopping_sessions(id, user_id, state)
       VALUES($1, $2, $3::jsonb)
       ON CONFLICT(id) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         state = EXCLUDED.state,
         updated_at = NOW()`,
      [state.session_id, state.owner_id ?? null, JSON.stringify(state)]
    );
  },

  async listSessions(userId) {
    const result = userId
      ? await query<{ state: SessionState }>(
          "SELECT state FROM shopping_sessions WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 100",
          [userId]
        )
      : await query<{ state: SessionState }>(
          "SELECT state FROM shopping_sessions ORDER BY updated_at DESC LIMIT 100"
        );
    return result.rows.map((row) => normalizeSessionState(row.state));
  },

  async createUser(user) {
    const result = await query(
      `INSERT INTO app_users(id, email, password_hash, created_at, updated_at)
       VALUES($1, $2, $3, $4, $5) RETURNING *`,
      [user.id, user.email, user.password_hash, user.created_at, user.updated_at]
    );
    return normalizeUser(result.rows[0]);
  },

  async findUserById(userId) {
    const result = await query("SELECT * FROM app_users WHERE id = $1", [userId]);
    return result.rowCount ? normalizeUser(result.rows[0]) : null;
  },

  async findUserByEmail(email) {
    const result = await query("SELECT * FROM app_users WHERE email = $1", [email]);
    return result.rowCount ? normalizeUser(result.rows[0]) : null;
  },

  async createAuthSession(session) {
    await query(
      `INSERT INTO auth_sessions(id, user_id, token_hash, expires_at, created_at, last_seen_at)
       VALUES($1, $2, $3, $4, $5, $6)`,
      [session.id, session.user_id, session.token_hash, session.expires_at, session.created_at, session.last_seen_at]
    );
  },

  async findAuthSession(tokenHash) {
    const result = await query(
      "SELECT * FROM auth_sessions WHERE token_hash = $1 AND expires_at > NOW()",
      [tokenHash]
    );
    return result.rowCount ? normalizeAuthSession(result.rows[0]) : null;
  },

  async deleteAuthSession(tokenHash) {
    await query("DELETE FROM auth_sessions WHERE token_hash = $1", [tokenHash]);
  },

  async touchAuthSession(tokenHash) {
    await query("UPDATE auth_sessions SET last_seen_at = NOW() WHERE token_hash = $1", [tokenHash]);
  },

  async createDevice(device) {
    const result = await query(
      `INSERT INTO executor_devices(id, user_id, name, token_hash, capabilities, status, last_heartbeat_at, created_at, updated_at)
       VALUES($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9) RETURNING *`,
      [
        device.id,
        device.user_id,
        device.name,
        device.token_hash,
        JSON.stringify(device.capabilities),
        device.status,
        device.last_heartbeat_at ?? null,
        device.created_at,
        device.updated_at
      ]
    );
    return normalizeDevice(result.rows[0]);
  },

  async findDeviceByToken(tokenHash) {
    const result = await query(
      "SELECT * FROM executor_devices WHERE token_hash = $1 AND status <> 'revoked'",
      [tokenHash]
    );
    return result.rowCount ? normalizeDevice(result.rows[0]) : null;
  },

  async heartbeatDevice(deviceId) {
    const result = await query(
      `UPDATE executor_devices SET status = 'online', last_heartbeat_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status <> 'revoked' RETURNING *`,
      [deviceId]
    );
    return result.rowCount ? normalizeDevice(result.rows[0]) : null;
  },

  async listDevices(userId) {
    const result = await query(
      "SELECT * FROM executor_devices WHERE user_id = $1 ORDER BY created_at DESC",
      [userId]
    );
    return result.rows.map(normalizeDevice);
  },

  async revokeDevice(deviceId, userId) {
    const result = await query(
      "UPDATE executor_devices SET status = 'revoked', updated_at = NOW() WHERE id = $1 AND user_id = $2",
      [deviceId, userId]
    );
    return Boolean(result.rowCount);
  },

  async createJob(input: CreateRuntimeJobInput) {
    const result = await query(
      `INSERT INTO agent_jobs(id, user_id, session_id, job_type, idempotency_key, payload, priority, max_attempts)
       VALUES($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
       RETURNING *`,
      [
        input.id,
        input.user_id ?? null,
        input.session_id,
        input.job_type,
        input.idempotency_key,
        JSON.stringify(input.payload),
        input.priority ?? 100,
        input.max_attempts ?? 3
      ]
    );
    return normalizeJob(result.rows[0]);
  },

  async getJob(jobId) {
    const result = await query("SELECT * FROM agent_jobs WHERE id = $1", [jobId]);
    return result.rowCount ? normalizeJob(result.rows[0]) : null;
  },

  async listJobs(sessionId, userId) {
    const values: unknown[] = [sessionId];
    const ownerClause = userId ? "AND user_id = $2" : "";
    if (userId) values.push(userId);
    const result = await query(
      `SELECT * FROM agent_jobs WHERE session_id = $1 ${ownerClause} ORDER BY created_at DESC LIMIT 200`,
      values
    );
    return result.rows.map(normalizeJob);
  },

  async claimJob(device, leaseMs) {
    return withTransaction(async (client) => {
      await client.query(
        `UPDATE agent_jobs SET
           status = CASE WHEN attempts < max_attempts THEN 'pending' ELSE 'failed' END,
           lease_owner_id = NULL,
           lease_expires_at = NULL,
           available_at = NOW(),
           completed_at = CASE WHEN attempts >= max_attempts THEN NOW() ELSE completed_at END,
           updated_at = NOW()
         WHERE status IN ('leased', 'running') AND lease_expires_at <= NOW()`
      );
      const selected = await client.query(
        `SELECT * FROM agent_jobs
         WHERE status = 'pending'
           AND available_at <= NOW()
           AND (user_id IS NULL OR user_id = $1)
           AND job_type = ANY($2::text[])
         ORDER BY priority DESC, created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [device.user_id, device.capabilities]
      );
      if (!selected.rowCount) return null;
      const claimed = await client.query(
        `UPDATE agent_jobs SET
           status = 'leased',
           lease_owner_id = $2,
           lease_expires_at = NOW() + ($3::text || ' milliseconds')::interval,
           attempts = attempts + 1,
           updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [selected.rows[0].id, device.id, Math.max(leaseMs, 5_000)]
      );
      return normalizeJob(claimed.rows[0]);
    });
  },

  async renewJobLease(jobId, deviceId, leaseMs) {
    const result = await query(
      `UPDATE agent_jobs SET
         status = 'running',
         lease_expires_at = NOW() + ($3::text || ' milliseconds')::interval,
         updated_at = NOW()
       WHERE id = $1 AND lease_owner_id = $2 AND status IN ('leased', 'running')
       RETURNING *`,
      [jobId, deviceId, Math.max(leaseMs, 5_000)]
    );
    return result.rowCount ? normalizeJob(result.rows[0]) : null;
  },

  async completeJob(jobId, deviceId, result) {
    return withTransaction(async (client) => {
      const job = await selectJobForUpdate(client, jobId);
      if (job.status === "completed") return { job, alreadyCompleted: true };
      if (job.lease_owner_id !== deviceId) throw new Error("job lease owner mismatch");
      const updated = await client.query(
        `UPDATE agent_jobs SET status = 'completed', result = $2::jsonb, completed_at = NOW(),
         lease_expires_at = NULL, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [jobId, JSON.stringify(result)]
      );
      return { job: normalizeJob(updated.rows[0]), alreadyCompleted: false };
    });
  },

  async failJob(jobId, deviceId, errorMessage, retryDelayMs = 2_000) {
    return withTransaction(async (client) => {
      const job = await selectJobForUpdate(client, jobId);
      if (job.status === "completed") return job;
      if (job.lease_owner_id !== deviceId) throw new Error("job lease owner mismatch");
      const shouldRetry = job.attempts < job.max_attempts;
      const updated = await client.query(
        `UPDATE agent_jobs SET
           status = $2,
           error_message = $3,
           available_at = CASE WHEN $2 = 'pending' THEN NOW() + ($4::text || ' milliseconds')::interval ELSE available_at END,
           lease_owner_id = NULL,
           lease_expires_at = NULL,
           completed_at = CASE WHEN $2 = 'failed' THEN NOW() ELSE completed_at END,
           updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [jobId, shouldRetry ? "pending" : "failed", errorMessage.slice(0, 1000), Math.max(retryDelayMs, 0)]
      );
      return normalizeJob(updated.rows[0]);
    });
  },

  async cancelJob(jobId, userId) {
    const values: unknown[] = [jobId];
    const ownerClause = userId ? "AND (user_id IS NULL OR user_id = $2)" : "";
    if (userId) values.push(userId);
    const result = await query(
      `UPDATE agent_jobs SET
         status = 'cancelled',
         error_message = '用户在执行器领取前取消任务',
         completed_at = NOW(),
         updated_at = NOW()
       WHERE id = $1 AND status = 'pending' ${ownerClause}
       RETURNING *`,
      values
    );
    return result.rowCount ? normalizeJob(result.rows[0]) : null;
  },

  async recoverExpiredJobs() {
    const result = await query(
      `UPDATE agent_jobs SET
         status = CASE WHEN attempts < max_attempts THEN 'pending' ELSE 'failed' END,
         lease_owner_id = NULL,
         lease_expires_at = NULL,
         available_at = NOW(),
         completed_at = CASE WHEN attempts >= max_attempts THEN NOW() ELSE completed_at END,
         updated_at = NOW()
       WHERE status IN ('leased', 'running') AND lease_expires_at <= NOW()`
    );
    return result.rowCount ?? 0;
  },

  async appendEvent(input) {
    const result = await query(
      `INSERT INTO execution_events(user_id, session_id, job_id, event_type, payload)
       VALUES($1, $2, $3, $4, $5::jsonb) RETURNING *`,
      [input.user_id ?? null, input.session_id, input.job_id ?? null, input.event_type, JSON.stringify(input.payload)]
    );
    return normalizeEvent(result.rows[0]);
  },

  async listEvents(sessionId, afterId, userId, limit = 100) {
    const values: unknown[] = [sessionId, afterId, Math.min(Math.max(limit, 1), 500)];
    const ownerClause = userId ? "AND user_id = $4" : "";
    if (userId) values.push(userId);
    const result = await query(
      `SELECT * FROM execution_events
       WHERE session_id = $1 AND id > $2 ${ownerClause}
       ORDER BY id ASC LIMIT $3`,
      values
    );
    return result.rows.map(normalizeEvent);
  }
};
