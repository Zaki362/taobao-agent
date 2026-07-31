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
      message: "发现旧环境变量 TAOBAO_NATIVE_PATH；Qoder provider 不再读取它，local bridge 请使用 TAOBAO_NATIVE_BIN"
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
    "SCENECART_PRODUCT_MODE",
    "ALLOW_DEMO_CART_FALLBACK",
    "TAOBAO_EXECUTION_BACKEND",
    "QODERCLI_PATH",
    "TAOBAO_NATIVE_BIN",
    "TAOBAO_MCP_BASE_URL",
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
  const required = ["dev", "build", "typecheck", "preflight", "release:audit", "check", "db:migrate", "db:check", "test:unit", "test:integration", "test:e2e", "eval:agent", "worker:local", "executor:doctor"];

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

  const required = ["node_modules", ".next", ".env.local", ".data", "search_*.json", "*.tsbuildinfo"];

  for (const entry of required) {
    if (!gitignore.includes(entry)) {
      fail(`.gitignore: 缺少 ${entry}`);
    }
  }
}

function assertRequiredFiles() {
  const requiredFiles = [
    "app/api/scene/parse/route.ts",
    "app/api/scene/plan/route.ts",
    "app/api/scene/refine/route.ts",
    "app/api/agent/next-action/route.ts",
    "app/api/modules/search/route.ts",
    "app/api/cart/add/route.ts",
    "app/api/mcp/status/route.ts",
    "app/api/session/agent-directives/route.ts",
    "app/api/session/search-strategy/route.ts",
    "app/api/session/state/route.ts",
    "app/api/runtime/readiness/route.ts",
    "app/error.tsx",
    "components/dashboard.tsx",
    "components/dashboard-api.ts",
    "components/dashboard-confirmation.tsx",
    "components/dashboard-execution.tsx",
    "components/dashboard-intake.tsx",
    "components/dashboard-results.tsx",
    "components/dashboard-workflow.ts",
    "lib/agent/directives.ts",
    "lib/agent/decision-engine.ts",
    "lib/agent/runtime-v2.ts",
    "lib/agent/orchestrator.ts",
    "lib/agent/planner.ts",
    "lib/agent/search-strategy.ts",
    "lib/agent/plan-reviewer.ts",
    "lib/agent/product-matcher.ts",
    "lib/agent/candidate-ranker.ts",
    "lib/agent/candidate-reviewer.ts",
    "lib/api/responses.ts",
    "lib/llm/deepseek.ts",
    "lib/llm/prompts.ts",
    "lib/llm/validation.ts",
    "lib/llm/telemetry.ts",
    "lib/mcp/client.ts",
    "lib/mcp/local-executor.ts",
    "lib/runtime/executor-protocol.json",
    "lib/runtime/executor-protocol.ts",
    "lib/runtime/postgres-repository.ts",
    "scripts/release-audit.mjs",
    "lib/runtime/readiness.ts",
    "lib/runtime/product-mode.ts",
    "lib/runtime/monitoring.ts",
    "lib/security/rate-limit.ts",
    "scripts/local-executor.mjs",
    "scripts/executor-doctor.mjs",
    "scripts/db-migrate.mjs",
    "scripts/db-check.mjs",
    ".github/workflows/quality.yml",
    "Dockerfile",
    "docker-compose.yml",
    "docs/deployment.md",
    "vitest.evaluation.config.ts",
    "tests/evaluation/new-car-agent-quality.test.ts",
    "lib/mcp/qoder.ts",
    "lib/session/guards.ts",
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
      file: "lib/mcp/qoder-async.ts",
      message: "旧 Qoder 后台加购实验文件已废弃，请不要重新引入"
    }
  ];

  for (const item of removedFiles) {
    if (fs.existsSync(path.join(ROOT, item.file))) {
      fail(`${item.file}: ${item.message}`);
    }
  }
}

function assertArchitectureContracts() {
  const deepseek = tryReadText("lib/llm/deepseek.ts");
  const matcher = tryReadText("lib/agent/product-matcher.ts");
  const planner = tryReadText("lib/agent/planner.ts");
  const searchStrategy = tryReadText("lib/agent/search-strategy.ts");
  const planReviewer = tryReadText("lib/agent/plan-reviewer.ts");
  const ranker = tryReadText("lib/agent/candidate-ranker.ts");
  const reviewer = tryReadText("lib/agent/candidate-reviewer.ts");
  const directives = tryReadText("lib/agent/directives.ts");
  const decisionEngine = tryReadText("lib/agent/decision-engine.ts");
  const orchestrator = tryReadText("lib/agent/orchestrator.ts");
  const refiner = tryReadText("lib/agent/refiner.ts");
  const prompts = tryReadText("lib/llm/prompts.ts");
  const types = tryReadText("lib/session/types.ts");
  const dashboard = tryReadText("components/dashboard.tsx");
  const dashboardApi = tryReadText("components/dashboard-api.ts");
  const hostedConsole = tryReadText("components/hosted-console.tsx");
  const dashboardWorkflow = tryReadText("components/dashboard-workflow.ts");
  const dashboardResults = tryReadText("components/dashboard-results.tsx");
  const dashboardConfirmation = tryReadText("components/dashboard-confirmation.tsx");
  const dashboardExecution = tryReadText("components/dashboard-execution.tsx");
  const config = tryReadText("components/dashboard-config.ts");
  const modulesSearchRoute = tryReadText("app/api/modules/search/route.ts");
  const agentNextActionRoute = tryReadText("app/api/agent/next-action/route.ts");
  const responses = tryReadText("lib/api/responses.ts");
  const cart = tryReadText("lib/agent/cart.ts");
  const cartRoute = tryReadText("app/api/cart/add/route.ts");
  const qoder = tryReadText("lib/mcp/qoder.ts");
  const mcpExecutor = tryReadText("lib/mcp/executor.ts");
  const mcpLogging = tryReadText("lib/mcp/logging.ts");
  const mcpHosted = tryReadText("lib/mcp/hosted.ts");
  const hostedWorker = tryReadText("scripts/codex-hosted-worker.mjs");
  const mcpRunRoute = tryReadText("app/api/mcp/run/route.ts");
  const mcpSchema = tryReadText("lib/mcp/schema.ts");
  const mcpClient = tryReadText("lib/mcp/client.ts");
  const parseRoute = tryReadText("app/api/scene/parse/route.ts");
  const planRoute = tryReadText("app/api/scene/plan/route.ts");
  const refineRoute = tryReadText("app/api/scene/refine/route.ts");
  const agentDirectivesRoute = tryReadText("app/api/session/agent-directives/route.ts");
  const searchStrategyRoute = tryReadText("app/api/session/search-strategy/route.ts");
  const sessionsRoute = tryReadText("app/api/sessions/route.ts");
  const sessionStateRoute = tryReadText("app/api/session/state/route.ts");
  const hostedTasksRoute = tryReadText("app/api/hosted/tasks/route.ts");
  const hostedNextRoute = tryReadText("app/api/hosted/tasks/next/route.ts");
  const hostedResolveRoute = tryReadText("app/api/hosted/tasks/resolve/route.ts");
  const hostedWorkerStatusRoute = tryReadText("app/api/hosted/worker-status/route.ts");
  const sessionStore = tryReadText("lib/session/store.ts");
  const sessionGuards = tryReadText("lib/session/guards.ts");
  const scenarioIndex = tryReadText("lib/scenarios/index.ts");
  const scenarioNormalize = tryReadText("lib/scenarios/normalize.ts");

  if (
    !deepseek ||
    !matcher ||
    !planner ||
    !searchStrategy ||
    !planReviewer ||
    !ranker ||
    !reviewer ||
    !directives ||
    !decisionEngine ||
    !orchestrator ||
    !refiner ||
    !prompts ||
    !types ||
    !dashboard ||
    !dashboardApi ||
    !hostedConsole ||
    !dashboardWorkflow ||
    !dashboardResults ||
    !dashboardConfirmation ||
    !dashboardExecution ||
    !config ||
    !modulesSearchRoute ||
    !agentNextActionRoute ||
    !responses ||
    !cart ||
    !cartRoute ||
    !qoder ||
    !mcpExecutor ||
    !mcpLogging ||
    !mcpHosted ||
    !hostedWorker ||
    !mcpRunRoute ||
    !mcpSchema ||
    !mcpClient ||
    !parseRoute ||
    !planRoute ||
    !refineRoute ||
    !agentDirectivesRoute ||
    !searchStrategyRoute ||
    !sessionsRoute ||
    !sessionStateRoute ||
    !hostedTasksRoute ||
    !hostedNextRoute ||
    !hostedResolveRoute ||
    !hostedWorkerStatusRoute ||
    !sessionStore ||
    !sessionGuards ||
    !scenarioIndex ||
    !scenarioNormalize
  ) {
    return;
  }

  const contracts = [
    {
      ok:
        types.includes("AgentDecision") &&
        types.includes("agent_decisions") &&
        decisionEngine.includes("decideNextAgentAction") &&
        decisionEngine.includes('action: "search_module"') &&
        decisionEngine.includes('action: "retry_module"') &&
        decisionEngine.includes('action: "skip_module"') &&
        decisionEngine.includes('action: "complete_workflow"') &&
        orchestrator.includes("getNextAgentAction") &&
        agentNextActionRoute.includes("getNextAgentAction") &&
        dashboard.includes("/api/agent/next-action") &&
        dashboard.includes('decision.action === "complete_workflow"') &&
        dashboardExecution.includes("Agent 决策与 AI 搜索策略") &&
        hostedConsole.includes("Agent 自主决策历史") &&
        sessionStore.includes("agent_decisions") &&
        sessionStore.includes("const normalized = normalizeSessionState(inMemory)") &&
        sessionGuards.includes("isAgentDecision"),
      message: "搜索主循环必须由服务端 Agent 决策驱动，并持久化搜索、补搜、跳过与结束动作"
    },
    {
      ok: deepseek.includes("validateSceneBriefOutput") && deepseek.includes("validateShoppingPlanOutput"),
      message: "DeepSeek 调用层必须校验结构化输出"
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
        dashboardResults.includes("suggested_keyword") &&
        dashboardResults.includes("Agent 搜索决策轨迹") &&
        sessionStore.includes("module_reviews") &&
        sessionStore.includes("normalizeModuleSearchTraces") &&
        sessionStore.includes("module_search_traces") &&
        matcher.includes("setModuleSearchTrace") &&
        matcher.includes("keywordAttemptReason") &&
        matcher.includes("ai_decision_summary") &&
        dashboardResults.includes("module_search_traces"),
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
        searchStrategy.includes("ensureModuleAnchors") &&
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
        !qoder.includes("TAOBAO_NATIVE_PATH") &&
        !qoder.includes("callTaobaoNative") &&
        !qoder.includes("runDirectSearch") &&
        !qoder.includes("runDirectAddToCart"),
      message: "Qoder provider 不应重新引入直接 taobao-native 实验路径，避免商品页跳转导致登录态问题"
    },
    {
      ok:
        mcpClient.includes("getConfiguredExecutionBackend") &&
        mcpClient.includes("isFormalProductMode") &&
        mcpClient.includes('configured !== "local_executor"') &&
        mcpClient.includes('return "local_executor"'),
      message: "正式产品模式必须阻断旧执行 backend，并安全收敛到 local_executor 持久任务路径"
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
        dashboard.includes("cartingProductId") &&
        dashboardResults.includes("cartingProductId === productId") &&
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
        dashboard.includes("已有候选会尽量保留") &&
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
