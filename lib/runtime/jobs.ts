import { createHash, randomUUID } from "node:crypto";
import { createOpaqueToken, hashOpaqueToken } from "@/lib/auth/crypto";
import { getRuntimeRepository } from "@/lib/runtime";
import { withWorkflowSessionTransaction } from "@/lib/runtime/database";
import { executorCapabilityForJobType } from "@/lib/runtime/types";
import type {
  AuthenticationFailureHold,
  ExecutorCapability,
  ExecutorDevice,
  RuntimeJob
} from "@/lib/runtime/types";
import type {
  HostedExecutionTask,
  ProductCandidate,
  SessionState,
  TaobaoMcpProductDetailEvidence,
  TaobaoMcpSearchEvidence
} from "@/lib/session/types";
import {
  resolveHostedAddToCartTask,
  resolveHostedModuleSearchTask
} from "@/lib/mcp/hosted";
import { reviewModuleCandidatesWithAgent } from "@/lib/agent/candidate-reviewer";
import { mergeAndRankModuleCandidates } from "@/lib/agent/candidate-ranker";
import {
  isProductCandidate,
  isTaobaoMcpProductDetailEvidence,
  isTaobaoMcpSearchEvidence
} from "@/lib/session/guards";
import { persistSession } from "@/lib/session/repository";

const ALLOWED_CAPABILITIES: ExecutorCapability[] = ["module_search", "add_to_cart"];
const MINIMUM_CAPABILITIES: ExecutorCapability[] = ["module_search"];
export const DEFAULT_JOB_LEASE_MS = 5 * 60 * 1000;
const TAOBAO_MCP_SEARCH_EVIDENCE_SCHEMA = "scenecart.taobao-mcp-search-evidence/v1";
const TAOBAO_MCP_PRODUCT_DETAIL_EVIDENCE_SCHEMA = "scenecart.taobao-mcp-product-detail-evidence/v1";
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
  type: HostedExecutionTask["task_type"];
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
  if (job.job_type === "product_detail") {
    throw new Error("product detail jobs do not create hosted shopping tasks");
  }

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
  capabilities: ExecutorCapability[] = MINIMUM_CAPABILITIES
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
  if (job.status === "pending") {
    const supersededDetailJobIds = new Set<string>();
    for (const task of state.hosted_tasks) {
      if (task.task_type !== "module_search" || task.module_id !== input.moduleId) continue;
      const detailJobId = typeof task.payload.preferred_product_detail_job_id === "string"
        ? task.payload.preferred_product_detail_job_id
        : "";
      if (detailJobId) supersededDetailJobIds.add(detailJobId);
      delete task.payload.preferred_product_detail_job_id;
      delete task.payload.preferred_product_id;
    }
    const activeDetailJobs = (await repository.listJobs(state.session_id, state.owner_id)).filter((detailJob) =>
      detailJob.job_type === "product_detail" &&
      detailJob.payload.module_id === input.moduleId &&
      detailJob.payload.workflow_run_id === workflowRunId &&
      (detailJob.status === "pending" || detailJob.status === "leased" || detailJob.status === "running")
    );
    for (const detailJob of activeDetailJobs) {
      supersededDetailJobIds.add(detailJob.id);
      const cancelled = detailJob.status === "pending"
        ? await repository.cancelJob(detailJob.id, state.owner_id)
        : null;
      await repository.appendEvent({
        user_id: state.owner_id,
        session_id: state.session_id,
        job_id: detailJob.id,
        event_type: "job.product_detail_superseded",
        payload: {
          job_type: "product_detail",
          previous_status: detailJob.status,
          cancelled: cancelled?.status === "cancelled",
          superseding_search_job_id: job.id,
          module_id: input.moduleId,
          workflow_run_id: workflowRunId
        }
      });
    }
    if (supersededDetailJobIds.size > 0) {
      await repository.appendEvent({
        user_id: state.owner_id,
        session_id: state.session_id,
        job_id: job.id,
        event_type: "job.product_detail_provenance_replaced",
        payload: {
          job_type: "module_search",
          module_id: input.moduleId,
          workflow_run_id: workflowRunId,
          superseded_detail_job_ids: [...supersededDetailJobIds]
        }
      });
    }
  }
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

function currentPreferredProductDetailTask(state: SessionState, moduleId: string) {
  return state.hosted_tasks.find((task) =>
    task.task_type === "module_search" &&
    task.module_id === moduleId &&
    task.status === "completed" &&
    typeof task.payload.preferred_product_detail_job_id === "string" &&
    task.payload.preferred_product_detail_job_id.length > 0
  );
}

export function isCurrentPreferredProductDetailJob(state: SessionState, job: RuntimeJob) {
  if (job.job_type !== "product_detail") return false;
  const moduleId = typeof job.payload.module_id === "string" ? job.payload.module_id : "";
  const searchJobId = typeof job.payload.search_job_id === "string" ? job.payload.search_job_id : "";
  const productId = typeof job.payload.product_id === "string" ? job.payload.product_id : "";
  const detailUrl = typeof job.payload.detail_url === "string" ? job.payload.detail_url : "";
  const workflowRunId = typeof job.payload.workflow_run_id === "string" ? job.payload.workflow_run_id : "";
  const candidate = state.module_candidates[moduleId]?.[0];
  const task = currentPreferredProductDetailTask(state, moduleId);
  return Boolean(
    moduleId &&
    searchJobId &&
    productId &&
    detailUrl &&
    workflowRunId &&
    state.agent_runtime.workflow_run_id === workflowRunId &&
    candidate?.product_id === productId &&
    candidate.detail_url === detailUrl &&
    task &&
    (task.runtime_job_id ?? task.task_id) === searchJobId &&
    task.payload.preferred_product_detail_job_id === job.id &&
    task.payload.preferred_product_id === productId
  );
}

const NON_DETAIL_FACT_PATTERNS = [
  /^来自淘宝实时搜索$/,
  /^匹配模块搜索意图$/,
  /^命中AI检索重点$/i,
  /^价格更贴近模块预算$/,
  /^(?:符合|满足|命中|触及)AI(?:检索|排序|验收|质量|排除|拒绝)/i
];

function isDetailFactTerm(value: string) {
  const term = value.trim();
  return term.length >= 2 && term.length <= 40 &&
    !NON_DETAIL_FACT_PATTERNS.some((pattern) => pattern.test(term));
}

async function enqueuePreferredProductDetailJob(
  state: SessionState,
  searchJob: RuntimeJob,
  candidate: ProductCandidate
) {
  const workflowRunId = typeof searchJob.payload.workflow_run_id === "string"
    ? searchJob.payload.workflow_run_id
    : "";
  const moduleId = typeof searchJob.payload.module_id === "string"
    ? searchJob.payload.module_id
    : "";
  if (!workflowRunId || !moduleId || !isTrustedTaobaoDetailUrl(candidate.detail_url)) return null;
  const module = state.shopping_plan.modules.find((item) => item.module_id === moduleId);
  const factTerms = [...new Set([
    typeof searchJob.payload.keyword === "string" ? searchJob.payload.keyword : "",
    ...(module?.search_strategy?.must_have_signals ?? []),
    ...(module?.search_strategy?.ranking_focus ?? []),
    ...candidate.highlights
  ].map((term) => term.trim()).filter(isDetailFactTerm))].slice(0, 12);
  const repository = getRuntimeRepository();
  const job = await repository.createJob({
    id: randomUUID(),
    user_id: state.owner_id,
    session_id: state.session_id,
    job_type: "product_detail",
    idempotency_key: `product-detail:${searchJob.id}:${candidate.product_id}`,
    payload: {
      search_job_id: searchJob.id,
      module_id: moduleId,
      workflow_run_id: workflowRunId,
      product_id: candidate.product_id,
      detail_url: candidate.detail_url,
      fact_terms: factTerms
    },
    priority: 130,
    max_attempts: 2
  });
  await repository.appendEvent({
    user_id: state.owner_id,
    session_id: state.session_id,
    job_id: job.id,
    event_type: "job.created",
    payload: {
      job_type: "product_detail",
      search_job_id: searchJob.id,
      module_id: moduleId,
      workflow_run_id: workflowRunId,
      product_id: candidate.product_id,
      mutation: false
    }
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

function taobaoProductIdFromUrl(value: string) {
  try {
    const url = new URL(value);
    return (url.searchParams.get("id") ?? url.searchParams.get("itemId") ?? "").trim();
  } catch {
    return "";
  }
}

function detailEvidenceReason(
  candidate: ProductCandidate,
  evidence: TaobaoMcpProductDetailEvidence
) {
  if (evidence.status === "unavailable") {
    return "详情证据暂不可用；当前推荐仍基于本次真实淘宝搜索摘要，购买前需人工确认详情。";
  }
  const pageTitle = evidence.summary?.page_title.trim() ?? "";
  const matchedSignals = evidence.summary?.matched_facts.slice(0, 2) ?? [];
  if (matchedSignals.length === 0) {
    return `已读取淘宝详情页“${pageTitle.slice(0, 80)}”并确认商品身份；当前可见文本未证实模块适配信号，仍需人工核对。`;
  }
  return `已读取淘宝详情页“${pageTitle.slice(0, 80)}”，页面可见信号：${matchedSignals.join("、")}；具体 SKU 与成交价仍需购买前确认。`;
}

function safeProductDetailUnavailableReason(value: string) {
  if (/(?:未登录|登录|auth|login)/i.test(value)) return "淘宝登录状态需要恢复";
  if (/(?:超时|timeout|timed out)/i.test(value)) return "详情页读取超时";
  if (/(?:navigate|导航|链接|url)/i.test(value)) return "详情页导航未完成";
  if (/(?:read_page_content|正文|页面|内容|content|空白)/i.test(value)) {
    return "详情页内容暂未完整返回";
  }
  if (/(?:mcp|工具|tool|连接|connect)/i.test(value)) return "淘宝详情读取工具暂不可用";
  return "本次详情页读取未完成";
}

async function validateTaobaoMcpProductDetailResult(
  job: RuntimeJob,
  result: Record<string, unknown>,
  state: SessionState,
  options: { now?: number } = {}
) {
  const rawEvidence = isRecord(result.detail_evidence) ? result.detail_evidence : undefined;
  if (
    rawEvidence?.schema !== TAOBAO_MCP_PRODUCT_DETAIL_EVIDENCE_SCHEMA ||
    !isTaobaoMcpProductDetailEvidence(rawEvidence)
  ) {
    throw new Error("淘宝 MCP 商品详情证据结构无效，已拒绝完成任务");
  }
  if (rawEvidence.recommendation_reason !== undefined) {
    throw new Error("淘宝 MCP 商品详情证据不得伪造服务端推荐理由");
  }

  const payload = job.payload;
  const searchJobId = typeof payload.search_job_id === "string" ? payload.search_job_id.trim() : "";
  const moduleId = typeof payload.module_id === "string" ? payload.module_id.trim() : "";
  const workflowRunId = typeof payload.workflow_run_id === "string" ? payload.workflow_run_id.trim() : "";
  const productId = typeof payload.product_id === "string" ? payload.product_id.trim() : "";
  const detailUrl = typeof payload.detail_url === "string" ? payload.detail_url.trim() : "";
  const factTerms = Array.isArray(payload.fact_terms)
    ? payload.fact_terms.filter((term): term is string => typeof term === "string")
    : [];
  if (
    rawEvidence.job_id !== job.id ||
    rawEvidence.search_job_id !== searchJobId ||
    rawEvidence.module_id !== moduleId ||
    rawEvidence.workflow_run_id !== workflowRunId ||
    rawEvidence.product_id !== productId ||
    rawEvidence.detail_url !== detailUrl
  ) {
    throw new Error("淘宝 MCP 商品详情证据与当前 Job 上下文不一致，已拒绝完成任务");
  }
  if (
    !isTrustedTaobaoDetailUrl(detailUrl) ||
    rawEvidence.source_app.length > 120 ||
    rawEvidence.tool !== "navigate_to_url+read_page_content"
  ) {
    throw new Error("淘宝 MCP 商品详情工具或可信链接无效，已拒绝完成任务");
  }

  const capturedAt = Date.parse(rawEvidence.captured_at);
  const jobCreatedAt = Date.parse(job.created_at);
  if (
    !Number.isFinite(jobCreatedAt) ||
    capturedAt < jobCreatedAt - EVIDENCE_CLOCK_SKEW_MS ||
    capturedAt > (options.now ?? Date.now()) + EVIDENCE_CLOCK_SKEW_MS
  ) {
    throw new Error("淘宝 MCP 商品详情证据时间无效，已拒绝完成任务");
  }

  const currentCandidate = state.module_candidates[moduleId]?.[0];
  if (
    !isCurrentPreferredProductDetailJob(state, job) ||
    !currentCandidate
  ) {
    throw new Error("淘宝 MCP 商品详情证据不再匹配当前 AI 首选或当前搜索任务，已拒绝覆盖");
  }
  const searchJob = await getRuntimeRepository().getJob(searchJobId);
  if (
    !searchJob ||
    searchJob.job_type !== "module_search" ||
    searchJob.status !== "completed" ||
    searchJob.session_id !== job.session_id ||
    searchJob.user_id !== job.user_id ||
    searchJob.payload.module_id !== moduleId ||
    searchJob.payload.workflow_run_id !== workflowRunId
  ) {
    throw new Error("淘宝 MCP 商品详情证据关联的搜索 Job 无效，已拒绝完成任务");
  }

  if (rawEvidence.status === "verified") {
    const summary = rawEvidence.summary!;
    if (
      rawEvidence.tools_used.length !== 2 ||
      rawEvidence.tools_used[0] !== "navigate_to_url" ||
      rawEvidence.tools_used[1] !== "read_page_content" ||
      !isTrustedTaobaoDetailUrl(summary.page_url) ||
      taobaoProductIdFromUrl(summary.page_url) !== productId ||
      summary.page_title.length === 0 || summary.page_title.length > 300 ||
      summary.page_url.length > 1000 ||
      !/^[a-f0-9]{64}$/.test(summary.visible_text_sha256) ||
      summary.matched_facts.length > 5 ||
      summary.matched_facts.some((fact) =>
        fact.length < 2 || fact.length > 40 || !factTerms.includes(fact)
      ) ||
      summary.displayed_price_texts.length > 5 ||
      summary.displayed_price_texts.some((price) =>
        price.length === 0 || price.length > 40 || !/^(?:¥|￥)\s*\d+(?:\.\d{1,2})?$/.test(price)
      ) ||
      rawEvidence.unavailable_reason !== undefined
    ) {
      throw new Error("淘宝 MCP 商品详情字段摘要无效，已拒绝完成任务");
    }
  } else if (
    rawEvidence.summary !== undefined ||
    !rawEvidence.unavailable_reason ||
    rawEvidence.unavailable_reason.length > 300 ||
    rawEvidence.tools_used.length > 2 ||
    rawEvidence.tools_used.some((tool, index) =>
      tool !== ["navigate_to_url", "read_page_content"][index]
    )
  ) {
    throw new Error("淘宝 MCP 商品详情不可用证据无效，已拒绝完成任务");
  }

  const evidence: TaobaoMcpProductDetailEvidence = rawEvidence.status === "verified"
    ? {
        schema: TAOBAO_MCP_PRODUCT_DETAIL_EVIDENCE_SCHEMA,
        source: "taobao-mcp",
        status: "verified",
        tool: "navigate_to_url+read_page_content",
        tools_used: ["navigate_to_url", "read_page_content"],
        source_app: rawEvidence.source_app,
        job_id: rawEvidence.job_id,
        search_job_id: rawEvidence.search_job_id,
        module_id: rawEvidence.module_id,
        workflow_run_id: rawEvidence.workflow_run_id,
        product_id: rawEvidence.product_id,
        detail_url: rawEvidence.detail_url,
        captured_at: rawEvidence.captured_at,
        summary: {
          page_title: rawEvidence.summary!.page_title,
          page_url: rawEvidence.summary!.page_url,
          visible_text_sha256: rawEvidence.summary!.visible_text_sha256,
          matched_facts: [...rawEvidence.summary!.matched_facts],
          displayed_price_texts: [...rawEvidence.summary!.displayed_price_texts]
        }
      }
    : {
        schema: TAOBAO_MCP_PRODUCT_DETAIL_EVIDENCE_SCHEMA,
        source: "taobao-mcp",
        status: "unavailable",
        tool: "navigate_to_url+read_page_content",
        tools_used: [...rawEvidence.tools_used],
        source_app: rawEvidence.source_app,
        job_id: rawEvidence.job_id,
        search_job_id: rawEvidence.search_job_id,
        module_id: rawEvidence.module_id,
        workflow_run_id: rawEvidence.workflow_run_id,
        product_id: rawEvidence.product_id,
        detail_url: rawEvidence.detail_url,
        captured_at: rawEvidence.captured_at,
        unavailable_reason: safeProductDetailUnavailableReason(rawEvidence.unavailable_reason ?? "")
      };
  evidence.recommendation_reason = detailEvidenceReason(currentCandidate, evidence);
  return evidence;
}

function markUnavailableProductDetail(
  state: SessionState,
  job: RuntimeJob,
  errorMessage: string
) {
  const moduleId = typeof job.payload.module_id === "string" ? job.payload.module_id : "";
  const workflowRunId = typeof job.payload.workflow_run_id === "string" ? job.payload.workflow_run_id : "";
  const productId = typeof job.payload.product_id === "string" ? job.payload.product_id : "";
  const detailUrl = typeof job.payload.detail_url === "string" ? job.payload.detail_url : "";
  const searchJobId = typeof job.payload.search_job_id === "string" ? job.payload.search_job_id : "";
  const candidate = state.module_candidates[moduleId]?.[0];
  if (
    !candidate ||
    !isCurrentPreferredProductDetailJob(state, job) ||
    !isTrustedTaobaoDetailUrl(detailUrl)
  ) {
    return false;
  }
  const evidence: TaobaoMcpProductDetailEvidence = {
    schema: TAOBAO_MCP_PRODUCT_DETAIL_EVIDENCE_SCHEMA,
    source: "taobao-mcp",
    status: "unavailable",
    tool: "navigate_to_url+read_page_content",
    tools_used: [],
    source_app: "SceneCartAI",
    job_id: job.id,
    search_job_id: searchJobId,
    module_id: moduleId,
    workflow_run_id: workflowRunId,
    product_id: productId,
    detail_url: detailUrl,
    captured_at: new Date().toISOString(),
    unavailable_reason: safeProductDetailUnavailableReason(errorMessage),
    recommendation_reason: "详情证据暂不可用；当前推荐仍基于本次真实淘宝搜索摘要，购买前需人工确认详情。"
  };
  candidate.detail_evidence = evidence;
  return true;
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
  recovered: boolean,
  validatedDetailEvidence?: TaobaoMcpProductDetailEvidence
) {
  const repository = getRuntimeRepository();
  const state = await repository.getSession(job.session_id, job.user_id);
  if (!state) throw new Error("session not found for completed job");
  if (job.job_type === "product_detail") {
    const evidence = validatedDetailEvidence ??
      await validateTaobaoMcpProductDetailResult(job, result, state);
    const candidate = state.module_candidates[evidence.module_id]?.[0];
    if (!candidate) throw new Error("preferred candidate not found for completed detail job");
    if (candidate.detail_evidence?.job_id === job.id) {
      return { persisted: false, followUpJobId: undefined };
    }
    candidate.detail_evidence = evidence;
    await persistSession(state);
    await repository.appendEvent({
      user_id: job.user_id,
      session_id: job.session_id,
      job_id: job.id,
      event_type: recovered ? "job.result_reconciled" : "job.completed",
      payload: {
        job_type: job.job_type,
        recovered,
        evidence: {
          status: evidence.status,
          source: evidence.source,
          tool: evidence.tool,
          tools_used: evidence.tools_used,
          source_app: evidence.source_app,
          job_id: evidence.job_id,
          search_job_id: evidence.search_job_id,
          module_id: evidence.module_id,
          workflow_run_id: evidence.workflow_run_id,
          product_id: evidence.product_id,
          detail_url: evidence.detail_url,
          captured_at: evidence.captured_at,
          recommendation_reason: evidence.recommendation_reason
        }
      }
    });
    return { persisted: true, followUpJobId: undefined };
  }
  const task = state.hosted_tasks.find((item) => item.task_id === job.id) ??
    (recovered ? restoreTaskForJob(state, job) : undefined);
  if (!task) throw new Error("execution task not found for completed job");
  const expectedTaskStatus = job.job_type === "add_to_cart" && result.success === false
    ? "failed"
    : "completed";
  if (task.status === expectedTaskStatus) {
    return { persisted: false, followUpJobId: undefined };
  }

  const taobaoMcpEvidence = job.job_type === "module_search" && !isIsolatedInterviewDemoSearch(result)
    ? validateTaobaoMcpSearchResult(job, result)
    : undefined;

  let followUpJobId: string | undefined;
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
    if (taobaoMcpEvidence) {
      candidates = candidates.map((candidate) => {
        const { detail_evidence: _supersededEvidence, ...currentCandidate } = candidate;
        return currentCandidate;
      });
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
    if (candidates[0] && taobaoMcpEvidence) {
      const detailJob = await enqueuePreferredProductDetailJob(state, job, candidates[0]);
      if (detailJob) {
        followUpJobId = detailJob.id;
        for (const moduleTask of state.hosted_tasks) {
          if (
            moduleTask.task_type === "module_search" &&
            moduleTask.module_id === moduleId &&
            moduleTask.task_id !== task.task_id
          ) {
            delete moduleTask.payload.preferred_product_detail_job_id;
            delete moduleTask.payload.preferred_product_id;
          }
        }
        task.payload = {
          ...task.payload,
          preferred_product_detail_job_id: detailJob.id,
          preferred_product_id: candidates[0].product_id
        };
      }
    }
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
      ...(followUpJobId ? { follow_up_job_id: followUpJobId } : {}),
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
  return { persisted: true, followUpJobId };
}

async function applyCompletedRuntimeJobLocked(
  jobId: string,
  device: ExecutorDevice,
  result: Record<string, unknown>,
  leaseToken: string
) {
  const repository = getRuntimeRepository();
  const pendingJob = await repository.getJob(jobId);
  if (!pendingJob) throw new Error("job not found");
  let validatedDetailEvidence: TaobaoMcpProductDetailEvidence | undefined;
  if (pendingJob.status !== "completed") {
    const pendingState = await repository.getSession(pendingJob.session_id, pendingJob.user_id);
    if (!pendingState) throw new Error("session not found for completed job");
    if (
      pendingJob.job_type !== "product_detail" &&
      !pendingState.hosted_tasks.some((item) => item.task_id === pendingJob.id)
    ) {
      throw new Error("execution task not found for completed job");
    }
    if (pendingJob.job_type === "module_search") {
      if (!isIsolatedInterviewDemoSearch(result)) {
        validateTaobaoMcpSearchResult(pendingJob, result, { required: true });
      }
    } else if (pendingJob.job_type === "product_detail") {
      validatedDetailEvidence = await validateTaobaoMcpProductDetailResult(
        pendingJob,
        result,
        pendingState
      );
    }
  }
  const persistedResult = validatedDetailEvidence
    ? { detail_evidence: validatedDetailEvidence }
    : result;
  const completion = await repository.completeJob(jobId, device.id, persistedResult, leaseToken);
  const effectiveResult = completion.alreadyCompleted && completion.job.result
    ? completion.job.result
    : result;
  const persistence = await persistCompletedRuntimeJobResult(
    completion.job,
    effectiveResult,
    completion.alreadyCompleted,
    validatedDetailEvidence
  );
  return {
    ...completion,
    follow_up_job_id: persistence.followUpJobId
  };
}

export async function applyCompletedRuntimeJob(
  jobId: string,
  device: ExecutorDevice,
  result: Record<string, unknown>,
  leaseToken: string
) {
  const job = await getRuntimeRepository().getJob(jobId);
  if (!job) throw new Error("job not found");
  return withWorkflowSessionTransaction(
    job.session_id,
    () => applyCompletedRuntimeJobLocked(jobId, device, result, leaseToken)
  );
}

export async function shouldContinueWorkflowAfterCompletion(input: {
  job: RuntimeJob;
  alreadyCompleted: boolean;
  followUpJobId?: string;
}) {
  if (input.alreadyCompleted) return false;
  if (input.job.job_type === "module_search") return !input.followUpJobId;
  if (input.job.job_type !== "product_detail") return false;
  const state = await getRuntimeRepository().getSession(input.job.session_id, input.job.user_id);
  return Boolean(state && isCurrentPreferredProductDetailJob(state, input.job));
}

export async function shouldContinueWorkflowAfterFailure(job: RuntimeJob) {
  if (job.status !== "failed") return false;
  if (job.job_type === "module_search") return true;
  if (job.job_type !== "product_detail") return false;
  const state = await getRuntimeRepository().getSession(job.session_id, job.user_id);
  const moduleId = typeof job.payload.module_id === "string" ? job.payload.module_id : "";
  const evidence = state?.module_candidates[moduleId]?.[0]?.detail_evidence;
  return Boolean(
    state &&
    isCurrentPreferredProductDetailJob(state, job) &&
    evidence?.status === "unavailable" &&
    evidence.job_id === job.id
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
      const persistence = await persistCompletedRuntimeJobResult(current, current.result ?? {}, true);
      return persistence.persisted;
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
  if (job.job_type === "product_detail") {
    const changed = markUnavailableProductDetail(
      state,
      job,
      job.error_message || (job.status === "cancelled" ? "详情读取任务已取消" : "详情读取未完成")
    );
    if (changed || options.forcePersist) await persistSession(state);
    return changed;
  }
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
      !device.capabilities.includes(executorCapabilityForJobType(current.job_type)) ||
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
  if (
    !authenticationFailureCallback &&
    (
      typeof options.leaseToken !== "string" ||
      options.leaseToken !== existing.lease_token ||
      existing.lease_owner_id !== device.id ||
      (existing.user_id !== undefined && existing.user_id !== device.user_id) ||
      !device.capabilities.includes(executorCapabilityForJobType(existing.job_type))
    )
  ) {
    throw new Error("invalid job lease callback");
  }
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
      !device.capabilities.includes(executorCapabilityForJobType(existing.job_type)) ||
      (existing.user_id !== undefined && existing.user_id !== device.user_id)
    ) {
      throw new Error("invalid authentication failure callback");
    }
  }
  if (
    existing.job_type === "product_detail" &&
    (existing.status === "leased" || existing.status === "running")
  ) {
    const currentState = await repository.getSession(existing.session_id, existing.user_id);
    if (!currentState || !isCurrentPreferredProductDetailJob(currentState, existing)) {
      throw new Error("stale product detail callback");
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
  const persistedErrorMessage = existing.job_type === "product_detail"
    ? safeProductDetailUnavailableReason(errorMessage)
    : errorMessage;
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
        persistedErrorMessage,
        options.leaseToken!,
        3_000,
        options.retryable === false
      );
  const state = await repository.getSession(job.session_id, job.user_id);
  const task = state?.hosted_tasks.find((item) => item.task_id === job.id);
  if (state && job.job_type === "product_detail") {
    if (job.status === "failed") {
      markUnavailableProductDetail(state, job, persistedErrorMessage);
      await persistSession(state);
    }
  } else if (state && task) {
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
