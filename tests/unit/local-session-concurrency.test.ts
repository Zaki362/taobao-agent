import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addToCart } from "@/lib/agent/orchestrator";
import { localRuntimeRepository, resetLocalRuntimeForTests } from "@/lib/runtime/local-repository";
import type { ProductCandidate } from "@/lib/session/types";
import { createSessionFixture } from "@/tests/fixtures/session";

const sessionFiles = new Set<string>();

function candidate(moduleId: string, productId: string, title: string, price: number): ProductCandidate {
  return {
    product_id: productId,
    title,
    price,
    source: "淘宝本地执行器测试",
    shop_name: "本地并发测试旗舰店",
    image_url: `https://example.com/${productId}.jpg`,
    detail_url: `https://item.taobao.com/item.htm?id=${productId}`,
    shop_badges: ["旗舰店"],
    highlights: ["本地并发测试"],
    risk_notes: ["测试数据"],
    fit_reason: "用于验证本地 Session 不丢失并发加购任务。",
    recommendation_type: "稳妥推荐",
    module_id: moduleId
  };
}

describe("local session write serialization", () => {
  beforeEach(() => {
    resetLocalRuntimeForTests();
  });

  afterEach(async () => {
    await Promise.all([...sessionFiles].map((sessionId) =>
      fs.unlink(path.join(process.cwd(), ".data", "sessions", `${sessionId}.json`)).catch(() => undefined)
    ));
    sessionFiles.clear();
    resetLocalRuntimeForTests();
  });

  it("keeps both durable cart tasks when requests arrive concurrently", async () => {
    const sessionId = `session-local-cart-${randomUUID()}`;
    sessionFiles.add(sessionId);
    const state = createSessionFixture({ session_id: sessionId });
    const module = state.shopping_plan.modules[0];
    state.module_candidates[module.module_id] = [
      candidate(module.module_id, "local-cart-a", "本地并发加购商品 A", 89),
      candidate(module.module_id, "local-cart-b", "本地并发加购商品 B", 109)
    ];
    await localRuntimeRepository.saveSession(state);

    await Promise.all([
      addToCart(sessionId, "local-cart-a", state.owner_id),
      addToCart(sessionId, "local-cart-b", state.owner_id)
    ]);

    const restored = await localRuntimeRepository.getSession(sessionId, state.owner_id);
    const cartTasks = restored?.hosted_tasks.filter((task) => task.task_type === "add_to_cart") ?? [];
    expect(new Set(cartTasks.map((task) => task.product_id))).toEqual(
      new Set(["local-cart-a", "local-cart-b"])
    );
    expect(cartTasks.every((task) => task.status === "pending" && Boolean(task.runtime_job_id))).toBe(true);

    const jobs = await localRuntimeRepository.listJobs(sessionId, state.owner_id);
    expect(new Set(jobs.filter((job) => job.job_type === "add_to_cart").map((job) => job.payload.product_id)))
      .toEqual(new Set(["local-cart-a", "local-cart-b"]));
  });

  it("returns isolated snapshots so dashboard reads cannot mutate an active workflow", async () => {
    const sessionId = `session-local-read-${randomUUID()}`;
    sessionFiles.add(sessionId);
    const state = createSessionFixture({ session_id: sessionId });
    await localRuntimeRepository.saveSession(state);

    const firstRead = await localRuntimeRepository.getSession(sessionId, state.owner_id);
    const secondRead = await localRuntimeRepository.getSession(sessionId, state.owner_id);
    expect(firstRead).not.toBe(secondRead);

    firstRead!.agent_runtime.workflow_status = "completed";
    firstRead!.agent_runtime.workflow_message = "只修改调用方快照";
    firstRead!.module_candidates[state.shopping_plan.modules[0].module_id] = [
      candidate(state.shopping_plan.modules[0].module_id, "isolated-candidate", "隔离候选", 99)
    ];

    const stored = await localRuntimeRepository.getSession(sessionId, state.owner_id);
    expect(stored?.agent_runtime.workflow_status).toBe("idle");
    expect(stored?.module_candidates[state.shopping_plan.modules[0].module_id]).toBeUndefined();
  });
});
