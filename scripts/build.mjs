import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

function runNextBuild(
  args = process.argv.slice(2),
  { root = process.cwd(), environment = process.env } = {}
) {
  const nextCli = path.join(root, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [nextCli, "build", ...args], {
    cwd: root,
    stdio: "inherit",
    env: environment
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

async function snapshotTrackedFile(file) {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
}

async function restoreTrackedFile(file, content) {
  if (content === null) {
    await fs.rm(file, { force: true });
    return;
  }
  await fs.writeFile(file, content);
}

export async function withRestoredNextBuildConfiguration(
  callback,
  { root = process.cwd(), environment = process.env } = {}
) {
  const resolvedRoot = path.resolve(root);
  const configuredTsconfig = environment.NEXT_TSCONFIG_PATH?.trim() || "tsconfig.json";
  const files = [...new Set([
    path.join(resolvedRoot, "next-env.d.ts"),
    path.resolve(resolvedRoot, configuredTsconfig)
  ])];
  const snapshots = await Promise.all(files.map((file) => snapshotTrackedFile(file)));

  try {
    return await callback();
  } finally {
    await Promise.all(files.map((file, index) => restoreTrackedFile(file, snapshots[index])));
  }
}

export async function buildApplication({
  root = process.cwd(),
  environment = process.env,
  args = process.argv.slice(2),
  runBuild = runNextBuild
} = {}) {
  const exitCode = await withRestoredNextBuildConfiguration(
    () => runBuild(args, { root, environment }),
    { root, environment }
  );
  if (exitCode !== 0) process.exitCode = exitCode;
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildApplication().catch((error) => {
    console.error(`[build] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
