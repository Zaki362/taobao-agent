"use client";

import { useEffect } from "react";

const RUNTIME_EVENT_NAMES = [
  "job.created",
  "job.requeued",
  "job.claimed",
  "job.completed",
  "job.failed",
  "job.retry_scheduled",
  "job.cancelled",
  "agent.workflow.updated"
] as const;

type RuntimeEventStreamOptions = {
  enabled: boolean;
  sessionId?: string;
  hydrateSession: (sessionId: string) => Promise<unknown>;
  refreshExecutorStatus: () => Promise<unknown>;
  updateStatusMessage: (message: string) => void;
};

function describeRuntimeEvent(event: MessageEvent<string>) {
  let message = "执行任务已更新";
  let shouldRefreshExecutorStatus = false;

  try {
    const payload = JSON.parse(event.data) as {
      event_type?: string;
      payload?: { job_type?: string };
    };
    if (payload.event_type === "job.completed") {
      message = payload.payload?.job_type === "add_to_cart"
        ? "后台加购已完成"
        : "后台搜索已完成";
    } else if (payload.event_type === "agent.workflow.updated") {
      message = "服务端 Agent 已推进到下一状态";
    } else if (payload.event_type === "job.failed") {
      message = "后台任务执行失败，可在执行台查看原因";
      shouldRefreshExecutorStatus = true;
    } else if (payload.event_type === "job.retry_scheduled") {
      message = "后台任务正在自动重试";
    } else if (payload.event_type === "job.requeued") {
      message = "任务已重新进入本地执行器队列";
    }
  } catch {
    // The persisted session remains the source of truth when metadata is unavailable.
  }

  return { message, shouldRefreshExecutorStatus };
}

export function useRuntimeEventStream({
  enabled,
  sessionId,
  hydrateSession,
  refreshExecutorStatus,
  updateStatusMessage
}: RuntimeEventStreamOptions) {
  useEffect(() => {
    if (!enabled || !sessionId) return;

    const cursorKey = `scenecart-event-cursor:${sessionId}`;
    const after = window.sessionStorage.getItem(cursorKey) ?? "0";
    const stream = new EventSource(
      `/api/runtime/events/stream?session_id=${encodeURIComponent(sessionId)}&after=${encodeURIComponent(after)}`
    );
    let refreshTimer: number | undefined;

    const refreshFromEvent = (event: Event) => {
      const messageEvent = event as MessageEvent<string>;
      if (messageEvent.lastEventId) {
        window.sessionStorage.setItem(cursorKey, messageEvent.lastEventId);
      }
      const { message, shouldRefreshExecutorStatus } = describeRuntimeEvent(messageEvent);

      if (refreshTimer) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        Promise.all([
          hydrateSession(sessionId),
          shouldRefreshExecutorStatus
            ? refreshExecutorStatus().catch(() => null)
            : Promise.resolve(null)
        ])
          .then(() => updateStatusMessage(message))
          .catch(() => undefined);
      }, 120);
    };

    for (const eventName of RUNTIME_EVENT_NAMES) {
      stream.addEventListener(eventName, refreshFromEvent);
    }

    return () => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      stream.close();
    };
  }, [enabled, hydrateSession, refreshExecutorStatus, sessionId, updateStatusMessage]);
}
