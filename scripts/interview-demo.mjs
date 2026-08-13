import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";
import { loadInterviewDemoSnapshot } from "./interview-demo-utils.mjs";

const root = process.cwd();
const args = new Set(process.argv.slice(2));
const verifyOnly = args.has("--verify") || process.env.SCENECART_INTERVIEW_DEMO_VERIFY === "true";
const headless = verifyOnly || args.has("--headless");
const port = Number(process.env.SCENECART_INTERVIEW_PORT || 3200);
const baseUrl = `http://127.0.0.1:${port}`;
const stepDelayMs = verifyOnly
  ? 0
  : Math.max(0, Number(process.env.SCENECART_INTERVIEW_STEP_DELAY_MS || 650));
const artifactDir = path.join(root, ".data", "interview-demo");
const screenshotPath = path.join(artifactDir, "latest-final.png");
const reportPath = path.join(artifactDir, "latest-report.json");
const snapshot = await loadInterviewDemoSnapshot();

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("SCENECART_INTERVIEW_PORT 必须是 1024-65535 之间的端口");
}

let appProcess;
let workerProcess;
let browser;
let shuttingDown = false;
const recentServerOutput = [];

function writeLine(message) {
  process.stdout.write(`[interview-demo] ${message}\n`);
}

function rememberServerOutput(chunk, stream) {
  const text = chunk.toString();
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    recentServerOutput.push(line);
    if (recentServerOutput.length > 30) recentServerOutput.shift();
    stream.write(`[interview-app] ${line}\n`);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertPortAvailable() {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => reject(error));
    server.once("listening", () => server.close(resolve));
    server.listen(port, "127.0.0.1");
  }).catch((error) => {
    if (error?.code === "EADDRINUSE") {
      throw new Error(`端口 ${port} 已被占用；请设置 SCENECART_INTERVIEW_PORT 使用其他端口`);
    }
    throw error;
  });
}

function startApp() {
  const recoverySecret = "interview-demo-recovery-secret-with-at-least-32-characters";
  const env = {
    ...process.env,
    NEXT_DIST_DIR: ".next-interview-demo",
    NEXT_TSCONFIG_PATH: "tsconfig.e2e.json",
    AUTH_REQUIRED: "true",
    AUTH_COOKIE_SECURE: "false",
    APP_ORIGIN: baseUrl,
    RUNTIME_STORE: "local",
    SCENECART_LOCAL_RUNTIME_PERSIST: "false",
    SCENECART_PRODUCT_MODE: "development",
    SCENECART_INTERVIEW_DEMO: "true",
    ALLOW_DEMO_CART_FALLBACK: "false",
    TAOBAO_EXECUTION_BACKEND: "local_executor",
    SCENECART_CRON_SECRET: recoverySecret,
    DEEPSEEK_API_KEY: "",
    DEEPSEEK_DISABLED: "true"
  };
  const child = spawn(process.execPath, ["scripts/e2e-server.mjs", "--port", String(port)], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => rememberServerOutput(chunk, process.stdout));
  child.stderr.on("data", (chunk) => rememberServerOutput(chunk, process.stderr));
  return child;
}

async function waitForApp(timeoutMs = 210_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (appProcess.exitCode !== null) {
      throw new Error(
        `SceneCart 演示服务提前退出。\n${recentServerOutput.slice(-10).join("\n")}`
      );
    }
    try {
      const response = await fetch(`${baseUrl}/api/runtime/health`, {
        signal: AbortSignal.timeout(2_000)
      });
      if (response.ok) return;
    } catch {}
    await delay(500);
  }
  throw new Error("等待 SceneCart 演示服务启动超时");
}

async function launchBrowser() {
  const options = { headless, slowMo: verifyOnly ? 0 : 80 };
  try {
    return await chromium.launch({ ...options, channel: "chrome" });
  } catch (chromeError) {
    try {
      return await chromium.launch(options);
    } catch {
      throw chromeError;
    }
  }
}

async function waitUntilEnabled(locator, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await locator.isVisible().catch(() => false) && await locator.isEnabled().catch(() => false)) {
      return;
    }
    await delay(250);
  }
  throw new Error(`等待按钮可用超时：${await locator.textContent().catch(() => "未知按钮")}`);
}

async function step(label, action) {
  writeLine(label);
  await action();
  if (stepDelayMs) await delay(stepDelayMs);
}

async function registerDemoIdentity(page, context) {
  await page.goto(`${baseUrl}/settings/executor`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "还没有账号？创建账号" }).click();
  await page.getByLabel("邮箱").fill(`interview-demo-${Date.now()}@example.com`);
  await page.getByLabel("密码").fill("interview-demo-password");
  await page.getByRole("button", { name: "注册并登录" }).click();
  await page.waitForURL(/\/settings\/executor$/);

  const response = await context.request.post(`${baseUrl}/api/executor/devices`, {
    headers: { Origin: baseUrl },
    data: {
      name: "SceneCart 面试演示执行器（不连接淘宝）",
      capabilities: ["module_search", "add_to_cart"]
    }
  });
  if (response.status() !== 201) {
    throw new Error(`注册面试演示设备失败：${response.status()} ${await response.text()}`);
  }
  return response.json();
}

function startWorker(deviceToken) {
  const child = spawn(process.execPath, ["scripts/interview-demo-executor.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      SCENECART_INTERVIEW_DEMO: "true",
      SCENECART_API_URL: baseUrl,
      SCENECART_DEVICE_TOKEN: deviceToken,
      EXECUTOR_POLL_MS: "150"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  return child;
}

async function waitForWorker(context, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (workerProcess.exitCode !== null) {
      throw new Error("面试演示执行器提前退出");
    }
    const response = await context.request.get(`${baseUrl}/api/mcp/status`);
    if (response.ok()) {
      const status = await response.json();
      if (
        status.mode === "local_executor" &&
        status.available === true &&
        status.executor_devices?.capabilities?.add_to_cart?.available === true
      ) {
        return;
      }
    }
    await delay(250);
  }
  throw new Error("等待面试演示执行器上线超时");
}

async function waitForWorkflowCompletion(context, sessionId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await context.request.get(
      `${baseUrl}/api/session/state?session_id=${encodeURIComponent(sessionId)}`
    );
    if (response.ok()) {
      const state = await response.json();
      if (state.agent_runtime?.workflow_status === "completed") return state;
      if (state.agent_runtime?.workflow_status === "paused") {
        throw new Error(`Agent 意外暂停：${state.agent_runtime.workflow_message || "未知原因"}`);
      }
    }
    await delay(300);
  }
  throw new Error("等待 Agent 完成历史快照候选编排超时");
}

async function runDemo(page, context) {
  await step("创建隔离的面试演示账号与本地演示设备", async () => {
    const registration = await registerDemoIdentity(page, context);
    workerProcess = startWorker(registration.device_token);
    await waitForWorker(context);
  });

  await step("进入新车选购场景", async () => {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /新车选购 提车初期分阶段补齐高频车用品/ }).click();
  });

  await step("输入固定演示需求", async () => {
    await page.locator("textarea").fill(
      "刚提新能源 SUV，预算 3000，希望优先买最实用的新车用品，不考虑装饰类，已有行车记录仪。"
    );
    await page.getByRole("button", { name: "开始理解需求" }).click();
    await page.getByText("确认新车选购需求").waitFor();
  });

  await step("确认结构化需求并生成购物规划", async () => {
    await page.getByRole("button", { name: "确认无误，生成购买路线" }).click();
    await page.getByText("确认新车购物规划").waitFor();
  });

  const sessionId = await page.evaluate(() => {
    const raw = window.localStorage.getItem("scenecart-dashboard-state");
    if (!raw) return "";
    return String(JSON.parse(raw).sessionId || "");
  });
  if (!sessionId) throw new Error("页面没有保存 SceneCart session_id");

  await step("启动 Agent Runtime；演示执行器只读取历史快照", async () => {
    await page.getByRole("button", { name: "就按这个方案开始找商品" }).click();
    await page.getByText("Agent 正在行动", { exact: true }).waitFor();
  });

  const completedState = await waitForWorkflowCompletion(context, sessionId);
  if (Object.keys(completedState.module_candidates || {}).length < 5) {
    throw new Error("历史快照没有覆盖完整的五模块演示规划");
  }

  await step("打开推荐结果并核对非实时披露", async () => {
    await page.goto(`${baseUrl}/?resume=1`, { waitUntil: "domcontentloaded" });
    const reviewButton = page.getByRole("button", { name: "查看推荐结果" });
    await waitUntilEnabled(reviewButton);
    await reviewButton.click();
    await page.getByText("非实时结果", { exact: true }).first().waitFor();
    await page.getByText("购买前确认", { exact: true }).first().click();
    await page.getByText(/面试演示数据：采集于 2026-08-08/).first().waitFor();
  });

  await step("确认加入产品内演示清单（不会调用淘宝加购）", async () => {
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "加入购物车" }).first().click();
    await page.getByText("演示已加", { exact: true }).first().waitFor({ timeout: 30_000 });
  });

  await step("进入购买确认，展示最终购物清单", async () => {
    const shoppingListButton = page.getByRole("button", { name: "查看购物清单" });
    await shoppingListButton.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: /购物清单共 \d+ 件/ }).waitFor();
    await page.getByText("我的购物清单", { exact: true }).waitFor();
    await page.getByText("演示清单", { exact: true }).first().waitFor();
    await page.getByRole("button", { name: "当前仅有演示清单" }).waitFor();
  });

  const finalResponse = await context.request.get(
    `${baseUrl}/api/session/state?session_id=${encodeURIComponent(sessionId)}`
  );
  const finalState = await finalResponse.json();
  if (!finalResponse.ok() || finalState.selected_items?.length !== 1) {
    throw new Error("最终购买确认没有且仅有一个已确认演示商品");
  }
  if (finalState.selected_items[0].cart_source !== "demo") {
    throw new Error("安全边界失败：面试模式商品被误标记为真实淘宝加购");
  }

  await fs.mkdir(artifactDir, { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await fs.writeFile(reportPath, JSON.stringify({
    verified_at: new Date().toISOString(),
    result: "passed",
    session_id: sessionId,
    final_stage: "cart_review",
    planned_modules: completedState.shopping_plan?.modules?.length || 0,
    covered_modules: Object.keys(completedState.module_candidates || {}).length,
    selected_items: finalState.selected_items.map((item) => ({
      product_id: item.product_id,
      title: item.title,
      cart_source: item.cart_source,
      cart_note: item.cart_note
    })),
    data_source: {
      kind: snapshot.kind,
      captured_at: snapshot.captured_at,
      realtime: false,
      disclosure: snapshot.disclosure
    },
    safety: {
      taobao_search_calls: 0,
      taobao_add_to_cart_calls: 0,
      taobao_order_calls: 0,
      taobao_payment_calls: 0
    },
    screenshot: screenshotPath
  }, null, 2));

  return { sessionId, finalState };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGINT");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(3_000)
  ]);
  if (child.exitCode === null) child.kill("SIGTERM");
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (browser) await browser.close().catch(() => undefined);
  await stopChild(workerProcess);
  await stopChild(appProcess);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    shutdown().catch(() => undefined);
  });
}

try {
  await assertPortAvailable();
  writeLine(`启动隔离服务 ${baseUrl}（首次构建可能需要约 1 分钟）`);
  appProcess = startApp();
  await waitForApp();
  browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => process.stderr.write(`[interview-browser] ${error.message}\n`));

  const result = await runDemo(page, context);
  writeLine(`全流程已跑通；session=${result.sessionId}`);
  writeLine(`最终页：我的购物清单；购物车来源=产品内演示清单；真实淘宝调用=0`);
  writeLine(`历史数据：${snapshot.captured_at}，价格/库存/规格均非实时`);
  writeLine(`截图：${screenshotPath}`);
  writeLine(`验证报告：${reportPath}`);

  if (!verifyOnly) {
    writeLine("浏览器将停留在最终购买确认页；按 Ctrl+C 安全关闭演示环境");
    await new Promise((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  }
} catch (error) {
  process.exitCode = 1;
  process.stderr.write(`[interview-demo] 失败：${error instanceof Error ? error.stack || error.message : String(error)}\n`);
} finally {
  await shutdown();
}
