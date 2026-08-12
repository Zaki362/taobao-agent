import { createHash, randomUUID } from "node:crypto";
import { createOpaqueToken, hashOpaqueToken } from "@/lib/auth/crypto";
import { getRuntimeRepository } from "@/lib/runtime";
import { withWorkflowSessionTransaction } from "@/lib/runtime/database";
import type {
  AuthenticationFailureHold,
  ExecutorDevice,
  RuntimeJob,
  RuntimeJobType
} from "@/lib/runtime/types";
import type { HostedExecutionTask, SessionState, TaobaoMcpSearchEvidence } from "@/lib/session/types";
import {
  resolveHostedAddToCartTask,
  resolveHostedModuleSearchTask
} from "@/lib/mcp/hosted";
import { reviewModuleCandidatesWithAgent } from "@/lib/agent/candidate-reviewer";
import { mergeAndRankModuleCandidates } from "@/lib/agent/candidate-ranker";
import { isProductCandidate, isTaobaoMcpSearchEvidence } from "@/lib/session/guards";
import { persistSession } from "@/lib/session/repository";

const ALLOWED_CAPABILITIES: RuntimeJobType[] = ["module_search", "add_to_cart"];
const MINIMUM_CAPABILITIES: RuntimeJobType[] = ["module_search"];
export const DEFAULT_JOB_LEASE_MS = 5 * 60 * 1000;
const TAOBAO_MCP_SEARCH_EVIDENCE_SCHEMA = "scenecart.taobao-mcp-search-evidence/v1";
const EVIDENCE_CLOCK_SKEW_MS = 5 * 60 * 1000;

export function isExecutorAuthenticationError(message: string) {
  return /未登录|登录页面|请先登录|auth(?:entication)?[_ ]required|(?:login|passport)\.taobao\.com|login\.tmall\.com/i.test(message);
}

export function authenticationFailureLeaseTokenHash(leaseToken: string) {
  return createHash("sha256").update(leaseToken).digest("hex");
}

export function isAcknowledgedAuthenticationFailure(job: RuntimeJob, leaseToken: string) {
  return Boolean(
    leaseToken &&
    job.last_auth_failure_token_hash === authenticationFailureLeaseTokenHash(leaseToken)
  );
}

export async function isAcknowledgedAuthenticationFailureForDevice(
  job: RuntimeJob,
  deviceId: string,
  leaseToken: string
) {
  return isAcknowledgedAuthenticationFailure(job, leaseToken) ||
    getRuntimeRepository().isAuthenticationFailureHoldReleased(job.id, deviceId, leaseToken);
}

function requiresUserToRestoreToolAccess(message: string) {
  return isExecutorAuthenticationError(message) || /授权|额度已用尽|usage limit|quota exceeded/i.test(message);
}

export function executorAuditSessionId(deviceId: string) {
  return `executor-device:${deviceId}`;
}

function stableDigest(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function taskForJob(input: {
  id: string;
  type: RuntimeJobType;
  state: SessionState;
  moduleId?: string;
  moduleName?: string;
  productId?: string;
  title: string;
  description: string;
  payload: Record<string, unknown>;
}): HostedExecutionTask {
  const now = new Date().toISOString();
  return {
    task_id: input.id,
    runtime_job_id: input.id,
    executor: "local_executor",
    task_type: input.type,
    session_id: input.state.session_id,
    status: "pending",
    title: input.title,
    description: input.description,
    module_id: input.moduleId,
    module_name: input.moduleName,
    product_id: input.productId,
    created_at: now,
    updated_at: now,
    payload: input.payload
  };
}

function restoreTaskForJob(state: SessionState, job: RuntimeJob) {
  const existing = state.hosted_tasks.find((task) => task.task_id === job.id);
  if (existing) return existing;

  const moduleId = typeof job.payload.module_id === "string" ? job.payload.module_id : undefined;
  const moduleName = typeof job.payload.module_name === "string" ? job.payload.module_name : undefined;
  const productId = typeof job.payload.product_id === "string" ? job.payload.product_id : undefined;
  const productTitle = typeof job.payload.product_title === "string"
    ? job.payload.product_title
    : "当前商品";
  const restored = taskForJob({
    id: job.id,
    type: job.job_type,
    state,
    moduleId,
    moduleName,
    productId,
    title: job.job_type === "module_search"
      ? `为「${moduleName ?? "当前模块"}」执行本地淘宝搜索`
      : `将「${productTitle}」加入淘宝购物车`,
    description: "从持久任务记录恢复的执行状态。",
    payload: job.payload
  });
  state.hosted_tasks.unshift(restored);
  return restored;
}

function attachOrReviveTask(state: SessionState, nextTask: HostedExecutionTask, jobStatus: string) {
  const existing = state.hosted_tasks.find((task) => task.task_id === nextTask.task_id);
  if (!existing) {
    state.hosted_tasks.unshift(nextTask);
    return false;
  }

  const requeued =
    jobStatus === "pending" &&
    (existing.status === "failed" || existing.status === "cancelled");
  if (requeued) {
    existing.status = "pending";
    existing.description = nextTask.description;
    existing.payload = nextTask.payload;
    existing.result_summary = undefined;
    existing.error_message = undefined;
    existing.updated_at = new Date().toISOString();
  }
  return requeued;
}

export async function registerExecutorDevice(
  userId: string,
  name: string,
  capabilities: RuntimeJobType[] = MINIMUM_CAPABILITIES
) {
  const repository = getRuntimeRepository();
  const token = createOpaqueToken();
  const now = new Date().toISOString();
  const grantedCapabilities = capabilities.filter((item) => ALLOWED_CAPABILITIES.includes(item));
  const device = await repository.createDevice({
    id: randomUUID(),
    user_id: userId,
    name: name.trim().slice(0, 80) || "本地淘宝执行器",
    token_hash: hashOpaqueToken(token),
    capabilities: grantedCapabilities.length ? grantedCapabilities : MINIMUM_CAPABILITIES,
    status: "offline",
    created_at: now,
    updated_at: now
  });
  await repository.appendEvent({
    user_id: userId,
    session_id: executorAuditSessionId(device.id),
    event_type: "executor.device_registered",
    payload: {
      device_id: device.id,
      device_name: device.name,
      capabilities: device.capabilities
    }
  });
  return { device, token };
}

export async function authenticateExecutorToken(rawToken: string) {
  if (!rawToken) return null;
  return getRuntimeRepository().findDeviceByToken(hashOpaqueToken(rawToken));
}

export function bearerToken(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

export async function enqueueModuleSearchJob(
  state: SessionState,
  input: { moduleId: string; moduleName: string; keyword: string }
) {
  if (state.archived_at) throw new Error("session archived");
  const repository = getRuntimeRepository();
  const existingTask = state.hosted_tasks.find(
    (task) =>
      task.task_type === "module_search" &&
      task.module_id === input.moduleId &&
      task.payload.keyword === input.keyword &&
      (task.status === "pending" || task.status === "running")
  );
  if (existingTask?.runtime_job_id) {
    const existingJob = await repository.getJob(existingTask.runtime_job_id);
    if (existingJob && existingJob.status !== "failed" && existingJob.status !== "cancelled") {
      return existingJob;
    }
  }

  const workflowRunId = state.agent_runtime.workflow_run_id ?? "manual";
  const idempotencyKey = `module-search:${state.session_id}:${input.moduleId}:${stableDigest(input.keyword)}:${workflowRunId}`;
  const jobId = randomUUID();
  const payload = {
    scene_brief: state.scene_brief,
    module_id: input.moduleId,
    module_name: input.moduleName,
    keyword: input.keyword,
    workflow_run_id: workflowRunId,
    budget: state.shopping_plan.modules.find((module) => module.module_id === input.moduleId)?.budget_allocation,
    recommendation_types: ["稳妥推荐", "性价比推荐", "升级推荐"]
  };
  const job = await repository.createJob({
    id: jobId,
    user_id: state.owner_id,
    session_id: state.session_id,
    job_type: "module_search",
    idempotency_key: idempotencyKey,
    payload,
    priority: 120,
    max_attempts: 3
  });

  const requeued = attachOrReviveTask(state, taskForJob({
    id: job.id,
    type: "module_search",
    state,
    moduleId: input.moduleId,
    moduleName: input.moduleName,
    title: `为「${input.moduleName}」执行本地淘宝搜索`,
    description: `本地执行器将直接使用淘宝 Skill 搜索“${input.keyword}”，完成后自动回填候选商品与淘宝链接。`,
    payload
  }), job.status);
  state.execution_mode = "local_executor";
  state.mcp_status = "hosted";
  await repository.appendEvent({
    user_id: state.owner_id,
    session_id: state.session_id,
    job_id: job.id,
    event_type: requeued ? "job.requeued" : "job.created",
    payload: {
      job_type: job.job_type,
      module_id: input.moduleId,
      module_name: input.moduleName,
      workflow_run_id: workflowRunId
    }
  });
  return job;
}

export async function enqueueAddToCartJob(
  state: SessionState,
  input: { productId: string; title: string; moduleId: string; moduleName?: string }
) {
  if (state.archived_at) throw new Error("session archived");
  const repository = getRuntimeRepository();
  const idempotencyKey = `add-to-cart:${state.session_id}:${input.productId}`;
  const payload = {
    product_id: input.productId,
    product_title: input.title,
    confirmed: true,
    quantity: 1
  };
  const job = await repository.createJob({
    id: randomUUID(),
    user_id: state.owner_id,
    session_id: state.session_id,
    job_type: "add_to_cart",
    idempotency_key: idempotencyKey,
    payload,
    priority: 200,
    // A cart mutation is not replay-safe. Any uncertain attempt must become
    // terminal and require a fresh, explicit user confirmation.
    max_attempts: 1
  });
  const requeued = attachOrReviveTask(state, taskForJob({
    id: job.id,
    type: "add_to_cart",
    state,
    moduleId: input.moduleId,
    moduleName: input.moduleName,
    productId: input.productId,
    title: `将「${input.title}」加入淘宝购物车`,
    description: "本地执行器将在用户已确认的前提下完成真实加购。",
    payload
  }), job.status);
  await repository.appendEvent({
    user_id: state.owner_id,
    session_id: state.session_id,
    job_id: job.id,
    event_type: requeued ? "job.requeued" : "job.created",
    payload: { job_type: job.job_type, product_id: input.productId }
  });
  return job;
}

function resultCandidates(result: Record<string, unknown>) {
  const candidates = Array.isArray(result.candidates)
    ? result.candidates.filter(isProductCandidate)
    : [];
  return candidates;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isTrustedTaobaoDetailUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const hostname = url.hostname.toLowerCase();
    return ["taobao.com", "tmall.com", "tmall.hk", "tb.cn"].some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}

function strictTaobaoMcpEvidence(result: Record<string, unknown>) {
  const evidence = isRecord(result.evidence) ? result.evidence : undefined;
  return evidence?.schema === TAOBAO_MCP_SEARCH_EVIDENCE_SCHEMA ? evidence : undefined;
}

function validateTaobaoMcpSearchResult(
  job: RuntimeJob,
  result: Record<string, unknown>,
  options: { required?: boolean; now?: number } = {}
): TaobaoMcpSearchEvidence | undefined {
  const rawEvidence = strictTaobaoMcpEvidence(result);
  // Results produced before the versioned evidence protocol remain recoverable,
  // but they never receive the UI's "本次淘宝 MCP" attestation.
  if (!rawEvidence) {
    if (options.required) {
      throw new Error("淘宝 MCP 在线搜索缺少 v1 完整证据，已拒绝完成任务");
    }
    return undefined;
  }
  if (!isTaobaoMcpSearchEvidence(rawEvidence)) {
    throw new Error("淘宝 MCP 搜索证据结构无效，已拒绝完成任务");
  }

  const moduleId = typeof job.payload.module_id === "string" ? job.payload.module_id.trim() : "";
  const workflowRunId = typeof job.payload.workflow_run_id === "string"
    ? job.payload.workflow_run_id.trim()
    : "";
  const keyword = typeof job.payload.keyword === "string" ? job.payload.keyword.trim() : "";
  if (
    rawEvidence.job_id !== job.id ||
    rawEvidence.module_id !== moduleId ||
    rawEvidence.workflow_run_id !== workflowRunId ||
    rawEvidence.keyword !== keyword
  ) {
    throw new Error("淘宝 MCP 搜索证据与当前 Job 上下文不一致，已拒绝完成任务");
  }
  if (rawEvidence.source_app.trim().length > 120) {
    throw new Error("淘宝 MCP 搜索证据的 source_app 无效，已拒绝完成任务");
  }

  const capturedAt = Date.parse(rawEvidence.captured_at);
  const jobCreatedAt = Date.parse(job.created_at);
  if (
    !Number.isFinite(jobCreatedAt) ||
    capturedAt < jobCreatedAt - EVIDENCE_CLOCK_SKEW_MS ||
    capturedAt > (options.now ?? Date.now()) + EVIDENCE_CLOCK_SKEW_MS
  ) {
    throw new Error("淘宝 MCP 搜索证据时间无效，已拒绝完成任务");
  }

  const rawCandidates = result.candidates;
  if (!Array.isArray(rawCandidates) || !rawCandidates.every(isProductCandidate)) {
    throw new Error("淘宝 MCP 搜索结果包含无效候选，已拒绝完成任务");
  }
  if (rawEvidence.raw_result_count < rawCandidates.length || rawEvidence.raw_result_count > 10_000) {
    throw new Error("淘宝 MCP 搜索证据的结果数量无效，已拒绝完成任务");
  }
  for (const candidate of rawCandidates) {
    if (
      candidate.source !== "淘宝" ||
      candidate.module_id !== moduleId ||
      !isTrustedTaobaoDetailUrl(candidate.detail_url)
    ) {
      throw new Error("淘宝 MCP 候选来源、模块或详情链接无效，已拒绝完成任务");
    }
  }
  return rawEvidence;
}

function isIsolatedInterviewDemoSearch(result: Record<string, unknown>) {
  return (
    process.env.SCENECART_INTERVIEW_DEMO === "true" &&
    result.execution_mode === "interview_demo"
  );
}

function updateRuntimeSearchTrace(
  state: SessionState,
  job: { payload: Record<string, unknown> },
  incomingCount: number,
  previousCandidateCount: number,
  candidates: ReturnType<typeof resultCandidates>
) {
  const moduleId = typeof job.payload.module_id === "string" ? job.payload.module_id : "";
  const module = state.shopping_plan.modules.find((item) => item.module_id === moduleId);
  if (!module) return;
  const keyword = typeof job.payload.keyword === "string"
    ? job.payload.keyword
    : module.search_strategy?.primary_keyword || module.search_keyword || module.module_name;
  const now = new Date().toISOString();
  const previous = state.module_search_traces[moduleId];
  const previousAttempts = previous?.attempts ?? [];
  const attempts = previousAttempts.some((attempt) => attempt.keyword === keyword)
    ? previousAttempts.map((attempt) => attempt.keyword === keyword
        ? {
            ...attempt,
            status: "success" as const,
            result_count: incomingCount,
            reason: previousCandidateCount > 0
              ? "本地执行器已完成补搜，并与已有候选池合并重排。"
              : "本地执行器已完成真实淘宝搜索并生成候选池。",
            created_at: now
          }
        : attempt)
    : [
        ...previousAttempts,
        {
          keyword,
          status: "success" as const,
          result_count: incomingCount,
          reason: previousCandidateCount > 0
            ? "本地执行器已完成补搜，并与已有候选池合并重排。"
            : "本地执行器已完成真实淘宝搜索并生成候选池。",
          created_at: now
        }
      ];
  const review = state.module_reviews[moduleId];
  state.module_search_traces[moduleId] = {
    module_id: moduleId,
    module_name: module.module_name,
    status: candidates.length === 0
      ? "failed"
      : previousCandidateCount > 0 && incomingCount > 0
        ? "recovered"
        : review?.status === "ready"
          ? "ready"
          : "thin",
    primary_keyword: previous?.primary_keyword || keyword,
    searched_keywords: [...new Set([...(previous?.searched_keywords ?? []), keyword])],
    attempts,
    result_count: attempts.reduce((sum, attempt) => sum + Math.max(0, attempt.result_count), 0),
    candidate_count: candidates.length,
    review_status: review?.status,
    review_summary: review?.summary,
    recovery_keyword: previousCandidateCount > 0 ? keyword : review?.suggested_keyword,
    ai_decision_summary: candidates.length > 0
      ? previousCandidateCount > 0
        ? incomingCount > 0
          ? `「${module.module_name}」本轮补搜返回 ${incomingCount} 个商品，跨轮次合并重排后保留 ${candidates.length} 个候选。`
          : `「${module.module_name}」本轮补搜未返回新商品，继续保留此前的 ${candidates.length} 个候选。`
        : `「${module.module_name}」本轮返回 ${incomingCount} 个商品，重排后保留 ${candidates.length} 个候选。`
      : `「${module.module_name}」真实搜索已完成，但没有形成可用候选，本轮将跳过该模块。`,
    next_action: candidates.length > 0
      ? review?.next_action || "查看候选商品并按需确认详情。"
      : "跳过当前模块并继续后续规划，或由用户稍后手动换词补搜。",
    generated_at: previous?.generated_at ?? now,
    updated_at: now
  };
}

function markRuntimeSearchFailure(state: SessionState, job: { payload: Record<string, unknown> }, errorMessage: string) {
  const moduleId = typeof job.payload.module_id === "string" ? job.payload.module_id : "";
  const module = state.shopping_plan.modules.find((item) => item.module_id === moduleId);
  if (!module) return;
  const keyword = typeof job.payload.keyword === "string"
    ? job.payload.keyword
    : module.search_strategy?.primary_keyword || module.search_keyword || module.module_name;
  const now = new Date().toISOString();
  const previous = state.module_search_traces[moduleId];
  const preservedCandidateCount = state.module_candidates[moduleId]?.length ?? 0;
  const attempts = (previous?.attempts ?? []).filter((attempt) => attempt.status !== "skipped");
  attempts.push({
    keyword,
    reason: "本地执行器达到最大重试次数后仍未完成搜索。",
    result_count: 0,
    status: "error",
    error_message: errorMessage.slice(0, 300),
    created_at: now
  });
  state.module_search_traces[moduleId] = {
    module_id: moduleId,
    module_name: module.module_name,
    status: preservedCandidateCount > 0 ? previous?.status ?? "thin" : "failed",
    primary_keyword: previous?.primary_keyword || keyword,
    searched_keywords: [...new Set([...(previous?.searched_keywords ?? []), keyword])],
    attempts,
    result_count: previous?.result_count ?? 0,
    candidate_count: preservedCandidateCount,
    review_status: previous?.review_status,
    review_summary: previous?.review_summary,
    recovery_keyword: previous?.recovery_keyword,
    ai_decision_summary: preservedCandidateCount > 0
      ? `「${module.module_name}」本轮补搜失败，已保留此前的 ${preservedCandidateCount} 个候选，不影响后续模块。`
      : `「${module.module_name}」在自动重试后仍未完成，Agent 将跳过该模块避免阻塞。`,
    next_action: preservedCandidateCount > 0
      ? "继续使用已保留候选，并推进后续模块。"
      : "继续后续模块；用户可在结果页手动换词补搜。",
    generated_at: previous?.generated_at ?? now,
    updated_at: now
  };
  if (requiresUserToRestoreToolAccess(errorMessage)) {
    state.agent_runtime.workflow_status = "paused";
    state.agent_runtime.auto_continue = false;
    state.agent_runtime.current_module_id = moduleId;
    state.agent_runtime.workflow_message = errorMessage.includes("未登录") || errorMessage.includes("登录页面")
      ? "淘宝账号当前未登录，搜索已安全暂停；重新登录后可从当前进度继续。"
      : "本地工具授权当前不可用，搜索已安全暂停；恢复授权后可继续。";
    state.agent_runtime.last_transition_at = now;
  }
}

async function persistCompletedRuntimeJobResult(
  job: RuntimeJob,
  result: Record<string, unknown>,
  recovered: boolean
) {
  const repository = getRuntimeRepository();
  const state = await repository.getSession(job.session_id, job.user_id);
  if (!state) throw new Error("session not found for completed job");
  const task = state.hosted_tasks.find((item) => item.task_id === job.id) ??
    (recovered ? restoreTaskForJob(state, job) : undefined);
  if (!task) throw new Error("execution task not found for completed job");
  const expectedTaskStatus = job.job_type === "add_to_cart" && result.success === false
    ? "failed"
    : "completed";
  if (task.status === expectedTaskStatus) return false;

  const taobaoMcpEvidence = job.job_type === "module_search" && !isIsolatedInterviewDemoSearch(result)
    ? validateTaobaoMcpSearchResult(job, result)
    : undefined;

  if (job.job_type === "module_search") {
    const incomingCandidates = resultCandidates(result);
    let candidates = incomingCandidates;
    const moduleId = typeof job.payload.module_id === "string" ? job.payload.module_id : "";
    const module = state.shopping_plan.modules.find((item) => item.module_id === moduleId);
    const previousCandidateCount = state.module_candidates[moduleId]?.length ?? 0;
    if (module) {
      candidates = mergeAndRankModuleCandidates(
        state.scene_brief,
        module,
        state.module_candidates[moduleId] ?? [],
        incomingCandidates,
        {
          rerank_rules: state.shopping_plan.agent_directives.rerank_rules,
          budget_guardrails: state.shopping_plan.execution_strategy.budget_guardrails
        }
      ).candidates;
    }
    const assessment = module && candidates.length > 0
      ? await reviewModuleCandidatesWithAgent(state, module, candidates)
      : null;
    if (assessment) {
      candidates = assessment.candidates;
    }
    resolveHostedModuleSearchTask(state, {
      task_id: task.task_id,
      status: "completed",
      candidates,
      review: assessment?.review,
      result_summary: typeof result.summary === "string"
        ? result.summary
        : recovered
          ? "已从持久化结果恢复淘宝搜索候选"
          : "本地执行器已完成淘宝搜索"
    });
    if (taobaoMcpEvidence) {
      task.payload = {
        ...task.payload,
        taobao_mcp_evidence: taobaoMcpEvidence
      };
    }
    updateRuntimeSearchTrace(state, job, incomingCandidates.length, previousCandidateCount, candidates);
  } else {
    const isInterviewDemoCart =
      process.env.SCENECART_INTERVIEW_DEMO === "true" &&
      result.demo_fallback === true &&
      result.execution_mode === "interview_demo";
    resolveHostedAddToCartTask(state, {
      task_id: task.task_id,
      status: result.success === false ? "failed" : "completed",
      result_summary: typeof result.message === "string"
        ? result.message
        : recovered
          ? "已从持久化结果恢复加购状态"
          : "本地执行器已完成加购",
      selected_spec: typeof result.selected_spec === "string" ? result.selected_spec : undefined,
      cart_source: isInterviewDemoCart ? "demo" : "taobao",
      cart_note: isInterviewDemoCart && typeof result.cart_note === "string"
        ? result.cart_note
        : undefined
    });
  }
  await persistSession(state);
  await repository.appendEvent({
    user_id: job.user_id,
    session_id: job.session_id,
    job_id: job.id,
    event_type: recovered ? "job.result_reconciled" : "job.completed",
    payload: {
      job_type: job.job_type,
      result_summary: task.result_summary ?? "执行完成",
      recovered,
      ...(taobaoMcpEvidence
        ? {
            evidence: {
              source: taobaoMcpEvidence.source,
              tool: taobaoMcpEvidence.tool,
              source_app: taobaoMcpEvidence.source_app,
              job_id: taobaoMcpEvidence.job_id,
              module_id: taobaoMcpEvidence.module_id,
              workflow_run_id: taobaoMcpEvidence.workflow_run_id,
              keyword: taobaoMcpEvidence.keyword,
              captured_at: taobaoMcpEvidence.captured_at,
              cache_hit: taobaoMcpEvidence.cache_hit,
              raw_result_count: taobaoMcpEvidence.raw_result_count
            }
          }
        : {})
    }
  });
  return true;
}

async function applyCompletedRuntimeJobLocked(
  jobId: string,
  device: ExecutorDevice,
  result: Record<string, unknown>
) {
  const repository = getRuntimeRepository();
  const pendingJob = await repository.getJob(jobId);
  if (!pendingJob) throw new Error("job not found");
  if (pendingJob.status !== "completed") {
    const pendingState = await repository.getSession(pendingJob.session_id, pendingJob.user_id);
    if (!pendingState) throw new Error("session not found for completed job");
    if (!pendingState.hosted_tasks.some((item) => item.task_id === pendingJob.id)) {
      throw new Error("execution task not found for completed job");
    }
    if (pendingJob.job_type === "module_search") {
      if (!isIsolatedInterviewDemoSearch(result)) {
        validateTaobaoMcpSearchResult(pendingJob, result, { required: true });
      }
    }
  }
  const completion = await repository.completeJob(jobId, device.id, result);
  const effectiveResult = completion.alreadyCompleted && completion.job.result
    ? completion.job.result
    : result;
  await persistCompletedRuntimeJobResult(
    completion.job,
    effectiveResult,
    completion.alreadyCompleted
  );
  return completion;
}

export async function applyCompletedRuntimeJob(jobId: string, device: ExecutorDevice, result: Record<string, unknown>) {
  const job = await getRuntimeRepository().getJob(jobId);
  if (!job) throw new Error("job not found");
  return withWorkflowSessionTransaction(
    job.session_id,
    () => applyCompletedRuntimeJobLocked(jobId, device, result)
  );
}

export async function reconcileCompletedRuntimeJob(jobId: string) {
  const job = await getRuntimeRepository().getJob(jobId);
  if (!job || job.status !== "completed") return false;
  return withWorkflowSessionTransaction(
    job.session_id,
    async () => {
      const current = await getRuntimeRepository().getJob(jobId);
      if (!current || current.status !== "completed") return false;
      return persistCompletedRuntimeJobResult(current, current.result ?? {}, true);
    }
  );
}

async function reconcileTerminalRuntimeJobLocked(
  jobId: string,
  options: { forcePersist?: boolean } = {}
) {
  const repository = getRuntimeRepository();
  const job = await repository.getJob(jobId);
  if (!job || (job.status !== "failed" && job.status !== "cancelled")) return false;
  const state = await repository.getSession(job.session_id, job.user_id);
  if (!state) return false;
  const task = state.hosted_tasks.find((item) => item.task_id === job.id) ?? restoreTaskForJob(state, job);
  const message = job.error_message || (job.status === "cancelled" ? "用户已取消任务" : "本地执行器执行失败");
  const moduleId = typeof job.payload.module_id === "string" ? job.payload.module_id : "";
  const authenticationPauseMissing =
    job.status === "failed" &&
    job.job_type === "module_search" &&
    requiresUserToRestoreToolAccess(message) &&
    (
      state.agent_runtime.workflow_status !== "paused" ||
      state.agent_runtime.auto_continue ||
      state.agent_runtime.current_module_id !== moduleId
    );
  const taskTransitionMissing = task.status !== job.status;
  if (!taskTransitionMissing && !authenticationPauseMissing) {
    if (!options.forcePersist) return false;
    await persistSession(state);
    return true;
  }

  if (job.status === "failed") {
    if (job.job_type === "module_search") {
      if (taskTransitionMissing) {
        resolveHostedModuleSearchTask(state, {
          task_id: task.task_id,
          status: "failed",
          error_message: message
        });
      }
      markRuntimeSearchFailure(state, job, message);
    } else {
      if (taskTransitionMissing) {
        resolveHostedAddToCartTask(state, {
          task_id: task.task_id,
          status: "failed",
          error_message: message
        });
      }
    }
  } else {
    task.status = "cancelled";
    task.error_message = message.slice(0, 500);
    task.updated_at = new Date().toISOString();
    state.agent_runtime.workflow_status = "paused";
    state.agent_runtime.auto_continue = false;
    state.agent_runtime.workflow_message = "检测到已取消任务，自动推进保持暂停";
    state.agent_runtime.last_transition_at = new Date().toISOString();
  }

  await persistSession(state);
  await repository.appendEvent({
    user_id: job.user_id,
    session_id: job.session_id,
    job_id: job.id,
    event_type: "job.state_reconciled",
    payload: { job_type: job.job_type, status: job.status }
  });
  return true;
}

export async function reconcileTerminalRuntimeJob(jobId: string) {
  const job = await getRuntimeRepository().getJob(jobId);
  if (!job) return false;
  return withWorkflowSessionTransaction(
    job.session_id,
    () => reconcileTerminalRuntimeJobLocked(jobId)
  );
}

async function releaseMatchingAuthenticationFailureHold(
  jobId: string,
  deviceId: string,
  leaseToken: string,
  reason: "callback_acknowledged" | "user_retry" | "partial_results_accepted"
) {
  const repository = getRuntimeRepository();
  const hold = await repository.getActiveAuthenticationFailureHold(jobId);
  if (!hold || hold.device_id !== deviceId || hold.lease_token !== leaseToken) return false;
  return repository.releaseAuthenticationFailureHold(hold, reason);
}

export async function releaseAuthenticationFailureHoldForUser(
  jobId: string,
  userId: string | undefined,
  reason: "user_retry" | "partial_results_accepted"
) {
  const repository = getRuntimeRepository();
  const job = await repository.getJob(jobId);
  if (!job || (userId && job.user_id && job.user_id !== userId)) return false;
  const hold = await repository.getActiveAuthenticationFailureHold(jobId);
  if (!hold || (userId && hold.user_id && hold.user_id !== userId)) return false;
  return repository.releaseAuthenticationFailureHold(hold, reason);
}

export async function establishAuthenticationFailureHold(
  jobId: string,
  device: ExecutorDevice,
  errorMessage: string,
  leaseToken: string
) {
  const initial = await getRuntimeRepository().getJob(jobId);
  if (!initial) throw new Error("job not found");
  return withWorkflowSessionTransaction(initial.session_id, async () => {
    const repository = getRuntimeRepository();
    const current = await repository.getJob(jobId);
    if (!current) throw new Error("job not found");
    if (
      !isExecutorAuthenticationError(errorMessage) ||
      leaseToken.length < 16 ||
      leaseToken.length > 200 ||
      !device.capabilities.includes(current.job_type) ||
      (current.user_id !== undefined && current.user_id !== device.user_id)
    ) {
      throw new Error("invalid authentication failure hold");
    }
    if (await isAcknowledgedAuthenticationFailureForDevice(current, device.id, leaseToken)) {
      const pausedDevice = await repository.heartbeatDevice(device.id, "authentication_required");
      if (!pausedDevice) throw new Error("executor device unavailable");
      return {
        job: current,
        device: pausedDevice,
        hold: null as AuthenticationFailureHold | null,
        authenticationFailureAcknowledged: true
      };
    }
    const held = await repository.holdAuthenticationJob(jobId, device, errorMessage, leaseToken);
    await reconcileTerminalRuntimeJobLocked(jobId, { forcePersist: true });
    await repository.appendEvent({
      user_id: held.job.user_id,
      session_id: held.job.session_id,
      job_id: held.job.id,
      event_type: "job.failed",
      payload: {
        job_type: held.job.job_type,
        attempts: held.job.attempts,
        error: errorMessage.slice(0, 500),
        authentication_failure_hold: true,
        executor_device_id: held.device.id
      }
    });
    return {
      ...held,
      authenticationFailureAcknowledged: false
    };
  });
}

export async function reconcileAuthenticationFailureHoldsForDevice(
  deviceId: string,
  options: { releaseCartAfterVerifiedLogin?: boolean } = {}
) {
  const repository = getRuntimeRepository();
  const holds = await repository.listActiveAuthenticationFailureHolds(deviceId);
  for (const hold of holds) {
    await withWorkflowSessionTransaction(hold.session_id, async () => {
      const current = await repository.getActiveAuthenticationFailureHold(hold.job_id);
      if (
        !current ||
        current.device_id !== hold.device_id ||
        current.attempt !== hold.attempt ||
        current.lease_token !== hold.lease_token
      ) return;
      await reconcileTerminalRuntimeJobLocked(hold.job_id, { forcePersist: true });
      if (options.releaseCartAfterVerifiedLogin) {
        const job = await repository.getJob(hold.job_id);
        if (job?.job_type === "add_to_cart") {
          await repository.releaseAuthenticationFailureHold(
            current,
            "cart_authentication_recovered"
          );
        }
      }
    });
  }
  return {
    repaired: holds.length,
    active: await repository.hasActiveAuthenticationFailureHold(deviceId)
  };
}

async function applyFailedRuntimeJobLocked(
  jobId: string,
  device: ExecutorDevice,
  errorMessage: string,
  options: {
    retryable?: boolean;
    authenticationFailureCallback?: boolean;
    leaseToken?: string;
  } = {}
) {
  const repository = getRuntimeRepository();
  const existing = await repository.getJob(jobId);
  if (!existing) throw new Error("job not found");
  const authenticationFailureCallback = options.authenticationFailureCallback === true;
  const authenticationFailureAlreadyAcknowledged =
    authenticationFailureCallback &&
    typeof options.leaseToken === "string" &&
    await isAcknowledgedAuthenticationFailureForDevice(
      existing,
      device.id,
      options.leaseToken
    );
  if (authenticationFailureCallback) {
    if (
      options.retryable !== false ||
      device.status !== "authentication_required" ||
      !isExecutorAuthenticationError(errorMessage) ||
      typeof options.leaseToken !== "string" ||
      options.leaseToken.length < 16 ||
      options.leaseToken.length > 200 ||
      (!authenticationFailureAlreadyAcknowledged && existing.lease_token !== options.leaseToken) ||
      !device.capabilities.includes(existing.job_type) ||
      (existing.user_id !== undefined && existing.user_id !== device.user_id)
    ) {
      throw new Error("invalid authentication failure callback");
    }
  }
  if (authenticationFailureAlreadyAcknowledged && existing.status !== "failed") {
    await repository.appendEvent({
      user_id: existing.user_id,
      session_id: existing.session_id,
      job_id: existing.id,
      event_type: "job.authentication_failure_callback_superseded",
      payload: {
        job_type: existing.job_type,
        executor_device_id: device.id,
        current_status: existing.status
      }
    });
    await releaseMatchingAuthenticationFailureHold(
      existing.id,
      device.id,
      options.leaseToken!,
      "callback_acknowledged"
    );
    return existing;
  }
  if (
    authenticationFailureCallback &&
    (existing.status === "completed" || existing.status === "cancelled")
  ) {
    throw new Error("terminal job cannot accept authentication failure callback");
  }
  if (
    (!authenticationFailureCallback && existing.status === "completed") ||
    (!authenticationFailureCallback && existing.status === "failed") ||
    (!authenticationFailureCallback && existing.status === "cancelled") ||
    (!authenticationFailureCallback && existing.status === "pending" && existing.attempts > 0)
  ) {
    return existing;
  }
  if (authenticationFailureCallback && existing.status === "failed") {
    // The previous callback may have committed the Job transition but lost its
    // HTTP response before session reconciliation or audit completed. Repair
    // those side effects before acknowledging the durable Worker ledger.
    const acknowledgedJob = authenticationFailureAlreadyAcknowledged
      ? existing
      : await repository.failAuthenticationJob(
          jobId,
          device,
          errorMessage,
          options.leaseToken!,
          authenticationFailureLeaseTokenHash(options.leaseToken!)
        );
    const currentState = await repository.getSession(existing.session_id, existing.user_id);
    const currentTask = currentState?.hosted_tasks.find((item) => item.task_id === existing.id);
    const partialResultsAlreadyAccepted =
      currentTask?.payload.user_resolution === "user_skipped" &&
      currentTask.payload.partial_results_status === "partial_results_accepted";
    if (!partialResultsAlreadyAccepted) {
      await reconcileTerminalRuntimeJobLocked(jobId, { forcePersist: true });
    }
    await repository.appendEvent({
      user_id: existing.user_id,
      session_id: existing.session_id,
      job_id: existing.id,
      event_type: "job.authentication_failure_callback_confirmed",
      payload: {
        job_type: existing.job_type,
        executor_device_id: device.id,
        replayed: true,
        user_resolution_preserved: partialResultsAlreadyAccepted
      }
    });
    await releaseMatchingAuthenticationFailureHold(
      acknowledgedJob.id,
      device.id,
      options.leaseToken!,
      "callback_acknowledged"
    );
    return acknowledgedJob;
  }
  const job = authenticationFailureCallback
    ? await repository.failAuthenticationJob(
        jobId,
        device,
        errorMessage,
        options.leaseToken!,
        authenticationFailureLeaseTokenHash(options.leaseToken!)
      )
    : await repository.failJob(
        jobId,
        device.id,
        errorMessage,
        3_000,
        options.retryable === false
      );
  const state = await repository.getSession(job.session_id, job.user_id);
  const task = state?.hosted_tasks.find((item) => item.task_id === job.id);
  if (state && task) {
    if (job.status === "failed") {
      if (job.job_type === "module_search") {
        resolveHostedModuleSearchTask(state, {
          task_id: task.task_id,
          status: "failed",
          error_message: errorMessage
        });
        markRuntimeSearchFailure(state, job, errorMessage);
      } else {
        resolveHostedAddToCartTask(state, {
          task_id: task.task_id,
          status: "failed",
          error_message: errorMessage
        });
      }
    } else {
      task.status = "pending";
      task.error_message = errorMessage.slice(0, 500);
      task.updated_at = new Date().toISOString();
    }
    await persistSession(state);
  }
  await repository.appendEvent({
    user_id: job.user_id,
    session_id: job.session_id,
    job_id: job.id,
    event_type: job.status === "failed" ? "job.failed" : "job.retry_scheduled",
    payload: {
      job_type: job.job_type,
      attempts: job.attempts,
      error: errorMessage.slice(0, 500),
      ...(authenticationFailureCallback
        ? {
            authentication_failure_callback: true,
            executor_device_id: device.id,
            recovered_from_status: existing.status
          }
        : {})
    }
  });
  if (authenticationFailureCallback) {
    await repository.appendEvent({
      user_id: job.user_id,
      session_id: job.session_id,
      job_id: job.id,
      event_type: "job.authentication_failure_callback_applied",
      payload: {
        job_type: job.job_type,
        executor_device_id: device.id,
        recovered_from_status: existing.status
      }
    });
    await releaseMatchingAuthenticationFailureHold(
      job.id,
      device.id,
      options.leaseToken!,
      "callback_acknowledged"
    );
  }
  return job;
}

export async function applyFailedRuntimeJob(
  jobId: string,
  device: ExecutorDevice,
  errorMessage: string,
  options: {
    retryable?: boolean;
    authenticationFailureCallback?: boolean;
    leaseToken?: string;
  } = {}
) {
  const job = await getRuntimeRepository().getJob(jobId);
  if (!job) throw new Error("job not found");
  return withWorkflowSessionTransaction(
    job.session_id,
    () => applyFailedRuntimeJobLocked(jobId, device, errorMessage, options)
  );
}

async function cancelPendingRuntimeJobLocked(jobId: string, userId?: string) {
  const repository = getRuntimeRepository();
  const job = await repository.cancelJob(jobId, userId);
  if (!job) return null;

  const state = await repository.getSession(job.session_id, userId ?? job.user_id);
  const task = state?.hosted_tasks.find((item) => item.task_id === job.id);
  if (state && task) {
    task.status = "cancelled";
    task.error_message = "用户已在执行器领取前取消任务";
    task.updated_at = new Date().toISOString();
    if (job.job_type === "module_search") {
      markRuntimeSearchFailure(state, job, "用户取消了本轮搜索任务");
      state.agent_runtime.workflow_status = "paused";
      state.agent_runtime.auto_continue = false;
      state.agent_runtime.current_module_id =
        typeof job.payload.module_id === "string" ? job.payload.module_id : undefined;
      state.agent_runtime.workflow_message = "用户取消了当前搜索，自动推进已暂停";
      state.agent_runtime.last_transition_at = new Date().toISOString();
    }
    await persistSession(state);
  }

  await repository.appendEvent({
    user_id: job.user_id,
    session_id: job.session_id,
    job_id: job.id,
    event_type: "job.cancelled",
    payload: { job_type: job.job_type, reason: "cancelled_before_claim" }
  });
  return job;
}

export async function cancelPendingRuntimeJob(jobId: string, userId?: string) {
  const job = await getRuntimeRepository().getJob(jobId);
  if (!job) return null;
  return withWorkflowSessionTransaction(
    job.session_id,
    () => cancelPendingRuntimeJobLocked(jobId, userId)
  );
}
