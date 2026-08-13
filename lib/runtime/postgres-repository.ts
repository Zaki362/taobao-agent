import type { PoolClient } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { query, withTransaction } from "@/lib/runtime/database";
import type {
  AuthenticationFailureHold,
  AuthSessionRecord,
  CreateRuntimeJobInput,
  ExecutionEvent,
  ExecutorDevice,
  RuntimeJob,
  RuntimeRepository,
  RuntimeServiceHeartbeat,
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
    lease_token: row.lease_token ? String(row.lease_token) : undefined,
    last_auth_failure_token_hash: row.last_auth_failure_token_hash
      ? String(row.last_auth_failure_token_hash)
      : undefined,
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

function authenticationFailureTokenHash(leaseToken: string) {
  return createHash("sha256").update(leaseToken).digest("hex");
}

function normalizeAuthenticationFailureHold(row: Record<string, unknown>): AuthenticationFailureHold {
  return {
    job_id: String(row.job_id),
    session_id: String(row.session_id),
    user_id: row.user_id ? String(row.user_id) : undefined,
    device_id: String(row.device_id),
    attempt: Number(row.attempt),
    lease_token: String(row.lease_token)
  };
}

async function selectActiveAuthenticationFailureHold(jobId: string, client?: PoolClient) {
  const result = await (client ? client.query.bind(client) : query)(
    `SELECT latest.job_id, latest.session_id, latest.user_id,
            latest.payload->>'device_id' AS device_id,
            (latest.payload->>'attempt')::integer AS attempt,
            latest.payload->>'lease_token' AS lease_token
     FROM agent_jobs AS jobs
     JOIN LATERAL (
       SELECT events.*
       FROM execution_events AS events
       WHERE events.job_id = jobs.id
         AND events.event_type IN (
           'job.authentication_failure_hold_pending',
           'job.authentication_failure_hold_released'
         )
         AND events.payload->>'attempt' = jobs.attempts::text
         AND events.payload->>'lease_token' = jobs.lease_token
       ORDER BY events.id DESC
       LIMIT 1
     ) AS latest ON TRUE
     WHERE jobs.id = $1
       AND latest.event_type = 'job.authentication_failure_hold_pending'`,
    [jobId]
  );
  return result.rowCount ? normalizeAuthenticationFailureHold(result.rows[0]) : null;
}

async function selectActiveAuthenticationFailureHoldsByDevice(deviceId: string, client?: PoolClient) {
  const result = await (client ? client.query.bind(client) : query)(
    `SELECT latest.job_id, latest.session_id, latest.user_id,
            latest.payload->>'device_id' AS device_id,
            (latest.payload->>'attempt')::integer AS attempt,
            latest.payload->>'lease_token' AS lease_token
     FROM agent_jobs AS jobs
     JOIN LATERAL (
       SELECT events.*
       FROM execution_events AS events
       WHERE events.job_id = jobs.id
         AND events.event_type IN (
           'job.authentication_failure_hold_pending',
           'job.authentication_failure_hold_released'
         )
         AND events.payload->>'attempt' = jobs.attempts::text
         AND events.payload->>'lease_token' = jobs.lease_token
       ORDER BY events.id DESC
       LIMIT 1
     ) AS latest ON TRUE
     WHERE latest.event_type = 'job.authentication_failure_hold_pending'
       AND latest.payload->>'device_id' = $1`,
    [deviceId]
  );
  return result.rows.map(normalizeAuthenticationFailureHold);
}

function normalizeServiceHeartbeat(row: Record<string, unknown>): RuntimeServiceHeartbeat {
  return {
    service_name: String(row.service_name),
    status: row.status as RuntimeServiceHeartbeat["status"],
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    checked_at: iso(row.checked_at as Date)!
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

  async listWorkflowRecoveryCandidates(userId, limit = 25) {
    const boundedLimit = Math.min(Math.max(limit, 1), 100);
    const values: unknown[] = [];
    const ownerClause = userId ? `AND sessions.user_id = $${values.push(userId)}` : "";
    const limitParameter = `$${values.push(boundedLimit)}`;
    const result = await query<{ state: SessionState }>(
      `SELECT sessions.state
       FROM shopping_sessions AS sessions
       WHERE NOT (sessions.state ? 'archived_at')
         AND sessions.state #>> '{agent_runtime,auto_continue}' = 'true'
         AND sessions.state #>> '{agent_runtime,workflow_status}' IN ('running', 'waiting_for_tools')
         ${ownerClause}
         AND (
           NOT EXISTS (
             SELECT 1
             FROM jsonb_array_elements(COALESCE(sessions.state->'hosted_tasks', '[]'::jsonb)) AS task
             WHERE task->>'task_type' = 'module_search'
               AND task->>'status' IN ('pending', 'running')
           )
           OR EXISTS (
             SELECT 1
             FROM jsonb_array_elements(COALESCE(sessions.state->'hosted_tasks', '[]'::jsonb)) AS task
             JOIN agent_jobs AS jobs ON jobs.id::text = task->>'runtime_job_id'
             WHERE task->>'task_type' = 'module_search'
               AND task->>'status' IN ('pending', 'running')
               AND jobs.status IN ('completed', 'failed', 'cancelled')
           )
         )
       ORDER BY sessions.updated_at ASC
       LIMIT ${limitParameter}`,
      values
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

  async heartbeatDevice(deviceId, status = "online") {
    return withTransaction(async (client) => {
      const lockedDevice = await client.query(
        `SELECT id, status FROM executor_devices
         WHERE id = $1 AND status <> 'revoked'
         FOR UPDATE`,
        [deviceId]
      );
      if (!lockedDevice.rowCount) return null;
      const activeHolds = status !== "authentication_required"
        ? await selectActiveAuthenticationFailureHoldsByDevice(deviceId, client)
        : [];
      const effectiveStatus = status !== "authentication_required" && activeHolds.length > 0
        ? "authentication_required"
        : status;
      const result = await client.query(
        `UPDATE executor_devices SET status = $2, last_heartbeat_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status <> 'revoked' RETURNING *`,
        [deviceId, effectiveStatus]
      );
      return result.rowCount ? normalizeDevice(result.rows[0]) : null;
    });
  },

  async listDevices(userId) {
    const result = await query(
      "SELECT * FROM executor_devices WHERE user_id = $1 ORDER BY created_at DESC",
      [userId]
    );
    return result.rows.map(normalizeDevice);
  },

  async updateDeviceCapabilities(deviceId, userId, capabilities) {
    const result = await query(
      `UPDATE executor_devices SET capabilities = $3::jsonb, updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status <> 'revoked' RETURNING *`,
      [deviceId, userId, JSON.stringify(capabilities)]
    );
    return result.rowCount ? normalizeDevice(result.rows[0]) : null;
  },

  async revokeDevice(deviceId, userId) {
    const result = await query(
      "UPDATE executor_devices SET status = 'revoked', updated_at = NOW() WHERE id = $1 AND user_id = $2",
      [deviceId, userId]
    );
    return Boolean(result.rowCount);
  },

  async createJob(input: CreateRuntimeJobInput) {
    const maxAttempts = input.job_type === "add_to_cart" ? 1 : input.max_attempts ?? 3;
    const result = await query(
      `INSERT INTO agent_jobs(id, user_id, session_id, job_type, idempotency_key, payload, priority, max_attempts)
       SELECT $1, $2, $3, $4, $5, $6::jsonb, $7, $8
       WHERE NOT EXISTS (
         SELECT 1 FROM shopping_sessions AS sessions
         WHERE sessions.id = $3 AND sessions.state ? 'archived_at'
       )
       ON CONFLICT(idempotency_key) DO UPDATE SET
         status = CASE WHEN agent_jobs.status IN ('failed', 'cancelled') THEN 'pending' ELSE agent_jobs.status END,
         payload = CASE WHEN agent_jobs.status IN ('failed', 'cancelled') THEN EXCLUDED.payload ELSE agent_jobs.payload END,
         priority = CASE WHEN agent_jobs.status IN ('failed', 'cancelled') THEN EXCLUDED.priority ELSE agent_jobs.priority END,
         attempts = CASE WHEN agent_jobs.status IN ('failed', 'cancelled') THEN 0 ELSE agent_jobs.attempts END,
         max_attempts = CASE WHEN agent_jobs.status IN ('failed', 'cancelled') THEN EXCLUDED.max_attempts ELSE agent_jobs.max_attempts END,
         available_at = CASE WHEN agent_jobs.status IN ('failed', 'cancelled') THEN NOW() ELSE agent_jobs.available_at END,
         error_message = CASE WHEN agent_jobs.status IN ('failed', 'cancelled') THEN NULL ELSE agent_jobs.error_message END,
         result = CASE WHEN agent_jobs.status IN ('failed', 'cancelled') THEN NULL ELSE agent_jobs.result END,
         lease_owner_id = CASE WHEN agent_jobs.status IN ('failed', 'cancelled') THEN NULL ELSE agent_jobs.lease_owner_id END,
         lease_expires_at = CASE WHEN agent_jobs.status IN ('failed', 'cancelled') THEN NULL ELSE agent_jobs.lease_expires_at END,
         lease_token = CASE WHEN agent_jobs.status IN ('failed', 'cancelled') THEN NULL ELSE agent_jobs.lease_token END,
         completed_at = CASE WHEN agent_jobs.status IN ('failed', 'cancelled') THEN NULL ELSE agent_jobs.completed_at END,
         updated_at = CASE WHEN agent_jobs.status IN ('failed', 'cancelled') THEN NOW() ELSE agent_jobs.updated_at END
       WHERE NOT EXISTS (
         SELECT 1
         FROM LATERAL (
           SELECT hold_events.event_type
           FROM execution_events AS hold_events
           WHERE hold_events.job_id = agent_jobs.id
             AND hold_events.event_type IN (
               'job.authentication_failure_hold_pending',
               'job.authentication_failure_hold_released'
             )
             AND hold_events.payload->>'attempt' = agent_jobs.attempts::text
             AND hold_events.payload->>'lease_token' = agent_jobs.lease_token
           ORDER BY hold_events.id DESC
           LIMIT 1
         ) AS latest_hold
         WHERE latest_hold.event_type = 'job.authentication_failure_hold_pending'
       )
       RETURNING *`,
      [
        input.id,
        input.user_id ?? null,
        input.session_id,
        input.job_type,
        input.idempotency_key,
        JSON.stringify(input.payload),
        input.priority ?? 100,
        maxAttempts
      ]
    );
    if (!result.rowCount) {
      const existing = await query(
        "SELECT id FROM agent_jobs WHERE idempotency_key = $1",
        [input.idempotency_key]
      );
      if (
        existing.rowCount &&
        await selectActiveAuthenticationFailureHold(String(existing.rows[0].id))
      ) {
        throw new Error("authentication failure hold requires explicit user release");
      }
      throw new Error("session archived");
    }
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
    if (device.status !== "online") return null;
    return withTransaction(async (client) => {
      const deviceResult = await client.query(
        `SELECT * FROM executor_devices
         WHERE id = $1 AND status <> 'revoked'
         FOR UPDATE`,
        [device.id]
      );
      if (!deviceResult.rowCount) return null;
      const storedDevice = normalizeDevice(deviceResult.rows[0]);
      if (storedDevice.status !== "online") return null;
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
           AND NOT (
             lease_token IS NOT NULL AND EXISTS (
               SELECT 1
               FROM execution_events AS claim_events
               JOIN executor_devices AS claim_devices
                 ON claim_devices.id::text = claim_events.payload->>'device_id'
               WHERE claim_events.job_id = agent_jobs.id
                 AND claim_events.event_type = 'job.claimed'
                 AND claim_events.payload->>'attempt' = agent_jobs.attempts::text
                 AND claim_events.payload->>'lease_token' = agent_jobs.lease_token
                 AND claim_devices.status = 'authentication_required'
             )
           )
           AND NOT EXISTS (
             SELECT 1
             FROM LATERAL (
               SELECT hold_events.event_type
               FROM execution_events AS hold_events
               WHERE hold_events.job_id = agent_jobs.id
                 AND hold_events.event_type IN (
                   'job.authentication_failure_hold_pending',
                   'job.authentication_failure_hold_released'
                 )
                 AND hold_events.payload->>'attempt' = agent_jobs.attempts::text
                 AND hold_events.payload->>'lease_token' = agent_jobs.lease_token
               ORDER BY hold_events.id DESC
               LIMIT 1
             ) AS latest_hold
             WHERE latest_hold.event_type = 'job.authentication_failure_hold_pending'
           )
           AND NOT EXISTS (
             SELECT 1 FROM shopping_sessions AS sessions
             WHERE sessions.id = agent_jobs.session_id
               AND sessions.state ? 'archived_at'
           )
         ORDER BY priority DESC, created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [storedDevice.user_id, storedDevice.capabilities]
      );
      if (!selected.rowCount) return null;
      const claimed = await client.query(
        `UPDATE agent_jobs SET
           status = 'leased',
           lease_owner_id = $2,
           lease_expires_at = NOW() + ($3::text || ' milliseconds')::interval,
           lease_token = $4,
           attempts = attempts + 1,
           updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [selected.rows[0].id, storedDevice.id, Math.max(leaseMs, 5_000), randomUUID()]
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

  async failJob(jobId, deviceId, errorMessage, retryDelayMs = 2_000, terminal = false) {
    return withTransaction(async (client) => {
      const job = await selectJobForUpdate(client, jobId);
      if (job.status === "completed") return job;
      if (job.lease_owner_id !== deviceId) throw new Error("job lease owner mismatch");
      const shouldRetry = !terminal && job.attempts < job.max_attempts;
      const updated = await client.query(
        `UPDATE agent_jobs SET
           status = $2,
           error_message = $3,
           available_at = CASE WHEN $2 = 'pending' THEN NOW() + ($4::text || ' milliseconds')::interval ELSE available_at END,
           lease_owner_id = NULL,
           lease_expires_at = NULL,
           lease_token = CASE WHEN $2 = 'pending' THEN NULL ELSE lease_token END,
           completed_at = CASE WHEN $2 = 'failed' THEN NOW() ELSE completed_at END,
           updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [jobId, shouldRetry ? "pending" : "failed", errorMessage.slice(0, 1000), Math.max(retryDelayMs, 0)]
      );
      return normalizeJob(updated.rows[0]);
    });
  },

  async failAuthenticationJob(jobId, device, errorMessage, leaseToken, leaseTokenHash) {
    return withTransaction(async (client) => {
      const deviceResult = await client.query(
        `SELECT id, user_id, capabilities, status
         FROM executor_devices
         WHERE id = $1
         FOR UPDATE`,
        [device.id]
      );
      const storedDevice = deviceResult.rows[0];
      if (!storedDevice || storedDevice.status !== "authentication_required") {
        throw new Error("executor authentication pause is not active");
      }
      const job = await selectJobForUpdate(client, jobId);
      if (job.status === "failed") {
        const capabilities = Array.isArray(storedDevice.capabilities)
          ? storedDevice.capabilities as string[]
          : [];
        if (
          !capabilities.includes(job.job_type) ||
          job.attempts <= 0 ||
          !job.lease_token ||
          job.lease_token !== leaseToken ||
          (job.user_id !== undefined && job.user_id !== String(storedDevice.user_id))
        ) {
          throw new Error("failed job does not match authentication callback lease");
        }
        const acknowledged = await client.query(
          `UPDATE agent_jobs SET
             last_auth_failure_token_hash = $2,
             updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [jobId, leaseTokenHash]
        );
        return normalizeJob(acknowledged.rows[0]);
      }
      if (job.status === "completed" || job.status === "cancelled") {
        throw new Error("terminal job cannot accept authentication failure callback");
      }
      const pendingClaim = job.status === "pending"
        ? await client.query(
            `SELECT 1
             FROM execution_events
             WHERE job_id = $1
               AND event_type = 'job.claimed'
               AND payload->>'device_id' = $2
               AND payload->>'attempt' = $3
               AND payload->>'lease_token' = $4
             LIMIT 1`,
            [job.id, device.id, String(job.attempts), job.lease_token]
          )
        : null;
      const capabilities = Array.isArray(storedDevice.capabilities)
        ? storedDevice.capabilities as string[]
        : [];
      if (
        (job.job_type !== "module_search" && job.job_type !== "add_to_cart") ||
        !capabilities.includes(job.job_type) ||
        job.attempts <= 0 ||
        !job.lease_token ||
        job.lease_token !== leaseToken ||
        (job.user_id !== undefined && job.user_id !== String(storedDevice.user_id)) ||
        (job.status !== "pending" && job.status !== "leased" && job.status !== "running") ||
        (job.status !== "pending" && job.lease_owner_id !== device.id) ||
        (job.status === "pending" && !pendingClaim?.rowCount)
      ) {
        throw new Error("job is not eligible for authentication failure recovery");
      }
      const updated = await client.query(
        `UPDATE agent_jobs SET
           status = 'failed',
           error_message = $2,
           last_auth_failure_token_hash = $3,
           lease_owner_id = NULL,
           lease_expires_at = NULL,
           completed_at = NOW(),
           updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [jobId, errorMessage.slice(0, 1000), leaseTokenHash]
      );
      return normalizeJob(updated.rows[0]);
    });
  },

  async holdAuthenticationJob(jobId, device, errorMessage, leaseToken) {
    return withTransaction(async (client) => {
      const deviceResult = await client.query(
        `SELECT * FROM executor_devices WHERE id = $1 FOR UPDATE`,
        [device.id]
      );
      const storedDevice = deviceResult.rows[0];
      if (!storedDevice || storedDevice.status === "revoked") {
        throw new Error("executor device unavailable");
      }
      const job = await selectJobForUpdate(client, jobId);
      if (job.status === "completed" || job.status === "cancelled") {
        throw new Error("job cannot accept authentication failure hold");
      }
      const claimed = await client.query(
        `SELECT 1 FROM execution_events
         WHERE job_id = $1
           AND event_type = 'job.claimed'
           AND payload->>'device_id' = $2
           AND payload->>'attempt' = $3
           AND payload->>'lease_token' = $4
         LIMIT 1`,
        [job.id, device.id, String(job.attempts), leaseToken]
      );
      const capabilities = Array.isArray(storedDevice.capabilities)
        ? storedDevice.capabilities as string[]
        : [];
      if (
        (job.job_type !== "module_search" && job.job_type !== "add_to_cart") ||
        !capabilities.includes(job.job_type) ||
        job.attempts <= 0 ||
        !job.lease_token ||
        job.lease_token !== leaseToken ||
        (job.user_id !== undefined && job.user_id !== String(storedDevice.user_id)) ||
        (job.status !== "failed" && job.status !== "pending" && job.status !== "leased" && job.status !== "running") ||
        ((job.status === "leased" || job.status === "running") && job.lease_owner_id !== device.id) ||
        ((job.status === "pending" || job.status === "failed") && !claimed.rowCount)
      ) {
        throw new Error("job is not eligible for authentication failure hold");
      }

      const updatedDevice = await client.query(
        `UPDATE executor_devices SET
           status = 'authentication_required',
           last_heartbeat_at = NOW(),
           updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [device.id]
      );
      const updatedJob = await client.query(
        `UPDATE agent_jobs SET
           status = 'failed',
           error_message = $2,
           lease_owner_id = NULL,
           lease_expires_at = NULL,
           completed_at = COALESCE(completed_at, NOW()),
           updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [job.id, errorMessage.slice(0, 1000)]
      );

      let hold = await selectActiveAuthenticationFailureHold(job.id, client);
      if (!hold) {
        const event = await client.query(
          `INSERT INTO execution_events(user_id, session_id, job_id, event_type, payload)
           VALUES($1, $2, $3, 'job.authentication_failure_hold_pending', $4::jsonb)
           RETURNING job_id, session_id, user_id,
             payload->>'device_id' AS device_id,
             (payload->>'attempt')::integer AS attempt,
             payload->>'lease_token' AS lease_token`,
          [
            job.user_id ?? null,
            job.session_id,
            job.id,
            JSON.stringify({
              job_type: job.job_type,
              device_id: device.id,
              attempt: job.attempts,
              lease_token: leaseToken,
              error: errorMessage.slice(0, 500)
            })
          ]
        );
        hold = normalizeAuthenticationFailureHold(event.rows[0]);
      }
      return {
        job: normalizeJob(updatedJob.rows[0]),
        device: normalizeDevice(updatedDevice.rows[0]),
        hold
      };
    });
  },

  async getActiveAuthenticationFailureHold(jobId) {
    return selectActiveAuthenticationFailureHold(jobId);
  },

  async hasActiveAuthenticationFailureHold(deviceId) {
    return (await selectActiveAuthenticationFailureHoldsByDevice(deviceId)).length > 0;
  },

  async listActiveAuthenticationFailureHolds(deviceId) {
    return selectActiveAuthenticationFailureHoldsByDevice(deviceId);
  },

  async isAuthenticationFailureHoldReleased(jobId, deviceId, leaseToken) {
    const result = await query(
      `SELECT 1 FROM execution_events
       WHERE job_id = $1
         AND event_type = 'job.authentication_failure_hold_released'
         AND payload->>'device_id' = $2
         AND payload->>'lease_token' = $3
       LIMIT 1`,
      [jobId, deviceId, leaseToken]
    );
    return Boolean(result.rowCount);
  },

  async releaseAuthenticationFailureHold(hold, reason) {
    return withTransaction(async (client) => {
      await client.query("SELECT id FROM agent_jobs WHERE id = $1 FOR UPDATE", [hold.job_id]);
      const active = await selectActiveAuthenticationFailureHold(hold.job_id, client);
      if (
        !active ||
        active.device_id !== hold.device_id ||
        active.attempt !== hold.attempt ||
        active.lease_token !== hold.lease_token
      ) return false;
      await client.query(
        `INSERT INTO execution_events(user_id, session_id, job_id, event_type, payload)
         VALUES($1, $2, $3, 'job.authentication_failure_hold_released', $4::jsonb)`,
        [
          active.user_id ?? null,
          active.session_id,
          active.job_id,
          JSON.stringify({
            device_id: active.device_id,
            attempt: active.attempt,
            lease_token: active.lease_token,
            reason
          })
        ]
      );
      await client.query(
        `UPDATE agent_jobs SET last_auth_failure_token_hash = $2, updated_at = NOW()
         WHERE id = $1`,
        [active.job_id, authenticationFailureTokenHash(active.lease_token)]
      );
      return true;
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
         lease_token = NULL,
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

  async recordServiceHeartbeat(heartbeat) {
    const result = await query(
      `INSERT INTO runtime_service_heartbeats(service_name, status, metadata, checked_at)
       VALUES($1, $2, $3::jsonb, $4)
       ON CONFLICT(service_name) DO UPDATE SET
         status = EXCLUDED.status,
         metadata = EXCLUDED.metadata,
         checked_at = EXCLUDED.checked_at
       RETURNING *`,
      [
        heartbeat.service_name,
        heartbeat.status,
        JSON.stringify(heartbeat.metadata),
        heartbeat.checked_at
      ]
    );
    return normalizeServiceHeartbeat(result.rows[0]);
  },

  async getServiceHeartbeat(serviceName) {
    const result = await query(
      "SELECT * FROM runtime_service_heartbeats WHERE service_name = $1",
      [serviceName]
    );
    return result.rowCount ? normalizeServiceHeartbeat(result.rows[0]) : null;
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
  },

  async listAuditEvents(userId, limit = 50) {
    const result = await query(
      `SELECT * FROM execution_events
       WHERE user_id = $1 AND event_type LIKE 'executor.%'
       ORDER BY id DESC LIMIT $2`,
      [userId, Math.min(Math.max(limit, 1), 100)]
    );
    return result.rows.map(normalizeEvent);
  }
};
