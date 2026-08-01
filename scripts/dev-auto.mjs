import { spawn } from "node:child_process";
import process from "node:process";
import nextEnv from "@next/env";
import { resolveDevServer } from "./dev-server.mjs";

const processes = [];
const { combinedEnv } = nextEnv.loadEnvConfig(process.cwd());
const runtimeEnv = { ...process.env, ...combinedEnv };
const devServer = await resolveDevServer({ env: runtimeEnv });
const apiBaseUrl = devServer.url;
runtimeEnv.SCENECART_API_URL = apiBaseUrl;
runtimeEnv.SCENECART_DEV_PORT = String(devServer.port);

function spawnCommand(command, args, name) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: runtimeEnv
  });

  child.on("exit", (code) => {
    if (code && code !== 0) {
      console.error(`[${name}] exited with code ${code}`);
    }
  });

  processes.push(child);
  return child;
}

function shutdown() {
  for (const child of processes) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function waitForApi(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiBaseUrl}/api/runtime/health`, {
        signal: AbortSignal.timeout(1_500)
      });
      if (response.ok) return true;
    } catch {
      // The dev server is still compiling.
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return false;
}

console.log("[dev:auto] starting SceneCart AI with the local executor architecture...");
console.log(`[dev:auto] web and local executor will use ${apiBaseUrl}`);

spawnCommand("npm", ["run", "dev", "--", "--port", String(devServer.port)], "next-dev");

if (!runtimeEnv.SCENECART_DEVICE_TOKEN) {
  console.log("[dev:auto] SCENECART_DEVICE_TOKEN is not configured; the web app will start without a worker.");
  console.log(`[dev:auto] register a device at ${apiBaseUrl}/settings/executor, then run npm run worker:local.`);
} else if (await waitForApi()) {
  spawnCommand("npm", ["run", "worker:local"], "local-executor");
} else {
  console.error(`[dev:auto] ${apiBaseUrl} did not become healthy; local executor was not started.`);
}
