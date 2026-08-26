import { defineConfig, devices } from "@playwright/test";

const port = 3100;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: "public-demo.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: {
    timeout: 20_000
  },
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  projects: [
    {
      name: "desktop-chrome",
      use: {
        ...devices["Desktop Chrome"],
        channel: process.env.CI ? undefined : "chrome"
      }
    }
  ],
  webServer: {
    command: `node scripts/e2e-server.mjs --port ${port}`,
    url: baseURL,
    timeout: 210_000,
    reuseExistingServer: !process.env.CI,
    env: {
      ...process.env,
      NEXT_DIST_DIR: ".next-e2e",
      NEXT_TSCONFIG_PATH: "tsconfig.e2e.json",
      AUTH_REQUIRED: "true",
      AUTH_COOKIE_SECURE: "false",
      APP_ORIGIN: baseURL,
      RUNTIME_STORE: "local",
      SCENECART_LOCAL_RUNTIME_PERSIST: "false",
      TAOBAO_EXECUTION_BACKEND: "local_executor",
      ALLOW_DEMO_CART_FALLBACK: "false",
      SCENECART_CRON_SECRET: "playwright-recovery-secret-with-at-least-32-characters",
      DEEPSEEK_API_KEY: "",
      DEEPSEEK_DISABLED: "true",
      SCENECART_AI_RATE_LIMIT_MINUTE_IP: "1000",
      SCENECART_AI_RATE_LIMIT_MINUTE_ACCOUNT: "1000",
      SCENECART_WORKFLOW_RATE_LIMIT_MINUTE_IP: "1000",
      SCENECART_WORKFLOW_RATE_LIMIT_MINUTE_ACCOUNT: "1000",
      SCENECART_EVENT_STREAM_RATE_LIMIT_MINUTE_IP: "1000",
      SCENECART_EVENT_STREAM_RATE_LIMIT_MINUTE_ACCOUNT: "1000"
    }
  }
});
