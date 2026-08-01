import { describe, expect, it } from "vitest";
import { resolveExecutorEnvironment } from "../../scripts/dev-auto.mjs";

const validFileToken = "file_token_abcdefghijklmnopqrstuvwxyz0123456789";
const validShellToken = "shell_token_abcdefghijklmnopqrstuvwxyz0123456789";

describe("SceneCart one-command development stack", () => {
  it("discovers executor settings written after the web process starts", () => {
    const resolved = resolveExecutorEnvironment(
      [
        "SCENECART_API_URL=http://127.0.0.1:3000",
        `SCENECART_DEVICE_TOKEN=${validFileToken}`,
        "QODERCLI_PATH=/Users/demo/.local/bin/qodercli"
      ].join("\n"),
      {},
      "http://127.0.0.1:3001"
    );

    expect(resolved).toEqual({
      TAOBAO_EXECUTION_BACKEND: "local_executor",
      SCENECART_API_URL: "http://127.0.0.1:3001",
      SCENECART_DEVICE_TOKEN: validFileToken,
      QODERCLI_PATH: "/Users/demo/.local/bin/qodercli"
    });
  });

  it("keeps explicit process secrets authoritative while binding the worker to the active web origin", () => {
    const resolved = resolveExecutorEnvironment(
      `SCENECART_DEVICE_TOKEN=${validFileToken}\nQODERCLI_PATH=/file/qodercli\n`,
      {
        SCENECART_DEVICE_TOKEN: validShellToken,
        QODERCLI_PATH: "/shell/qodercli"
      },
      "http://127.0.0.1:3100"
    );

    expect(resolved.SCENECART_DEVICE_TOKEN).toBe(validShellToken);
    expect(resolved.QODERCLI_PATH).toBe("/shell/qodercli");
    expect(resolved.SCENECART_API_URL).toBe("http://127.0.0.1:3100");
  });

  it("does not invent a device token before registration", () => {
    const resolved = resolveExecutorEnvironment("", {}, "http://127.0.0.1:3000");

    expect(resolved.SCENECART_DEVICE_TOKEN).toBe("");
    expect(resolved.TAOBAO_EXECUTION_BACKEND).toBe("local_executor");
  });
});
