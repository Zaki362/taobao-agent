import { getRuntimeRepository } from "@/lib/runtime";
import type { SessionState } from "@/lib/session/types";

export async function loadSession(sessionId: string, userId?: string) {
  return getRuntimeRepository().getSession(sessionId, userId);
}

export async function persistSession(state: SessionState) {
  await getRuntimeRepository().saveSession(state);
}

export async function loadSessions(userId?: string) {
  return getRuntimeRepository().listSessions(userId);
}
