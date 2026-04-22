import { spawn } from "node:child_process";

const processes = [];

function spawnCommand(command, args, name) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: process.env,
    shell: true
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

console.log("[dev:auto] starting Next.js dev server and Codex hosted worker...");
console.log("[dev:auto] the hosted worker packages tasks for Codex host execution.");

spawnCommand("npm", ["run", "dev"], "next-dev");
setTimeout(() => {
  spawnCommand("npm", ["run", "worker:codex", "--", "watch"], "codex-worker");
}, 2500);
