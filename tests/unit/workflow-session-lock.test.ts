import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  withWorkflowSessionLock,
  withWorkflowSessionTransaction
} from "@/lib/runtime/database";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("local workflow session lock", () => {
  it("serializes waiting session transactions", async () => {
    const sessionId = `local-lock-${randomUUID()}`;
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const order: string[] = [];

    const first = withWorkflowSessionTransaction(sessionId, async () => {
      order.push("first-entered");
      firstEntered.resolve();
      await releaseFirst.promise;
      order.push("first-released");
      return "first";
    });
    await firstEntered.promise;

    const second = withWorkflowSessionTransaction(sessionId, async () => {
      order.push("second-entered");
      return "second";
    });
    await Promise.resolve();
    expect(order).toEqual(["first-entered"]);

    releaseFirst.resolve();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(order).toEqual(["first-entered", "first-released", "second-entered"]);
  });

  it("keeps the workflow advance lock non-blocking while a transaction owns the session", async () => {
    const sessionId = `local-lock-${randomUUID()}`;
    const entered = deferred();
    const release = deferred();
    const owner = withWorkflowSessionTransaction(sessionId, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;

    const competing = await withWorkflowSessionLock(sessionId, async () => "should-not-run");
    expect(competing).toEqual({ acquired: false });

    release.resolve();
    await owner;
    await expect(withWorkflowSessionLock(sessionId, async () => "after-release"))
      .resolves.toEqual({ acquired: true, value: "after-release" });
  });

  it("allows reentrant operations for the same session", async () => {
    const sessionId = `local-lock-${randomUUID()}`;
    await expect(withWorkflowSessionTransaction(sessionId, async () => {
      const nestedTransaction = await withWorkflowSessionTransaction(sessionId, async () => "nested");
      const nestedTryLock = await withWorkflowSessionLock(sessionId, async () => "try-lock");
      return { nestedTransaction, nestedTryLock };
    })).resolves.toEqual({
      nestedTransaction: "nested",
      nestedTryLock: { acquired: true, value: "try-lock" }
    });
  });

  it("removes a timed-out waiter without blocking later work", async () => {
    const sessionId = `local-lock-${randomUUID()}`;
    const entered = deferred();
    const release = deferred();
    const owner = withWorkflowSessionTransaction(sessionId, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;

    await expect(withWorkflowSessionTransaction(sessionId, async () => "late", 20))
      .rejects.toThrow("workflow session lock timed out");
    release.resolve();
    await owner;

    await expect(withWorkflowSessionTransaction(sessionId, async () => "recovered"))
      .resolves.toBe("recovered");
  });
});
