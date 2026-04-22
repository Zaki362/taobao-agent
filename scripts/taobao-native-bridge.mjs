import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import { randomUUID } from "node:crypto";
import osPath from "node:path";

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.TAOBAO_MCP_BRIDGE_PORT || 8787);
const HOST = process.env.TAOBAO_MCP_BRIDGE_HOST || "127.0.0.1";
const SOURCE_APP = process.env.TAOBAO_SOURCE_APP || "SceneCartAI";
const TAOBAO_NATIVE_BIN = process.env.TAOBAO_NATIVE_BIN || "taobao-native";
const FALLBACK_MAC_RUNNER = osPath.join(
  os.homedir(),
  "Library",
  "Application Support",
  "taobao",
  "cli",
  "taobao-runner"
);
const TAOBAO_CONFIG_PATH = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "taobao",
  "config.json"
);

function unwrapResult(payload) {
  if (payload && typeof payload === "object" && "result" in payload) {
    return payload.result;
  }
  return payload;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload));
}

async function readTaobaoConfig() {
  try {
    const raw = await fs.readFile(TAOBAO_CONFIG_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function getAuthorizationState() {
  const config = await readTaobaoConfig();
  return {
    mcpEnabled: Boolean(config?.mcpEnabled),
    mcpAiAppsAuthorized: Boolean(config?.mcpAiAppsAuthorized),
    mcpChatEnabled: Boolean(config?.mcpChatEnabled),
    mcpOrderEnabled: Boolean(config?.mcpOrderEnabled)
  };
}

async function runTaobaoNative(tool, argumentsPayload) {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "taobao-native-bridge-"));
  const requestPath = path.join(workdir, `${tool}-${randomUUID()}.request.json`);
  const outputPath = path.join(workdir, `${tool}-${randomUUID()}.output.json`);

  const requestPayload = {
    tool,
    arguments: {
      ...argumentsPayload,
      sourceApp: SOURCE_APP
    }
  };

  await fs.writeFile(requestPath, JSON.stringify(requestPayload, null, 2), "utf-8");
  try {
    await execTaobaoCommand(["--request", requestPath, "-o", outputPath]);
    const raw = await fs.readFile(outputPath, "utf-8");
    return raw ? JSON.parse(raw) : {};
  } finally {
    await fs.rm(workdir, { recursive: true, force: true });
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildErrorMessage(error) {
  if (!error || typeof error !== "object") {
    return String(error);
  }

  const candidate = error;
  const parts = [
    typeof candidate.message === "string" ? candidate.message : "",
    typeof candidate.stderr === "string" ? candidate.stderr.trim() : "",
    typeof candidate.stdout === "string" ? candidate.stdout.trim() : ""
  ].filter(Boolean);

  return parts.join("\n").trim() || "taobao-native 调用失败";
}

function isCommandMissing(message) {
  return message.includes("ENOENT") || message.includes("command not found");
}

function isConnectFailure(message) {
  return message.includes("connect") || message.includes("连接失败") || message.includes("cli-rpc.sock");
}

function isWarmupFailure(message) {
  return (
    message.includes("Tool 执行层未就绪") ||
    message.includes("应用已加载完成") ||
    message.includes("未就绪") ||
    message.includes("加载完成")
  );
}

async function getAvailableBinaries() {
  const bins = [TAOBAO_NATIVE_BIN];

  try {
    await fs.access(FALLBACK_MAC_RUNNER);
    if (!bins.includes(FALLBACK_MAC_RUNNER)) {
      bins.push(FALLBACK_MAC_RUNNER);
    }
  } catch {
    // ignore
  }

  return bins;
}

async function execTaobaoCommand(args, preferredBin) {
  const bins = preferredBin ? [preferredBin] : await getAvailableBinaries();
  let lastError;

  for (const bin of bins) {
    try {
      return await execFileAsync(bin, args, {
        env: process.env,
        timeout: 120000,
        maxBuffer: 1024 * 1024 * 8
      });
    } catch (error) {
      lastError = error;
      const message = buildErrorMessage(error);
      if (!isCommandMissing(message) || bin === bins[bins.length - 1]) {
        throw new Error(message);
      }
    }
  }

  throw new Error(buildErrorMessage(lastError));
}

async function launchDesktop() {
  if (process.platform === "darwin") {
    try {
      await execFileAsync("open", ["-a", "/Applications/淘宝桌面版.app"], {
        env: process.env,
        timeout: 120000,
        maxBuffer: 1024 * 1024 * 4
      });
    } catch {
      // Keep going and still try the CLI launch path below.
    }
  }

  try {
    await execTaobaoCommand(["launch"]);
    return;
  } catch (error) {
    const message = buildErrorMessage(error);
    if (process.platform === "darwin") {
      try {
        await execFileAsync("open", ["-a", "/Applications/淘宝桌面版.app"], {
          env: process.env,
          timeout: 120000,
          maxBuffer: 1024 * 1024 * 4
        });
        return;
      } catch {
        throw new Error(`启动淘宝桌面版失败：${message}`);
      }
    }
    throw new Error(`启动淘宝桌面版失败：${message}`);
  }
}

async function waitForExecutorReady() {
  const retryIntervals = [8000, 10000, 12000, 15000, 15000];
  let lastError;

  for (const interval of retryIntervals) {
    await sleep(interval);
    try {
      await runTaobaoNative("get_current_tab", {});
      return;
    } catch (error) {
      lastError = error;
      const message = buildErrorMessage(error);
      if (!isConnectFailure(message) && !isWarmupFailure(message)) {
        throw new Error(message);
      }
    }
  }

  const reason = buildErrorMessage(lastError);
  throw new Error(
    `淘宝桌面版已经启动，但工具执行层在等待后仍未就绪。请确认淘宝桌面版已完全加载、已登录且停留在主界面后重试。\n\n原始错误：${reason}`
  );
}

async function runTaobaoNativeWithRecovery(tool, argumentsPayload) {
  const authState = await getAuthorizationState();
  if (!authState.mcpEnabled) {
    throw new Error("淘宝桌面版未开启 MCP 能力，请先在客户端设置中开启相关功能。");
  }
  if (!authState.mcpAiAppsAuthorized) {
    throw new Error("淘宝桌面版尚未授权 AI 应用调用 MCP，请先在客户端内完成授权后再重试。");
  }

  try {
    return await runTaobaoNative(tool, argumentsPayload);
  } catch (error) {
    const message = buildErrorMessage(error);
    if (!isConnectFailure(message) && !isWarmupFailure(message)) {
      throw new Error(message);
    }
  }

  await launchDesktop();
  await waitForExecutorReady();

  const retryIntervals = [2000, 4000, 6000, 8000];
  let lastError;

  for (const interval of retryIntervals) {
    await sleep(interval);
    try {
      return await runTaobaoNative(tool, argumentsPayload);
    } catch (error) {
      lastError = error;
      const message = buildErrorMessage(error);
      if (!isConnectFailure(message) && !isWarmupFailure(message)) {
        throw new Error(message);
      }
    }
  }

  throw new Error(buildErrorMessage(lastError));
}

function normalizeSearchResults(payload) {
  const source = unwrapResult(payload);
  const list =
    source?.products ||
    source?.items ||
    source?.results ||
    source?.data ||
    [];

  if (!Array.isArray(list)) {
    return [];
  }

  return list.slice(0, 12).map((item, index) => ({
    product_id:
      String(
        item?.itemId ||
          item?.item_id ||
          item?.id ||
          item?.product_id ||
          `taobao-item-${index + 1}`
      ),
    title: String(item?.title || item?.name || "未命名商品"),
    price: Number(item?.price || item?.skuPrice || item?.finalPrice || 0),
    shop_name: String(item?.shopName || item?.sellerName || item?.shop_name || "未知店铺"),
    image_url: String(item?.image || item?.imageUrl || item?.picUrl || item?.mainPic || ""),
    detail_url: String(item?.detailUrl || item?.url || item?.itemUrl || "https://www.taobao.com/"),
    shop_badges: Array.isArray(item?.shopBadges)
      ? item.shopBadges.filter((entry) => typeof entry === "string")
      : Array.isArray(item?.tags)
        ? item.tags.filter((entry) => typeof entry === "string").slice(0, 3)
        : [],
    highlights: Array.isArray(item?.highlights)
      ? item.highlights.filter((entry) => typeof entry === "string")
      : Array.isArray(item?.sellingPoints)
        ? item.sellingPoints.filter((entry) => typeof entry === "string").slice(0, 4)
        : []
  }));
}

function normalizeProductInfo(payload, fallback = {}) {
  const raw = unwrapResult(payload);
  const source = raw?.product || raw?.item || raw?.data || raw || {};
  return {
    product_id: String(source?.itemId || source?.item_id || source?.id || fallback.product_id || ""),
    title: String(source?.title || source?.name || fallback.title || "未命名商品"),
    price: Number(source?.price || source?.skuPrice || source?.finalPrice || fallback.price || 0),
    shop_name: String(source?.shopName || source?.sellerName || fallback.shop_name || "未知店铺"),
    image_url: String(source?.image || source?.imageUrl || source?.picUrl || fallback.image_url || ""),
    detail_url: String(source?.detailUrl || source?.url || source?.itemUrl || fallback.detail_url || "https://www.taobao.com/"),
    shop_badges: Array.isArray(source?.shopBadges)
      ? source.shopBadges.filter((entry) => typeof entry === "string")
      : Array.isArray(fallback.shop_badges)
        ? fallback.shop_badges
        : [],
    highlights: Array.isArray(source?.highlights)
      ? source.highlights.filter((entry) => typeof entry === "string")
      : [],
    risk_notes: Array.isArray(source?.riskNotes)
      ? source.riskNotes.filter((entry) => typeof entry === "string")
      : []
  };
}

async function handleRun(tool, input) {
  if (tool === "search_taobao_products") {
    const raw = await runTaobaoNativeWithRecovery("search_products", {
      keyword: input.keyword
    });
    return {
      output: {
        results: normalizeSearchResults(raw)
      }
    };
  }

  if (tool === "open_product_detail") {
    if (!input.detail_url) {
      throw new Error("open_product_detail 需要 detail_url，当前 bridge 无法仅凭 product_id 打开详情页。");
    }
    await runTaobaoNativeWithRecovery("navigate_to_url", {
      url: input.detail_url
    });
    return {
      output: {
        opened: true,
        product_id: input.product_id
      }
    };
  }

  if (tool === "extract_product_info") {
    const payload = input.detail_url
      ? await runTaobaoNativeWithRecovery("navigate_to_url", { url: input.detail_url }).then(() =>
          runTaobaoNativeWithRecovery("read_page_content", { maxLength: 8000 })
        )
      : {};

    return {
      output: normalizeProductInfo(
        payload,
        {
          product_id: input.product_id,
          title: input.title,
          detail_url: input.detail_url
        }
      )
    };
  }

  if (tool === "add_to_cart") {
    const raw = await runTaobaoNativeWithRecovery("add_to_cart", {
      itemId: input.product_id,
      confirmed: input.confirmed,
      quantity: input.quantity || 1
    });
    return {
      output: {
        success: Boolean(raw?.success ?? true),
        message: String(raw?.message || "已加入购物车"),
        product_id: input.product_id
      }
    };
  }

  throw new Error(`unsupported tool: ${tool}`);
}

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url) {
      return sendJson(res, 404, { error: "not found" });
    }

    if (req.method === "GET" && req.url === "/health") {
      const authState = await getAuthorizationState();
      if (!authState.mcpEnabled) {
        return sendJson(res, 409, {
          error: "淘宝桌面版未开启 MCP 能力，请先在客户端设置中开启相关功能。",
          permissions_scope: ["搜索商品", "浏览商品详情", "提取商品信息", "加入购物车需显式确认"],
          auth_state: authState
        });
      }
      if (!authState.mcpAiAppsAuthorized) {
        return sendJson(res, 409, {
          error: "淘宝桌面版尚未授权 AI 应用调用 MCP，请先在客户端内完成授权后再重试。",
          permissions_scope: ["搜索商品", "浏览商品详情", "提取商品信息", "加入购物车需显式确认"],
          auth_state: authState
        });
      }
      return sendJson(res, 200, {
        message: "taobao-native bridge ready",
        permissions_scope: ["搜索商品", "浏览商品详情", "提取商品信息", "加入购物车需显式确认"],
        auth_state: authState
      });
    }

    if (req.method === "POST" && req.url === "/run") {
      const body = await readJsonBody(req);
      const result = await handleRun(body.tool, body.input || {});
      return sendJson(res, 200, result);
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (error) {
    return sendJson(res, 500, {
      error: error instanceof Error ? error.message : "bridge error"
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`taobao-native bridge listening on http://${HOST}:${PORT}`);
});
