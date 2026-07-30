import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import nextEnv from "@next/env";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { combinedEnv } = nextEnv.loadEnvConfig(projectRoot);
const apiKey = combinedEnv.DEEPSEEK_API_KEY;

if (!apiKey) {
  process.stderr.write("在线 Agent 评测需要在 .env.local 中配置 DEEPSEEK_API_KEY。\n");
  process.exit(1);
}

const vitestEntry = path.join(projectRoot, "node_modules", "vitest", "vitest.mjs");
const child = spawn(process.execPath, [
  vitestEntry,
  "run",
  "--config",
  "vitest.evaluation.config.ts",
  ...process.argv.slice(2)
], {
  cwd: projectRoot,
  env: {
    ...process.env,
    ...combinedEnv,
    AGENT_EVAL_LIVE: "true",
    DEEPSEEK_DISABLED: "false",
    DEEPSEEK_API_KEY: apiKey
  },
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.stderr.write(`在线 Agent 评测被信号 ${signal} 中止。\n`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
