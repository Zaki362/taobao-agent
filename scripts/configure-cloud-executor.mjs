import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { updateCloudExecutorToken } from "./cloud-demo-config.mjs";
import { validateExecutorDeviceToken } from "./executor-config-utils.mjs";

const TARGET = path.join(process.cwd(), ".env.local");

async function hiddenQuestion(label) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("该命令需要交互式终端；云端设备令牌不能通过命令参数或管道输入");
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

async function readExisting() {
  try {
    return await fs.readFile(TARGET, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return "";
    throw error;
  }
}

async function writeAtomically(content) {
  const temporary = `${TARGET}.tmp-${process.pid}`;
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, TARGET);
    await fs.chmod(TARGET, 0o600);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function configureCloudExecutor() {
  if (process.argv.includes("--help")) {
    process.stdout.write("在云端 /settings/executor 注册设备后，运行此命令并粘贴一次性令牌。\n");
    return;
  }
  const token = validateExecutorDeviceToken(
    await hiddenQuestion("云端设备令牌（输入不会回显）: ")
  );
  const existing = await readExisting();
  await writeAtomically(updateCloudExecutorToken(existing, token));
  process.stdout.write("云端设备令牌已安全保存；本地设备令牌和本地 API 地址均未修改。\n");
  process.stdout.write("下一步：npm run demo:cloud -- --check\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  configureCloudExecutor().catch((error) => {
    process.stderr.write(`[demo:cloud:configure] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
