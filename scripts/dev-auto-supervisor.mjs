export const WORKER_RESTART_BASE_MS = 1_000;
export const WORKER_RESTART_MAX_MS = 30_000;
export const WORKER_STABLE_WINDOW_MS = 30_000;

export function workerRestartDelay(failureCount) {
  const exponent = Math.max(0, Number(failureCount || 1) - 1);
  return Math.min(WORKER_RESTART_BASE_MS * (2 ** exponent), WORKER_RESTART_MAX_MS);
}

function snapshotConfig(config) {
  return {
    token: config.token,
    env: { ...config.env }
  };
}

/**
 * Supervises exactly one local executor process. The injected process factory
 * keeps the lifecycle deterministic in unit tests and lets the caller perform
 * asynchronous readiness checks before spawning.
 */
export function createWorkerSupervisor({
  spawnWorker,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onRestartScheduled = () => {},
  onWorkerExit = () => {},
  onSpawnError = () => {},
  onChildSpawn = () => {},
  onChildExit = () => {}
}) {
  let stopped = false;
  let child = null;
  let childToken = "";
  let childStartedAt = 0;
  let childStopRequested = false;
  let starting = false;
  let restartTimer = null;
  let restartFailures = 0;
  let pendingConfig = null;
  let activeConfig = null;

  function clearRestartTimer() {
    if (restartTimer !== null) clearTimer(restartTimer);
    restartTimer = null;
  }

  function scheduleRestart(config) {
    if (stopped || child || starting || restartTimer !== null || !config?.token) return;
    pendingConfig = snapshotConfig(config);
    const attempt = restartFailures + 1;
    const delay = workerRestartDelay(attempt);
    restartFailures = attempt;
    onRestartScheduled({ attempt, delay, token: config.token });
    restartTimer = setTimer(() => {
      restartTimer = null;
      const nextConfig = pendingConfig;
      pendingConfig = null;
      void launch(nextConfig);
    }, delay);
  }

  function handleExit(exitedChild, code, signal) {
    onChildExit(exitedChild);
    if (child !== exitedChild) return;

    const exitedConfig = activeConfig;
    const runtime = now() - childStartedAt;
    child = null;
    childToken = "";
    activeConfig = null;
    childStopRequested = false;

    if (stopped) return;
    if (runtime >= WORKER_STABLE_WINDOW_MS) restartFailures = 0;

    const requestedConfig = pendingConfig;
    pendingConfig = null;
    if (requestedConfig && requestedConfig.token !== exitedConfig?.token) {
      restartFailures = 0;
      void launch(requestedConfig);
      return;
    }

    onWorkerExit({ code, signal, runtime, token: exitedConfig?.token ?? "" });
    // A managed Worker should remain alive for the lifetime of `npm run dev`.
    // Even a clean, unsolicited exit is restarted; coordinated shutdown is
    // already guarded by `stopped`, and token rotation is handled above.
    if (exitedConfig) scheduleRestart(requestedConfig ?? exitedConfig);
  }

  async function launch(config) {
    if (stopped || child || starting || !config?.token) return;
    starting = true;
    const launchConfig = snapshotConfig(config);
    try {
      const spawnedChild = await spawnWorker(launchConfig);
      if (stopped) {
        if (spawnedChild && !spawnedChild.killed) spawnedChild.kill("SIGTERM");
        return;
      }
      if (!spawnedChild) throw new Error("Worker process factory returned no child process.");

      child = spawnedChild;
      childToken = launchConfig.token;
      activeConfig = launchConfig;
      childStartedAt = now();
      childStopRequested = false;
      onChildSpawn(spawnedChild);
      spawnedChild.once("exit", (code, signal) => handleExit(spawnedChild, code, signal));

      if (pendingConfig && pendingConfig.token !== childToken && !childStopRequested) {
        childStopRequested = true;
        spawnedChild.kill("SIGTERM");
      } else if (pendingConfig?.token === childToken) {
        pendingConfig = null;
      }
    } catch (error) {
      if (!stopped) {
        onSpawnError(error);
        pendingConfig = snapshotConfig(pendingConfig ?? launchConfig);
      }
    } finally {
      starting = false;
      // scheduleRestart is intentionally retried here because a synchronous
      // spawn failure occurs while `starting` is still true.
      if (!stopped && !child && restartTimer === null && pendingConfig) {
        scheduleRestart(pendingConfig);
      }
    }
  }

  function reconcile(config) {
    if (stopped || !config?.token) return;
    const nextConfig = snapshotConfig(config);

    if (child) {
      if (nextConfig.token === childToken) return;
      pendingConfig = nextConfig;
      if (!childStopRequested) {
        childStopRequested = true;
        child.kill("SIGTERM");
      }
      return;
    }

    if (starting) {
      pendingConfig = nextConfig;
      return;
    }

    if (restartTimer !== null) {
      if (pendingConfig?.token === nextConfig.token) {
        pendingConfig = nextConfig;
        return;
      }
      clearRestartTimer();
      restartFailures = 0;
      pendingConfig = null;
    }

    void launch(nextConfig);
  }

  function shutdown() {
    if (stopped) return;
    stopped = true;
    pendingConfig = null;
    clearRestartTimer();
    if (child && !childStopRequested && !child.killed) {
      childStopRequested = true;
      child.kill("SIGTERM");
    }
  }

  return {
    reconcile,
    shutdown,
    getState() {
      return {
        stopped,
        starting,
        childToken,
        pendingToken: pendingConfig?.token ?? "",
        restartFailures,
        restartScheduled: restartTimer !== null
      };
    }
  };
}
