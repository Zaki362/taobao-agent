import type { SessionState } from "@/lib/session/types";

export type RuntimeJobStatus =
  | "pending"
  | "leased"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type RuntimeJobType = "module_search" | "add_to_cart";

export interface RuntimeUser {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
}

export interface AuthSessionRecord {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
  last_seen_at: string;
}

export interface ExecutorDevice {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  capabilities: RuntimeJobType[];
  status: "online" | "offline" | "revoked";
  last_heartbeat_at?: string;
  created_at: string;
  updated_at: string;
}

export interface RuntimeJob {
  id: string;
  user_id?: string;
  session_id: string;
  job_type: RuntimeJobType;
  idempotency_key: string;
  payload: Record<string, unknown>;
  status: RuntimeJobStatus;
  priority: number;
  attempts: number;
  max_attempts: number;
  available_at: string;
  lease_owner_id?: string;
  lease_expires_at?: string;
  result?: Record<string, unknown>;
  error_message?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

export interface ExecutionEvent {
  id: number;
  user_id?: string;
  session_id: string;
  job_id?: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface CreateRuntimeJobInput {
  id: string;
  user_id?: string;
  session_id: string;
  job_type: RuntimeJobType;
  idempotency_key: string;
  payload: Record<string, unknown>;
  priority?: number;
  max_attempts?: number;
}

export interface RuntimeRepository {
  getSession(sessionId: string, userId?: string): Promise<SessionState | null>;
  saveSession(state: SessionState): Promise<void>;
  listSessions(userId?: string): Promise<SessionState[]>;

  createUser(user: RuntimeUser): Promise<RuntimeUser>;
  findUserById(userId: string): Promise<RuntimeUser | null>;
  findUserByEmail(email: string): Promise<RuntimeUser | null>;
  createAuthSession(session: AuthSessionRecord): Promise<void>;
  findAuthSession(tokenHash: string): Promise<AuthSessionRecord | null>;
  deleteAuthSession(tokenHash: string): Promise<void>;
  touchAuthSession(tokenHash: string): Promise<void>;

  createDevice(device: ExecutorDevice): Promise<ExecutorDevice>;
  findDeviceByToken(tokenHash: string): Promise<ExecutorDevice | null>;
  heartbeatDevice(deviceId: string): Promise<ExecutorDevice | null>;
  listDevices(userId: string): Promise<ExecutorDevice[]>;
  revokeDevice(deviceId: string, userId: string): Promise<boolean>;

  createJob(input: CreateRuntimeJobInput): Promise<RuntimeJob>;
  getJob(jobId: string): Promise<RuntimeJob | null>;
  listJobs(sessionId: string, userId?: string): Promise<RuntimeJob[]>;
  claimJob(device: ExecutorDevice, leaseMs: number): Promise<RuntimeJob | null>;
  renewJobLease(jobId: string, deviceId: string, leaseMs: number): Promise<RuntimeJob | null>;
  completeJob(
    jobId: string,
    deviceId: string,
    result: Record<string, unknown>
  ): Promise<{ job: RuntimeJob; alreadyCompleted: boolean }>;
  failJob(
    jobId: string,
    deviceId: string,
    errorMessage: string,
    retryDelayMs?: number,
    terminal?: boolean
  ): Promise<RuntimeJob>;
  cancelJob(jobId: string, userId?: string): Promise<RuntimeJob | null>;
  recoverExpiredJobs(): Promise<number>;

  appendEvent(input: Omit<ExecutionEvent, "id" | "created_at">): Promise<ExecutionEvent>;
  listEvents(sessionId: string, afterId: number, userId?: string, limit?: number): Promise<ExecutionEvent[]>;
}
