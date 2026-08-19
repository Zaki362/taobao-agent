import { describe, expect, it, vi } from "vitest";
// The production worker imports this native ESM module directly from Node.
// @ts-expect-error The runtime module intentionally has no TypeScript build step.
import { ExecutorLeaseGuard } from "../../scripts/executor-lease-guard.mjs";

describe("local executor lease guard", () => {
  it("resets transient heartbeat failures after a successful renewal", () => {
    const controller = new AbortController();
    const guard = new ExecutorLeaseGuard({ failureLimit: 3 });
    guard.start("job-1", "lease-1", controller);
    guard.rejectHeartbeat("job-1", "lease-1");
    guard.rejectHeartbeat("job-1", "lease-1");
    guard.acceptHeartbeat("job-1", "lease-1", true);
    guard.rejectHeartbeat("job-1", "lease-1");

    expect(controller.signal.aborted).toBe(false);
    expect(guard.failureCount).toBe(1);
    expect(guard.lossReason).toBeNull();
  });

  it("aborts immediately when the server rejects lease renewal", () => {
    const controller = new AbortController();
    const onLeaseLost = vi.fn();
    const guard = new ExecutorLeaseGuard({ failureLimit: 3, onLeaseLost });
    guard.start("job-2", "lease-2", controller);
    guard.acceptHeartbeat("job-2", "lease-2", false);

    expect(controller.signal.aborted).toBe(true);
    expect(guard.lossReason).toBe("server rejected lease renewal");
    expect(onLeaseLost).toHaveBeenCalledWith({
      jobId: "job-2",
      reason: "server rejected lease renewal"
    });
  });

  it("fails closed after the configured number of consecutive heartbeat failures", () => {
    const controller = new AbortController();
    const guard = new ExecutorLeaseGuard({ failureLimit: 2 });
    guard.start("job-3", "lease-3", controller);
    guard.rejectHeartbeat("job-3", "lease-3");
    expect(controller.signal.aborted).toBe(false);
    guard.rejectHeartbeat("job-3", "lease-3");

    expect(controller.signal.aborted).toBe(true);
    expect(guard.lossReason).toBe("2 consecutive heartbeat failures");
  });

  it("ignores a delayed heartbeat response from a previous job", () => {
    const first = new AbortController();
    const second = new AbortController();
    const guard = new ExecutorLeaseGuard({ failureLimit: 1 });
    guard.start("job-old", "lease-old", first);
    guard.clear("job-old");
    guard.start("job-new", "lease-new", second);
    guard.acceptHeartbeat("job-old", "lease-old", false);
    guard.rejectHeartbeat("job-old", "lease-old");

    expect(first.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(false);
    expect(guard.currentJobId).toBe("job-new");
  });

  it("aborts the current operation when the worker is stopping", () => {
    const controller = new AbortController();
    const guard = new ExecutorLeaseGuard();
    guard.start("job-4", "lease-4", controller);
    guard.stop("worker received SIGTERM");

    expect(controller.signal.aborted).toBe(true);
    expect(guard.lossReason).toBe("worker received SIGTERM");
  });

  it("ignores a delayed heartbeat from an earlier lease generation of the same job", () => {
    const current = new AbortController();
    const guard = new ExecutorLeaseGuard({ failureLimit: 1 });
    guard.start("job-same", "lease-old");
    guard.clear("job-same");
    guard.start("job-same", "lease-current", current);

    guard.acceptHeartbeat("job-same", "lease-old", false);
    guard.rejectHeartbeat("job-same", "lease-old");

    expect(current.signal.aborted).toBe(false);
    expect(guard.currentLeaseToken).toBe("lease-current");
  });

  it("requires a lease token before starting a v4 operation", () => {
    const guard = new ExecutorLeaseGuard();
    expect(() => guard.start("job-no-token", "")).toThrow("executor lease token is required");
    expect(guard.currentJobId).toBeNull();
  });
});
