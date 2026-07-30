import { fileURLToPath } from "node:url";
import { loadEnvConfig } from "@next/env";
import { defineConfig } from "vitest/config";

const liveEvaluation = process.env.AGENT_EVAL_LIVE === "true";
if (liveEvaluation) {
  loadEnvConfig(process.cwd());
}

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["tests/evaluation/**/*.test.ts"],
    clearMocks: true,
    fileParallelism: false,
    testTimeout: liveEvaluation ? 90_000 : 15_000,
    env: {
      RUNTIME_STORE: "local",
      TAOBAO_EXECUTION_BACKEND: "local_executor",
      DEEPSEEK_DISABLED: liveEvaluation ? "false" : "true",
      DEEPSEEK_API_KEY: liveEvaluation ? process.env.DEEPSEEK_API_KEY ?? "" : ""
    }
  }
});
