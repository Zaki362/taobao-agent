import fs from "node:fs/promises";
import path from "node:path";
import { apiOk } from "@/lib/api/responses";
import { summarizeLogText } from "@/lib/mcp/logging";

const STATUS_FILE = path.join(process.cwd(), ".data", "hosted-worker", "worker-status.json");
const ONLINE_TTL_MS = 15_000;

function optionalStatusText(value: unknown) {
  return typeof value === "string" && value.trim() ? summarizeLogText(value, 220) : null;
}

export async function GET() {
  try {
    const raw = await fs.readFile(STATUS_FILE, "utf-8");
    const payload = raw ? JSON.parse(raw) : {};
    const updatedAt = typeof payload.updated_at === "string" ? Date.parse(payload.updated_at) : NaN;
    const online = Number.isFinite(updatedAt) ? Date.now() - updatedAt < ONLINE_TTL_MS : false;

    return apiOk({
      online,
      updated_at: payload.updated_at ?? null,
      started_at: payload.started_at ?? null,
      state: payload.state ?? "unknown",
      mode: payload.mode ?? null,
      interval_ms: payload.interval_ms ?? null,
      pid: payload.pid ?? null,
      api_base_url: payload.api_base_url ?? null,
      last_task_id: payload.last_task_id ?? null,
      last_task_type: payload.last_task_type ?? null,
      last_result: optionalStatusText(payload.last_result),
      last_error: optionalStatusText(payload.last_error)
    });
  } catch {
    return apiOk({
      online: false,
      updated_at: null,
      started_at: null,
      state: "offline",
      mode: null,
      interval_ms: null,
      pid: null,
      api_base_url: null,
      last_task_id: null,
      last_task_type: null,
      last_result: null,
      last_error: null
    });
  }
}
