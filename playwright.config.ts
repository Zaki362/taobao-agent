import { defineConfig, devices } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

const port = 3100;
const baseURL = `http://127.0.0.1:${port}`;
const inheritedOrRandomUuid = (name: string) => process.env[name]?.trim() || randomUUID();
const inheritedOrRandomToken = (name: string) =>
  process.env[name]?.trim() || randomBytes(32).toString("base64url");

// Every Playwright invocation owns an isolated local runtime. Assigning these
// values to the runner process lets test modules and the spawned web server
// share the same fixture without ever serializing credentials into source.
const e2eEnvironment = {
  SCENECART_E2E_OWNER_ID: inheritedOrRandomUuid("SCENECART_E2E_OWNER_ID"),
  SCENECART_E2E_MODULE_DEVICE_ID: inheritedOrRandomUuid("SCENECART_E2E_MODULE_DEVICE_ID"),
  SCENECART_E2E_MODULE_DEVICE_TOKEN: inheritedOrRandomToken("SCENECART_E2E_MODULE_DEVICE_TOKEN"),
  SCENECART_E2E_FULL_DEVICE_ID: inheritedOrRandomUuid("SCENECART_E2E_FULL_DEVICE_ID"),
  SCENECART_E2E_FULL_DEVICE_TOKEN: inheritedOrRandomToken("SCENECART_E2E_FULL_DEVICE_TOKEN"),
  SCENECART_LOCAL_RUNTIME_PATH: path.join(
    process.cwd(),
    ".data",
    "e2e",
    randomBytes(12).toString("hex"),
    "local-runtime.json"
  )
};

Object.assign(process.env, e2eEnvironment);

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
    // Reusing an unrelated process would couple random fixture credentials to
    // stale state. Fail on a busy port instead of silently testing the wrong app.
    reuseExistingServer: false,
    env: {
      ...process.env,
      ...e2eEnvironment,
      NEXT_DIST_DIR: ".next-e2e",
      NEXT_TSCONFIG_PATH: "tsconfig.e2e.json",
      SCENECART_ACCESS_MODE: "single_user",
      SCENECART_SINGLE_USER_ID: e2eEnvironment.SCENECART_E2E_OWNER_ID,
      SCENECART_PRODUCT_MODE: "development",
      VERCEL_ENV: "development",
      AUTH_REQUIRED: "false",
      AUTH_COOKIE_SECURE: "false",
      APP_ORIGIN: baseURL,
      RUNTIME_STORE: "local",
      SCENECART_LOCAL_RUNTIME_PERSIST: "true",
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
