import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import {
  discoverExecutorApiUrl,
  executorNeedsVercelProtection,
  normalizeExecutorApiUrl,
  preferredExecutorApiUrl,
  preferredVercelProtectionMode,
  preferredVercelProtectedOrigin,
  readEnvValue,
  updateExecutorEnv,
  validateExecutorDeviceToken,
  validateVercelProtectionBypassSecret
} from "./executor-config-utils.mjs";
import {
  DEFAULT_SCENECART_PROTECTED_ORIGIN,
  normalizeProtectedOrigin,
  safeMachineErrorMessage
} from "./vercel-protection-bypass.mjs";

const target = path.join(process.cwd(), ".env.local");

async function readExisting() {
  try {
    return await fs.readFile(target, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return "";
    throw error;
  }
}

async function hiddenQuestion(label) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("该命令需要在交互式终端运行，不能通过网页控制台或管道输入令牌");
  }

  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("已取消配置"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (character >= " ") {
          value += character;
          process.stdout.write("•");
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

async function writeAtomically(content) {
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log("在交互式终端中安全配置 SceneCart 本地执行器；设备令牌和可选 Vercel Bypass Secret 均不会回显或进入 shell history。");
    return;
  }

  const existing = await readExisting();
  const currentApiUrl = await discoverExecutorApiUrl(
    preferredExecutorApiUrl(existing, process.env.SCENECART_API_URL)
  );
  const currentToken = readEnvValue(existing, "SCENECART_DEVICE_TOKEN");
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  let apiUrl;
  let protectedOrigin = "";
  let protectionMode = "protected";
  try {
    apiUrl = normalizeExecutorApiUrl(
      (await input.question(`SceneCart API 地址 [${currentApiUrl}]: `)).trim() || currentApiUrl
    );
    const suggestedProtectedOrigin = preferredVercelProtectedOrigin(
      existing,
      process.env.SCENECART_VERCEL_PROTECTED_ORIGIN ?? "",
      apiUrl
    );
    const parsedApiUrl = new URL(apiUrl);
    const remoteHttps = parsedApiUrl.protocol === "https:" &&
      !["localhost", "127.0.0.1", "::1"].includes(parsedApiUrl.hostname);
    if (remoteHttps) {
      const suggestedProtectionMode = preferredVercelProtectionMode(
        existing,
        process.env.SCENECART_VERCEL_PROTECTION_MODE ?? ""
      );
      const modeInput = (await input.question(
        `Vercel 传输模式 protected/unprotected [${suggestedProtectionMode}]: `
      )).trim();
      protectionMode = preferredVercelProtectionMode(
        "",
        modeInput || suggestedProtectionMode
      );
      if (protectionMode === "unprotected") {
        executorNeedsVercelProtection(apiUrl, DEFAULT_SCENECART_PROTECTED_ORIGIN, protectionMode);
        protectedOrigin = DEFAULT_SCENECART_PROTECTED_ORIGIN;
      } else {
        const prompt = suggestedProtectedOrigin
          ? `Vercel 受保护 origin [${suggestedProtectedOrigin}]: `
          : "Vercel 受保护 origin: ";
        const originInput = (await input.question(prompt)).trim();
        protectedOrigin = originInput
          ? normalizeProtectedOrigin(originInput)
          : suggestedProtectedOrigin;
        if (!protectedOrigin) {
          throw new Error("protected 传输模式必须配置与 SceneCart API 完全一致的 Vercel HTTPS origin");
        }
      }
    }
  } finally {
    input.close();
  }

  const tokenInput = await hiddenQuestion(
    currentToken
      ? "设备令牌（留空保留当前值，输入不会回显）: "
      : "设备令牌（输入不会回显）: "
  );
  const deviceToken = tokenInput.trim() ? validateExecutorDeviceToken(tokenInput) : currentToken;
  if (!deviceToken) {
    throw new Error("尚未配置设备令牌；请先由受控运维终端运行 npm run executor:provision 安全签发固定 owner 设备");
  }

  let bypassSecret = "";
  const protectionRequired = protectedOrigin
    ? executorNeedsVercelProtection(apiUrl, protectedOrigin, protectionMode)
    : executorNeedsVercelProtection(apiUrl, "", protectionMode);
  if (protectionRequired) {
    const currentBypassSecret =
      process.env.SCENECART_VERCEL_PROTECTION_BYPASS_SECRET?.trim() ||
      readEnvValue(existing, "SCENECART_VERCEL_PROTECTION_BYPASS_SECRET").trim();
    const bypassInput = await hiddenQuestion(
      currentBypassSecret
        ? "Vercel Automation Bypass Secret（留空保留当前值，输入不会回显）: "
        : "Vercel Automation Bypass Secret（输入不会回显）: "
    );
    bypassSecret = validateVercelProtectionBypassSecret(
      bypassInput.trim() || currentBypassSecret
    );
  }

  await writeAtomically(updateExecutorEnv(existing, {
    apiUrl,
    deviceToken,
    protectionMode,
    ...(protectedOrigin ? { protectedOrigin } : {}),
    ...(bypassSecret ? { bypassSecret } : {})
  }));
  console.log(`配置已安全写入 ${target}`);
  console.log(`API: ${apiUrl}`);
  console.log("淘宝执行通道：桌面版官方本地 HTTP MCP（无需 Qoder）");
  console.log("设备令牌：已保存但不显示");
  if (protectionRequired) {
    console.log("Vercel Automation Bypass：已保存但不显示；Worker 子进程将从本机环境读取");
  } else if (protectionMode === "unprotected") {
    console.log("Vercel 外层保护：显式未启用；只允许固定正式域名，仍必须使用 SceneCart 设备令牌");
  }
  console.log("下一步运行：npm run executor:doctor");
}

main().catch((error) => {
  console.error(`配置失败：${safeMachineErrorMessage(error)}`);
  process.exitCode = 1;
});
