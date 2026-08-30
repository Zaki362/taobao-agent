import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  isVercelProtectionError,
  safeMachineErrorMessage,
  vercelProtectedFetch
} from "./vercel-protection-bypass.mjs";

for (const filename of [".env", ".env.local"]) {
  const target = path.join(process.cwd(), filename);
  if (!fs.existsSync(target)) continue;
  for (const rawLine of fs.readFileSync(target, "utf-8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const apiBaseUrl = (process.env.SCENECART_API_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const secret = process.env.SCENECART_CRON_SECRET?.trim() ?? "";
const intervalMs = Math.max(Number(process.env.SCENECART_RECOVERY_INTERVAL_MS || 30_000), 10_000);
const once = process.argv.includes("--once");
let stopped = false;
let fatalAuthenticationError = null;

class RecoveryAuthenticationError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "RecoveryAuthenticationError";
    this.status = status;
  }
}

if (secret.length < 32) {
  throw new Error("SCENECART_CRON_SECRET must contain at least 32 characters");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function recover() {
  const response = await vercelProtectedFetch(`${apiBaseUrl}/api/internal/workflow-recovery?limit=5`, {
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(55_000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new RecoveryAuthenticationError(
        payload.error || `workflow recovery authentication failed with HTTP ${response.status}`,
        response.status
      );
    }
    throw new Error(payload.error || `workflow recovery failed with HTTP ${response.status}`);
  }
  const timestamp = new Date().toISOString();
  const failed = Array.isArray(payload.items)
    ? payload.items.filter((item) => item?.reason === "recovery_failed").length
    : 0;
  process.stdout.write(
    `[场景购 Recovery] ${timestamp} scanned=${payload.scanned ?? 0} recovered=${payload.recovered ?? 0} failed=${failed}\n`
  );
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopped = true;
  });
}

do {
  await recover().catch((error) => {
    const message = safeMachineErrorMessage(error);
    process.stderr.write(`[场景购 Recovery] ${new Date().toISOString()} ${message}\n`);
    if (isVercelProtectionError(error) || error instanceof RecoveryAuthenticationError) {
      fatalAuthenticationError = error;
      stopped = true;
    }
  });
  if (!once && !stopped) await sleep(intervalMs);
} while (!once && !stopped);

if (fatalAuthenticationError) process.exitCode = 1;
