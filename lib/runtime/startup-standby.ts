import type { SessionState } from "@/lib/session/types";

export const EXECUTOR_STARTUP_STANDBY_MESSAGE =
  "本地执行器已就绪。为避免启动终端后自动执行历史搜索，请回到网页点击“继续搜索”。";
export const EXECUTOR_STARTUP_STANDBY_REASON = "executor_startup_standby" as const;

export function isExecutorStartupStandby(state: SessionState | null | undefined) {
  return Boolean(
    state &&
    state.agent_runtime.workflow_status === "paused" &&
    !state.agent_runtime.auto_continue &&
    (
      state.agent_runtime.pause_reason === EXECUTOR_STARTUP_STANDBY_REASON ||
      (
        state.agent_runtime.pause_reason === undefined &&
        state.agent_runtime.workflow_message === EXECUTOR_STARTUP_STANDBY_MESSAGE
      )
    )
  );
}
