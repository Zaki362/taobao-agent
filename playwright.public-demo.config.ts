import { defineConfig, devices } from "@playwright/test";

const port = 3110;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "public-demo.spec.ts",
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
      name: "public-demo-chrome",
      use: {
        ...devices["Desktop Chrome"],
        channel: process.env.CI ? undefined : "chrome"
      }
    }
  ],
  webServer: {
    command: `npm --prefix apps/public-demo run dev -- --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    timeout: 210_000,
    reuseExistingServer: !process.env.CI
  }
});
