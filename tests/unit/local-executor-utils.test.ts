import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
// The local executor loads these helpers directly in native Node ESM.
// @ts-expect-error Runtime utility intentionally has no TypeScript declarations.
import * as executorUtils from "../../scripts/local-executor-utils.mjs";

const {
  buildUnavailableTaobaoMcpProductDetailEvidence,
  buildTaobaoMcpSearchEvidence,
  classifyTaobaoAuthentication,
  createPendingAuthenticationFailure,
  createPendingResultAcknowledgement,
  deliverPendingAuthenticationFailure,
  executorFailureDisposition,
  isTaobaoLoginError,
  normalizeTaobaoCartResult,
  normalizeTaobaoMcpProductDetailEvidence,
  normalizeTaobaoSearchEvidence,
  PendingAuthenticationFailureCoordinator,
  PendingAuthenticationFailureStore,
  PendingResultAcknowledgementCoordinator,
  PendingResultAcknowledgementStore,
  prepareTaobaoCartAction,
  taobaoCurrentTabUrl
} = executorUtils as {
  buildUnavailableTaobaoMcpProductDetailEvidence: (
    context: Record<string, unknown>,
    reason: string,
    toolsUsed?: string[]
  ) => Record<string, unknown>;
  buildTaobaoMcpSearchEvidence: (context: Record<string, unknown>) => Record<string, unknown>;
  classifyTaobaoAuthentication: (value: unknown) => "authenticated" | "authentication_required" | "unknown";
  createPendingAuthenticationFailure: (
    job: Record<string, unknown>,
    error: string,
    createdAt?: string
  ) => Record<string, unknown>;
  createPendingResultAcknowledgement: (
    job: Record<string, unknown>,
    result: Record<string, unknown>,
    createdAt?: string
  ) => Record<string, unknown>;
  deliverPendingAuthenticationFailure: (
    store: InstanceType<typeof PendingAuthenticationFailureStore>,
    report: (callback: Record<string, unknown>) => Promise<Record<string, unknown>>
  ) => Promise<{ state: "empty" | "pending" | "confirmed"; callback: Record<string, unknown> | null }>;
  executorFailureDisposition: (input: {
    authenticationRequired: boolean;
    leaseLost: boolean;
  }) => "persist_authentication_failure" | "abandon_lost_lease" | "report_failure";
  isTaobaoLoginError: (value: unknown) => boolean;
  normalizeTaobaoCartResult: (raw: unknown, productId: string) => Record<string, unknown>;
  normalizeTaobaoMcpProductDetailEvidence: (
    raw: unknown,
    context: Record<string, unknown>
  ) => Record<string, unknown>;
  normalizeTaobaoSearchEvidence: (
    raw: unknown,
    context: { keyword: string; moduleId: string }
  ) => { summary: string; candidates: Array<Record<string, unknown>>; evidence: Record<string, unknown> };
  prepareTaobaoCartAction: (
    raw: unknown,
    payload: Record<string, unknown>,
    productId: string
  ) => {
    action: "add_to_cart" | "sku_selection_required";
    arguments?: Record<string, unknown>;
    result?: Record<string, unknown>;
  };
  PendingAuthenticationFailureStore: new (filePath: string) => {
    load: () => Promise<Record<string, unknown> | null>;
    save: (callback: Record<string, unknown>) => Promise<Record<string, unknown>>;
    clear: (expectedJobId: string) => Promise<boolean>;
  };
  PendingAuthenticationFailureCoordinator: new (store: {
    load: () => Promise<Record<string, unknown> | null>;
    save: (callback: Record<string, unknown>) => Promise<Record<string, unknown>>;
    clear: (expectedJobId: string) => Promise<boolean>;
  }) => {
    hold: (callback: Record<string, unknown>) => Record<string, unknown>;
    current: () => Promise<Record<string, unknown> | null>;
    persistHeld: () => Promise<{ persisted: boolean; callback: Record<string, unknown> | null }>;
    deliver: (
      report: (callback: Record<string, unknown>) => Promise<Record<string, unknown>>
    ) => Promise<{ state: "empty" | "pending" | "confirmed" }>;
  };
  PendingResultAcknowledgementStore: new (filePath: string) => {
    load: () => Promise<Record<string, unknown> | null>;
    save: (callback: Record<string, unknown>) => Promise<Record<string, unknown>>;
    clear: (expectedJobId: string, expectedLeaseToken: string) => Promise<boolean>;
  };
  PendingResultAcknowledgementCoordinator: new (store: {
    load: () => Promise<Record<string, unknown> | null>;
    save: (callback: Record<string, unknown>) => Promise<Record<string, unknown>>;
    clear: (expectedJobId: string, expectedLeaseToken: string) => Promise<boolean>;
  }) => {
    restore: () => Promise<Record<string, unknown> | null>;
    hold: (callback: Record<string, unknown>) => Record<string, unknown>;
    current: () => Promise<Record<string, unknown> | null>;
    persistHeld: () => Promise<{ persisted: boolean; callback: Record<string, unknown> | null }>;
    deliver: (
      report: (callback: Record<string, unknown>) => Promise<Record<string, unknown>>,
      options?: {
        isDiscardableError?: (error: unknown) => boolean;
        isFatalError?: (error: unknown) => boolean;
      }
    ) => Promise<{
      state: "empty" | "pending" | "confirmed" | "discarded";
      callback: Record<string, unknown> | null;
      error?: string;
    }>;
  };
  taobaoCurrentTabUrl: (raw: unknown) => string;
};

describe("local executor evidence boundary", () => {
  const detailContext = {
    sourceApp: "SceneCartAI",
    jobId: "detail-job-1",
    searchJobId: "search-job-1",
    moduleId: "practical-interior",
    workflowRunId: "workflow-live",
    productId: "843402079981",
    detailUrl: "https://item.taobao.com/item.htm?id=843402079981",
    factTerms: ["稳固夹持", "旗舰店"],
    capturedAt: "2026-08-18T12:34:56.000Z"
  };

  it("normalizes only visible detail fields without claiming a SKU price", () => {
    expect(normalizeTaobaoMcpProductDetailEvidence({
      result: {
        title: "车载手机支架 - 淘宝网",
        url: detailContext.detailUrl,
        content: "测试旗舰店 稳固夹持 页面活动价 ￥73.80 另有配件 ¥9.9"
      }
    }, detailContext)).toMatchObject({
      schema: "scenecart.taobao-mcp-product-detail-evidence/v1",
      status: "verified",
      tools_used: ["navigate_to_url", "read_page_content"],
      summary: {
        page_title: "车载手机支架 - 淘宝网",
        page_url: detailContext.detailUrl,
        matched_facts: ["稳固夹持", "旗舰店"],
        displayed_price_texts: ["￥73.80", "¥9.9"]
      }
    });
    const serialized = JSON.stringify(normalizeTaobaoMcpProductDetailEvidence({
      result: {
        title: "车载手机支架 - 淘宝网",
        url: detailContext.detailUrl,
        content: "账号昵称 小明 北京市朝阳区 稳固夹持"
      }
    }, detailContext));
    expect(serialized).not.toContain("小明");
    expect(serialized).not.toContain("北京市朝阳区");
    expect(serialized).not.toContain("visible_text_excerpt");
    expect(serialized).toContain("visible_text_sha256");
  });

  it("records missing detail tools as unavailable without inventing fields", () => {
    expect(buildUnavailableTaobaoMcpProductDetailEvidence(
      detailContext,
      "缺少 read_page_content",
      ["navigate_to_url"]
    )).toMatchObject({
      status: "unavailable",
      tools_used: ["navigate_to_url"],
      unavailable_reason: "缺少 read_page_content"
    });
  });

  it("builds a job-bound proof for one live Taobao MCP search", () => {
    expect(buildTaobaoMcpSearchEvidence({
      sourceApp: "SceneCartAI",
      jobId: "job-live-12345678",
      moduleId: "practical-interior",
      workflowRunId: "workflow-live",
      keyword: "车载手机支架",
      capturedAt: "2026-08-11T12:34:56.000Z",
      rawResultCount: 48
    })).toEqual({
      schema: "scenecart.taobao-mcp-search-evidence/v1",
      source: "taobao-mcp",
      tool: "search_products",
      source_app: "SceneCartAI",
      job_id: "job-live-12345678",
      module_id: "practical-interior",
      workflow_run_id: "workflow-live",
      keyword: "车载手机支架",
      captured_at: "2026-08-11T12:34:56.000Z",
      cache_hit: false,
      raw_result_count: 48,
      transport: "http_mcp"
    });
    expect(buildTaobaoMcpSearchEvidence({
      sourceApp: "SceneCartAI",
      jobId: "job-cli-12345678",
      moduleId: "practical-interior",
      workflowRunId: "workflow-cli",
      keyword: "车载手机支架",
      capturedAt: "2026-08-11T12:35:56.000Z",
      rawResultCount: 48,
      transport: "native_cli"
    })).toMatchObject({ transport: "native_cli", tool: "search_products" });
  });

  it("normalizes only products contained in a Taobao evidence artifact", () => {
    const result = normalizeTaobaoSearchEvidence({
      result: {
        keyword: "车载手机支架",
        count: 2,
        products: [
          {
            itemId: "843402079981",
            title: "车载手机支架",
            price: "73.8",
            shopName: "示例旗舰店",
            image: "http://img.alicdn.com/item.jpg",
            productUrl: "https://item.taobao.com/item.htm?id=843402079981",
            shopTags: ["天猫"],
            sellingPoints: ["稳固"]
          },
          {
            itemId: "843402079981",
            title: "重复商品",
            price: "1"
          }
        ]
      }
    }, {
      keyword: "车载手机支架",
      moduleId: "practical-interior"
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      product_id: "843402079981",
      title: "车载手机支架",
      price: 73.8,
      source: "淘宝",
      shop_name: "示例旗舰店",
      image_url: "https://img.alicdn.com/item.jpg",
      module_id: "practical-interior"
    });
    expect(result.candidates[0].highlights).toEqual(expect.arrayContaining(["稳固", "旗舰店", "来自淘宝实时搜索"]));
    expect(result.evidence).toMatchObject({ source: "taobao-native", raw_result_count: 2 });
  });

  it("rejects model-shaped JSON when no Taobao product evidence exists", () => {
    expect(() => normalizeTaobaoSearchEvidence({
      summary: "模型自行声称搜索成功",
      candidates: [{ product_id: "fake" }]
    }, {
      keyword: "车载手机支架",
      moduleId: "practical-interior"
    })).toThrow("缺少 result.products");
  });

  it("classifies login failures and login-page URLs before account actions", () => {
    expect(isTaobaoLoginError('{"error":"未登录，已打开登录页面，请先登录淘宝账号"}')).toBe(true);
    expect(isTaobaoLoginError("network timeout")).toBe(false);
    expect(taobaoCurrentTabUrl({ result: { url: "https://login.taobao.com/login.htm" } })).toContain("login.taobao.com");
    expect(classifyTaobaoAuthentication({ result: { url: "https://login.taobao.com/login.htm" } }))
      .toBe("authentication_required");
    expect(classifyTaobaoAuthentication({ result: { url: "https://www.taobao.com/" } }))
      .toBe("authenticated");
    expect(classifyTaobaoAuthentication({ result: { url: "https://example.com/" } }))
      .toBe("unknown");
    expect(classifyTaobaoAuthentication({ success: false, message: "未登录，请先登录淘宝账号" }))
      .toBe("authentication_required");
  });

  it("persists an auth failure callback atomically and keeps it across Worker restarts", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scenecart-auth-callback-"));
    const callbackPath = path.join(directory, "pending-auth-failure.json");
    try {
      const firstWorker = new PendingAuthenticationFailureStore(callbackPath);
      const callback = createPendingAuthenticationFailure({
        id: "job-auth-search",
        job_type: "module_search",
        lease_token: "lease-token-search-123456"
      }, "[auth_required] 淘宝未登录，请先登录淘宝账号", "2026-08-11T12:34:56.000Z");
      await firstWorker.save(callback);

      const restartedWorker = new PendingAuthenticationFailureStore(callbackPath);
      await expect(restartedWorker.load()).resolves.toEqual(callback);
      await expect(fs.stat(callbackPath)).resolves.toMatchObject({ mode: expect.any(Number) });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("restores the local WAL when the remote auth hold hangs before responding", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scenecart-auth-hung-hold-"));
    const callbackPath = path.join(directory, "pending-auth-failure.json");
    try {
      const callback = createPendingAuthenticationFailure({
        id: "job-auth-hung-server",
        job_type: "module_search",
        lease_token: "lease-token-hung-server-123"
      }, "[auth_required] 淘宝未登录，请先登录淘宝账号");
      const firstWorker = new PendingAuthenticationFailureCoordinator(
        new PendingAuthenticationFailureStore(callbackPath)
      );
      firstWorker.hold(callback);
      await expect(firstWorker.persistHeld()).resolves.toMatchObject({ persisted: true });

      // Model kill -9 while the subsequent HTTP hold request is still pending:
      // no response/cleanup runs, but a fresh Worker must restore the WAL.
      const restartedWorker = new PendingAuthenticationFailureCoordinator(
        new PendingAuthenticationFailureStore(callbackPath)
      );
      await expect(restartedWorker.current()).resolves.toEqual(callback);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("does not clear or replay an auth-failed action until the server confirms failed", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scenecart-auth-retry-"));
    const callbackPath = path.join(directory, "pending-auth-failure.json");
    let resolveAttempts = 0;
    const taobaoToolCalls = 0;
    try {
      const originalWorker = new PendingAuthenticationFailureStore(callbackPath);
      await originalWorker.save(createPendingAuthenticationFailure({
        id: "job-auth-cart",
        job_type: "add_to_cart",
        lease_token: "lease-token-cart-12345678"
      }, "[auth_required] 淘宝未登录，请先登录淘宝账号"));

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const outcome = await deliverPendingAuthenticationFailure(originalWorker, async () => {
          resolveAttempts += 1;
          throw new Error("resolve API unavailable");
        });
        expect(outcome.state).toBe("pending");
        expect(await originalWorker.load()).not.toBeNull();
      }

      // A fresh store models a process restart. Callback delivery is the only
      // permitted operation; neither search_products nor add_to_cart is called.
      const restartedWorker = new PendingAuthenticationFailureStore(callbackPath);
      const outcome = await deliverPendingAuthenticationFailure(restartedWorker, async (pending) => {
        resolveAttempts += 1;
        return {
          job: { id: pending.job_id, status: "failed" }
        };
      });
      expect(outcome.state).toBe("confirmed");
      expect(resolveAttempts).toBe(4);
      expect(taobaoToolCalls).toBe(0);
      expect(await restartedWorker.load()).toBeNull();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("persists a successful result callback and retries only its acknowledgement after restart", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scenecart-result-ack-"));
    const callbackPath = path.join(directory, "pending-result-acknowledgement.json");
    const callback = createPendingResultAcknowledgement({
      id: "job-result-search",
      job_type: "module_search",
      lease_token: "lease-token-result-search-123"
    }, {
      summary: "real Taobao result",
      candidates: []
    }, "2026-08-19T01:23:45.000Z");
    const externalActionCalls = 1;
    let acknowledgementCalls = 0;
    try {
      const firstWorker = new PendingResultAcknowledgementCoordinator(
        new PendingResultAcknowledgementStore(callbackPath)
      );
      firstWorker.hold(callback);
      await expect(firstWorker.persistHeld()).resolves.toMatchObject({ persisted: true });
      expect((await fs.stat(callbackPath)).mode & 0o777).toBe(0o600);
      const unavailable = await firstWorker.deliver(async () => {
        acknowledgementCalls += 1;
        throw new Error("resolve API unavailable");
      });
      expect(unavailable.state).toBe("pending");

      const restartedWorker = new PendingResultAcknowledgementCoordinator(
        new PendingResultAcknowledgementStore(callbackPath)
      );
      await expect(restartedWorker.restore()).resolves.toEqual(callback);
      const confirmed = await restartedWorker.deliver(async (pending) => {
        acknowledgementCalls += 1;
        return { job: { id: pending.job_id, status: "completed" } };
      });
      expect(confirmed.state).toBe("confirmed");
      expect(acknowledgementCalls).toBe(2);
      expect(externalActionCalls).toBe(1);
      await expect(restartedWorker.current()).resolves.toBeNull();
      await expect(fs.stat(callbackPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("discards only an explicitly stale result callback and keeps fatal callbacks durable", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scenecart-result-disposition-"));
    const callbackPath = path.join(directory, "pending-result-acknowledgement.json");
    const callback = createPendingResultAcknowledgement({
      id: "job-result-detail",
      job_type: "product_detail",
      lease_token: "lease-token-result-detail-123"
    }, { detail_evidence: { status: "verified" } });
    try {
      const staleWorker = new PendingResultAcknowledgementCoordinator(
        new PendingResultAcknowledgementStore(callbackPath)
      );
      staleWorker.hold(callback);
      const staleError = Object.assign(new Error("superseded"), {
        status: 409,
        code: "job_superseded"
      });
      const discarded = await staleWorker.deliver(async () => {
        throw staleError;
      }, {
        isDiscardableError: (error) => error === staleError
      });
      expect(discarded.state).toBe("discarded");
      await expect(staleWorker.current()).resolves.toBeNull();

      const fatalWorker = new PendingResultAcknowledgementCoordinator(
        new PendingResultAcknowledgementStore(callbackPath)
      );
      fatalWorker.hold(callback);
      const fatalError = Object.assign(new Error("invalid token"), { status: 401 });
      await expect(fatalWorker.deliver(async () => {
        throw fatalError;
      }, {
        isFatalError: (error) => error === fatalError
      })).rejects.toBe(fatalError);
      await expect(fatalWorker.current()).resolves.toEqual(callback);
      await expect(new PendingResultAcknowledgementStore(callbackPath).load())
        .resolves.toEqual(callback);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("persists authentication failure even when lease loss is observed at the same time", () => {
    expect(executorFailureDisposition({
      authenticationRequired: true,
      leaseLost: true
    })).toBe("persist_authentication_failure");
    expect(executorFailureDisposition({
      authenticationRequired: false,
      leaseLost: true
    })).toBe("abandon_lost_lease");
  });

  it("flushes a restored auth callback before Taobao startup tool discovery", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "scripts", "local-executor.mjs"),
      "utf8"
    );
    const verifyStart = source.indexOf("async function verifyStartup()");
    const callbackFlush = source.indexOf("await flushPendingAuthenticationFailure()", verifyStart);
    const taobaoToolDiscovery = source.indexOf("await taobaoClient.listTools(", verifyStart);
    expect(verifyStart).toBeGreaterThanOrEqual(0);
    expect(callbackFlush).toBeGreaterThan(verifyStart);
    expect(taobaoToolDiscovery).toBeGreaterThan(callbackFlush);
    expect(source).toContain("automatic replay is forbidden");
    expect(source).toContain("retrying without repeating the Taobao action");
  });

  it("stays fail-closed in memory when the auth callback ledger cannot be written", async () => {
    const callback = createPendingAuthenticationFailure({
      id: "job-auth-memory-only",
      job_type: "module_search",
      lease_token: "lease-token-memory-only-123"
    }, "[auth_required] 淘宝未登录，请先登录淘宝账号");
    const store = {
      load: async () => null,
      save: async () => {
        throw new Error("disk unavailable");
      },
      clear: async () => false
    };
    const coordinator = new PendingAuthenticationFailureCoordinator(store);
    coordinator.hold(callback);
    await expect(coordinator.persistHeld()).resolves.toMatchObject({ persisted: false });

    const first = await coordinator.deliver(async () => {
      throw new Error("resolve unavailable");
    });
    expect(first.state).toBe("pending");
    await expect(coordinator.current()).resolves.toEqual(callback);

    const second = await coordinator.deliver(async (pending) => ({
      job: { id: pending.job_id, status: "pending" },
      authentication_failure_acknowledged: true
    }));
    expect(second.state).toBe("confirmed");
    await expect(coordinator.current()).resolves.toBeNull();
  });

  it("writes the local auth WAL before awaiting the server hold or detaching the lease", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "scripts", "local-executor.mjs"),
      "utf8"
    );
    const authBranch = source.indexOf(
      'if (failureDisposition === "persist_authentication_failure")'
    );
    const heldCallback = source.indexOf("pendingAuthFailureCoordinator.hold(", authBranch);
    const localLedger = source.indexOf("pendingAuthFailureCoordinator.persistHeld()", heldCallback);
    const serverHold = source.indexOf("authenticationFailure: callback", localLedger);
    const leaseDetached = source.indexOf("leaseGuard.clear(job.id)", serverHold);
    expect(authBranch).toBeGreaterThanOrEqual(0);
    expect(heldCallback).toBeGreaterThan(authBranch);
    expect(localLedger).toBeGreaterThan(heldCallback);
    expect(serverHold).toBeGreaterThan(localLedger);
    expect(leaseDetached).toBeGreaterThan(serverHold);
    expect(source).toContain("if (authenticationRequired && !authenticationDurabilityEstablished)");
    expect(source).toContain("authentication_recovery_verified: true");
  });

  it("accepts confirmed cart results without an agent-generated success claim", () => {
    expect(normalizeTaobaoCartResult({ result: {
      success: true,
      message: "加购成功",
      selectedSku: ["黑色", "标准版"]
    } }, "product-1")).toEqual({
      success: true,
      message: "加购成功",
      product_id: "product-1",
      selected_spec: "黑色 / 标准版"
    });
  });

  it("stops for explicit SKU selection instead of choosing a random variant", () => {
    expect(normalizeTaobaoCartResult({
      needsSkuSelection: true,
      availableSkus: [{ groupLabel: "颜色" }, { groupLabel: "版本" }]
    }, "product-2")).toMatchObject({
      success: false,
      product_id: "product-2",
      needs_sku_selection: true,
      message: "商品需要先选择规格：颜色、版本"
    });
  });

  it("allows cart mutation without a sku only when Taobao explicitly reports no sku", () => {
    expect(prepareTaobaoCartAction({
      success: true,
      hasSku: false,
      allSelected: false,
      availableSkus: []
    }, {}, "product-no-sku")).toEqual({
      action: "add_to_cart",
      arguments: { itemId: "product-no-sku" }
    });
  });

  it("allows cart mutation without a sku when Taobao reports all dimensions selected", () => {
    expect(prepareTaobaoCartAction({
      result: {
        success: true,
        hasSku: true,
        allSelected: true,
        availableSkus: [{ label: "颜色", options: [{ text: "黑色" }] }]
      }
    }, {}, "product-selected")).toEqual({
      action: "add_to_cart",
      arguments: { itemId: "product-selected" }
    });
  });

  it("returns structured evidence and never guesses when a multi-sku task has no user selection", () => {
    const groups = [
      { label: "颜色", options: [{ text: "黑色" }, { text: "白色" }] },
      { label: "尺码", options: [{ text: "M" }, { text: "L" }] }
    ];
    expect(prepareTaobaoCartAction({
      success: true,
      hasSku: true,
      allSelected: false,
      availableSkus: groups
    }, {
      confirmed: true
    }, "product-needs-sku")).toEqual({
      action: "sku_selection_required",
      result: {
        success: false,
        code: "sku_selection_required",
        error_code: "sku_selection_required",
        message: "商品需要先选择规格：颜色、尺码",
        product_id: "product-needs-sku",
        needsSkuSelection: true,
        needs_sku_selection: true,
        availableSkus: groups,
        available_skus: groups,
        retryable: false
      }
    });
  });

  it("passes only a complete enabled user sku selection to add_to_cart", () => {
    expect(prepareTaobaoCartAction({
      success: true,
      hasSku: true,
      availableSkus: [
        { groupLabel: "颜色", options: [{ text: "黑色" }, { text: "白色" }] },
        { groupLabel: "版本", options: [{ text: "标准版" }, { text: "升级版" }] }
      ]
    }, {
      sku: ["白色", "升级版"]
    }, "product-explicit-sku")).toEqual({
      action: "add_to_cart",
      arguments: {
        itemId: "product-explicit-sku",
        sku: ["白色", "升级版"]
      }
    });
  });

  it("rejects incomplete, unknown, or disabled user sku values", () => {
    const skuResult = {
      success: true,
      hasSku: true,
      availableSkus: [
        { label: "颜色", options: [{ text: "黑色" }, { text: "白色", disabled: true }] },
        { label: "尺码", options: [{ text: "M" }, { text: "L" }] }
      ]
    };

    expect(prepareTaobaoCartAction(skuResult, { sku: ["黑色"] }, "product-1").result).toMatchObject({
      code: "sku_selection_required",
      needsSkuSelection: true,
      retryable: false
    });
    expect(prepareTaobaoCartAction(skuResult, { sku: ["红色", "M"] }, "product-1").result).toMatchObject({
      code: "sku_selection_required",
      message: expect.stringContaining("不在淘宝返回的可选项中")
    });
    expect(prepareTaobaoCartAction(skuResult, { sku: ["白色", "M"] }, "product-1").result).toMatchObject({
      code: "sku_selection_required",
      message: expect.stringContaining("当前无货")
    });
  });

  it("fails closed when get_product_skus omits authoritative sku state", () => {
    expect(() => prepareTaobaoCartAction({ success: true }, {}, "product-unknown"))
      .toThrow("缺少 hasSku/allSelected 证据");
  });
});
