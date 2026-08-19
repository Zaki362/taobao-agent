import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export function shouldRunProductionMigrations(environment = process.env) {
  return environment.VERCEL_ENV === "production";
}

function runNextBuild(args = process.argv.slice(2)) {
  const nextCli = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [nextCli, "build", ...args], {
    stdio: "inherit",
    env: process.env
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (typeof code === "number") {
        resolve(code);
        return;
      }
      reject(new Error(`Next.js build terminated by signal ${signal ?? "unknown"}`));
    });
  });
}

export async function buildApplication() {
  if (shouldRunProductionMigrations()) {
    process.stdout.write("[build] Vercel Production detected; applying and verifying database migrations before build.\n");
    await import("./db-migrate.mjs");
    await import("./db-check.mjs");
  }
  const exitCode = await runNextBuild();
  if (exitCode !== 0) process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildApplication().catch((error) => {
    console.error(`[build] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
