import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    clearMocks: true,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      RUNTIME_STORE: "postgres",
      TAOBAO_EXECUTION_BACKEND: "local_executor",
      DEEPSEEK_API_KEY: "",
      DEEPSEEK_DISABLED: "true"
    }
  }
});
