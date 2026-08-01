import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import {
  normalizeExecutorApiUrl,
  preferredExecutorApiUrl,
  readEnvValue,
  updateExecutorEnv,
  validateExecutorDeviceToken
} from "./executor-config-utils.mjs";

const target = path.join(process.cwd(), ".env.local");

async function readExisting() {
  try {
    return await fs.readFile(target, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return "";
    throw error;
  }
}

function expandHome(value) {
  const trimmed = value.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
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
    console.log("在交互式终端中安全配置 SceneCart 本地执行器；设备令牌不会回显或进入 shell history。");
    return;
  }

  const existing = await readExisting();
  const currentApiUrl = preferredExecutorApiUrl(existing, process.env.SCENECART_API_URL);
  const currentQoderPath = readEnvValue(existing, "QODERCLI_PATH") || path.join(os.homedir(), ".local/bin/qodercli");
  const currentToken = readEnvValue(existing, "SCENECART_DEVICE_TOKEN");
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  let apiUrl;
  let qoderPath;
  try {
    apiUrl = normalizeExecutorApiUrl(
      (await input.question(`SceneCart API 地址 [${currentApiUrl}]: `)).trim() || currentApiUrl
    );
    qoderPath = expandHome(
      (await input.question(`Qoder CLI 路径 [${currentQoderPath}]: `)).trim() || currentQoderPath
    );
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
    throw new Error("尚未配置设备令牌，请先在 /settings/executor 注册设备");
  }

  await writeAtomically(updateExecutorEnv(existing, { apiUrl, deviceToken, qoderPath }));
  console.log(`配置已安全写入 ${target}`);
  console.log(`API: ${apiUrl}`);
  console.log(`Qoder: ${qoderPath}`);
  console.log("设备令牌：已保存但不显示");
  console.log("下一步运行：npm run executor:doctor");
}

main().catch((error) => {
  console.error(`配置失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
