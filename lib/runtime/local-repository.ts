import { getSession, listSessions, saveSession } from "@/lib/session/store";
import type { SessionState } from "@/lib/session/types";
import type {
  AuthSessionRecord,
  CreateRuntimeJobInput,
  ExecutionEvent,
  ExecutorDevice,
  RuntimeJob,
  RuntimeRepository,
  RuntimeUser
} from "@/lib/runtime/types";

interface LocalRuntimeState {
  users: Map<string, RuntimeUser>;
  authSessions: Map<string, AuthSessionRecord>;
  devices: Map<string, ExecutorDevice>;
  jobs: Map<string, RuntimeJob>;
  events: ExecutionEvent[];
  eventSequence: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __sceneCartLocalRuntime: LocalRuntimeState | undefined;
}

function runtimeState() {
  if (!globalThis.__sceneCartLocalRuntime) {
    globalThis.__sceneCartLocalRuntime = {
      users: new Map(),
      authSessions: new Map(),
      devices: new Map(),
      jobs: new Map(),
      events: [],
      eventSequence: 0
    };
  }
  return globalThis.__sceneCartLocalRuntime;
}

export function resetLocalRuntimeForTests() {
  globalThis.__sceneCartLocalRuntime = undefined;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function canAccessSession(session: SessionState, userId?: string) {
  if (!userId) return true;
  return !session.owner_id || session.owner_id === userId;
}

function isActiveWorkflow(session: SessionState) {
  return session.agent_runtime.auto_continue &&
    (session.agent_runtime.workflow_status === "running" ||
      session.agent_runtime.workflow_status === "waiting_for_tools");
}

function workflowTransitionTime(session: SessionState) {
  return session.agent_runtime.last_transition_at ?? session.agent_runtime.initialized_at;
}

function isWorkflowRecoveryCandidate(session: SessionState) {
  if (!isActiveWorkflow(session)) return false;

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
    runtimeState().authSessions.set(session.token_hash, copy(session));
  },

  async findAuthSession(tokenHash) {
    const found = runtimeState().authSessions.get(tokenHash);
    if (!found || new Date(found.expires_at).getTime() <= Date.now()) {
      runtimeState().authSessions.delete(tokenHash);
      return null;
    }
    return copy(found);
  },

  async deleteAuthSession(tokenHash) {
    runtimeState().authSessions.delete(tokenHash);
  },

  async touchAuthSession(tokenHash) {
    const found = runtimeState().authSessions.get(tokenHash);
    if (found) {
      found.last_seen_at = new Date().toISOString();
    }
  },

  async createDevice(device) {
    runtimeState().devices.set(device.id, copy(device));
    return copy(device);
  },

  async findDeviceByToken(tokenHash) {
    const found = [...runtimeState().devices.values()].find(
      (device) => device.token_hash === tokenHash && device.status !== "revoked"
    );
    return found ? copy(found) : null;
  },

  async heartbeatDevice(deviceId) {
    const found = runtimeState().devices.get(deviceId);
    if (!found || found.status === "revoked") return null;
    const now = new Date().toISOString();
    found.status = "online";
    found.last_heartbeat_at = now;
    found.updated_at = now;
    return copy(found);
  },

  async listDevices(userId) {
    return [...runtimeState().devices.values()]
      .filter((device) => device.user_id === userId)
      .map(copy);
  },

  async updateDeviceCapabilities(deviceId, userId, capabilities) {
    const found = runtimeState().devices.get(deviceId);
    if (!found || found.user_id !== userId || found.status === "revoked") return null;
    found.capabilities = [...capabilities];
    found.updated_at = new Date().toISOString();
    return copy(found);
  },

  async revokeDevice(deviceId, userId) {
    const found = runtimeState().devices.get(deviceId);
    if (!found || found.user_id !== userId) return false;
    found.status = "revoked";
    found.updated_at = new Date().toISOString();
    return true;
  },

  async createJob(input) {
    const state = runtimeState();
    const existing = [...state.jobs.values()].find((job) => job.idempotency_key === input.idempotency_key);
    if (existing) {
      if (existing.status === "failed" || existing.status === "cancelled") {
        const now = new Date().toISOString();
        existing.status = "pending";
        existing.payload = copy(input.payload);
        existing.priority = input.priority ?? 100;
        existing.attempts = 0;
        existing.max_attempts = input.max_attempts ?? 3;
        existing.available_at = now;
        existing.updated_at = now;
        existing.error_message = undefined;
        existing.result = undefined;
        existing.completed_at = undefined;
        existing.lease_owner_id = undefined;
        existing.lease_expires_at = undefined;
      }
      return copy(existing);
    }
    const now = new Date().toISOString();
    const job: RuntimeJob = {
      ...input,
      status: "pending",
      priority: input.priority ?? 100,
      attempts: 0,
      max_attempts: input.max_attempts ?? 3,
      available_at: now,
      created_at: now,
      updated_at: now
    };
    state.jobs.set(job.id, job);
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

  async claimJob(device, leaseMs) {
    await this.recoverExpiredJobs();
    const now = Date.now();
    const job = [...runtimeState().jobs.values()]
      .filter(
        (item) =>
          item.status === "pending" &&
          new Date(item.available_at).getTime() <= now &&
          (!item.user_id || item.user_id === device.user_id) &&
          device.capabilities.includes(item.job_type)
      )
      .sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at))[0];
    if (!job) return null;
    job.status = "leased";
    job.lease_owner_id = device.id;
    job.lease_expires_at = new Date(now + leaseMs).toISOString();
    job.attempts += 1;
    job.updated_at = new Date(now).toISOString();
    return copy(job);
  },

  async renewJobLease(jobId, deviceId, leaseMs) {
    const job = runtimeState().jobs.get(jobId);
    if (!job || job.lease_owner_id !== deviceId || (job.status !== "leased" && job.status !== "running")) {
      return null;
    }
    const now = Date.now();
    job.status = "running";
    job.lease_expires_at = new Date(now + Math.max(leaseMs, 5_000)).toISOString();
    job.updated_at = new Date(now).toISOString();
    return copy(job);
  },

  async completeJob(jobId, deviceId, result) {
    const job = runtimeState().jobs.get(jobId);
    if (!job) throw new Error("job not found");
    if (job.status === "completed") return { job: copy(job), alreadyCompleted: true };
    if (job.lease_owner_id !== deviceId) throw new Error("job lease owner mismatch");
    const now = new Date().toISOString();
    job.status = "completed";
    job.result = copy(result);
    job.completed_at = now;
    job.updated_at = now;
    job.lease_expires_at = undefined;
    return { job: copy(job), alreadyCompleted: false };
  },

  async failJob(jobId, deviceId, errorMessage, retryDelayMs = 2_000, terminal = false) {
    const job = runtimeState().jobs.get(jobId);
    if (!job) throw new Error("job not found");
    if (job.status === "completed") return copy(job);
    if (job.lease_owner_id !== deviceId) throw new Error("job lease owner mismatch");
    const now = Date.now();
    job.error_message = errorMessage.slice(0, 1000);
    job.updated_at = new Date(now).toISOString();
    job.lease_expires_at = undefined;
    if (!terminal && job.attempts < job.max_attempts) {
      job.status = "pending";
      job.available_at = new Date(now + retryDelayMs).toISOString();
      job.lease_owner_id = undefined;
    } else {
      job.status = "failed";
      job.completed_at = new Date(now).toISOString();
      job.lease_owner_id = undefined;
    }
    return copy(job);
  },

  async cancelJob(jobId, userId) {
    const job = runtimeState().jobs.get(jobId);
    if (!job || job.status !== "pending") return null;
    if (userId && job.user_id && job.user_id !== userId) return null;
    const now = new Date().toISOString();
    job.status = "cancelled";
    job.error_message = "用户在执行器领取前取消任务";
    job.completed_at = now;
    job.updated_at = now;
    return copy(job);
  },

  async recoverExpiredJobs() {
    let recovered = 0;
    const now = Date.now();
    for (const job of runtimeState().jobs.values()) {
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
    return recovered;
  },

  async appendEvent(input) {
    const state = runtimeState();
    state.eventSequence += 1;
    const event: ExecutionEvent = {
      ...input,
      id: state.eventSequence,
      created_at: new Date().toISOString()
    };
    state.events.push(event);
    if (state.events.length > 5_000) state.events.splice(0, state.events.length - 5_000);
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
