import { describe, expect, it } from "vitest";
import {
  findCurrentTaobaoMcpEvidence,
  findTaobaoAuthenticationFailedCartTask,
  findTaobaoAuthenticationFailedTask,
  isTaobaoAuthenticationPause,
  isTaobaoCartAuthenticationPause
} from "@/components/dashboard-helpers";
import type { MpcStatus } from "@/components/dashboard-types";
import type { HostedExecutionTask, SessionState } from "@/lib/session/types";
import { createSessionFixture } from "@/tests/fixtures/session";

function failedSearchTask(
  state: SessionState,
  errorMessage: string,
  options: { moduleId?: string; workflowRunId?: string } = {}
): HostedExecutionTask {
  const module = state.shopping_plan.modules.find((item) => item.module_id === options.moduleId) ??
    state.shopping_plan.modules[0];
  const workflowRunId = options.workflowRunId ?? state.agent_runtime.workflow_run_id ?? "workflow-test";
  state.agent_runtime.current_module_id ??= module.module_id;
  state.agent_runtime.workflow_run_id ??= workflowRunId;
  return {
    task_id: "failed-taobao-search",
    task_type: "module_search",
    session_id: state.session_id,
    status: "failed",
    title: `搜索${module.module_name}`,
    description: "通过本地执行器触发淘宝搜索",
    module_id: module.module_id,
    module_name: module.module_name,
    created_at: "2026-08-11T00:00:00.000Z",
    updated_at: "2026-08-11T00:00:01.000Z",
    payload: { keyword: "新能源汽车脚垫", workflow_run_id: workflowRunId },
    error_message: errorMessage,
    executor: "local_executor"
  };
}

function mcpStatus({ available, authenticationRequired = 0 }: {
  available: boolean;
  authenticationRequired?: number;
}): MpcStatus {
  return {
    mode: "local_executor",
    available,
    message: "test",
    permissions_scope: [],
    executor_devices: {
      online: available ? 1 : 0,
      registered: 1,
      authentication_required: authenticationRequired,
      capabilities: {
        module_search: { registered: 1, online: available ? 1 : 0, available },
        add_to_cart: { registered: 1, online: available ? 1 : 0, available }
      }
    }
  };
}

describe("dashboard Taobao authentication pause", () => {
  it("keeps an ordinary user pause on the generic resume path", () => {
    const state = createSessionFixture();
    state.agent_runtime.workflow_status = "paused";
    state.agent_runtime.workflow_message = "已按用户要求暂停 Agent 搜索，可随时从当前进度继续";
    state.hosted_tasks = [failedSearchTask(state, "用户取消了当前任务")];

    expect(isTaobaoAuthenticationPause(state)).toBe(false);
    expect(findTaobaoAuthenticationFailedTask(state)).toBeUndefined();
  });

  it("detects a task-level Taobao login failure without relying on executor availability", () => {
    const state = createSessionFixture();
    state.agent_runtime.workflow_status = "paused";
    state.agent_runtime.workflow_message = "搜索任务已安全暂停";
    const failedTask = failedSearchTask(state, "未登录，已打开登录页面，请先登录淘宝账号");
    state.hosted_tasks = [failedTask];

    expect(isTaobaoAuthenticationPause(state)).toBe(true);
    expect(findTaobaoAuthenticationFailedTask(state)).toBe(failedTask);
  });

  it("uses the authoritative workflow message to recover the current failed module", () => {
    const state = createSessionFixture();
    const failedTask = failedSearchTask(state, "执行器返回不可重试错误");
    state.agent_runtime.workflow_status = "paused";
    state.agent_runtime.workflow_message = "淘宝账号当前未登录，搜索已安全暂停；重新登录后可从当前进度继续。";
    state.agent_runtime.current_module_id = failedTask.module_id;
    state.hosted_tasks = [failedTask];

    expect(isTaobaoAuthenticationPause(state)).toBe(true);
    expect(findTaobaoAuthenticationFailedTask(state)?.task_id).toBe(failedTask.task_id);
  });

  it("does not show a stale authentication pause once the workflow is running", () => {
    const state = createSessionFixture();
    state.agent_runtime.workflow_status = "running";
    state.agent_runtime.workflow_message = "淘宝账号当前未登录";
    state.hosted_tasks = [failedSearchTask(state, "auth_required")];

    expect(isTaobaoAuthenticationPause(state)).toBe(false);
    expect(findTaobaoAuthenticationFailedTask(state)).toBeUndefined();
  });

  it("ignores an authentication failure from an older workflow run", () => {
    const state = createSessionFixture();
    state.agent_runtime.workflow_status = "paused";
    state.agent_runtime.workflow_message = "已按用户要求暂停 Agent 搜索";
    state.agent_runtime.workflow_run_id = "current-run";
    state.agent_runtime.current_module_id = state.shopping_plan.modules[0].module_id;
    state.hosted_tasks = [failedSearchTask(state, "淘宝未登录，请先登录", {
      workflowRunId: "older-run"
    })];

    expect(findTaobaoAuthenticationFailedTask(state)).toBeUndefined();
    expect(isTaobaoAuthenticationPause(state)).toBe(false);
  });

  it("ignores an authentication failure from another module in the current run", () => {
    const state = createSessionFixture();
    const currentModule = state.shopping_plan.modules[0];
    const otherModule = state.shopping_plan.modules[1];
    state.agent_runtime.workflow_status = "paused";
    state.agent_runtime.workflow_message = "已按用户要求暂停 Agent 搜索";
    state.agent_runtime.workflow_run_id = "current-run";
    state.agent_runtime.current_module_id = currentModule.module_id;
    state.hosted_tasks = [failedSearchTask(state, "淘宝未登录，请先登录", {
      moduleId: otherModule.module_id,
      workflowRunId: "current-run"
    })];

    expect(findTaobaoAuthenticationFailedTask(state)).toBeUndefined();
    expect(isTaobaoAuthenticationPause(state)).toBe(false);
  });

  it("detects add-to-cart authentication failures separately from search workflow state", () => {
    const state = createSessionFixture();
    const task: HostedExecutionTask = {
      ...failedSearchTask(state, "淘宝未登录，请先登录"),
      task_id: "failed-cart",
      task_type: "add_to_cart",
      product_id: "product-auth-failed"
    };
    state.hosted_tasks = [task];

    expect(findTaobaoAuthenticationFailedCartTask(state)?.task_id).toBe("failed-cart");
    expect(findTaobaoAuthenticationFailedCartTask(state, "product-auth-failed")?.task_id).toBe("failed-cart");
    expect(findTaobaoAuthenticationFailedCartTask(state, "another-product")).toBeUndefined();
    expect(isTaobaoCartAuthenticationPause(state, mcpStatus({ available: false }))).toBe(true);
    expect(isTaobaoCartAuthenticationPause(state, mcpStatus({ available: true }))).toBe(false);
  });

  it("ignores an older cart authentication failure after the same product has a newer task", () => {
    const state = createSessionFixture();
    const failedTask: HostedExecutionTask = {
      ...failedSearchTask(state, "淘宝未登录，请先登录"),
      task_id: "failed-cart-old",
      task_type: "add_to_cart",
      product_id: "product-recovered",
      updated_at: "2026-08-11T00:00:01.000Z"
    };
    const recoveredTask: HostedExecutionTask = {
      ...failedTask,
      task_id: "cart-recovered",
      status: "completed",
      error_message: undefined,
      updated_at: "2026-08-11T00:00:02.000Z"
    };
    state.hosted_tasks = [failedTask, recoveredTask];

    expect(findTaobaoAuthenticationFailedCartTask(state)).toBeUndefined();
    expect(isTaobaoCartAuthenticationPause(
      state,
      mcpStatus({ available: false, authenticationRequired: 1 })
    )).toBe(true);
  });

  it("exposes only a validated proof from the current workflow and selected module", () => {
    const state = createSessionFixture();
    const module = state.shopping_plan.modules[0];
    state.agent_runtime.workflow_run_id = "workflow-current";
    state.hosted_tasks = [{
      task_id: "job-live-12345678",
      runtime_job_id: "job-live-12345678",
      task_type: "module_search",
      session_id: state.session_id,
      status: "completed",
      title: "真实淘宝搜索",
      description: "通过本地执行器触发淘宝搜索",
      module_id: module.module_id,
      module_name: module.module_name,
      created_at: "2026-08-11T12:34:50.000Z",
      updated_at: "2026-08-11T12:34:56.000Z",
      payload: {
        keyword: "车载手机支架",
        workflow_run_id: "workflow-current",
        taobao_mcp_evidence: {
          schema: "scenecart.taobao-mcp-search-evidence/v1",
          source: "taobao-mcp",
          tool: "search_products",
          source_app: "SceneCartAI",
          job_id: "job-live-12345678",
          module_id: module.module_id,
          workflow_run_id: "workflow-current",
          keyword: "车载手机支架",
          captured_at: "2026-08-11T12:34:56.000Z",
          cache_hit: false,
          raw_result_count: 48
        }
      },
      executor: "local_executor"
    }];

    expect(findCurrentTaobaoMcpEvidence(state, module.module_id)).toMatchObject({
      job_id: "job-live-12345678",
      keyword: "车载手机支架",
      raw_result_count: 48
    });

    state.agent_runtime.workflow_run_id = "workflow-next";
    expect(findCurrentTaobaoMcpEvidence(state, module.module_id)).toBeUndefined();
  });

  it("does not promote legacy or self-asserted evidence to a current MCP proof", () => {
    const state = createSessionFixture();
    const module = state.shopping_plan.modules[0];
    state.agent_runtime.workflow_run_id = "workflow-current";
    state.hosted_tasks = [{
      task_id: "job-legacy",
      runtime_job_id: "job-legacy",
      task_type: "module_search",
      session_id: state.session_id,
      status: "completed",
      title: "旧淘宝搜索",
      description: "旧执行器结果",
      module_id: module.module_id,
      module_name: module.module_name,
      created_at: "2026-08-11T12:34:50.000Z",
      updated_at: "2026-08-11T12:34:56.000Z",
      payload: {
        keyword: "车载手机支架",
        workflow_run_id: "workflow-current",
        taobao_mcp_evidence: {
          source: "taobao-mcp",
          keyword: "车载手机支架",
          raw_result_count: 48
        }
      },
      executor: "local_executor"
    }];

    expect(findCurrentTaobaoMcpEvidence(state, module.module_id)).toBeUndefined();
  });

});
