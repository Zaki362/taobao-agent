import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getSession, listSessions, saveSession } from "@/lib/session/store";
import type { SessionState } from "@/lib/session/types";
import { allowUnownedRuntimeJobs } from "@/lib/runtime/product-mode";
import { executorCapabilityForJobType } from "@/lib/runtime/types";
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

interface LocalRuntimeState {
  users: Map<string, RuntimeUser>;
  authSessions: Map<string, AuthSessionRecord>;
  devices: Map<string, ExecutorDevice>;
  jobs: Map<string, RuntimeJob>;
  serviceHeartbeats: Map<string, RuntimeServiceHeartbeat>;
  events: ExecutionEvent[];
  eventSequence: number;
}

interface PersistedLocalRuntimeState {
  version: 1;
  users: RuntimeUser[];
  auth_sessions: AuthSessionRecord[];
  devices: ExecutorDevice[];
  jobs: RuntimeJob[];
  service_heartbeats: RuntimeServiceHeartbeat[];
  events: ExecutionEvent[];
  event_sequence: number;
  saved_at: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __sceneCartLocalRuntime: LocalRuntimeState | undefined;
}

function emptyRuntimeState(): LocalRuntimeState {
  return {
    users: new Map(),
    authSessions: new Map(),
    devices: new Map(),
    jobs: new Map(),
    serviceHeartbeats: new Map(),
    events: [],
    eventSequence: 0
  };
}

function localPersistenceEnabled() {
  if (process.env.SCENECART_LOCAL_RUNTIME_PERSIST === "false") return false;
  if (process.env.SCENECART_LOCAL_RUNTIME_PERSIST === "true") return true;
  return process.env.NODE_ENV !== "test";
}

function localRuntimeFile() {
  return process.env.SCENECART_LOCAL_RUNTIME_PATH || path.join(process.cwd(), ".data", "runtime", "local-runtime.json");
}

function records<T>(value: unknown): T[] {
  return Array.isArray(value)
    ? value.filter((item) => Boolean(item) && typeof item === "object") as T[]
    : [];
}

function loadPersistedRuntimeState(): LocalRuntimeState {
  const empty = emptyRuntimeState();
  if (!localPersistenceEnabled()) return empty;

  try {
    const parsed = JSON.parse(fs.readFileSync(localRuntimeFile(), "utf8")) as Partial<PersistedLocalRuntimeState>;
    const now = Date.now();
    const users = records<RuntimeUser>(parsed.users);
    const authSessions = records<AuthSessionRecord>(parsed.auth_sessions)
      .filter((session) => Date.parse(session.expires_at) > now);
    const devices = records<ExecutorDevice>(parsed.devices).map((device) => ({
      ...device,
      status: device.status === "revoked"
        ? "revoked" as const
        : device.status === "authentication_required"
          ? "authentication_required" as const
          : device.status === "mcp_unavailable"
            ? "mcp_unavailable" as const
          : "offline" as const
    }));
    const jobs = records<RuntimeJob>(parsed.jobs).map((job) => ({
      ...job,
      lease_token: typeof job.lease_token === "string" ? job.lease_token : undefined,
      lease_protocol: typeof job.lease_protocol === "string"
        ? job.lease_protocol
        : (job.lease_token && (job.status === "leased" || job.status === "running") ? "3" : undefined)
    }));
    const serviceHeartbeats = records<RuntimeServiceHeartbeat>(parsed.service_heartbeats);
    const events = records<ExecutionEvent>(parsed.events).slice(-5_000);
    const eventSequence = Math.max(
      Number.isFinite(parsed.event_sequence) ? Number(parsed.event_sequence) : 0,
      ...events.map((event) => Number.isFinite(event.id) ? event.id : 0)
    );

    return {
      users: new Map(users.filter((user) => typeof user.id === "string").map((user) => [user.id, user])),
      authSessions: new Map(authSessions.filter((session) => typeof session.token_hash === "string").map((session) => [session.token_hash, session])),
      devices: new Map(devices.filter((device) => typeof device.id === "string").map((device) => [device.id, device])),
      jobs: new Map(jobs.filter((job) => typeof job.id === "string").map((job) => [job.id, job])),
      serviceHeartbeats: new Map(serviceHeartbeats.filter((heartbeat) => typeof heartbeat.service_name === "string").map((heartbeat) => [heartbeat.service_name, heartbeat])),
      events,
      eventSequence
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return empty;
    }
    console.warn("[local-runtime] persisted state is unreadable; starting with an empty development runtime");
    return empty;
  }
}

function persistRuntimeState(state: LocalRuntimeState) {
  if (!localPersistenceEnabled()) return;
  const file = localRuntimeFile();
  const directory = path.dirname(file);
  const temporary = `${file}.${process.pid}.tmp`;
  const payload: PersistedLocalRuntimeState = {
    version: 1,
    users: [...state.users.values()],
    auth_sessions: [...state.authSessions.values()],
    devices: [...state.devices.values()],
    jobs: [...state.jobs.values()],
    service_heartbeats: [...state.serviceHeartbeats.values()],
    events: state.events.slice(-5_000),
    event_sequence: state.eventSequence,
    saved_at: new Date().toISOString()
  };
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function runtimeState() {
  if (!globalThis.__sceneCartLocalRuntime) {
    globalThis.__sceneCartLocalRuntime = loadPersistedRuntimeState();
  }
  // Preserve compatibility with an already-created dev/HMR singleton after schema additions.
  globalThis.__sceneCartLocalRuntime.serviceHeartbeats ??= new Map();
  return globalThis.__sceneCartLocalRuntime;
}

export function resetLocalRuntimeForTests() {
  globalThis.__sceneCartLocalRuntime = undefined;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

const AUTHENTICATION_HOLD_PENDING_EVENT = "job.authentication_failure_hold_pending";
const AUTHENTICATION_HOLD_RELEASED_EVENT = "job.authentication_failure_hold_released";

function appendRuntimeEvent(
  state: LocalRuntimeState,
  input: Omit<ExecutionEvent, "id" | "created_at">
) {
  state.eventSequence += 1;
  const event: ExecutionEvent = {
    ...input,
    id: state.eventSequence,
    created_at: new Date().toISOString()
  };
  state.events.push(event);
  if (state.events.length > 5_000) state.events.splice(0, state.events.length - 5_000);
  return event;
}

function authenticationHoldFromEvent(event: ExecutionEvent): AuthenticationFailureHold | null {
  const attempt = Number(event.payload.attempt);
  const deviceId = typeof event.payload.device_id === "string" ? event.payload.device_id : "";
  const leaseToken = typeof event.payload.lease_token === "string" ? event.payload.lease_token : "";
  if (!event.job_id || !deviceId || !leaseToken || !Number.isInteger(attempt) || attempt <= 0) return null;
  return {
    job_id: event.job_id,
    session_id: event.session_id,
    user_id: event.user_id,
    device_id: deviceId,
    attempt,
    lease_token: leaseToken
  };
}

function sameAuthenticationHold(event: ExecutionEvent, hold: AuthenticationFailureHold) {
  return event.job_id === hold.job_id &&
    event.payload.device_id === hold.device_id &&
    Number(event.payload.attempt) === hold.attempt &&
    event.payload.lease_token === hold.lease_token;
}

function activeAuthenticationHoldForJob(
  state: LocalRuntimeState,
  job: RuntimeJob
): AuthenticationFailureHold | null {
  if (!job.lease_token || job.attempts <= 0) return null;
  for (let index = state.events.length - 1; index >= 0; index -= 1) {
    const event = state.events[index];
    if (
      event.job_id !== job.id ||
      Number(event.payload.attempt) !== job.attempts ||
      event.payload.lease_token !== job.lease_token ||
      (
        event.event_type !== AUTHENTICATION_HOLD_PENDING_EVENT &&
        event.event_type !== AUTHENTICATION_HOLD_RELEASED_EVENT
      )
    ) continue;
    return event.event_type === AUTHENTICATION_HOLD_PENDING_EVENT
      ? authenticationHoldFromEvent(event)
      : null;
  }
  return null;
}

export function canAccessSession(session: SessionState, userId?: string) {
  if (!userId) return true;
  // Once an authenticated identity is present, local development must follow
  // the same fail-closed ownership rule as PostgreSQL. Legacy anonymous
  // sessions remain available only to the intentionally anonymous dev mode.
  return session.owner_id === userId;
}

function isActiveWorkflow(session: SessionState) {
  return session.agent_runtime.auto_continue &&
    (session.agent_runtime.workflow_status === "running" ||
      session.agent_runtime.workflow_status === "waiting_for_tools");
}

function workflowTransitionTime(session: SessionState) {
  return session.agent_runtime.last_transition_at ?? session.agent_runtime.initialized_at;
}

function isCurrentPreferredProductDetailJob(session: SessionState, job: RuntimeJob) {
  if (job.job_type !== "product_detail") return false;
  const moduleId = typeof job.payload.module_id === "string" ? job.payload.module_id : "";
  const searchJobId = typeof job.payload.search_job_id === "string" ? job.payload.search_job_id : "";
  const productId = typeof job.payload.product_id === "string" ? job.payload.product_id : "";
  const detailUrl = typeof job.payload.detail_url === "string" ? job.payload.detail_url : "";
  const preferred = session.module_candidates[moduleId]?.[0];
  const provenanceTask = session.hosted_tasks.find((task) =>
    task.task_type === "module_search" &&
    task.module_id === moduleId &&
    task.status === "completed" &&
    typeof task.payload.preferred_product_detail_job_id === "string" &&
    task.payload.preferred_product_detail_job_id.length > 0
  );
  return Boolean(
    preferred?.product_id === productId &&
    preferred.detail_url === detailUrl &&
    provenanceTask &&
    (provenanceTask.runtime_job_id ?? provenanceTask.task_id) === searchJobId &&
    provenanceTask.payload.preferred_product_detail_job_id === job.id &&
    provenanceTask.payload.preferred_product_id === productId
  );
}

function isWorkflowRecoveryCandidate(session: SessionState) {
  if (session.archived_at) return false;
  if (!isActiveWorkflow(session)) return false;

  const workflowRunId = session.agent_runtime.workflow_run_id;
  const hasActiveProductDetail = [...runtimeState().jobs.values()].some((job) => {
    if (
      job.session_id !== session.session_id ||
      job.job_type !== "product_detail" ||
      job.payload.workflow_run_id !== workflowRunId ||
      (job.status !== "pending" && job.status !== "leased" && job.status !== "running")
    ) return false;
    const moduleId = typeof job.payload.module_id === "string" ? job.payload.module_id : "";
    const preferred = session.module_candidates[moduleId]?.[0];
    return isCurrentPreferredProductDetailJob(session, job) &&
      preferred.detail_evidence?.job_id !== job.id;
  });
  if (hasActiveProductDetail) return false;

  const activeTask = session.hosted_tasks.find((task) =>
    task.task_type === "module_search" &&
    (task.status === "pending" || task.status === "running")
  );
  if (!activeTask) return true;
  if (!activeTask.runtime_job_id) return false;

  const job = runtimeState().jobs.get(activeTask.runtime_job_id);
  return job?.status === "completed" || job?.status === "failed" || job?.status === "cancelled";
}

export const localRuntimeRepository: RuntimeRepository = {
  async getSession(sessionId, userId) {
    const session = getSession(sessionId);
    return session && canAccessSession(session, userId) ? session : null;
  },

  async saveSession(state) {
    saveSession(state);
  },

  async listSessions(userId) {
    return listSessions().filter((session) => canAccessSession(session, userId));
  },

  async listWorkflowRecoveryCandidates(userId, limit = 25) {
    const boundedLimit = Math.min(Math.max(limit, 1), 100);
    return listSessions()
      .filter((session) => canAccessSession(session, userId) && isWorkflowRecoveryCandidate(session))
      .sort((a, b) => workflowTransitionTime(a).localeCompare(workflowTransitionTime(b)))
      .slice(0, boundedLimit);
  },

  async createUser(user) {
    const state = runtimeState();
    if ([...state.users.values()].some((item) => item.email === user.email)) {
      throw new Error("email already registered");
    }
    state.users.set(user.id, copy(user));
    persistRuntimeState(state);
    return copy(user);
  },

  async findUserById(userId) {
    const found = runtimeState().users.get(userId);
    return found ? copy(found) : null;
  },

  async findUserByEmail(email) {
    const found = [...runtimeState().users.values()].find((user) => user.email === email);
    return found ? copy(found) : null;
  },

  async createAuthSession(session) {
    const state = runtimeState();
    state.authSessions.set(session.token_hash, copy(session));
    persistRuntimeState(state);
  },

  async findAuthSession(tokenHash) {
    const found = runtimeState().authSessions.get(tokenHash);
    if (!found || new Date(found.expires_at).getTime() <= Date.now()) {
      const state = runtimeState();
      if (state.authSessions.delete(tokenHash)) persistRuntimeState(state);
      return null;
    }
    return copy(found);
  },

  async deleteAuthSession(tokenHash) {
    const state = runtimeState();
    if (state.authSessions.delete(tokenHash)) persistRuntimeState(state);
  },

  async touchAuthSession(tokenHash, minIntervalMs = 0) {
    const state = runtimeState();
    const found = state.authSessions.get(tokenHash);
    if (found) {
      const now = Date.now();
      const previousLastSeenAt = Date.parse(found.last_seen_at);
      if (
        Number.isFinite(previousLastSeenAt) &&
        now - previousLastSeenAt < Math.max(0, minIntervalMs)
      ) return;
      found.last_seen_at = new Date(now).toISOString();
      persistRuntimeState(state);
    }
  },

  async createDevice(device) {
    const state = runtimeState();
    state.devices.set(device.id, copy(device));
    persistRuntimeState(state);
    return copy(device);
  },

  async findDeviceByToken(tokenHash) {
    const found = [...runtimeState().devices.values()].find(
      (device) => device.token_hash === tokenHash && device.status !== "revoked"
    );
    return found ? copy(found) : null;
  },

  async heartbeatDevice(deviceId, status = "online") {
    const state = runtimeState();
    const found = state.devices.get(deviceId);
    if (!found || found.status === "revoked") return null;
    const now = new Date().toISOString();
    const effectiveStatus = status !== "authentication_required" && [...state.jobs.values()].some(
      (job) => activeAuthenticationHoldForJob(state, job)?.device_id === deviceId
    )
      ? "authentication_required"
      : status;
    const statusChanged = found.status !== effectiveStatus;
    found.status = effectiveStatus;
    found.last_heartbeat_at = now;
    found.updated_at = now;
    // Normal online heartbeats remain memory-only to avoid rewriting the full
    // local runtime every 15 seconds. Authentication transitions are durable.
    if (statusChanged) persistRuntimeState(state);
    return copy(found);
  },

  async listDevices(userId) {
    return [...runtimeState().devices.values()]
      .filter((device) => userId === undefined || device.user_id === userId)
      .map(copy);
  },

  async updateDeviceCapabilities(deviceId, userId, capabilities) {
    const state = runtimeState();
    const found = state.devices.get(deviceId);
    if (!found || found.user_id !== userId || found.status === "revoked") return null;
    found.capabilities = [...capabilities];
    found.updated_at = new Date().toISOString();
    persistRuntimeState(state);
    return copy(found);
  },

  async revokeDevice(deviceId, userId) {
    const state = runtimeState();
    const found = state.devices.get(deviceId);
    if (!found || found.user_id !== userId) return false;
    found.status = "revoked";
    found.updated_at = new Date().toISOString();
    persistRuntimeState(state);
    return true;
  },

  async createJob(input) {
    if (getSession(input.session_id)?.archived_at) {
      throw new Error("session archived");
    }
    const state = runtimeState();
    const existing = [...state.jobs.values()].find((job) => job.idempotency_key === input.idempotency_key);
    if (existing) {
      if (existing.status === "failed" || existing.status === "cancelled") {
        if (activeAuthenticationHoldForJob(state, existing)) {
          throw new Error("authentication failure hold requires explicit user release");
        }
        const now = new Date().toISOString();
        existing.status = "pending";
        existing.payload = copy(input.payload);
        existing.priority = input.priority ?? 100;
        existing.attempts = 0;
        existing.max_attempts = input.job_type === "add_to_cart" ? 1 : input.max_attempts ?? 3;
        existing.available_at = now;
        existing.updated_at = now;
        existing.error_message = undefined;
        existing.result = undefined;
        existing.completed_at = undefined;
        existing.lease_owner_id = undefined;
        existing.lease_expires_at = undefined;
        existing.lease_token = undefined;
        existing.lease_protocol = undefined;
      }
      persistRuntimeState(state);
      return copy(existing);
    }
    const now = new Date().toISOString();
    const job: RuntimeJob = {
      ...input,
      status: "pending",
      priority: input.priority ?? 100,
      attempts: 0,
      max_attempts: input.job_type === "add_to_cart" ? 1 : input.max_attempts ?? 3,
      available_at: now,
      created_at: now,
      updated_at: now
    };
    state.jobs.set(job.id, job);
    persistRuntimeState(state);
    return copy(job);
  },

  async getJob(jobId) {
    const found = runtimeState().jobs.get(jobId);
    return found ? copy(found) : null;
  },

  async listJobs(sessionId, userId) {
    return [...runtimeState().jobs.values()]
      .filter((job) => job.session_id === sessionId && (!userId || !job.user_id || job.user_id === userId))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(copy);
  },

  async claimJob(device, leaseMs, protocolVersion = "4") {
    if (device.status !== "online") return null;
    await this.recoverExpiredJobs();
    const state = runtimeState();
    const storedDevice = state.devices.get(device.id);
    if (!storedDevice || storedDevice.status !== "online") return null;
    const now = Date.now();
    const job = [...state.jobs.values()]
      .filter(
        (item) => {
          const authenticationBlocked = Boolean(activeAuthenticationHoldForJob(state, item)) || Boolean(item.lease_token && state.events.some((event) => {
            if (
              event.job_id !== item.id ||
              event.event_type !== "job.claimed" ||
              Number(event.payload.attempt) !== item.attempts ||
              event.payload.lease_token !== item.lease_token
            ) return false;
            const claimingDevice = state.devices.get(String(event.payload.device_id));
            return claimingDevice?.status === "authentication_required";
          }));
          return item.status === "pending" &&
            !authenticationBlocked &&
            !getSession(item.session_id)?.archived_at &&
            new Date(item.available_at).getTime() <= now &&
            (item.user_id === storedDevice.user_id || (!item.user_id && allowUnownedRuntimeJobs())) &&
            storedDevice.capabilities.includes(executorCapabilityForJobType(item.job_type));
        }
      )
      .sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at))[0];
    if (!job) return null;
    job.status = "leased";
    job.lease_owner_id = storedDevice.id;
    job.lease_expires_at = new Date(now + leaseMs).toISOString();
    job.lease_token = randomUUID();
    job.lease_protocol = protocolVersion;
    job.attempts += 1;
    job.updated_at = new Date(now).toISOString();
    persistRuntimeState(state);
    return copy(job);
  },

  async renewJobLease(jobId, deviceId, leaseToken, leaseMs) {
    const state = runtimeState();
    const job = state.jobs.get(jobId);
    if (
      !job ||
      job.lease_owner_id !== deviceId ||
      !job.lease_token ||
      job.lease_token !== leaseToken ||
      (job.status !== "leased" && job.status !== "running")
    ) {
      return null;
    }
    const now = Date.now();
    job.status = "running";
    job.lease_expires_at = new Date(now + Math.max(leaseMs, 5_000)).toISOString();
    job.updated_at = new Date(now).toISOString();
    persistRuntimeState(state);
    return copy(job);
  },

  async completeJob(jobId, deviceId, result, leaseToken) {
    const state = runtimeState();
    const job = state.jobs.get(jobId);
    if (!job) throw new Error("job not found");
    if (job.lease_owner_id !== deviceId) throw new Error("job lease owner mismatch");
    if (!job.lease_token || job.lease_token !== leaseToken) throw new Error("job lease token mismatch");
    if (job.status === "completed") return { job: copy(job), alreadyCompleted: true };
    const now = new Date().toISOString();
    job.status = "completed";
    job.result = copy(result);
    job.completed_at = now;
    job.updated_at = now;
    job.lease_expires_at = undefined;
    persistRuntimeState(state);
    return { job: copy(job), alreadyCompleted: false };
  },

  async failJob(jobId, deviceId, errorMessage, leaseToken, retryDelayMs = 2_000, terminal = false) {
    const state = runtimeState();
    const job = state.jobs.get(jobId);
    if (!job) throw new Error("job not found");
    if (job.lease_owner_id !== deviceId) throw new Error("job lease owner mismatch");
    if (!job.lease_token || job.lease_token !== leaseToken) throw new Error("job lease token mismatch");
    if (job.status === "completed") return copy(job);
    const now = Date.now();
    job.error_message = errorMessage.slice(0, 1000);
    job.updated_at = new Date(now).toISOString();
    job.lease_expires_at = undefined;
    if (!terminal && job.attempts < job.max_attempts) {
      job.status = "pending";
      job.available_at = new Date(now + retryDelayMs).toISOString();
      job.lease_owner_id = undefined;
      job.lease_token = undefined;
    } else {
      job.status = "failed";
      job.completed_at = new Date(now).toISOString();
      job.lease_owner_id = undefined;
    }
    persistRuntimeState(state);
    return copy(job);
  },

  async failAuthenticationJob(jobId, device, errorMessage, leaseToken, leaseTokenHash) {
    const state = runtimeState();
    const storedDevice = state.devices.get(device.id);
    const job = state.jobs.get(jobId);
    if (!storedDevice || storedDevice.status !== "authentication_required") {
      throw new Error("executor authentication pause is not active");
    }
    if (!job) throw new Error("job not found");
    if (job.status === "failed") {
      if (
        !storedDevice.capabilities.includes(executorCapabilityForJobType(job.job_type)) ||
        job.attempts <= 0 ||
        !job.lease_token ||
        job.lease_token !== leaseToken ||
        (job.user_id !== undefined && job.user_id !== storedDevice.user_id)
      ) {
        throw new Error("failed job does not match authentication callback lease");
      }
      job.last_auth_failure_token_hash = leaseTokenHash;
      job.updated_at = new Date().toISOString();
      persistRuntimeState(state);
      return copy(job);
    }
    if (job.status === "completed" || job.status === "cancelled") {
      throw new Error("terminal job cannot accept authentication failure callback");
    }
    const pendingClaimedByDevice = job.status !== "pending" || state.events.some(
      (event) =>
        event.job_id === job.id &&
        event.event_type === "job.claimed" &&
        event.payload.device_id === storedDevice.id &&
        Number(event.payload.attempt) === job.attempts &&
        event.payload.lease_token === job.lease_token
    );
    if (
      (job.job_type !== "module_search" && job.job_type !== "add_to_cart") ||
      !storedDevice.capabilities.includes(executorCapabilityForJobType(job.job_type)) ||
      job.attempts <= 0 ||
      !job.lease_token ||
      job.lease_token !== leaseToken ||
      (job.user_id !== undefined && job.user_id !== storedDevice.user_id) ||
      (job.status !== "pending" && job.status !== "leased" && job.status !== "running") ||
      (job.status !== "pending" && job.lease_owner_id !== storedDevice.id) ||
      !pendingClaimedByDevice
    ) {
      throw new Error("job is not eligible for authentication failure recovery");
    }
    const now = new Date().toISOString();
    job.status = "failed";
    job.error_message = errorMessage.slice(0, 1000);
    job.last_auth_failure_token_hash = leaseTokenHash;
    job.completed_at = now;
    job.updated_at = now;
    job.lease_owner_id = undefined;
    job.lease_expires_at = undefined;
    persistRuntimeState(state);
    return copy(job);
  },

  async holdAuthenticationJob(jobId, device, errorMessage, leaseToken) {
    const state = runtimeState();
    const storedDevice = state.devices.get(device.id);
    const job = state.jobs.get(jobId);
    if (!storedDevice || storedDevice.status === "revoked") {
      throw new Error("executor device unavailable");
    }
    if (!job || job.status === "completed" || job.status === "cancelled") {
      throw new Error("job cannot accept authentication failure hold");
    }
    const claimedByDevice = state.events.some(
      (event) =>
        event.job_id === job.id &&
        event.event_type === "job.claimed" &&
        event.payload.device_id === storedDevice.id &&
        Number(event.payload.attempt) === job.attempts &&
        event.payload.lease_token === leaseToken
    );
    if (
      (job.job_type !== "module_search" && job.job_type !== "add_to_cart") ||
      !storedDevice.capabilities.includes(executorCapabilityForJobType(job.job_type)) ||
      job.attempts <= 0 ||
      !job.lease_token ||
      job.lease_token !== leaseToken ||
      (job.user_id !== undefined && job.user_id !== storedDevice.user_id) ||
      (job.status !== "failed" && job.status !== "pending" && job.status !== "leased" && job.status !== "running") ||
      ((job.status === "leased" || job.status === "running") && job.lease_owner_id !== storedDevice.id) ||
      ((job.status === "pending" || job.status === "failed") && !claimedByDevice)
    ) {
      throw new Error("job is not eligible for authentication failure hold");
    }

    const now = new Date().toISOString();
    storedDevice.status = "authentication_required";
    storedDevice.last_heartbeat_at = now;
    storedDevice.updated_at = now;
    job.status = "failed";
    job.error_message = errorMessage.slice(0, 1000);
    job.completed_at = now;
    job.updated_at = now;
    job.lease_owner_id = undefined;
    job.lease_expires_at = undefined;

    let hold = activeAuthenticationHoldForJob(state, job);
    if (!hold) {
      const event = appendRuntimeEvent(state, {
        user_id: job.user_id,
        session_id: job.session_id,
        job_id: job.id,
        event_type: AUTHENTICATION_HOLD_PENDING_EVENT,
        payload: {
          job_type: job.job_type,
          device_id: storedDevice.id,
          attempt: job.attempts,
          lease_token: leaseToken,
          error: errorMessage.slice(0, 500)
        }
      });
      hold = authenticationHoldFromEvent(event);
    }
    if (!hold) throw new Error("authentication failure hold could not be recorded");
    persistRuntimeState(state);
    return { job: copy(job), device: copy(storedDevice), hold: copy(hold) };
  },

  async getActiveAuthenticationFailureHold(jobId) {
    const state = runtimeState();
    const job = state.jobs.get(jobId);
    if (!job) return null;
    const hold = activeAuthenticationHoldForJob(state, job);
    return hold ? copy(hold) : null;
  },

  async hasActiveAuthenticationFailureHold(deviceId) {
    return (await this.listActiveAuthenticationFailureHolds(deviceId)).length > 0;
  },

  async listActiveAuthenticationFailureHolds(deviceId) {
    const state = runtimeState();
    return [...state.jobs.values()]
      .map((job) => activeAuthenticationHoldForJob(state, job))
      .filter((hold): hold is AuthenticationFailureHold => hold?.device_id === deviceId)
      .map(copy);
  },

  async isAuthenticationFailureHoldReleased(jobId, deviceId, leaseToken) {
    return runtimeState().events.some(
      (event) =>
        event.job_id === jobId &&
        event.event_type === AUTHENTICATION_HOLD_RELEASED_EVENT &&
        event.payload.device_id === deviceId &&
        event.payload.lease_token === leaseToken
    );
  },

  async releaseAuthenticationFailureHold(hold, reason) {
    const state = runtimeState();
    const job = state.jobs.get(hold.job_id);
    if (!job) return false;
    const active = activeAuthenticationHoldForJob(state, job);
    if (
      !active ||
      active.device_id !== hold.device_id ||
      active.attempt !== hold.attempt ||
      active.lease_token !== hold.lease_token
    ) return false;
    appendRuntimeEvent(state, {
      user_id: job.user_id,
      session_id: job.session_id,
      job_id: job.id,
      event_type: AUTHENTICATION_HOLD_RELEASED_EVENT,
      payload: {
        job_type: job.job_type,
        device_id: active.device_id,
        attempt: active.attempt,
        lease_token: active.lease_token,
        reason
      }
    });
    job.last_auth_failure_token_hash = createHash("sha256")
      .update(active.lease_token)
      .digest("hex");
    job.updated_at = new Date().toISOString();
    persistRuntimeState(state);
    return true;
  },

  async cancelJob(jobId, userId) {
    const state = runtimeState();
    const job = state.jobs.get(jobId);
    if (!job || job.status !== "pending") return null;
    if (userId && job.user_id && job.user_id !== userId) return null;
    const now = new Date().toISOString();
    job.status = "cancelled";
    job.error_message = "用户在执行器领取前取消任务";
    job.completed_at = now;
    job.updated_at = now;
    job.lease_token = undefined;
    persistRuntimeState(state);
    return copy(job);
  },

  async recoverExpiredJobs() {
    let recovered = 0;
    const now = Date.now();
    const state = runtimeState();
    for (const job of state.jobs.values()) {
      if (
        (job.status === "leased" || job.status === "running") &&
        job.lease_expires_at &&
        new Date(job.lease_expires_at).getTime() <= now
      ) {
        job.status = job.attempts < job.max_attempts ? "pending" : "failed";
        job.available_at = new Date(now).toISOString();
        job.lease_owner_id = undefined;
        job.lease_expires_at = undefined;
        job.updated_at = new Date(now).toISOString();
        if (job.status === "failed") job.completed_at = job.updated_at;
        recovered += 1;
      }
    }
    if (recovered > 0) persistRuntimeState(state);
    return recovered;
  },

  async recordServiceHeartbeat(heartbeat) {
    const state = runtimeState();
    state.serviceHeartbeats.set(heartbeat.service_name, copy(heartbeat));
    persistRuntimeState(state);
    return copy(heartbeat);
  },

  async getServiceHeartbeat(serviceName) {
    const heartbeat = runtimeState().serviceHeartbeats.get(serviceName);
    return heartbeat ? copy(heartbeat) : null;
  },

  async appendEvent(input) {
    const state = runtimeState();
    const event = appendRuntimeEvent(state, input);
    persistRuntimeState(state);
    return copy(event);
  },

  async listEvents(sessionId, afterId, userId, limit = 100) {
    return runtimeState().events
      .filter(
        (event) =>
          event.session_id === sessionId &&
          event.id > afterId &&
          (!userId || !event.user_id || event.user_id === userId)
      )
      .slice(0, Math.min(Math.max(limit, 1), 500))
      .map(copy);
  },

  async listAuditEvents(userId, limit = 50) {
    return runtimeState().events
      .filter(
        (event) =>
          event.user_id === userId &&
          event.event_type.startsWith("executor.")
      )
      .sort((a, b) => b.id - a.id)
      .slice(0, Math.min(Math.max(limit, 1), 100))
      .map(copy);
  }
};
