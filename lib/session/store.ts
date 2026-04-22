import fs from "node:fs";
import path from "node:path";
import { SessionState } from "@/lib/session/types";

declare global {
  // eslint-disable-next-line no-var
  var __AUTOPREP_SESSION_STORE__: Map<string, SessionState> | undefined;
}

const store = globalThis.__AUTOPREP_SESSION_STORE__ ?? new Map<string, SessionState>();
globalThis.__AUTOPREP_SESSION_STORE__ = store;

const SESSION_DIR = path.join(process.cwd(), ".data", "sessions");

function ensureSessionDir() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

function sessionFile(sessionId: string) {
  ensureSessionDir();
  return path.join(SESSION_DIR, `${sessionId}.json`);
}

function isSessionState(value: unknown): value is SessionState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.session_id === "string" &&
    typeof record.raw_input === "string" &&
    record.scene_brief !== null &&
    typeof record.scene_brief === "object" &&
    Array.isArray(record.base_template) &&
    record.shopping_plan !== null &&
    typeof record.shopping_plan === "object" &&
    Array.isArray((record.shopping_plan as Record<string, unknown>).modules) &&
    Array.isArray(record.selected_items) &&
    Array.isArray(record.tool_logs)
  );
}

function normalizeSessionState(state: SessionState): SessionState {
  return {
    ...state,
    module_candidates: state.module_candidates ?? {},
    selected_items: Array.isArray(state.selected_items) ? state.selected_items : [],
    tool_logs: Array.isArray(state.tool_logs) ? state.tool_logs : [],
    hosted_tasks: Array.isArray((state as Partial<SessionState>).hosted_tasks)
      ? (state as Partial<SessionState>).hosted_tasks ?? []
      : [],
    execution_mode: state.execution_mode ?? "codex_hosted",
    permissions_scope: Array.isArray(state.permissions_scope) ? state.permissions_scope : [],
    deepseek_status: state.deepseek_status ?? "mock",
    mcp_status: state.mcp_status ?? "hosted",
    current_scene_label: state.current_scene_label ?? state.scene_brief.scene_type
  };
}

function readSessionFromDisk(sessionId: string) {
  const file = sessionFile(sessionId);
  if (!fs.existsSync(file)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isSessionState(parsed)) {
      return null;
    }
    return normalizeSessionState(parsed);
  } catch {
    return null;
  }
}

export function getSession(sessionId: string) {
  const inMemory = store.get(sessionId);
  if (inMemory) {
    return inMemory;
  }

  const persisted = readSessionFromDisk(sessionId);
  if (persisted) {
    store.set(sessionId, persisted);
    return persisted;
  }

  return null;
}

export function saveSession(state: SessionState) {
  const normalized = normalizeSessionState(state);
  store.set(normalized.session_id, normalized);
  const file = sessionFile(normalized.session_id);
  fs.writeFileSync(file, JSON.stringify(normalized, null, 2), "utf-8");
  return normalized;
}

export function listSessions() {
  ensureSessionDir();
  const fromDisk = fs
    .readdirSync(SESSION_DIR)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => readSessionFromDisk(entry.replace(/\.json$/, "")))
    .filter((item): item is SessionState => Boolean(item));

  for (const session of fromDisk) {
    store.set(session.session_id, session);
  }

  return Array.from(store.values());
}
