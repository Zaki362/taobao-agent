import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

const SCAN_DIRS = ["app", "components", "lib", "scripts", "docs"];
const SCAN_FILES = [
  ".env.example",
  "README.md",
  "package.json",
  "architecture_and_technical_design.md",
  "product_creation_recap.md"
];
const FORBIDDEN_TEXT_EXCLUDES = new Set(["scripts/preflight.mjs"]);
const SKIP_DIRS = new Set([".git", ".next", ".data", "node_modules", "out", "dist", "coverage"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".json", ".md"]);

const failures = [];

function fail(message) {
  failures.push(message);
}

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf-8");
}

function tryReadText(relativePath) {
  try {
    return readText(relativePath);
  } catch {
    fail(`无法读取文件：${relativePath}`);
    return null;
  }
}

function walk(relativeDir) {
  const absoluteDir = path.join(ROOT, relativeDir);
  if (!fs.existsSync(absoluteDir)) {
    return [];
  }

  const entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        files.push(...walk(relativePath));
      }
      continue;
    }

    if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(relativePath);
    }
  }

  return files;
}

function scannedFiles() {
  return [
    ...SCAN_DIRS.flatMap(walk),
    ...SCAN_FILES.filter((file) => fs.existsSync(path.join(ROOT, file)))
  ];
}

function assertNoForbiddenText() {
  const forbidden = [
    {
      pattern: /sk-[A-Za-z0-9_-]{20,}/,
      message: "疑似 API Key 被写入仓库文件"
    },
    {
      pattern: /TAOBAO_MCP_MODE/,
      message: "发现旧环境变量 TAOBAO_MCP_MODE，请使用 TAOBAO_EXECUTION_BACKEND",
      allowedFiles: new Set(["lib/runtime/readiness.ts", "scripts/release-audit.mjs"])
    },
    {
      pattern: /TAOBAO_NATIVE_PATH/,
      message: "发现旧环境变量 TAOBAO_NATIVE_PATH；正式执行器请使用 TAOBAO_NATIVE_MCP_URL"
    },
    {
      pattern: /NEXT_PUBLIC_SCENECART_SINGLE_USER_ID/,
      message: "固定 owner ID 不得进入浏览器环境变量或前端 bundle"
    },
    {
      pattern: /NEXT_PUBLIC_SCENECART_ALLOW_UNPROTECTED_SINGLE_USER_PRODUCTION/,
      message: "公开单用户 Production 风险开关只能存在于服务端环境"
    },
    {
      pattern: /NEXT_PUBLIC_SCENECART_VERCEL_PROTECTION_MODE/,
      message: "Vercel 机器传输模式只能存在于服务端或本机 Worker 环境"
    },
    {
      pattern: /\/Users\/guohuaz/,
      message: "发现本机用户名硬编码路径，请改为环境变量或 homedir()"
    },
    {
      pattern: /await\s+request\.json\(\);/,
      message: "发现裸 request.json()，请使用 catch 兜底并返回统一 API 错误"
    }
  ];

  for (const file of scannedFiles()) {
    if (FORBIDDEN_TEXT_EXCLUDES.has(file)) {
      continue;
    }

    const text = readText(file);
    for (const rule of forbidden) {
      if (rule.allowedFiles?.has(file)) {
        continue;
      }
      if (rule.pattern.test(text)) {
        fail(`${file}: ${rule.message}`);
      }
    }
  }
}

function assertEnvExample() {
  const envText = tryReadText(".env.example");
  if (!envText) {
    return;
  }

  const required = [
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_CHAT_MODEL",
    "DEEPSEEK_REASONER_MODEL",
    "DEEPSEEK_DISABLED",
    "DEEPSEEK_BUNDLE_TIMEOUT_MS",
    "SCENECART_PRODUCT_MODE",
    "ALLOW_DEMO_CART_FALLBACK",
    "TAOBAO_EXECUTION_BACKEND",
    "TAOBAO_NATIVE_MCP_URL",
    "TAOBAO_MCP_BASE_URL",
    "SCENECART_ENABLE_MCP_DEBUG",
    "SCENECART_ACCESS_MODE",
    "SCENECART_SINGLE_USER_ID",
    "SCENECART_ALLOW_UNPROTECTED_SINGLE_USER_PRODUCTION",
    "SCENECART_OUTER_PROTECTION_VERIFIED",
    "SCENECART_OUTER_PROTECTION_SCOPE",
    "SCENECART_OUTER_PROTECTION_VERIFIED_AT",
    "SCENECART_OUTER_PROTECTION_PROJECT_ID",
    "SCENECART_OUTER_PROTECTION_ORIGIN",
    "SCENECART_OUTER_PROTECTION_AUDIT_RECEIPT",
    "SCENECART_PUBLIC_DEMO_URL",
    "SCENECART_DEV_PORT",
    "SCENECART_VERCEL_PROTECTION_MODE",
    "APP_ORIGIN"
  ];

  for (const key of required) {
    if (!envText.includes(`${key}=`)) {
      fail(`.env.example: 缺少 ${key}`);
    }
  }
}

function assertPackageScripts() {
  const pkgText = tryReadText("package.json");
  if (!pkgText) {
    return;
  }

  let pkg;
  try {
    pkg = JSON.parse(pkgText);
  } catch {
    fail("package.json: 不是有效 JSON");
    return;
  }

  const scripts = pkg.scripts ?? {};
  const required = ["dev", "build", "typecheck", "preflight", "release:audit", "release:verify", "check", "db:migrate", "db:check", "test:unit", "test:integration", "test:e2e", "eval:agent", "worker:local", "worker:recovery", "executor:configure", "executor:doctor", "demo:cloud:prepare", "demo:cloud:configure", "demo:cloud"];

  for (const scriptName of required) {
    if (typeof scripts[scriptName] !== "string") {
      fail(`package.json: 缺少 npm script "${scriptName}"`);
    }
  }

  if (typeof scripts.check === "string" && !scripts.check.includes("preflight")) {
    fail("package.json: npm run check 应包含 preflight");
  }
}

function assertGitignore() {
  const gitignore = tryReadText(".gitignore");
  if (!gitignore) {
    return;
  }

  const required = ["node_modules", ".next", ".next-*", ".env.local", ".data", "search_*.json", "*.tsbuildinfo"];

  for (const entry of required) {
    if (!gitignore.includes(entry)) {
      fail(`.gitignore: 缺少 ${entry}`);
    }
  }
}

function assertExecutorConfigurator() {
  const configurator = tryReadText("scripts/configure-executor.mjs");
  const utilities = tryReadText("scripts/executor-config-utils.mjs");
  const settings = tryReadText("components/executor-settings.tsx");
  const settingsPage = tryReadText("app/settings/executor/page.tsx");
  if (!configurator || !utilities || !settings || !settingsPage) return;

  if (
    !configurator.includes("hiddenQuestion") ||
    !configurator.includes("mode: 0o600") ||
    !configurator.includes("fs.rename") ||
    !utilities.includes("TAOBAO_EXECUTION_BACKEND") ||
    !utilities.includes("SCENECART_DEVICE_TOKEN") ||
    !settings.includes("npm run executor:configure") ||
    !settings.includes("SCENECART_API_URL=${apiUrl}") ||
    !settingsPage.includes("requireAuthenticatedPageIdentity")
  ) {
    fail("本地执行器必须提供固定 owner 绑定和不回显令牌的配置入口");
  }
}

function assertDevelopmentLauncher() {
  const launcher = tryReadText("scripts/dev-server.mjs");
  const autoLauncher = tryReadText("scripts/dev-auto.mjs");
  const workerSupervisor = tryReadText("scripts/dev-auto-supervisor.mjs");
  const pkgText = tryReadText("package.json");
  if (!launcher || !autoLauncher || !workerSupervisor || !pkgText) return;

  let pkg;
  try {
    pkg = JSON.parse(pkgText);
  } catch {
    return;
  }

  if (
    !String(pkg.scripts?.dev ?? "").includes("scripts/dev-auto.mjs") ||
    !String(pkg.scripts?.["dev:web"] ?? "").includes("scripts/dev-server.mjs") ||
    !launcher.includes("resolveDevServer") ||
    !launcher.includes('probeAddress(port, "127.0.0.1")') ||
    !launcher.includes('probeAddress(port, "::", true)') ||
    !launcher.includes("SCENECART_DEV_PORT") ||
    !launcher.includes("NEXT_DIST_DIR: resolveDevDistDir(runtimeEnv)") ||
    !autoLauncher.includes('from "./dev-server.mjs"') ||
    !autoLauncher.includes("runtimeEnv.SCENECART_API_URL = apiBaseUrl") ||
    !autoLauncher.includes("resolveExecutorEnvironment") ||
    !autoLauncher.includes("discoverAndStartWorker") ||
    !autoLauncher.includes("createWorkerSupervisor") ||
    !autoLauncher.includes('spawn("npm", ["run", "worker:local"]') ||
    !autoLauncher.includes("env: config.env") ||
    !workerSupervisor.includes("scheduleRestart") ||
    !workerSupervisor.includes("WORKER_RESTART_MAX_MS") ||
    !workerSupervisor.includes('child.kill("SIGTERM")')
  ) {
    fail("默认开发启动器必须检测双栈端口冲突、隔离开发构建缓存、热发现设备令牌、监督单一 Worker，并让网页与本地执行器共享同一个实际 API 地址");
  }
}

function assertProductionBuildMigrationGate() {
  const pkgText = tryReadText("package.json");
  const buildScript = tryReadText("scripts/build.mjs");
  if (!pkgText || !buildScript) return;
  let pkg;
  try {
    pkg = JSON.parse(pkgText);
  } catch {
    return;
  }
  if (
    !String(pkg.scripts?.build ?? "").includes("scripts/build.mjs") ||
    !String(pkg.scripts?.["db:migrate"] ?? "").includes("db-migrate.mjs") ||
    !String(pkg.scripts?.["db:check"] ?? "").includes("db-check.mjs") ||
    buildScript.includes('import("./db-migrate.mjs")') ||
    buildScript.includes('import("./db-check.mjs")')
  ) {
    fail("数据库迁移必须由独立 release 阶段执行并验证，Next.js 构建不得直接修改数据库");
  }
}

function assertBuildConfigurationIsolation() {
  const buildScript = tryReadText("scripts/build.mjs");
  if (!buildScript) return;

  if (
    !buildScript.includes("withRestoredNextBuildConfiguration") ||
    !buildScript.includes('path.join(resolvedRoot, "next-env.d.ts")') ||
    !buildScript.includes("environment.NEXT_TSCONFIG_PATH") ||
    !buildScript.includes("snapshotTrackedFile") ||
    !buildScript.includes("restoreTrackedFile") ||
    !buildScript.includes("finally")
  ) {
    fail("Next.js build 必须在成功或失败后恢复 next-env.d.ts 与构建使用的 tsconfig");
  }
}

function assertE2EServerIsolation() {
  const playwright = tryReadText("playwright.config.ts");
  const nextConfig = tryReadText("next.config.ts");
  const server = tryReadText("scripts/e2e-server.mjs");
  const tsconfig = tryReadText("tsconfig.e2e.json");
  if (!playwright || !nextConfig || !server || !tsconfig) return;

  if (
    !playwright.includes("scripts/e2e-server.mjs") ||
    !playwright.includes('NEXT_DIST_DIR: ".next-e2e"') ||
    !playwright.includes('NEXT_TSCONFIG_PATH: "tsconfig.e2e.json"') ||
    !playwright.includes('AUTH_COOKIE_SECURE: "false"') ||
    !playwright.includes("APP_ORIGIN: baseURL") ||
    !nextConfig.includes("NEXT_TSCONFIG_PATH") ||
    !server.includes('runNext(["build"') ||
    !server.includes("buildTimeoutMs = 90_000") ||
    !server.includes("buildWithOneRetry") ||
    !server.includes("prepareStandaloneAssets") ||
    !server.includes("standaloneServer") ||
    !server.includes("originalNextEnv") ||
    !server.includes("originalTsconfig") ||
    !server.includes("restore(nextEnvPath") ||
    !server.includes("restore(e2eTsconfigPath") ||
    !tsconfig.includes('".next-e2e/types/**/*.ts"')
  ) {
    fail("E2E 必须使用隔离的 distDir/tsconfig 构建不可变测试服务器，并在构建后恢复 Next.js 生成的配置文件");
  }
}

function assertDeploymentAssets() {
  const dockerfile = tryReadText("Dockerfile");
  const compose = tryReadText("docker-compose.yml");
  const dockerignore = tryReadText(".dockerignore");
  const dbCheck = tryReadText("scripts/db-check.mjs");
  if (!dockerfile || !compose || !dockerignore || !dbCheck) return;

  if (
    !dockerfile.includes('COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./') ||
    !dockerfile.includes("/app/db ./db") ||
    !dockerfile.includes("scripts/workflow-recovery-worker.mjs") ||
    !dockerfile.includes("USER nextjs")
  ) {
    fail("Docker 镜像必须使用非 root standalone 运行时，并包含 migration 与恢复 Worker 资产");
  }

  if (
    !compose.includes("postgres:") ||
    !compose.includes("app:") ||
    !compose.includes("recovery:") ||
    !compose.includes("node scripts/db-migrate.mjs && node scripts/db-check.mjs && node server.js") ||
    !compose.includes("TAOBAO_EXECUTION_BACKEND: local_executor") ||
    compose.includes("SCENECART_DEVICE_TOKEN:")
  ) {
    fail("Compose 必须启动 PostgreSQL、Web 与恢复服务，且不能把用户设备令牌注入云端容器");
  }

  if (!dockerignore.includes(".env*") || !dockerignore.includes(".data") || !dockerignore.includes("node_modules")) {
    fail(".dockerignore 必须排除本地密钥、运行数据和依赖目录");
  }

  if (!dbCheck.includes('"runtime_service_heartbeats"')) {
    fail("db:check 必须验证恢复调度心跳表存在，不能只依赖 migration 记录");
  }
}

function assertRequiredFiles() {
  const requiredFiles = [
    "app/api/scene/parse/route.ts",
    "app/api/scene/plan/route.ts",
    "app/api/scene/refine/route.ts",
    "app/api/agent/next-action/route.ts",
    "app/api/agent/pause/route.ts",
    "app/api/agent/resume/route.ts",
    "app/api/modules/search/route.ts",
    "app/api/cart/add/route.ts",
    "app/api/cart/remove/route.ts",
    "app/api/mcp/status/route.ts",
    "app/api/session/agent-directives/route.ts",
    "app/api/session/budget-reallocation/route.ts",
    "app/api/session/search-strategy/route.ts",
    "app/api/session/purchase-bundle/route.ts",
    "app/api/session/archive/route.ts",
    "app/api/session/state/route.ts",
    "app/api/runtime/readiness/route.ts",
    "app/api/internal/runtime-readiness/route.ts",
    "app/error.tsx",
    "components/dashboard.tsx",
    "components/dashboard-api.ts",
    "components/dashboard-confirmation.tsx",
    "components/dashboard-execution.tsx",
    "components/dashboard-intake.tsx",
    "components/dashboard-results-simple.tsx",
    "components/dashboard-workflow.ts",
    "lib/agent/directives.ts",
    "lib/agent/decision-engine.ts",
    "lib/agent/completion-review.ts",
    "lib/session/bundle-adoption.ts",
    "lib/session/lifecycle.ts",
    "app/api/agent/remediate/route.ts",
    "lib/agent/runtime-v2.ts",
    "lib/agent/orchestrator.ts",
    "lib/agent/planner.ts",
    "lib/agent/search-strategy.ts",
    "lib/agent/plan-reviewer.ts",
    "lib/agent/product-matcher.ts",
    "lib/agent/candidate-ranker.ts",
    "lib/agent/candidate-reviewer.ts",
    "lib/api/responses.ts",
    "lib/auth/hosted-worker.ts",
    "lib/auth/return-path.ts",
    "lib/llm/deepseek.ts",
    "lib/llm/prompts.ts",
    "lib/llm/validation.ts",
    "lib/llm/telemetry.ts",
    "lib/llm/session-evidence.ts",
    "lib/mcp/client.ts",
    "lib/mcp/local-executor.ts",
    "lib/runtime/executor-protocol.json",
    "lib/runtime/executor-protocol.ts",
    "lib/runtime/startup-standby.ts",
    "lib/runtime/postgres-repository.ts",
    "app/api/executor/startup/route.ts",
    "scripts/release-audit.mjs",
    "scripts/release-verify.mjs",
    "lib/runtime/readiness.ts",
    "lib/runtime/product-mode.ts",
    "lib/runtime/monitoring.ts",
    "lib/security/rate-limit.ts",
    "scripts/local-executor.mjs",
    "scripts/taobao-mcp-client.mjs",
    "scripts/taobao-native-cli-client.mjs",
    "scripts/dev-server.mjs",
    "scripts/e2e-server.mjs",
    "scripts/configure-executor.mjs",
    "scripts/executor-config-utils.mjs",
    "scripts/executor-doctor.mjs",
    "scripts/demo-cloud.mjs",
    "scripts/demo-cloud-utils.mjs",
    "scripts/cloud-demo-config.mjs",
    "scripts/prepare-cloud-demo.mjs",
    "scripts/configure-cloud-executor.mjs",
    "scripts/db-migrate.mjs",
    "scripts/db-check.mjs",
    "vercel.json",
    ".github/workflows/quality.yml",
    "Dockerfile",
    "docker-compose.yml",
    ".dockerignore",
    "docs/deployment.md",
    "vitest.evaluation.config.ts",
    "tests/evaluation/new-car-agent-quality.test.ts",
    "tsconfig.e2e.json",
    "lib/session/guards.ts",
    "lib/session/summaries.ts",
    "lib/session/store.ts",
    "app/not-found.tsx",
    "lib/scenarios/new-car.ts",
    "lib/scenarios/normalize.ts"
  ];

  for (const file of requiredFiles) {
    if (!fs.existsSync(path.join(ROOT, file))) {
      fail(`缺少关键项目文件：${file}`);
    }
  }
}

function assertRemovedLegacyFiles() {
  const removedFiles = [
    {
      file: "components/dashboard-results.tsx",
      message: "旧推荐页已被当前购物清单联动页面替代，请不要恢复双实现"
    },
    {
      file: "lib/mcp/qoder.ts",
      message: "Qoder CLI provider 已退役，真实链路只允许持久化本地执行器"
    },
    {
      file: "lib/mcp/qoder-async.ts",
      message: "旧 Qoder 后台加购实验文件已废弃，请不要重新引入"
    },
    {
      file: "lib/mcp/live.ts",
      message: "旧 experimental bridge adapter 已退役"
    },
    {
      file: "lib/mcp/mock.ts",
      message: "旧 MCP mock adapter 已退役，商品候选不能伪装为实时搜索"
    },
    {
      file: "scripts/taobao-native-bridge.mjs",
      message: "旧 8787 bridge 已退役，请使用淘宝桌面版官方 HTTP MCP"
    }
  ];

  for (const item of removedFiles) {
    if (fs.existsSync(path.join(ROOT, item.file))) {
      fail(`${item.file}: ${item.message}`);
    }
  }
}

function assertArchitectureContracts() {
  const homePage = tryReadText("app/page.tsx");
  const hostedPage = tryReadText("app/hosted/page.tsx");
  const loginPage = tryReadText("app/login/page.tsx");
  const executorSettingsPage = tryReadText("app/settings/executor/page.tsx");
  const deepseek = tryReadText("lib/llm/deepseek.ts");
  const matcher = tryReadText("lib/agent/product-matcher.ts");
  const planner = tryReadText("lib/agent/planner.ts");
  const searchStrategy = tryReadText("lib/agent/search-strategy.ts");
  const planReviewer = tryReadText("lib/agent/plan-reviewer.ts");
  const ranker = tryReadText("lib/agent/candidate-ranker.ts");
  const reviewer = tryReadText("lib/agent/candidate-reviewer.ts");
  const directives = tryReadText("lib/agent/directives.ts");
  const decisionEngine = tryReadText("lib/agent/decision-engine.ts");
  const agentRuntimeV2 = tryReadText("lib/agent/runtime-v2.ts");
  const completionReview = tryReadText("lib/agent/completion-review.ts");
  const purchaseBundle = tryReadText("lib/agent/purchase-bundle.ts");
  const bundleAdoption = tryReadText("lib/session/bundle-adoption.ts");
  const workflowRunner = tryReadText("lib/agent/workflow-runner.ts");
  const marketFeedback = tryReadText("lib/agent/market-feedback.ts");
  const orchestrator = tryReadText("lib/agent/orchestrator.ts");
  const refiner = tryReadText("lib/agent/refiner.ts");
  const prompts = tryReadText("lib/llm/prompts.ts");
  const validation = tryReadText("lib/llm/validation.ts");
  const llmTelemetry = tryReadText("lib/llm/telemetry.ts");
  const llmSessionEvidence = tryReadText("lib/llm/session-evidence.ts");
  const runtimeReadiness = tryReadText("lib/runtime/readiness.ts");
  const types = tryReadText("lib/session/types.ts");
  const dashboard = tryReadText("components/dashboard.tsx");
  const dashboardIntake = tryReadText("components/dashboard-intake.tsx");
  const dashboardApi = tryReadText("components/dashboard-api.ts");
  const hostedConsole = tryReadText("components/hosted-console.tsx");
  const executorSettings = tryReadText("components/executor-settings.tsx");
  const dashboardWorkflow = tryReadText("components/dashboard-workflow.ts");
  const dashboardResults = tryReadText("components/dashboard-results-simple.tsx");
  const dashboardConfirmation = tryReadText("components/dashboard-confirmation.tsx");
  const dashboardExecution = tryReadText("components/dashboard-execution.tsx");
  const config = tryReadText("components/dashboard-config.ts");
  const modulesSearchRoute = tryReadText("app/api/modules/search/route.ts");
  const agentNextActionRoute = tryReadText("app/api/agent/next-action/route.ts");
  const agentPauseRoute = tryReadText("app/api/agent/pause/route.ts");
  const agentRemediateRoute = tryReadText("app/api/agent/remediate/route.ts");
  const agentResumeRoute = tryReadText("app/api/agent/resume/route.ts");
  const executorStartupRoute = tryReadText("app/api/executor/startup/route.ts");
  const responses = tryReadText("lib/api/responses.ts");
  const hostedWorkerAuth = tryReadText("lib/auth/hosted-worker.ts");
  const cart = tryReadText("lib/agent/cart.ts");
  const cartRoute = tryReadText("app/api/cart/add/route.ts");
  const cartRemoveRoute = tryReadText("app/api/cart/remove/route.ts");
  const mcpExecutor = tryReadText("lib/mcp/executor.ts");
  const mcpLogging = tryReadText("lib/mcp/logging.ts");
  const mcpHosted = tryReadText("lib/mcp/hosted.ts");
  const hostedWorker = tryReadText("scripts/codex-hosted-worker.mjs");
  const localExecutor = tryReadText("scripts/local-executor.mjs");
  const taobaoMcpClient = tryReadText("scripts/taobao-mcp-client.mjs");
  const taobaoNativeCliClient = tryReadText("scripts/taobao-native-cli-client.mjs");
  const mcpRunRoute = tryReadText("app/api/mcp/run/route.ts");
  const mcpSchema = tryReadText("lib/mcp/schema.ts");
  const mcpClient = tryReadText("lib/mcp/client.ts");
  const parseRoute = tryReadText("app/api/scene/parse/route.ts");
  const planRoute = tryReadText("app/api/scene/plan/route.ts");
  const refineRoute = tryReadText("app/api/scene/refine/route.ts");
  const agentDirectivesRoute = tryReadText("app/api/session/agent-directives/route.ts");
  const budgetReallocationRoute = tryReadText("app/api/session/budget-reallocation/route.ts");
  const searchStrategyRoute = tryReadText("app/api/session/search-strategy/route.ts");
  const purchaseBundleRoute = tryReadText("app/api/session/purchase-bundle/route.ts");
  const sessionArchiveRoute = tryReadText("app/api/session/archive/route.ts");
  const sessionsRoute = tryReadText("app/api/sessions/route.ts");
  const sessionStateRoute = tryReadText("app/api/session/state/route.ts");
  const hostedTasksRoute = tryReadText("app/api/hosted/tasks/route.ts");
  const hostedNextRoute = tryReadText("app/api/hosted/tasks/next/route.ts");
  const hostedResolveRoute = tryReadText("app/api/hosted/tasks/resolve/route.ts");
  const hostedWorkerStatusRoute = tryReadText("app/api/hosted/worker-status/route.ts");
  const runtimeDatabase = tryReadText("lib/runtime/database.ts");
  const runtimeIndex = tryReadText("lib/runtime/index.ts");
  const localRuntimeRepository = tryReadText("lib/runtime/local-repository.ts");
  const postgresRuntimeRepository = tryReadText("lib/runtime/postgres-repository.ts");
  const authRequest = tryReadText("lib/auth/request.ts");
  const authPage = tryReadText("lib/auth/page.ts");
  const authAccessMode = tryReadText("lib/auth/access-mode.ts");
  const authOuterProtection = tryReadText("lib/auth/outer-protection.ts");
  const authMeRoute = tryReadText("app/api/auth/me/route.ts");
  const authLoginRoute = tryReadText("app/api/auth/login/route.ts");
  const authRegisterRoute = tryReadText("app/api/auth/register/route.ts");
  const middleware = tryReadText("middleware.ts");
  const runtimeJobs = tryReadText("lib/runtime/jobs.ts");
  const sessionStore = tryReadText("lib/session/store.ts");
  const sessionGuards = tryReadText("lib/session/guards.ts");
  const sessionSummaries = tryReadText("lib/session/summaries.ts");
  const sessionLifecycle = tryReadText("lib/session/lifecycle.ts");
  const scenarioIndex = tryReadText("lib/scenarios/index.ts");
  const scenarioNormalize = tryReadText("lib/scenarios/normalize.ts");
  const releaseAudit = tryReadText("scripts/release-audit.mjs");

  if (
    !homePage ||
    !hostedPage ||
    !loginPage ||
    !executorSettingsPage ||
    !deepseek ||
    !matcher ||
    !planner ||
    !searchStrategy ||
    !planReviewer ||
    !ranker ||
    !reviewer ||
    !directives ||
    !decisionEngine ||
    !completionReview ||
    !purchaseBundle ||
    !bundleAdoption ||
    !workflowRunner ||
    !marketFeedback ||
    !orchestrator ||
    !refiner ||
    !prompts ||
    !validation ||
    !llmTelemetry ||
    !llmSessionEvidence ||
    !runtimeReadiness ||
    !types ||
    !dashboard ||
    !dashboardIntake ||
    !dashboardApi ||
    !hostedConsole ||
    !executorSettings ||
    !dashboardWorkflow ||
    !dashboardResults ||
    !dashboardConfirmation ||
    !dashboardExecution ||
    !config ||
    !modulesSearchRoute ||
    !agentNextActionRoute ||
    !agentPauseRoute ||
    !agentRemediateRoute ||
    !agentResumeRoute ||
    !executorStartupRoute ||
    !purchaseBundleRoute ||
    !sessionArchiveRoute ||
    !responses ||
    !hostedWorkerAuth ||
    !cart ||
    !cartRoute ||
    !mcpExecutor ||
    !mcpLogging ||
    !mcpHosted ||
    !hostedWorker ||
    !localExecutor ||
    !taobaoMcpClient ||
    !mcpRunRoute ||
    !mcpSchema ||
    !mcpClient ||
    !parseRoute ||
    !planRoute ||
    !refineRoute ||
    !agentDirectivesRoute ||
    !budgetReallocationRoute ||
    !searchStrategyRoute ||
    !sessionsRoute ||
    !sessionStateRoute ||
    !hostedTasksRoute ||
    !hostedNextRoute ||
    !hostedResolveRoute ||
    !hostedWorkerStatusRoute ||
    !runtimeDatabase ||
    !runtimeIndex ||
    !localRuntimeRepository ||
    !postgresRuntimeRepository ||
    !authAccessMode ||
    !authOuterProtection ||
    !authMeRoute ||
    !authLoginRoute ||
    !authRegisterRoute ||
    !middleware ||
    !authPage ||
    !authRequest ||
    !runtimeJobs ||
    !sessionStore ||
    !sessionGuards ||
    !sessionSummaries ||
    !sessionLifecycle ||
    !scenarioIndex ||
    !scenarioNormalize ||
    !releaseAudit
  ) {
    return;
  }

  if (
    !sessionStore.includes('execution_mode: state.execution_mode ?? "local_executor"') ||
    !sessionStore.includes('mcp_status: state.mcp_status ?? "unavailable"')
  ) {
    fail("旧 Session 缺失执行字段时必须迁移到 local_executor，不能重新激活 Codex hosted 兼容通道");
  }

  if (
    !homePage.includes('export const dynamic = "force-dynamic"') ||
    !hostedPage.includes('export const dynamic = "force-dynamic"') ||
    !loginPage.includes('export const dynamic = "force-dynamic"') ||
    !executorSettingsPage.includes('export const dynamic = "force-dynamic"') ||
    !runtimeIndex.includes("assertRuntimeRepositoryConfiguration") ||
    !runtimeIndex.includes("正式产品模式拒绝使用本地运行时") ||
    !authRequest.includes('getSceneCartAccessMode() === "single_user"') ||
    !authRequest.includes('isFormalProductMode() || process.env.AUTH_REQUIRED === "true"') ||
    !authAccessMode.includes("inspectSingleUserExposureConfiguration") ||
    !authAccessMode.includes("SCENECART_SINGLE_USER_ID") ||
    !authAccessMode.includes("findUserById") ||
    !authRequest.includes("configuredSingleUserId();") ||
    !authOuterProtection.includes("SCENECART_OUTER_PROTECTION_VERIFIED") ||
    !authOuterProtection.includes("SCENECART_OUTER_PROTECTION_SCOPE") ||
    !authOuterProtection.includes("SCENECART_OUTER_PROTECTION_PROJECT_ID") ||
    !authOuterProtection.includes("SCENECART_ALLOW_UNPROTECTED_SINGLE_USER_PRODUCTION") ||
    !authOuterProtection.includes("VERCEL_PROJECT_PRODUCTION_URL") ||
    !authPage.includes('from "next/server"') ||
    !authPage.includes("await connection();") ||
    !authRequest.includes("if (hasHttpsAppOrigin()) return true")
  ) {
    fail("身份相关页面必须动态渲染；固定 owner 只能由 server-only 暴露策略开放，并拒绝本地运行时与 Cookie 降级");
  }

  if (
    !loginPage.includes('permanentRedirect("/")') ||
    authLoginRoute.includes("readJsonObject") ||
    authRegisterRoute.includes("readJsonObject") ||
    authLoginRoute.includes("loginUser") ||
    authRegisterRoute.includes("registerUser") ||
    !authLoginRoute.includes("410") ||
    !authRegisterRoute.includes("410") ||
    !authMeRoute.includes('identity.accessMode === "single_user"') ||
    !authMeRoute.includes('persistence_scope: "single_user"') ||
    !dashboardIntake.includes("PublicDemoLink") ||
    dashboardIntake.includes('fetch("/api/auth/me")') ||
    dashboardIntake.includes("账户菜单") ||
    dashboardIntake.includes("退出登录") ||
    !middleware.includes("inspectSingleUserExposureConfiguration") ||
    !releaseAudit.includes('"single_user_exposure_policy"') ||
    !releaseAudit.includes('"outer_protection_live_audit"') ||
    !releaseAudit.includes("SCENECART_OUTER_PROTECTION_AUDIT_RECEIPT") ||
    !releaseAudit.includes("SCENECART_ALLOW_UNPROTECTED_SINGLE_USER_PRODUCTION")
  ) {
    fail("固定单用户产品必须关闭登录/注册 UI 与 API、隐藏 owner 身份，并把保护或显式风险接受作为发布硬门");
  }

  const contracts = [
    {
      ok:
        hostedWorkerAuth.includes("assertLegacyHostedWorkerAvailable") &&
        hostedWorkerAuth.includes("isFormalProductMode()") &&
        hostedWorkerAuth.includes("legacy_hosted_disabled") &&
        dashboard.includes("if (!isHostedMode(mcpStatus))") &&
        releaseAudit.includes('"legacy_hosted_worker"') &&
        releaseAudit.includes("HOSTED_WORKER_TOKEN"),
      message: "正式 local_executor 路径必须停止轮询旧宿主状态，并在 production 关闭 legacy hosted Worker 通道"
    },
    {
      ok:
        types.includes("AgentCompletionReport") &&
        types.includes("completion_report") &&
        types.includes("uncovered_module_ids") &&
        completionReview.includes("buildAgentCompletionReport") &&
        completionReview.includes("critical_coverage_ratio") &&
        workflowRunner.includes("buildAgentCompletionReport") &&
        workflowRunner.includes("recoverAgentCompletionGaps") &&
        workflowRunner.includes("improveAgentCompletionQuality") &&
        workflowRunner.includes("user_confirmed_retry = true") &&
        agentRemediateRoute.includes("body.confirmed !== true") &&
        agentRemediateRoute.includes("recoverAgentCompletionGaps") &&
        agentRemediateRoute.includes('body.scope === "thin"') &&
        dashboardResults.includes("session.completion_report") &&
        dashboardResults.includes("onRecoverCompletionGaps") &&
        dashboardResults.includes("个缺失分类") &&
        types.includes("user_confirmed_retry") &&
        sessionGuards.includes("user_confirmed_retry") &&
        hostedConsole.includes("Agent 完成质量审计") &&
        sessionsRoute.includes("completion_report: session.completion_report"),
      message: "Agent 结束搜索时必须生成可持久化的完成报告，并支持用户确认后补齐空白或增量优化薄弱候选池"
    },
    {
      ok:
        types.includes("AgentPurchaseBundle") &&
        types.includes("AgentRefinementSuggestion") &&
        types.includes("purchase_bundle") &&
        types.includes("refinement_suggestions") &&
        purchaseBundle.includes("buildPolicyPurchaseBundle") &&
        purchaseBundle.includes("buildPolicyRefinementSuggestions") &&
        purchaseBundle.includes("materializePurchaseBundleProposal") &&
        deepseek.includes("composePurchaseBundle") &&
        deepseek.includes("selectPurchaseBundleModelTier") &&
        prompts.includes("composePurchaseBundlePrompt") &&
        prompts.includes("suggested_refinements") &&
        validation.includes("validatePurchaseBundleProposalOutput") &&
        validation.includes("allowedRefinements") &&
        workflowRunner.includes('event_type: "agent.purchase_bundle.composed"') &&
        sessionGuards.includes("isAgentPurchaseBundle") &&
        hostedConsole.includes("purchase_bundle") &&
        hostedConsole.includes("购买组合") &&
        hostedConsole.includes("预算安全购买组合"),
      message: "Agent 完成搜索后必须生成经预算、候选白名单与必需覆盖 guardrail 校验的购买组合，并提供白名单内的上下文调整建议"
    },
    {
      ok:
        types.includes("AgentBundleAdoption") &&
        types.includes("bundle_adoption") &&
        bundleAdoption.includes("acceptCurrentPurchaseBundle") &&
        bundleAdoption.includes("refreshBundleAdoptionProgress") &&
        bundleAdoption.includes("invalidateAgentCompletionArtifacts") &&
        purchaseBundleRoute.includes("confirmed !== true") &&
        purchaseBundleRoute.includes("bundle_generated_at") &&
        orchestrator.includes('event_type: "agent.purchase_bundle.accepted"') &&
        cart.includes("refreshBundleAdoptionProgress") &&
        mcpHosted.includes("refreshBundleAdoptionProgress") &&
        sessionsRoute.includes("bundle_adoption: session.bundle_adoption"),
      message: "预算安全购买组合服务端能力必须经用户确认后形成校验过的待处理清单，并仅通过逐件高风险确认推进加购"
    },
    {
      ok:
        types.includes("AgentDecision") &&
        types.includes("agent_decisions") &&
        decisionEngine.includes("decideNextAgentAction") &&
        decisionEngine.includes('action: "search_module"') &&
        decisionEngine.includes('action: "retry_module"') &&
        decisionEngine.includes('action: "skip_module"') &&
        decisionEngine.includes('action: "complete_workflow"') &&
        searchStrategy.includes("validateAutonomousSearchKeyword") &&
        searchStrategy.includes("moduleSearchAnchorTerms") &&
        searchStrategy.includes("normalizeModelSearchKeyword") &&
        agentRuntimeV2.includes("normalizeModelSearchKeyword") &&
        agentRuntimeV2.includes("markSessionLlmCallFallback") &&
        agentRuntimeV2.includes("补搜前必须已有首轮搜索记录") &&
        matcher.includes("requireValidModuleSearchKeyword") &&
        decisionEngine.includes("validateAutonomousSearchKeyword") &&
        orchestrator.includes("requireValidModuleSearchKeyword") &&
        responses.includes("invalid_search_keyword") &&
        prompts.includes("allowed_category_anchors") &&
        orchestrator.includes("getNextAgentAction") &&
        agentNextActionRoute.includes("getNextAgentAction") &&
        dashboard.includes("/api/agent/next-action") &&
        dashboard.includes('decision.action === "complete_workflow"') &&
        dashboardExecution.includes("Agent 决策与 AI 搜索策略") &&
        hostedConsole.includes("Agent 自主决策历史") &&
        sessionStore.includes("agent_decisions") &&
        (sessionStore.includes("const normalized = normalizeSessionState(inMemory)") ||
          sessionStore.includes("return normalizeSessionState(structuredClone(inMemory))")) &&
        sessionGuards.includes("isAgentDecision"),
      message: "搜索主循环必须由服务端 Agent 决策驱动，并持久化搜索、补搜、跳过与结束动作"
    },
    {
      ok:
        workflowRunner.includes("pauseAgentWorkflow") &&
        workflowRunner.includes("resumeAgentWorkflow") &&
        workflowRunner.includes('trigger: "user_resume"') &&
        agentPauseRoute.includes("body.confirmed !== true") &&
        agentResumeRoute.includes("body.confirmed !== true") &&
        dashboardExecution.includes("完成当前模块后暂停") &&
        dashboardExecution.includes("从当前进度继续") &&
        hostedConsole.includes("完成当前模块后暂停") &&
        hostedConsole.includes("从原进度继续"),
      message: "服务端 Agent 必须支持用户显式暂停和原进度继续，不能要求强杀运行中的外部工具"
    },
    {
      ok:
        workflowRunner.includes("establishExecutorStartupStandby") &&
        workflowRunner.includes('"executor_startup_standby"') &&
        executorStartupRoute.includes("establishExecutorStartupStandby") &&
        executorStartupRoute.includes("assertExecutorProtocol") &&
        localExecutor.includes('api("/api/executor/startup"') &&
        localExecutor.includes("startup_standby_established") &&
        localRuntimeRepository.includes("isPausedCurrentWorkflowJob") &&
        postgresRuntimeRepository.includes("paused_sessions.state #>> '{agent_runtime,workflow_status}' = 'paused'"),
      message: "Worker 启动必须先建立历史工作流待命门，暂停 workflow 在本地与 PostgreSQL 都不可领取"
    },
    {
      ok:
        runtimeDatabase.includes("__sceneCartLocalWorkflowLocks") &&
        runtimeDatabase.includes("reserveLocalWorkflowLock") &&
        runtimeDatabase.includes("waitForLocalWorkflowLock") &&
        runtimeDatabase.includes("holdsLocalWorkflowLock"),
      message: "本地运行时必须序列化同一 Session 的回填、暂停和加购写入，不能把 workflow lock 退化为空实现"
    },
    {
      ok: deepseek.includes("validateSceneBriefOutput") && deepseek.includes("validateShoppingPlanOutput"),
      message: "DeepSeek 调用层必须校验结构化输出"
    },
    {
      ok:
        llmTelemetry.includes("summarizeLlmRuntimeStatus") &&
        llmTelemetry.includes("last_sequence") &&
        runtimeReadiness.includes('"deepseek_runtime"') &&
        runtimeReadiness.includes("summarizeLlmRuntimeStatus") &&
        executorSettings.includes("DeepSeek 已真实连接") &&
        executorSettings.includes("DeepSeek 等待真实验证") &&
        types.includes("SessionLlmCall") &&
        types.includes("llm_calls") &&
        llmSessionEvidence.includes("appendSessionLlmCalls") &&
        deepseek.includes("call: SessionLlmCall") &&
        hostedConsole.includes("本次会话模型凭证") &&
        sessionsRoute.includes("MAX_SESSION_LIST_LLM_CALLS"),
      message: "发布就绪度必须区分 DeepSeek 已配置与真实运行证据，且同毫秒调用不能误判最近状态"
    },
    {
      ok: matcher.includes("rankCandidatesForModule"),
      message: "商品匹配层必须经过候选排序器"
    },
    {
      ok:
        ranker.includes("CandidateRankingContext") &&
        ranker.includes("scoreAgentRules") &&
        matcher.includes("rerank_rules: state.shopping_plan.agent_directives.rerank_rules") &&
        matcher.includes("budget_guardrails: state.shopping_plan.execution_strategy.budget_guardrails"),
      message: "候选排序必须接入 AI 的 rerank_rules 与预算纪律，不能只靠静态词表排序"
    },
    {
      ok:
        ranker.includes("mergeAndRankModuleCandidates") &&
        ranker.includes("previous_count") &&
        ranker.includes("retained_product_ids") &&
        runtimeJobs.includes("mergeAndRankModuleCandidates") &&
        runtimeJobs.includes("previousCandidateCount") &&
        runtimeJobs.includes("跨轮次合并重排") &&
        mcpHosted.includes("mergeAndRankModuleCandidates") &&
        hostedResolveRoute.includes("mergeAndRankModuleCandidates") &&
        matcher.includes("previousTrace?.searched_keywords"),
      message: "Agent 补搜必须合并并重排跨轮次候选，保留搜索历史与旧候选，不能使用末次结果覆盖"
    },
    {
      ok:
        types.includes("ModuleCandidateReview") &&
        types.includes("module_reviews") &&
        types.includes("ModuleSearchTrace") &&
        types.includes("module_search_traces") &&
        prompts.includes("reviewCandidatePoolPrompt") &&
        deepseek.includes("reviewCandidatePool") &&
        deepseek.includes("REVIEW_TIMEOUT_MS") &&
        deepseek.includes("validateCandidateReviewOutput") &&
        reviewer.includes("reviewModuleCandidates") &&
        reviewer.includes("reviewModuleCandidatesWithAgent") &&
        matcher.includes("reviewModuleCandidates") &&
        matcher.includes("reviewModuleCandidatesWithAgent") &&
        matcher.includes("keywordOverride") &&
        modulesSearchRoute.includes("keyword_override") &&
        dashboardResults.includes("selectedReview?.suggested_keyword") &&
        hostedConsole.includes("module_search_traces") &&
        sessionStore.includes("module_reviews") &&
        sessionStore.includes("normalizeModuleSearchTraces") &&
        sessionStore.includes("module_search_traces") &&
        matcher.includes("setModuleSearchTrace") &&
        matcher.includes("keywordAttemptReason") &&
        matcher.includes("ai_decision_summary") &&
        dashboardResults.includes("findCurrentTaobaoMcpEvidence"),
      message: "商品匹配后必须生成 Agent 候选池评估和搜索决策轨迹，并支持按建议关键词补搜"
    },
    {
      ok:
        types.includes("PlanQualityReview") &&
        types.includes("plan_review") &&
        prompts.includes("reviewShoppingPlanPrompt") &&
        deepseek.includes("reviewShoppingPlan") &&
        deepseek.includes("PLAN_REVIEW_TIMEOUT_MS") &&
        deepseek.includes("validatePlanQualityReviewOutput") &&
        planReviewer.includes("reviewPlanWithAgent") &&
        orchestrator.includes("reviewPlanWithAgent") &&
        orchestrator.includes('parsed.mode === "connected"') &&
        orchestrator.includes('parseMode === "connected"') &&
        refiner.includes("reviewPlanWithAgent") &&
        sessionStore.includes("normalizePlanQualityReview") &&
        planRoute.includes("plan_review: state.plan_review") &&
        planRoute.includes("parse_deepseek_mode") &&
        refineRoute.includes("plan_review: result.state.plan_review") &&
        sessionsRoute.includes("plan_review: session.plan_review") &&
        dashboard.includes("parseDeepSeekMode") &&
        dashboard.includes("parse_deepseek_mode: parseDeepSeekMode") &&
        dashboardWorkflow.includes("parseDeepSeekMode") &&
        hostedConsole.includes("Agent 方案自检") &&
        dashboardConfirmation.includes("Agent 方案自检"),
      message: "购物规划生成后必须保留 Agent 方案自检，帮助用户确认预算、模块与搜索策略质量"
    },
    {
      ok:
        planner.includes("normalizeBudgetAllocations") &&
        planner.includes("normalizeSearchKeywords") &&
        planner.includes('from "@/lib/agent/search-strategy"'),
      message: "规划层必须保留预算归一化，并调用纯搜索策略模块做关键词归一化"
    },
    {
      ok:
        searchStrategy.includes("repairKeywordForDistinctness") &&
        searchStrategy.includes("toStableTaobaoSearchKeyword") &&
        searchStrategy.includes("moduleCategoryTerms") &&
        searchStrategy.includes("keywordSignature") &&
        searchStrategy.includes("normalizeAlternateKeywords") &&
        searchStrategy.includes("export function normalizeSearchKeywords") &&
        sessionStore.includes('from "@/lib/agent/search-strategy"') &&
        sessionStore.includes("normalizeSearchKeywords("),
      message: "纯搜索策略模块必须主动修复跨模块搜索关键词相似问题，并在旧会话恢复时复用同一归一化逻辑"
    },
    {
      ok:
        types.includes("ModuleSearchStrategy") &&
        types.includes("PlanExecutionStrategy") &&
        types.includes("AgentDirectives") &&
        types.includes("RefinementImpactSummary") &&
        types.includes("last_refinement") &&
        types.includes("alternate_keywords") &&
        types.includes("failure_recovery") &&
        types.includes("must_have_signals") &&
        types.includes("reject_signals") &&
        types.includes("quality_checks") &&
        prompts.includes("search_strategy") &&
        prompts.includes("execution_strategy") &&
        prompts.includes("agent_directives") &&
        prompts.includes("alternate_keywords") &&
        prompts.includes("failure_recovery") &&
        prompts.includes("must_have_signals") &&
        prompts.includes("reject_signals") &&
        prompts.includes("quality_checks") &&
        deepseek.includes("normalizeSearchStrategy") &&
        deepseek.includes("must_have_signals: asStringArray(source.must_have_signals)") &&
        deepseek.includes("normalizeExecutionStrategy") &&
        deepseek.includes("normalizeAgentDirectives") &&
        searchStrategy.includes("search_strategy") &&
        searchStrategy.includes("mustHaveSignals") &&
        planner.includes("orderModulesByExecutionStrategy") &&
        searchStrategy.includes("alternateKeywords") &&
        matcher.includes("search_strategy") &&
        matcher.includes("buildSearchKeywordQueue") &&
        matcher.includes("shouldTryAdditionalSearch") &&
        matcher.includes("maxSearchAttempts") &&
        matcher.includes("shouldUseReviewSuggestion") &&
        matcher.includes("agent_directives.search_depth") &&
        matcher.includes("agent_directives.autonomy_level") &&
        matcher.includes("acceptanceSignals") &&
        ranker.includes("scoreSearchStrategy") &&
        ranker.includes("mustHaveMatches") &&
        ranker.includes("rejectMatches") &&
        reviewer.includes("matchedMustHaveSignals") &&
        sessionStore.includes("normalizeAgentDirectives") &&
        sessionStore.includes("must_have_signals") &&
        dashboardConfirmation.includes("Agent 自主指令") &&
        dashboardConfirmation.includes("验收信号") &&
        dashboardConfirmation.includes("可编辑搜索任务包") &&
        dashboardConfirmation.includes("onSearchStrategyChange") &&
        dashboardExecution.includes("自主级别") &&
        dashboardExecution.includes("AI 决策轨迹"),
      message: "AI 搜索/执行策略与 Agent 自主指令必须贯穿类型、Prompt、归一化、搜索执行、候选排序、Session 恢复与前端展示"
    },
    {
      ok:
        directives.includes("AgentDirectiveProfile") &&
        directives.includes("isAgentDirectiveProfile") &&
        directives.includes("applyAgentDirectiveProfile") &&
        orchestrator.includes("updateAgentDirectiveProfile") &&
        orchestrator.includes("updateModuleSearchStrategy") &&
        agentDirectivesRoute.includes("isAgentDirectiveProfile") &&
        agentDirectivesRoute.includes("updateAgentDirectiveProfile") &&
        searchStrategyRoute.includes("updateModuleSearchStrategy") &&
        searchStrategyRoute.includes("primary_keyword") &&
        dashboardConfirmation.includes("agentProfileOptions") &&
        dashboardConfirmation.includes("onAgentProfileChange") &&
        dashboard.includes("/api/session/agent-directives") &&
        dashboard.includes("/api/session/search-strategy") &&
        dashboard.includes("updateAgentProfile") &&
        dashboard.includes("updateModuleSearchStrategy") &&
        matcher.includes("agent_directives.autonomy_level") &&
        matcher.includes("agent_directives.search_depth"),
      message: "AI 执行档位和模块搜索任务包必须可由用户在规划确认页调整，并写回后端 session 影响后续搜索深度与关键词"
    },
    {
      ok:
        marketFeedback.includes("applyBudgetReallocationSuggestion") &&
        marketFeedback.includes("MAX_REALLOCATION_RATIO") &&
        marketFeedback.includes("预算总额校验失败") &&
        orchestrator.includes("applyMarketBudgetSuggestion") &&
        budgetReallocationRoute.includes("confirmed !== true") &&
        budgetReallocationRoute.includes("applyMarketBudgetSuggestion") &&
        hostedConsole.includes("reallocation_suggestions") &&
        hostedConsole.includes("真实市场反馈"),
      message: "真实候选产生的跨模块预算建议必须由用户显式确认、由服务端校验金额与总额，并只失效受影响模块"
    },
    {
      ok: !types.includes('| "confirm_refine"') && !config.includes("confirm_refine:"),
      message: "废弃的 confirm_refine 阶段不应重新进入正式 workflow"
    },
    {
      ok:
        dashboard.includes('from "@/components/dashboard-workflow"') &&
        dashboardWorkflow.includes("isWorkflowStage") &&
        dashboardWorkflow.includes("fallbackStageForAvailableState") &&
        !dashboardWorkflow.includes("return stage as WorkflowStage") &&
        dashboardWorkflow.includes("toRestorableStage") &&
        dashboardWorkflow.includes("statusMessageForRestoredStage") &&
        dashboardWorkflow.includes("restoreDashboardSnapshot") &&
        dashboardWorkflow.includes("buildDashboardPersistenceSnapshot"),
      message: "前端 workflow 必须通过白名单恢复阶段，防止恢复到未知或瞬态 loading 阶段"
    },
    {
      ok:
        dashboardApi.includes("DEFAULT_CLIENT_TIMEOUT_MS") &&
        dashboardApi.includes("AbortController") &&
        dashboardApi.includes("buildJsonHeaders") &&
        dashboardApi.includes('headers.set("Accept", "application/json")') &&
        dashboardApi.includes("timeoutErrorMessage"),
      message: "客户端 jsonFetch 必须保留超时兜底、Headers 正确合并和友好超时提示"
    },
    {
      ok: responses.includes("redactSensitiveText") && responses.includes("summarizeKnownError"),
      message: "API 错误必须经过脱敏与分类"
    },
    {
      ok:
        mcpLogging.includes("redactLogText") &&
        mcpLogging.includes("summarizeUrl") &&
        mcpLogging.includes("[redacted-api-key]") &&
        mcpLogging.includes("[local-path]") &&
        mcpExecutor.includes("summarizeLogValue") &&
        mcpExecutor.includes("summarizeLogText(error.message") &&
        mcpHosted.includes("summarizeLogText(outputSummary") &&
        mcpHosted.includes("const resultSummary = input.result_summary ? summarizeLogText") &&
        mcpHosted.includes("task.result_summary = resultSummary") &&
        mcpHosted.includes("task.error_message = errorMessage") &&
        hostedResolveRoute.includes("optionalString(body.result_summary)") &&
        hostedResolveRoute.includes("optionalString(body.error_message)") &&
        !hostedResolveRoute.includes("as string | undefined") &&
        hostedWorker.includes("summarizeWorkerStatusText") &&
        hostedWorker.includes("last_result: summarizeWorkerStatusText") &&
        hostedWorker.includes("last_error: summarizeWorkerStatusText") &&
        hostedWorkerStatusRoute.includes("optionalStatusText(payload.last_result)") &&
        hostedWorkerStatusRoute.includes("optionalStatusText(payload.last_error)") &&
        cart.includes("summarizeLogText(error.message") &&
        responses.includes("console.error(") &&
        responses.includes("redactSensitiveText("),
      message: "MCP/hosted/cart/API 日志必须统一摘要和脱敏，避免长 URL、本机路径或密钥进入前端日志"
    },
    {
      ok:
        localExecutor.includes('taobaoClient.callTool("search_products"') &&
        localExecutor.includes('type: "all"') &&
        localExecutor.includes('taobaoClient.callTool(\n      "add_to_cart"') &&
        localExecutor.includes('taobaoClient.callTool(\n        "get_current_tab"') &&
        localExecutor.includes("This probe is deliberately restricted to the authentication-paused state") &&
        localExecutor.includes('if (authenticationPaused) {\n      await recoverTaobaoAuthentication()') &&
        localExecutor.includes("Keep each user-approved search to one stateful shopping tool call") &&
        localExecutor.includes("const taobaoClient = createTaobaoMcpClient") &&
        localExecutor.includes("await taobaoClient.close()") &&
        !localExecutor.includes("client.resetSession()") &&
        localExecutor.includes("authentication circuit breaker opened") &&
        taobaoMcpClient.includes('method: "initialize"') &&
        !taobaoMcpClient.includes('method: "DELETE"') &&
        taobaoMcpClient.includes("desktop server reclaim it by TTL") &&
        taobaoMcpClient.includes("resetSession()") &&
        !localExecutor.includes("qodercli") &&
        !localExecutor.includes("qoderPrintArgs") &&
        !localExecutor.includes("execFile") &&
        localExecutor.includes("shouldFallbackToTaobaoNativeCli") &&
        localExecutor.includes("taobaoCliClient.searchProducts") &&
        taobaoNativeCliClient.includes('"search_products"') &&
        taobaoNativeCliClient.includes('"list_available_pages"') &&
        !taobaoNativeCliClient.includes('"add_to_cart"'),
      message: "本地执行器必须优先复用官方 HTTP MCP；只读搜索可安全降级官方 CLI，但禁止 Qoder 与加购 CLI 重放"
    },
    {
      ok:
        mcpClient.includes("getConfiguredExecutionBackend") &&
        mcpClient.includes("isFormalProductMode") &&
        mcpClient.includes('configured === "qoder_cli" || configured === "experimental_local"') &&
        mcpClient.includes('configured !== "local_executor"') &&
        mcpClient.includes('return "local_executor"') &&
        !mcpClient.includes("@/lib/mcp/qoder") &&
        !mcpClient.includes("@/lib/mcp/live") &&
        !mcpClient.includes("fs.existsSync") &&
        !mcpClient.includes("DEFAULT_QODERCLI_PATH") &&
        mcpRunRoute.includes("isMcpDebugEnabled") &&
        mcpRunRoute.includes("MCP 手动调试端点未启用") &&
        releaseAudit.includes('"mcp_debug_endpoint"') &&
        releaseAudit.includes("SCENECART_ENABLE_MCP_DEBUG"),
      message: "正式产品必须默认使用 local_executor，不能因安装 Qoder 隐式切换 provider，且手动 MCP 端点必须默认关闭"
    },
    {
      ok:
        cart.includes("allowDemoCartFallback") &&
        cart.includes("if (!allowDemoCartFallback())") &&
        cart.includes("demo_cart_fallback") &&
        cart.includes("真实加购失败，已加入产品内演示购物车"),
      message: "加购链路必须由产品模式控制演示回退，正式模式不得把真实失败伪装成成功"
    },
    {
      ok:
        cart.includes('selectedItem.cart_source !== "demo"') &&
        cart.includes("taobao_cart_managed_externally") &&
        cartRemoveRoute.includes("body.confirmed !== true") &&
        cartRemoveRoute.includes("removeDemoCartItem") &&
        dashboardExecution.includes("从演示清单移除") &&
        dashboardExecution.includes("在淘宝购物车中管理"),
      message: "购物车确认页只能移除明确标记的演示项；真实淘宝条目必须 fail-closed 并引导到淘宝管理"
    },
    {
      ok: /export async function addToCart\([\s\S]{0,700}return withWorkflowSessionTransaction\(sessionId/.test(orchestrator),
      message: "加购请求必须在 Session 事务锁内读取、入队和持久化，避免并发请求或执行器回填覆盖状态"
    },
    {
      ok:
        dashboard.includes("cartingProductId") &&
        dashboardResults.includes("cartingProductId === product.product_id") &&
        !dashboard.includes('setStage("carting");'),
      message: "加购交互应保留在推荐页内显示商品级 loading，不能退回整页 carting loading"
    },
    {
      ok:
        mcpSchema.includes("getMcpToolDefinition") &&
        mcpSchema.includes("name is MCPToolName") &&
        mcpSchema.includes("validateMcpToolInput") &&
        mcpSchema.includes("validateMcpToolOutput") &&
        mcpSchema.includes("normalizeSearchResultItem") &&
        mcpSchema.includes("dedupeSearchResults") &&
        mcpSchema.includes("requireTextField") &&
        mcpSchema.includes("requires_confirmation") &&
        mcpExecutor.includes("requires_confirmation") &&
        mcpExecutor.includes("confirmed") &&
        mcpExecutor.includes("validateMcpToolOutput(toolName, rawOutput, input)") &&
        mcpRunRoute.includes("validateMcpToolInput") &&
        mcpRunRoute.includes("badRequest(") &&
        mcpRunRoute.includes("confirm_high_risk") &&
        mcpRunRoute.includes('requireString(body.session_id, "session_id")') &&
        !mcpRunRoute.includes("as MCPToolName") &&
        !mcpRunRoute.includes("as string | undefined") &&
        cartRoute.includes("body.confirmed !== true") &&
        dashboard.includes("confirmed: true"),
      message: "高风险 MCP/加购动作必须在服务端校验显式确认，并通过类型守卫收窄工具名，不能只依赖前端弹窗或类型强转"
    },
    {
      ok:
        sessionsRoute.includes("apiRouteError") &&
        sessionsRoute.includes("failed to list sessions") &&
        sessionStateRoute.includes("apiRouteError") &&
        sessionStateRoute.includes("failed to read session state") &&
        hostedTasksRoute.includes("failed to list hosted tasks") &&
        hostedNextRoute.includes("failed to read next hosted task"),
      message: "会话与 hosted task 的 GET API 必须使用统一 apiRouteError 兜底，避免返回非结构化错误"
    },
    {
      ok: sessionStore.includes("normalizeModuleSearchStrategy") && sessionStore.includes("search_strategy"),
      message: "Session 恢复必须为旧规划补齐 AI 搜索策略，避免旧会话破坏新 Agent 能力"
    },
    {
      ok:
        refiner.includes("selectImpactedModules") &&
        refiner.includes("strategySignature") &&
        refiner.includes("last_refinement") &&
        refiner.includes("refinementImpact") &&
        refineRoute.includes("refinement_impact") &&
        dashboardConfirmation.includes("调整影响说明") &&
        hostedConsole.includes("最近一次调整影响") &&
        refiner.includes("delete state.module_reviews") &&
        refiner.includes("delete state.module_search_traces") &&
        refineRoute.includes('requireString(body.quick_action') &&
        decisionEngine.includes("candidateCount > 0") &&
        decisionEngine.includes("hasSkippedModule") &&
        refiner.includes("removeModuleAgentDecisions"),
      message: "快捷调整必须基于 AI 新旧规划差异局部失效候选，不能退回全量清空所有模块"
    },
    {
      ok:
        sessionGuards.includes("export function isSessionState") &&
        sessionGuards.includes("export function isRenderableSessionState") &&
        sessionGuards.includes("export function isPlanQualityReview") &&
        sessionGuards.includes("export function isModuleCandidateReview") &&
        sessionGuards.includes("export function isModuleSearchTrace") &&
        sessionGuards.includes("isPlanQualityReview(value.plan_review)") &&
        sessionGuards.includes("export function isHostedExecutionTask") &&
        sessionGuards.includes("export function isProductCandidate") &&
        sessionGuards.includes("export function isSelectedItem") &&
        sessionGuards.includes("isRecord(value.module_candidates)") &&
        sessionStore.includes("normalizeModuleCandidates") &&
        sessionStore.includes("normalizeModuleReviews") &&
        sessionStore.includes("normalizeModuleSearchTraces") &&
        sessionStore.includes("normalizeSelectedItems") &&
        sessionStore.includes("filter(isHostedExecutionTask)") &&
        sessionStore.includes("filter(isProductCandidate)") &&
        sessionStore.includes("filter(isSelectedItem)") &&
        hostedConsole.includes("filter(isRenderableSessionState)") &&
        hostedConsole.includes("nextSessions.some((session) => session.session_id === current)") &&
        hostedTasksRoute.includes("isHostedExecutionTask") &&
        hostedNextRoute.includes("isHostedExecutionTask") &&
        hostedResolveRoute.includes("isHostedExecutionTask") &&
        hostedResolveRoute.includes("filter(isProductCandidate)") &&
        !hostedResolveRoute.includes("as ProductCandidate[]") &&
        sessionStore.includes('from "@/lib/session/guards"') &&
        dashboard.includes("isRenderableSessionState") &&
        !dashboard.includes("function isSessionState"),
      message: "SessionState、HostedTask、ProductCandidate 与 SelectedItem 运行时校验必须使用共享 guard，避免前后端结构判断分叉"
    },
    {
      ok:
        sessionStore.includes("MAX_TOOL_LOGS") &&
        sessionStore.includes("MAX_HOSTED_TASKS") &&
        sessionStore.includes("MAX_MODULE_CANDIDATES") &&
        sessionsRoute.includes("MAX_SESSION_LIST_TOOL_LOGS") &&
        sessionsRoute.includes("MAX_SESSION_LIST_SEARCH_TRACES") &&
        sessionsRoute.includes("summarizeModuleCandidates"),
      message: "AI 多轮执行后的会话日志、任务、候选池和搜索决策轨迹必须有持久化与列表接口体积边界"
    },
    {
      ok:
        localRuntimeRepository.includes("return session.owner_id === userId") &&
        sessionSummaries.includes("summarizeShoppingSessions") &&
        !sessionSummaries.includes("llm_calls:") &&
        !sessionSummaries.includes("tool_logs:") &&
        !sessionSummaries.includes("module_candidates:") &&
        sessionsRoute.includes('searchParams.get("view") === "summary"') &&
        dashboard.includes('"/api/sessions?view=summary&limit=6"') &&
        dashboardIntake.includes("最近购物任务"),
      message: "登录态会话必须精确校验 owner，首页历史只能读取隐私收敛摘要，不能传输完整 Agent context"
    },
    {
      ok:
        types.includes("archived_at?: string") &&
        types.includes("archived_from_workflow_status?") &&
        sessionArchiveRoute.includes("confirmed !== true") &&
        sessionArchiveRoute.includes("updateShoppingSessionLifecycle") &&
        sessionLifecycle.includes("withWorkflowSessionTransaction") &&
        sessionLifecycle.includes('event_type: "session.archived"') &&
        sessionLifecycle.includes('event_type: "session.restored"') &&
        sessionLifecycle.includes("repository.cancelJob") &&
        sessionsRoute.includes('archiveFilter === "archived"') &&
        (
          localRuntimeRepository.includes("!getSession(item.session_id)?.archived_at") ||
          localRuntimeRepository.includes("!session?.archived_at")
        ) &&
        postgresRuntimeRepository.includes("sessions.state ? 'archived_at'") &&
        dashboardIntake.includes("已归档任务") &&
        dashboard.includes('action: "archive" | "restore"'),
      message: "购物任务必须支持账号隔离的安全归档与恢复，并阻止执行器继续领取已归档会话任务"
    },
    {
      ok:
        scenarioIndex.includes("export function isScenarioId") &&
        scenarioNormalize.includes("isScenarioId") &&
        parseRoute.includes("isScenarioId(body.scenario_id)") &&
        planRoute.includes("isScenarioId(body.scenario_id)") &&
        planRoute.includes("isRecord(body.scene_brief)") &&
        planRoute.includes("normalizeSceneBriefInput(value: unknown") &&
        !planRoute.includes("as SceneBrief") &&
        deepseek.includes("isScenarioId(source.scenario_id)") &&
        !parseRoute.includes("as ScenarioId") &&
        !planRoute.includes("as ScenarioId"),
      message: "场景 ID 必须通过统一 isScenarioId 守卫进入 API、模型归一化与场景配置，不能使用类型强转"
    }
  ];

  for (const contract of contracts) {
    if (!contract.ok) {
      fail(contract.message);
    }
  }
}

function assertDocumentationContracts() {
  const readme = tryReadText("README.md");
  const architecture = tryReadText("architecture_and_technical_design.md");
  if (!readme || !architecture) {
    return;
  }

  const contracts = [
    {
      ok: readme.includes("预算安全购买组合") && architecture.includes("compose_purchase_bundle"),
      message: "README 与架构文档必须同步说明预算安全购买组合和模型 guardrail"
    },
    {
      ok: readme.includes("预算组合采纳") && architecture.includes("bundle_adoption"),
      message: "README 与架构文档必须同步说明组合采纳、待处理清单与逐件确认边界"
    },
    {
      ok:
        readme.includes("购物车来源隔离") &&
        architecture.includes("taobao_cart_managed_externally") &&
        architecture.includes("cart_source=demo"),
      message: "README 与架构文档必须同步说明演示购物项移除和真实淘宝购物车 fail-closed 边界"
    },
    {
      ok: readme.includes("候选池复盘") && readme.includes("按 Agent 建议补搜"),
      message: "README 必须同步说明候选池复盘与 Agent 建议补搜能力"
    },
    {
      ok: readme.includes("高风险动作必须显式确认") && readme.includes("confirm_high_risk"),
      message: "README 必须同步说明高风险工具服务端确认边界"
    },
    {
      ok:
        architecture.includes("Module Reviews") &&
        architecture.includes("review_candidates") &&
        architecture.includes("keyword_override"),
      message: "架构文档必须同步说明搜索后复盘、候选池状态与建议补搜链路"
    },
    {
      ok: architecture.includes("高风险工具动作服务端确认") && architecture.includes("confirm_high_risk"),
      message: "架构文档必须同步说明高风险 MCP 工具确认机制"
    }
  ];

  for (const contract of contracts) {
    if (!contract.ok) {
      fail(contract.message);
    }
  }
}

function run() {
  assertNoForbiddenText();
  assertEnvExample();
  assertPackageScripts();
  assertGitignore();
  assertExecutorConfigurator();
  assertDevelopmentLauncher();
  assertProductionBuildMigrationGate();
  assertBuildConfigurationIsolation();
  assertE2EServerIsolation();
  assertDeploymentAssets();
  assertRequiredFiles();
  assertRemovedLegacyFiles();
  assertArchitectureContracts();
  assertDocumentationContracts();

  if (failures.length > 0) {
    console.error("Preflight failed:");
    for (const item of failures) {
      console.error(`- ${item}`);
    }
    process.exit(1);
  }

  console.log("Preflight passed.");
}

run();
