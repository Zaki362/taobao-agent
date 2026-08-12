import { describe, expect, it } from "vitest";
import { commandPort, localApiPort, resolveDevServer } from "../../scripts/dev-server.mjs";

describe("SceneCart development server selection", () => {
  it("parses supported Next.js port arguments", () => {
    expect(commandPort(["-p", "3001"])).toBe(3001);
    expect(commandPort(["--port", "3100"])).toBe(3100);
    expect(commandPort(["--port=3200"])).toBe(3200);
    expect(() => commandPort(["--port", "invalid"])).toThrow("不是有效端口");
  });

  it("uses only local API URLs as development port hints", () => {
    expect(localApiPort("http://127.0.0.1:3001")).toBe(3001);
    expect(localApiPort("http://localhost:3100/")).toBe(3100);
    expect(localApiPort("https://scenecart.example.com")).toBeUndefined();
  });

  it("selects the next available port when the default is occupied", async () => {
    const checked = [];
    const selected = await resolveDevServer({
      env: {},
      defaultPort: 3000,
      isAvailable: async (port) => {
        checked.push(port);
        return port === 3002;
      }
    });
    expect(checked).toEqual([3000, 3001, 3002]);
    expect(selected).toMatchObject({
      port: 3002,
      url: "http://127.0.0.1:3002",
      source: "automatic",
      changedFromDefault: true
    });
  });

  it("keeps explicit configuration strict instead of silently moving the worker", async () => {
    await expect(resolveDevServer({
      args: ["--port", "3100"],
      env: {},
      isAvailable: async () => false
    })).rejects.toThrow("端口 3100 已被占用");

    const selected = await resolveDevServer({
      env: { SCENECART_API_URL: "http://127.0.0.1:3001" },
      isAvailable: async (port) => port === 3001
    });
    expect(selected).toMatchObject({ port: 3001, source: "api_url" });
  });
});
