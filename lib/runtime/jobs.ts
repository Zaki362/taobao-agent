import { createHash, randomUUID } from "node:crypto";
import { createOpaqueToken, hashOpaqueToken } from "@/lib/auth/crypto";
import { getRuntimeRepository } from "@/lib/runtime";
import type { ExecutorDevice, RuntimeJobType } from "@/lib/runtime/types";
import type { HostedExecutionTask, SessionState } from "@/lib/session/types";
import {
  resolveHostedAddToCartTask,
  resolveHostedModuleSearchTask
} from "@/lib/mcp/hosted";
import { isProductCandidate } from "@/lib/session/guards";
import { persistSession } from "@/lib/session/repository";

const DEFAULT_CAPABILITIES: RuntimeJobType[] = ["module_search", "add_to_cart"];
export const DEFAULT_JOB_LEASE_MS = 5 * 60 * 1000;

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

export async function registerExecutorDevice(
  userId: string,
  name: string,
  capabilities: RuntimeJobType[] = DEFAULT_CAPABILITIES
) {
  const repository = getRuntimeRepository();
  const token = createOpaqueToken();
  const now = new Date().toISOString();
  const device = await repository.createDevice({
    id: randomUUID(),
    user_id: userId,
    name: name.trim().slice(0, 80) || "本地淘宝执行器",
    token_hash: hashOpaqueToken(token),
    capabilities: capabilities.filter((item) => DEFAULT_CAPABILITIES.includes(item)),
    status: "offline",
    created_at: now,
    updated_at: now
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
  const repository = getRuntimeRepository();
  const decisionId = state.agent_decisions.at(-1)?.decision_id ?? "manual";
  const idempotencyKey = `module-search:${state.session_id}:${input.moduleId}:${stableDigest(input.keyword)}:${decisionId}`;
  const jobId = randomUUID();
  const payload = {
    scene_brief: state.scene_brief,
    module_id: input.moduleId,
    module_name: input.moduleName,
    keyword: input.keyword,
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

  if (!state.hosted_tasks.some((task) => task.task_id === job.id)) {
    state.hosted_tasks.unshift(taskForJob({
      id: job.id,
      type: "module_search",
      state,
      moduleId: input.moduleId,
      moduleName: input.moduleName,
      title: `为「${input.moduleName}」执行本地淘宝搜索`,
      description: `本地执行器将使用 Qoder/Taobao skill 搜索“${input.keyword}”，完成后自动回填候选商品。`,
      payload
    }));
  }
  state.execution_mode = "local_executor";
  state.mcp_status = "hosted";
  await repository.appendEvent({
    user_id: state.owner_id,
    session_id: state.session_id,
    job_id: job.id,
    event_type: "job.created",
    payload: { job_type: job.job_type, module_id: input.moduleId, module_name: input.moduleName }
  });
  return job;
}

export async function enqueueAddToCartJob(
  state: SessionState,
  input: { productId: string; title: string; moduleId: string; moduleName?: string }
) {
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
    max_attempts: 2
  });
  if (!state.hosted_tasks.some((task) => task.task_id === job.id)) {
    state.hosted_tasks.unshift(taskForJob({
      id: job.id,
      type: "add_to_cart",
      state,
      moduleId: input.moduleId,
      moduleName: input.moduleName,
      productId: input.productId,
      title: `将「${input.title}」加入淘宝购物车`,
      description: "本地执行器将在用户已确认的前提下完成真实加购。",
      payload
    }));
  }
  await repository.appendEvent({
    user_id: state.owner_id,
    session_id: state.session_id,
    job_id: job.id,
    event_type: "job.created",
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

function updateRuntimeSearchTrace(
  state: SessionState,
  job: { payload: Record<string, unknown> },
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
            result_count: candidates.length,
            reason: "本地执行器已完成真实淘宝搜索并回填候选。",
            created_at: now
          }
        : attempt)
    : [
        ...previousAttempts,
        {
          keyword,
          status: "success" as const,
          result_count: candidates.length,
          reason: "本地执行器已完成真实淘宝搜索并回填候选。",
          created_at: now
        }
      ];
  const review = state.module_reviews[moduleId];
  state.module_search_traces[moduleId] = {
    module_id: moduleId,
    module_name: module.module_name,
    status: candidates.length === 0 ? "failed" : review?.status === "ready" ? "ready" : "thin",
    primary_keyword: previous?.primary_keyword || keyword,
    searched_keywords: [...new Set([...(previous?.searched_keywords ?? []), keyword])],
    attempts,
    result_count: candidates.length,
    candidate_count: candidates.length,
    review_status: review?.status,
    review_summary: review?.summary,
    recovery_keyword: review?.suggested_keyword,
    ai_decision_summary: candidates.length > 0
      ? `「${module.module_name}」已由本地执行器回填 ${candidates.length} 个候选商品。`
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
    status: "failed",
    primary_keyword: previous?.primary_keyword || keyword,
    searched_keywords: [...new Set([...(previous?.searched_keywords ?? []), keyword])],
    attempts,
    result_count: 0,
    candidate_count: 0,
    ai_decision_summary: `「${module.module_name}」在自动重试后仍未完成，Agent 将跳过该模块避免阻塞。`,
    next_action: "继续后续模块；用户可在结果页手动换词补搜。",
    generated_at: previous?.generated_at ?? now,
    updated_at: now
  };
}

export async function applyCompletedRuntimeJob(jobId: string, device: ExecutorDevice, result: Record<string, unknown>) {
  const repository = getRuntimeRepository();
  const pendingJob = await repository.getJob(jobId);
  if (!pendingJob) throw new Error("job not found");
  if (pendingJob.status !== "completed") {
    const pendingState = await repository.getSession(pendingJob.session_id, pendingJob.user_id);
    if (!pendingState) throw new Error("session not found for completed job");
    if (!pendingState.hosted_tasks.some((item) => item.task_id === pendingJob.id)) {
      throw new Error("execution task not found for completed job");
    }
  }
  const completion = await repository.completeJob(jobId, device.id, result);
  if (completion.alreadyCompleted) return completion;
  const job = completion.job;
  const state = await repository.getSession(job.session_id, job.user_id);
  if (!state) throw new Error("session not found for completed job");
  const task = state.hosted_tasks.find((item) => item.task_id === job.id);
  if (!task) throw new Error("execution task not found for completed job");

  if (job.job_type === "module_search") {
    const candidates = resultCandidates(result);
    resolveHostedModuleSearchTask(state, {
      task_id: task.task_id,
      status: "completed",
      candidates,
      result_summary: typeof result.summary === "string" ? result.summary : "本地执行器已完成淘宝搜索"
    });
    updateRuntimeSearchTrace(state, job, candidates);
  } else {
    resolveHostedAddToCartTask(state, {
      task_id: task.task_id,
      status: result.success === false ? "failed" : "completed",
      result_summary: typeof result.message === "string" ? result.message : "本地执行器已完成加购"
    });
  }
  await persistSession(state);
  await repository.appendEvent({
    user_id: job.user_id,
    session_id: job.session_id,
    job_id: job.id,
    event_type: "job.completed",
    payload: { job_type: job.job_type, result_summary: task.result_summary ?? "执行完成" }
  });
  return completion;
}

export async function applyFailedRuntimeJob(
  jobId: string,
  device: ExecutorDevice,
  errorMessage: string
) {
  const repository = getRuntimeRepository();
  const job = await repository.failJob(jobId, device.id, errorMessage, 3_000);
  const state = await repository.getSession(job.session_id, job.user_id);
  const task = state?.hosted_tasks.find((item) => item.task_id === job.id);
  if (state && task) {
    task.status = job.status === "failed" ? "failed" : "pending";
    task.error_message = errorMessage.slice(0, 500);
    task.updated_at = new Date().toISOString();
    if (job.status === "failed" && job.job_type === "module_search") {
      markRuntimeSearchFailure(state, job, errorMessage);
    }
    await persistSession(state);
  }
  await repository.appendEvent({
    user_id: job.user_id,
    session_id: job.session_id,
    job_id: job.id,
    event_type: job.status === "failed" ? "job.failed" : "job.retry_scheduled",
    payload: { job_type: job.job_type, attempts: job.attempts, error: errorMessage.slice(0, 500) }
  });
  return job;
}

export async function cancelPendingRuntimeJob(jobId: string, userId?: string) {
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
