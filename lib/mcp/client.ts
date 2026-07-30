import fs from "node:fs";
import { homedir } from "node:os";
import { liveMcpAdapter } from "@/lib/mcp/live";
import { qoderMcpAdapter } from "@/lib/mcp/qoder";

export type ExecutorBackend = "codex_hosted" | "experimental_local" | "qoder_cli";

const DEFAULT_QODERCLI_PATH = `${homedir()}/.local/bin/qodercli`;

export function getExecutionBackend(): ExecutorBackend {
  if (process.env.TAOBAO_EXECUTION_BACKEND === "qoder_cli") {
    return "qoder_cli";
  }
  if (process.env.QODERCLI_PATH || fs.existsSync(DEFAULT_QODERCLI_PATH)) {
    return "qoder_cli";
  }
  return process.env.TAOBAO_EXECUTION_BACKEND === "experimental_local"
    ? "experimental_local"
    : "codex_hosted";
}

export async function getMcpClient() {
  const backend = getExecutionBackend();

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

  if (backend === "qoder_cli") {
    const qoderStatus = await qoderMcpAdapter.detect();
    return {
      client: qoderMcpAdapter,
      status: qoderStatus
    };
  }

  const liveStatus = await liveMcpAdapter.detect();
  return {
    client: liveMcpAdapter,
    status: liveStatus
  };
}
