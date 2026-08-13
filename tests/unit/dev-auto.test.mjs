import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveExecutorEnvironment, resolvePreferredNode22 } from "../../scripts/dev-auto.mjs";
import {
  WORKER_RESTART_MAX_MS,
  createWorkerSupervisor,
  workerRestartDelay
} from "../../scripts/dev-auto-supervisor.mjs";
import { validateExecutorDeviceToken } from "../../scripts/executor-config-utils.mjs";

const validFileToken = "file_token_abcdefghijklmnopqrstuvwxyz0123456789";
const validShellToken = "shell_token_abcdefghijklmnopqrstuvwxyz0123456789";

class FakeChild extends EventEmitter {
  killed = false;

  kill = vi.fn((signal) => {
    this.killed = true;
    this.lastSignal = signal;
    return true;
  });
}

async function flushLaunch() {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SceneCart one-command development stack", () => {
  it("prefers an installed Node 22 without changing the global Node link", () => {
    const homebrewNode22 = "/opt/homebrew/opt/node@22/bin/node";
    expect(resolvePreferredNode22({
      nodeMajor: 25,
      environment: {},
      exists: (candidate) => candidate === homebrewNode22
    })).toBe(homebrewNode22);
    expect(resolvePreferredNode22({ nodeMajor: 22, environment: {}, exists: () => true })).toBe("");
  });

  it("allows an explicit Node 22 runtime path", () => {
    const configured = "/custom/node22/bin/node";
    expect(resolvePreferredNode22({
      nodeMajor: 25,
      environment: { SCENECART_NODE22_PATH: configured },
      exists: (candidate) => candidate === configured
    })).toBe(configured);
  });

  it("discovers executor settings written after the web process starts", () => {
    const resolved = resolveExecutorEnvironment(
      [
        "SCENECART_API_URL=http://127.0.0.1:3000",
        `SCENECART_DEVICE_TOKEN=${validFileToken}`,
        "TAOBAO_SOURCE_APP=SceneCartAI"
      ].join("\n"),
      {},
      "http://127.0.0.1:3001"
    );

    expect(resolved).toEqual({
      TAOBAO_EXECUTION_BACKEND: "local_executor",
      SCENECART_API_URL: "http://127.0.0.1:3001",
      SCENECART_DEVICE_TOKEN: validFileToken,
      TAOBAO_SOURCE_APP: "SceneCartAI"
    });
  });

  it("keeps explicit process secrets authoritative while binding the worker to the active web origin", () => {
    const resolved = resolveExecutorEnvironment(
      `SCENECART_DEVICE_TOKEN=${validFileToken}\nTAOBAO_SOURCE_APP=SceneCartAI\n`,
      {
        SCENECART_DEVICE_TOKEN: validShellToken,
        TAOBAO_SOURCE_APP: "SceneCartAI"
      },
      "http://127.0.0.1:3100"
    );

    expect(resolved.SCENECART_DEVICE_TOKEN).toBe(validShellToken);
    expect(resolved).not.toHaveProperty("QODERCLI_PATH");
    expect(resolved.SCENECART_API_URL).toBe("http://127.0.0.1:3100");
  });

  it("does not invent a device token before registration", () => {
    const resolved = resolveExecutorEnvironment("", {}, "http://127.0.0.1:3000");

    expect(resolved.SCENECART_DEVICE_TOKEN).toBe("");
    expect(resolved.TAOBAO_EXECUTION_BACKEND).toBe("local_executor");
  });
});

describe("local executor process supervisor", () => {
  it("uses capped 1/2/4 second exponential delays", () => {
    expect([1, 2, 3, 4].map(workerRestartDelay)).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(workerRestartDelay(100)).toBe(WORKER_RESTART_MAX_MS);
  });

  it("restarts a crashing token with exponential backoff and never overlaps children", async () => {
    vi.useFakeTimers();
    const children = [];
    const scheduled = [];
    const spawnWorker = vi.fn(async () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    const supervisor = createWorkerSupervisor({
      spawnWorker,
      onRestartScheduled: (event) => scheduled.push(event)
    });

    supervisor.reconcile({ token: validFileToken, env: { GENERATION: "1" } });
    await flushLaunch();
    children[0].emit("exit", 1, null);
    expect(scheduled.map(({ delay }) => delay)).toEqual([1_000]);
    expect(spawnWorker).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await flushLaunch();
    expect(spawnWorker).toHaveBeenCalledTimes(2);
    children[1].emit("exit", 1, null);
    expect(scheduled.map(({ delay }) => delay)).toEqual([1_000, 2_000]);

    await vi.advanceTimersByTimeAsync(2_000);
    await flushLaunch();
    children[2].emit("exit", 1, null);
    expect(scheduled.map(({ delay }) => delay)).toEqual([1_000, 2_000, 4_000]);
  });

  it("resets the failure backoff after a worker stays alive for 30 seconds", async () => {
    vi.useFakeTimers();
    let clock = 0;
    const children = [];
    const scheduled = [];
    const supervisor = createWorkerSupervisor({
      now: () => clock,
      spawnWorker: async () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      onRestartScheduled: (event) => scheduled.push(event)
    });

    supervisor.reconcile({ token: validFileToken, env: {} });
    await flushLaunch();
    children[0].emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushLaunch();

    clock = 30_000;
    children[1].emit("exit", 1, null);
    expect(scheduled.map(({ delay }) => delay)).toEqual([1_000, 1_000]);
  });

  it("restarts an unsolicited clean worker exit", async () => {
    vi.useFakeTimers();
    const children = [];
    const spawnWorker = vi.fn(async () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    const supervisor = createWorkerSupervisor({ spawnWorker });

    supervisor.reconcile({ token: validFileToken, env: {} });
    await flushLaunch();
    children[0].emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushLaunch();

    expect(spawnWorker).toHaveBeenCalledTimes(2);
  });

  it("waits for token A to exit before starting valid token B", async () => {
    const children = [];
    const launched = [];
    const supervisor = createWorkerSupervisor({
      spawnWorker: async (config) => {
        launched.push(config);
        const child = new FakeChild();
        children.push(child);
        return child;
      }
    });

    supervisor.reconcile({ token: validFileToken, env: { TOKEN_NAME: "A" } });
    await flushLaunch();
    supervisor.reconcile({ token: validShellToken, env: { TOKEN_NAME: "B" } });
    supervisor.reconcile({ token: validShellToken, env: { TOKEN_NAME: "B-latest" } });

    expect(children[0].kill).toHaveBeenCalledTimes(1);
    expect(children[0].kill).toHaveBeenCalledWith("SIGTERM");
    expect(launched).toHaveLength(1);

    children[0].emit("exit", null, "SIGTERM");
    await flushLaunch();
    expect(launched).toHaveLength(2);
    expect(launched[1]).toMatchObject({
      token: validShellToken,
      env: { TOKEN_NAME: "B-latest" }
    });
  });

  it("does not stop a healthy worker when a newly discovered token is invalid", async () => {
    const child = new FakeChild();
    const supervisor = createWorkerSupervisor({ spawnWorker: async () => child });
    supervisor.reconcile({ token: validFileToken, env: {} });
    await flushLaunch();

    const reconcileDiscoveredToken = (token) => {
      try {
        validateExecutorDeviceToken(token);
        supervisor.reconcile({ token, env: {} });
      } catch {
        // Mirrors dev-auto: invalid discoveries are reported but never reconciled.
      }
    };
    reconcileDiscoveredToken("invalid");

    expect(child.kill).not.toHaveBeenCalled();
    expect(supervisor.getState().childToken).toBe(validFileToken);
  });

  it("takes a fresh immutable environment snapshot for every child", async () => {
    const children = [];
    const launched = [];
    const supervisor = createWorkerSupervisor({
      spawnWorker: async (config) => {
        launched.push(config);
        const child = new FakeChild();
        children.push(child);
        return child;
      }
    });
    const firstEnv = { GENERATION: "A" };

    supervisor.reconcile({ token: validFileToken, env: firstEnv });
    firstEnv.GENERATION = "mutated";
    await flushLaunch();
    supervisor.reconcile({ token: validShellToken, env: { GENERATION: "B" } });
    children[0].emit("exit", null, "SIGTERM");
    await flushLaunch();

    expect(launched[0].env).toEqual({ GENERATION: "A" });
    expect(launched[1].env).toEqual({ GENERATION: "B" });
    expect(launched[0].env).not.toBe(launched[1].env);
  });

  it("cancels pending restarts and cannot resurrect after shutdown", async () => {
    vi.useFakeTimers();
    const children = [];
    const spawnWorker = vi.fn(async () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    const supervisor = createWorkerSupervisor({ spawnWorker });

    supervisor.reconcile({ token: validFileToken, env: {} });
    await flushLaunch();
    children[0].emit("exit", 1, null);
    supervisor.shutdown();
    await vi.runAllTimersAsync();
    await flushLaunch();

    expect(spawnWorker).toHaveBeenCalledTimes(1);
    expect(supervisor.getState()).toMatchObject({ stopped: true, restartScheduled: false });
  });

  it("terminates a child that arrives after shutdown during an async start", async () => {
    let releaseSpawn;
    const child = new FakeChild();
    const spawnWorker = vi.fn(() => new Promise((resolve) => {
      releaseSpawn = () => resolve(child);
    }));
    const supervisor = createWorkerSupervisor({ spawnWorker });

    supervisor.reconcile({ token: validFileToken, env: {} });
    supervisor.shutdown();
    releaseSpawn();
    await flushLaunch();

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(supervisor.getState().childToken).toBe("");
  });
});
