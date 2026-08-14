import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export function cloudRecoverySecretPath(root) {
  return path.join(root, ".data", "cloud-demo", "recovery-secret");
}

export function updateCloudDemoEnv(content, cloudUrl) {
  const key = "SCENECART_DEMO_CLOUD_URL";
  const line = `${key}=${cloudUrl}`;
  const source = String(content ?? "").split(/\r?\n/);
  let replaced = false;
  const lines = source
    .filter((item, index) => !(index === source.length - 1 && item === ""))
    .map((item) => {
      if (!new RegExp(`^\\s*${key}\\s*=`).test(item)) return item;
      if (replaced) return null;
      replaced = true;
      return line;
    })
    .filter((item) => item !== null);

  if (!replaced) {
    if (lines.length > 0 && lines.at(-1)?.trim()) lines.push("");
    lines.push("# SceneCart cloud interview demo", line);
  }
  return `${lines.join("\n")}\n`;
}

export function updateCloudExecutorToken(content, token) {
  const key = "SCENECART_CLOUD_DEVICE_TOKEN";
  const line = `${key}=${token}`;
  const source = String(content ?? "").split(/\r?\n/);
  let replaced = false;
  const lines = source
    .filter((item, index) => !(index === source.length - 1 && item === ""))
    .map((item) => {
      if (!new RegExp(`^\\s*${key}\\s*=`).test(item)) return item;
      if (replaced) return null;
      replaced = true;
      return line;
    })
    .filter((item) => item !== null);

  if (!replaced) {
    if (lines.length > 0 && lines.at(-1)?.trim()) lines.push("");
    lines.push("# SceneCart cloud executor (keep the local device token above unchanged)", line);
  }
  return `${lines.join("\n")}\n`;
}

export async function readCloudRecoverySecret(root) {
  try {
    const secret = (await fs.readFile(cloudRecoverySecretPath(root), "utf8")).trim();
    return secret.length >= 32 ? secret : "";
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return "";
    throw error;
  }
}

export async function ensureCloudRecoverySecret(root) {
  const existing = await readCloudRecoverySecret(root);
  if (existing) return { created: false, path: cloudRecoverySecretPath(root) };

  const target = cloudRecoverySecretPath(root);
  const directory = path.dirname(target);
  const temporary = `${target}.tmp-${process.pid}`;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  try {
    await fs.writeFile(temporary, `${randomBytes(32).toString("base64url")}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600);
    return { created: true, path: target };
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}
