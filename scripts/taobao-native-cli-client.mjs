import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_ERROR_LENGTH = 1000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

function parseJson(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function unwrapResult(value) {
  return value && typeof value === "object" && value.result && typeof value.result === "object"
    ? value.result
    : value;
}

function errorText(error) {
  const values = [error?.stdout, error?.stderr, error?.message, String(error ?? "")]
    .filter((value) => typeof value === "string" && value.trim());
  for (const value of values) {
    const parsed = parseJson(value);
    if (parsed && typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error.trim().slice(0, MAX_ERROR_LENGTH);
    }
  }
  return values.join("\n").replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_LENGTH) ||
    "淘宝官方 CLI 未返回可识别结果";
}

export function resolveTaobaoNativeCliCommand(options = {}) {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const exists = options.exists ?? fsSync.existsSync;
  const configured = String(environment.TAOBAO_NATIVE_CLI_PATH ?? "").trim();
  if (configured) return configured;
  if (platform === "darwin") {
    const bundled = path.join(
      homeDirectory,
      "Library",
      "Application Support",
      "taobao",
      "cli",
      "bin",
      "taobao-native"
    );
    if (exists(bundled)) return bundled;
  }
  return "taobao-native";
}

export class TaobaoNativeCliClient {
  constructor(options = {}) {
    this.command = options.command || resolveTaobaoNativeCliCommand(options);
    this.sourceApp = options.sourceApp || "SceneCartAI";
    this.timeoutMs = Math.max(Number(options.timeoutMs || 60_000), 5_000);
    this.tempDirectory = options.tempDirectory || os.tmpdir();
    this.execFileImpl = options.execFileImpl || execFileAsync;
  }

  async runTool(name, argumentsValue = {}, options = {}) {
    const outputPath = options.outputFile === false
      ? null
      : path.join(
        this.tempDirectory,
        `scenecart-taobao-${name}-${process.pid}-${randomUUID()}.json`
      );
    const cliArguments = [
      name,
      "--args",
      JSON.stringify({ ...argumentsValue, sourceApp: this.sourceApp }),
      ...(outputPath ? ["-o", outputPath] : [])
    ];

    try {
      const execution = await this.execFileImpl(this.command, cliArguments, {
        cwd: process.cwd(),
        timeout: this.timeoutMs,
        signal: options.signal,
        maxBuffer: DEFAULT_MAX_BUFFER,
        encoding: "utf8"
      });
      const payload = outputPath
        ? parseJson(await fs.readFile(outputPath, "utf8"))
        : parseJson(execution?.stdout);
      if (!payload || typeof payload !== "object") {
        throw new Error(`淘宝官方 CLI ${name} 返回了无效 JSON`);
      }
      if (typeof payload.error === "string" && payload.error.trim()) {
        throw new Error(payload.error.trim());
      }
      return payload;
    } catch (error) {
      throw new Error(errorText(error));
    } finally {
      if (outputPath) await fs.unlink(outputPath).catch(() => undefined);
    }
  }

  async probeSearchReadiness(signal) {
    const payload = await this.runTool(
      "list_available_pages",
      {},
      { signal, outputFile: false }
    );
    const result = unwrapResult(payload);
    if (!result || result.success !== true || !Array.isArray(result.pages)) {
      throw new Error("淘宝官方 CLI 搜索执行层尚未就绪");
    }
    return true;
  }

  async searchProducts({ keyword, type = "all" }, signal) {
    const normalizedKeyword = String(keyword ?? "").trim();
    if (!normalizedKeyword) throw new Error("淘宝官方 CLI 搜索关键词不能为空");
    return this.runTool("search_products", {
      keyword: normalizedKeyword,
      type: String(type || "all")
    }, { signal, outputFile: true });
  }

  async getCurrentTab(signal) {
    return this.runTool("get_current_tab", {}, { signal, outputFile: false });
  }
}
