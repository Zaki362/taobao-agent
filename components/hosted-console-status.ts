import type { HostedWorkerStatus, MpcStatus } from "@/components/dashboard-types";
import type { SessionState } from "@/lib/session/types";

export type ExecutionConsoleStatus = {
  tone: "healthy" | "warning" | "critical" | "neutral";
  title: string;
  detail: string;
};

export function executionConsoleStatus(input: {
  executionMode?: SessionState["execution_mode"];
  activeTaskCount: number;
  mcpStatus: MpcStatus | null;
  workerStatus: HostedWorkerStatus | null;
}): ExecutionConsoleStatus {
  if (!input.executionMode) {
    return {
      tone: "neutral",
      title: "尚未选择会话",
      detail: "选择一个会话后查看真实执行状态。"
    };
  }

  if (input.executionMode === "local_executor") {
    const devices = input.mcpStatus?.mode === "local_executor"
      ? input.mcpStatus.executor_devices
      : undefined;
    if (!devices) {
      return {
        tone: "warning",
        title: "正在读取本地执行器状态",
        detail: "任务状态已保存在队列中；当前尚未取得淘宝 MCP 状态。"
      };
    }
    if (devices.authentication_required > 0) {
      return {
        tone: "critical",
        title: "本地执行器有响应，等待淘宝重新登录",
        detail: input.mcpStatus?.message ?? "登录恢复后可继续原搜索，已有结果不会丢失。"
      };
    }
    if (devices.mcp_unavailable > 0) {
      return {
        tone: "warning",
        title: "本地执行器有响应，淘宝 MCP 重连中",
        detail: input.mcpStatus?.message ?? "未完成任务保持排队，不会被误报为 Worker 断线。"
      };
    }
    if (devices.online > 0 && input.mcpStatus?.search_available) {
      return {
        tone: "healthy",
        title: "真实淘宝执行链路可用",
        detail: input.activeTaskCount > 0
          ? `本地执行器正在处理 ${input.activeTaskCount} 个持久任务，结果会自动回填。`
          : "本地执行器与淘宝 MCP 均在线，当前队列没有待处理任务。"
      };
    }
    if (devices.online > 0) {
      return {
        tone: "warning",
        title: "本地执行器在线，但搜索能力不可用",
        detail: input.mcpStatus?.message ?? "请检查执行器能力配置。"
      };
    }
    return {
      tone: "critical",
      title: devices.registered > 0 ? "本地执行器未响应" : "尚未注册本地执行器",
      detail: input.mcpStatus?.message ?? "请启动本机 Worker 并运行执行器 Doctor。"
    };
  }

  if (input.workerStatus?.online) {
    return {
      tone: "healthy",
      title: "兼容宿主 Worker 在线",
      detail: `状态：${input.workerStatus.state}，最近动作：${input.workerStatus.last_result ?? "暂无"}`
    };
  }
  return {
    tone: input.activeTaskCount > 0 ? "warning" : "neutral",
    title: input.activeTaskCount > 0 ? "兼容宿主 Worker 未响应" : "当前没有后台任务",
    detail: input.activeTaskCount > 0 ? "任务仍在等待兼容 Worker。" : "已完成结果均保存在当前会话。"
  };
}
