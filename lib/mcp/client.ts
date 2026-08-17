import { localExecutorMcpAdapter } from "@/lib/mcp/local-executor";
import { isFormalProductMode } from "@/lib/runtime/product-mode";

export type ExecutorBackend = "codex_hosted" | "experimental_local" | "qoder_cli" | "local_executor";

export function getConfiguredExecutionBackend(): ExecutorBackend {
  const configured = process.env.TAOBAO_EXECUTION_BACKEND;
  if (
    configured === "codex_hosted" ||
    configured === "experimental_local" ||
    configured === "qoder_cli" ||
    configured === "local_executor"
  ) {
    return configured;
  }

  // Installing Qoder must not silently change the web application's execution
  // architecture. Compatibility providers are development-only opt-ins.
  return "local_executor";
}

export function getExecutionBackend(): ExecutorBackend {
  const configured = getConfiguredExecutionBackend();
  // The Qoder CLI and experimental bridge adapters have been retired. Keep
  // recognizing their old configuration values so readiness can explain the
  // misconfiguration, but never make either path executable again.
  if (configured === "qoder_cli" || configured === "experimental_local") {
    return "local_executor";
  }
  if (isFormalProductMode() && configured !== "local_executor") {
    return "local_executor";
  }
  return configured;
}

export async function getMcpClient() {
  const backend = getExecutionBackend();

  if (backend === "local_executor") {
    return {
      client: localExecutorMcpAdapter,
      status: await localExecutorMcpAdapter.detect()
    };
  }

  if (backend === "codex_hosted") {
    return {
      client: {
        mode: "codex_hosted" as const
      },
      status: {
        available: true,
        message: "当前使用 Codex 宿主代理方案。网页产品负责任务编排，淘宝执行由 Codex 宿主接管并回填结果。",
        permissions_scope: ["淘宝搜索", "详情提取", "加入购物车需显式确认"]
      }
    };
  }

  return {
    client: localExecutorMcpAdapter,
    status: await localExecutorMcpAdapter.detect()
  };
}
