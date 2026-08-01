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
    include: ["tests/unit/**/*.test.{ts,mjs}"],
    clearMocks: true,
    fileParallelism: false,
    env: {
      RUNTIME_STORE: "local",
      TAOBAO_EXECUTION_BACKEND: "local_executor",
      DEEPSEEK_API_KEY: "",
      DEEPSEEK_DISABLED: "true"
    }
  }
});
