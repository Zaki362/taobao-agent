import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  resolveTaobaoNativeCliCommand,
  TaobaoNativeCliClient
} from "../../scripts/taobao-native-cli-client.mjs";

describe("TaobaoNativeCliClient", () => {
  it("prefers the bundled macOS CLI without depending on shell PATH", () => {
    expect(resolveTaobaoNativeCliCommand({
      environment: {},
      platform: "darwin",
      homeDirectory: "/Users/tester",
      exists: (candidate) => candidate.endsWith("/taobao/cli/bin/taobao-native")
    })).toBe("/Users/tester/Library/Application Support/taobao/cli/bin/taobao-native");
    expect(resolveTaobaoNativeCliCommand({
      environment: { TAOBAO_NATIVE_CLI_PATH: "/opt/taobao/custom-cli" },
      platform: "darwin",
      exists: () => false
    })).toBe("/opt/taobao/custom-cli");
  });

  it("probes the real tool execution layer rather than only reading CLI help", async () => {
    const calls = [];
    const client = new TaobaoNativeCliClient({
      command: "/fake/taobao-native",
      sourceApp: "SceneCartAI",
      execFileImpl: async (command, args) => {
        calls.push({ command, args });
        return {
          stdout: JSON.stringify({ result: { success: true, pages: [{ name: "home" }] } }),
          stderr: ""
        };
      }
    });

    await expect(client.probeSearchReadiness()).resolves.toBe(true);
    expect(calls).toEqual([{
      command: "/fake/taobao-native",
      args: [
        "list_available_pages",
        "--args",
        JSON.stringify({ sourceApp: "SceneCartAI" })
      ]
    }]);
  });

  it("runs one search with exact arguments, reads the result file, and removes it", async () => {
    const tempDirectory = await fs.mkdtemp("/tmp/scenecart-cli-client-");
    let outputPath = "";
    const client = new TaobaoNativeCliClient({
      command: "/fake/taobao-native",
      sourceApp: "SceneCartAI",
      tempDirectory,
      execFileImpl: async (_command, args) => {
        expect(args.slice(0, 3)).toEqual([
          "search_products",
          "--args",
          JSON.stringify({ keyword: "行车记录仪", type: "all", sourceApp: "SceneCartAI" })
        ]);
        outputPath = args[4];
        await fs.writeFile(outputPath, JSON.stringify({
          result: {
            keyword: "行车记录仪",
            type: "all",
            count: 1,
            products: [{ itemId: "1", title: "测试商品" }]
          }
        }));
        return { stdout: JSON.stringify({ resultFile: outputPath }), stderr: "" };
      }
    });

    try {
      await expect(client.searchProducts({ keyword: "行车记录仪" })).resolves.toMatchObject({
        result: { keyword: "行车记录仪", count: 1 }
      });
      await expect(fs.stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("preserves a structured upstream failure and cleans an unfinished output file", async () => {
    const tempDirectory = await fs.mkdtemp("/tmp/scenecart-cli-error-");
    const client = new TaobaoNativeCliClient({
      command: "/fake/taobao-native",
      tempDirectory,
      execFileImpl: async (_command, args) => {
        const outputPath = args[4];
        await fs.writeFile(outputPath, "partial");
        const error = new Error("command failed");
        error.stdout = JSON.stringify({ error: "Tool 执行层未就绪，请确保应用已加载完成" });
        throw error;
      }
    });

    try {
      await expect(client.searchProducts({ keyword: "帐篷" })).rejects.toThrow(
        "Tool 执行层未就绪，请确保应用已加载完成"
      );
      expect(await fs.readdir(tempDirectory)).toEqual([]);
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
