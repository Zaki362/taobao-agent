import type { SessionState } from "@/lib/session/types";

export type RuntimeJobStatus =
  | "pending"
  | "leased"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type ExecutorCapability = "module_search" | "add_to_cart";
export type RuntimeJobType = ExecutorCapability | "product_detail";

export function executorCapabilityForJobType(jobType: RuntimeJobType): ExecutorCapability {
  return jobType === "product_detail" ? "module_search" : jobType;
}

export function claimableJobTypes(capabilities: ExecutorCapability[]): RuntimeJobType[] {
  return capabilities.includes("module_search")
    ? [...capabilities, "product_detail"]
    : [...capabilities];
}

export type ExecutorDeviceStatus =
  | "online"
  | "offline"
  | "mcp_unavailable"
  | "authentication_required"
  | "revoked";

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
  capabilities: ExecutorCapability[];
  status: ExecutorDeviceStatus;
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
  lease_token?: string;
  lease_protocol?: string;
  last_auth_failure_token_hash?: string;
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

export interface AuthenticationFailureHold {
  job_id: string;
  session_id: string;
  user_id?: string;
  device_id: string;
  attempt: number;
  lease_token: string;
}

export interface RuntimeServiceHeartbeat {
  service_name: string;
  status: "healthy" | "degraded" | "failed";
  metadata: Record<string, unknown>;
  checked_at: string;
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
  listWorkflowRecoveryCandidates(userId?: string, limit?: number): Promise<SessionState[]>;

  createUser(user: RuntimeUser): Promise<RuntimeUser>;
  findUserById(userId: string): Promise<RuntimeUser | null>;
  findUserByEmail(email: string): Promise<RuntimeUser | null>;
  createAuthSession(session: AuthSessionRecord): Promise<void>;
  findAuthSession(tokenHash: string): Promise<AuthSessionRecord | null>;
  deleteAuthSession(tokenHash: string): Promise<void>;
  touchAuthSession(tokenHash: string, minIntervalMs?: number): Promise<void>;

  createDevice(device: ExecutorDevice): Promise<ExecutorDevice>;
  findDeviceByToken(tokenHash: string): Promise<ExecutorDevice | null>;
  heartbeatDevice(
    deviceId: string,
    status?: Extract<ExecutorDeviceStatus, "online" | "offline" | "mcp_unavailable" | "authentication_required">
  ): Promise<ExecutorDevice | null>;
  listDevices(userId?: string): Promise<ExecutorDevice[]>;
  updateDeviceCapabilities(
    deviceId: string,
    userId: string,
    capabilities: ExecutorCapability[]
  ): Promise<ExecutorDevice | null>;
  revokeDevice(deviceId: string, userId: string): Promise<boolean>;

  createJob(input: CreateRuntimeJobInput): Promise<RuntimeJob>;
  getJob(jobId: string): Promise<RuntimeJob | null>;
  listJobs(sessionId: string, userId?: string): Promise<RuntimeJob[]>;
  claimJob(device: ExecutorDevice, leaseMs: number, protocolVersion?: string): Promise<RuntimeJob | null>;
  renewJobLease(
    jobId: string,
    deviceId: string,
    leaseToken: string,
    leaseMs: number
  ): Promise<RuntimeJob | null>;
  completeJob(
    jobId: string,
    deviceId: string,
    result: Record<string, unknown>,
    leaseToken: string
  ): Promise<{ job: RuntimeJob; alreadyCompleted: boolean }>;
  failJob(
    jobId: string,
    deviceId: string,
    errorMessage: string,
    leaseToken: string,
    retryDelayMs?: number,
    terminal?: boolean
  ): Promise<RuntimeJob>;
  failAuthenticationJob(
    jobId: string,
    device: ExecutorDevice,
    errorMessage: string,
    leaseToken: string,
    leaseTokenHash: string
  ): Promise<RuntimeJob>;
  holdAuthenticationJob(
    jobId: string,
    device: ExecutorDevice,
    errorMessage: string,
    leaseToken: string
  ): Promise<{ job: RuntimeJob; device: ExecutorDevice; hold: AuthenticationFailureHold }>;
  getActiveAuthenticationFailureHold(jobId: string): Promise<AuthenticationFailureHold | null>;
  listActiveAuthenticationFailureHolds(deviceId: string): Promise<AuthenticationFailureHold[]>;
  hasActiveAuthenticationFailureHold(deviceId: string): Promise<boolean>;
  isAuthenticationFailureHoldReleased(
    jobId: string,
    deviceId: string,
    leaseToken: string
  ): Promise<boolean>;
  releaseAuthenticationFailureHold(
    hold: AuthenticationFailureHold,
    reason:
      | "callback_acknowledged"
      | "user_retry"
      | "partial_results_accepted"
      | "cart_authentication_recovered"
  ): Promise<boolean>;
  cancelJob(jobId: string, userId?: string): Promise<RuntimeJob | null>;
  recoverExpiredJobs(): Promise<number>;

  recordServiceHeartbeat(heartbeat: RuntimeServiceHeartbeat): Promise<RuntimeServiceHeartbeat>;
  getServiceHeartbeat(serviceName: string): Promise<RuntimeServiceHeartbeat | null>;

  appendEvent(input: Omit<ExecutionEvent, "id" | "created_at">): Promise<ExecutionEvent>;
  listEvents(sessionId: string, afterId: number, userId?: string, limit?: number): Promise<ExecutionEvent[]>;
  listAuditEvents(userId: string, limit?: number): Promise<ExecutionEvent[]>;
}
