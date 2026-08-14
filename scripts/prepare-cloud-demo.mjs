import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { ensureCloudRecoverySecret, updateCloudDemoEnv } from "./cloud-demo-config.mjs";
import { normalizeCloudDemoUrl, parseCloudDemoArgs } from "./demo-cloud-utils.mjs";

const ROOT = process.cwd();

async function readLocalEnv(target) {
  try {
    return await fs.readFile(target, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return "";
    throw error;
  }
}

async function writeLocalEnv(target, content) {
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

export async function prepareCloudDemo(args = process.argv.slice(2)) {
  const options = parseCloudDemoArgs(args);
  if (options.help) {
    process.stdout.write("用法：npm run demo:cloud:prepare -- --url https://你的正式域名\n");
    return;
  }
  if (options.checkOnly || options.skipRecovery) {
    throw new Error("prepare 仅接受 --url 参数");
  }
  const cloudUrl = normalizeCloudDemoUrl(options.url);
  const localEnvPath = path.join(ROOT, ".env.local");
  const existing = await readLocalEnv(localEnvPath);
  await writeLocalEnv(localEnvPath, updateCloudDemoEnv(existing, cloudUrl));
  const secret = await ensureCloudRecoverySecret(ROOT);

  process.stdout.write(`PASS  cloud_url: ${cloudUrl}\n`);
  process.stdout.write(`PASS  recovery_secret: 已${secret.created ? "生成" : "复用"}本机安全文件（内容不会显示）\n`);
  process.stdout.write("本地 SCENECART_API_URL 与设备令牌未修改，npm run dev 兜底仍然可用。\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareCloudDemo().catch((error) => {
    process.stderr.write(`[demo:cloud:prepare] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
