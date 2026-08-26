import { expect, test, type Page } from "@playwright/test";
import { getScenarioConfig } from "../../lib/scenarios";
import type { ScenarioId } from "../../lib/session/types";

async function enterResultsManually(page: Page) {
  await page.locator('[data-demo-target="scene:example:new-car:0"]').click();
  await expect(page.getByRole("textbox", { name: "描述你的购物场景" })).toHaveValue(
    getScenarioConfig("new-car").example_prompts[0]
  );
  await page.locator('[data-demo-target="scene:start"]').click();
  await expect(page.getByRole("heading", { name: "确认新车选购需求" })).toBeVisible();
  await page.locator('[data-demo-target="scene:budget"]').fill("1000");
  await page.locator('[data-demo-target="scene:confirm"]').click();
  await expect(page.getByRole("heading", { name: "确认新车购物规划" })).toBeVisible();
  await page.locator('[data-demo-target="plan:confirm"]').click();
  await expect(page.getByText("Agent 正在行动", { exact: true })).toBeVisible();
  await expect(page.locator('[data-demo-target="search:view-results"]')).toBeEnabled();
  await page.locator('[data-demo-target="search:view-results"]').click();
  await expect(page.getByRole("heading", { name: "我的购物清单" })).toBeVisible();
}

test("public demo reuses the real product flow and keeps every action local", async ({ page }) => {
  await page.setViewportSize({ width: 1470, height: 900 });
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/api/")) apiRequests.push(pathname);
  });

  await page.goto("/demo?demoSpeed=fast");
  await expect(page.getByRole("heading", { name: "把一句需求，变成买得明白的方案" })).toBeVisible();
  await expect(page.locator(".public-demo-disclosure")).toHaveCount(0);
  await enterResultsManually(page);

  await expect(page.getByText("为什么推荐它", { exact: true })).toBeVisible();
  await expect(page.locator(".product-primary-recommendation")).toHaveCount(1);
  await expect(page.getByText("还没有加入商品", { exact: true })).toBeVisible();
  await expect(page.getByText("改选这个", { exact: true })).toHaveCount(0);
  await expect(page.getByText("加入体验清单", { exact: true })).toHaveCount(0);
  await expect(page.getByText("生成决策清单", { exact: true })).toHaveCount(0);

  const desktopGeometry = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".workflow-content")!.getBoundingClientRect();
    const workspace = document.querySelector<HTMLElement>(".results-workspace")!.getBoundingClientRect();
    const results = document.querySelector<HTMLElement>('[aria-label="淘宝搜索结果"]')!.getBoundingClientRect();
    const sidebar = document.querySelector<HTMLElement>(".results-cart-sidebar")!.getBoundingClientRect();
    return {
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      content: [content.x, content.width],
      workspace: [workspace.x, workspace.width],
      results: [results.x, results.width],
      sidebar: [sidebar.x, sidebar.width]
    };
  });
  expect(desktopGeometry).toEqual({
    viewport: 1470,
    scrollWidth: 1470,
    content: [35, 1400],
    workspace: [35, 1400],
    results: [35, 1104],
    sidebar: [1155, 280]
  });

  await page.locator('[data-demo-target="results:module:practical-interior"]').click();
  await page.locator('[data-demo-target="results:alternatives"]').click();
  await expect(page.locator("article.product-result-card")).toHaveCount(3);
  const addButton = page.locator('[data-demo-target="results:add:966069280059"]');
  await addButton.click();
  await expect(addButton).toContainText("演示清单");
  await expect(page.getByText(/另有 1 件仅在演示清单中/)).toBeVisible();

  await page.locator('[data-demo-target="results:view-cart"]').click();
  await expect(page.getByRole("heading", { name: "购物清单共 1 件" })).toBeVisible();
  await expect(page.getByText("演示清单", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "当前仅有演示清单" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "从演示清单移除" })).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "从演示清单移除" }).click();
  await expect(page.getByText("当前还没有待处理商品", { exact: true })).toBeVisible();
  expect(apiRequests).toEqual([]);
});

test("every visible product scenario completes through the same frozen product flow", async ({ page }) => {
  const scenarioIds: Exclude<ScenarioId, "new-car">[] = [
    "camping",
    "room-decor",
    "dorm-move-in",
    "moving-setup"
  ];
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/api/")) apiRequests.push(pathname);
  });
  await page.addInitScript(() => {
    (window as unknown as { __openedProductUrls: string[] }).__openedProductUrls = [];
    window.open = ((url?: string | URL) => {
      (window as unknown as { __openedProductUrls: string[] }).__openedProductUrls.push(String(url ?? ""));
      return null;
    }) as typeof window.open;
  });

  for (const scenarioId of scenarioIds) {
    const scenario = getScenarioConfig(scenarioId);
    await page.goto("/demo?demoSpeed=fast");
    await page.getByRole("button", {
      name: `${scenario.name} ${scenario.short_description}`,
      exact: true
    }).click();
    await page.locator(`[data-demo-target="scene:example:${scenarioId}:0"]`).click();
    await expect(page.getByRole("textbox", { name: "描述你的购物场景" })).toHaveValue(
      scenario.example_prompts[0]
    );
    await page.locator('[data-demo-target="scene:start"]').click();
    await expect(page.getByRole("heading", { name: scenario.confirm_scene_title })).toBeVisible();
    await page.locator('[data-demo-target="scene:confirm"]').click();
    await expect(page.getByRole("heading", { name: scenario.confirm_plan_title })).toBeVisible();
    await page.locator('[data-demo-target="plan:confirm"]').click();
    await expect(page.locator('[data-demo-target="search:view-results"]')).toBeEnabled();
    await page.locator('[data-demo-target="search:view-results"]').click();
    await expect(page.getByRole("tab")).toHaveCount(scenario.base_template_modules.length);
    await expect(page.getByText("公开演示样本 · 非实时商品", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("为什么推荐它", { exact: true })).toBeVisible();
    await expect(page.locator(".product-primary-recommendation img")).toBeVisible();
    await expect(page.locator(".product-primary-recommendation").getByText("暂无商品图片")).toHaveCount(0);
    await page.getByRole("button", { name: "淘宝搜索" }).first().click();
    const openedUrl = await page.evaluate(() =>
      (window as unknown as { __openedProductUrls: string[] }).__openedProductUrls.at(-1)
    );
    expect(openedUrl).toBeTruthy();
    const parsedUrl = new URL(openedUrl!);
    expect(parsedUrl.origin).toBe("https://s.taobao.com");
    expect(parsedUrl.pathname).toBe("/search");
    expect(parsedUrl.searchParams.get("q")).toBeTruthy();
  }

  expect(apiRequests).toEqual([]);
});

test("frozen navigation and refresh actions stay inside the demo", async ({ context, page }) => {
  const apiRequests: string[] = [];
  const externalRequests: string[] = [];
  const popupUrls: string[] = [];
  const observePage = (observedPage: Page) => {
    observedPage.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/")) apiRequests.push(url.pathname);
      if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") externalRequests.push(url.toString());
    });
  };
  observePage(page);
  context.on("page", (popup) => {
    popupUrls.push(popup.url());
    observePage(popup);
  });

  await page.goto("/demo?demoSpeed=fast");
  const landingLinks = await page.locator('[data-public-demo] a[href]').evaluateAll((links) =>
    links.map((link) => (link as HTMLAnchorElement).getAttribute("href"))
  );
  expect(landingLinks.every((href) => href?.startsWith("/demo"))).toBe(true);

  await page.getByRole("link", { name: "设置" }).click();
  await expect(page.getByText(/不会离开冻结体验/)).toBeVisible();
  await expect(page.getByText(/不会离开冻结体验/)).toBeHidden({ timeout: 6_000 });
  await page.getByRole("link", { name: "最近任务" }).click();
  await expect(page.getByText(/“执行详情”入口/)).toBeVisible();
  await expect(page).toHaveURL(/\/demo/);

  await page.locator('[data-demo-target="scene:example:new-car:0"]').click();
  await page.locator('[data-demo-target="scene:start"]').click();
  await page.locator('[data-demo-target="scene:confirm"]').click();
  await page.locator('[data-demo-target="plan:confirm"]').click();
  await page.getByRole("button", { name: "刷新进度" }).click();
  await expect(page.getByText(/重新读取搜索进度冻结状态/)).toBeVisible();
  await expect(page.locator('[data-demo-target="search:view-results"]')).toBeEnabled();
  await page.locator('[data-demo-target="search:view-results"]').click();

  const workflowLinks = await page.locator('[data-public-demo] a[href]').evaluateAll((links) =>
    links.map((link) => (link as HTMLAnchorElement).getAttribute("href"))
  );
  expect(workflowLinks.every((href) => href?.startsWith("/demo"))).toBe(true);
  await page.getByRole("link", { name: "执行器设置" }).click();
  await expect(page.getByText(/“执行器设置”入口/)).toBeVisible();

  expect(new URL(page.url()).pathname.replace(/\/$/, "")).toBe("/demo");
  expect(popupUrls).toEqual([]);
  expect(apiRequests).toEqual([]);
  expect(externalRequests).toEqual([]);
});

test("a user can open the corresponding Taobao product detail link", async ({ context, page }) => {
  await context.route("https://item.taobao.com/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<title>Frozen product detail target</title>"
    });
  });
  await page.goto("/demo?demoSpeed=fast");
  await enterResultsManually(page);

  const popupPromise = page.waitForEvent("popup");
  await page.locator('[data-demo-target="results:detail:749277654435"]').click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  expect(popup.url()).toBe("https://item.taobao.com/item.htm?id=749277654435");
});

test("auto narrator explains at the top before the cursor starts moving", async ({ page }) => {
  await page.setViewportSize({ width: 1470, height: 900 });
  await page.goto("/demo");
  const launchButton = page.getByRole("button", { name: "启动自动演示" });
  await expect(launchButton).toHaveClass(/public-demo-launch-button/);
  await expect(launchButton).toHaveCSS("background-color", "rgb(246, 112, 35)");
  await expect(launchButton).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(launchButton).toHaveCSS("animation-name", "public-demo-launch-attention");
  await launchButton.click();

  const narrator = page.locator(".public-demo-narrator");
  await expect(narrator).toHaveAttribute("data-demo-phase", "explaining");
  const geometry = await narrator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      top: rect.top,
      width: rect.width,
      height: rect.height,
      center: rect.left + rect.width / 2,
      viewportCenter: window.innerWidth / 2,
      backgroundImage: getComputedStyle(element).backgroundImage,
      titleWeight: getComputedStyle(element.querySelector(".public-demo-narrator-title")!).fontWeight
    };
  });
  expect(geometry.top).toBe(6);
  expect(geometry.width).toBe(720);
  expect(geometry.height).toBe(56);
  expect(Math.abs(geometry.center - geometry.viewportCenter)).toBeLessThanOrEqual(1);
  expect(geometry.backgroundImage).toContain("linear-gradient");
  expect(Number(geometry.titleWeight)).toBeGreaterThanOrEqual(700);
  await page.waitForTimeout(1200);
  await expect(narrator).toHaveAttribute("data-demo-phase", "explaining");
  await expect(page.locator(".public-demo-cursor")).not.toHaveClass(/public-demo-cursor-visible/);
  await expect(narrator).toHaveAttribute("data-demo-phase", "acting", { timeout: 4000 });
  await page.getByRole("button", { name: "暂停演示" }).click();
});

test("auto tour moves its cursor onto real controls and reaches the real cart review", async ({ page }) => {
  await page.goto("/demo?demoSpeed=fast");
  await page.evaluate(() => {
    type ClickSample = { target: string; distance: number; cursor: [number, number]; center: [number, number]; callout?: string };
    const samples: ClickSample[] = [];
    const pointSamples: ClickSample[] = [];
    (window as unknown as { __demoClickSamples: ClickSample[] }).__demoClickSamples = samples;
    (window as unknown as { __demoPointSamples: ClickSample[] }).__demoPointSamples = pointSamples;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target as HTMLElement;
        const isClick = record.attributeName === "data-demo-clicking" && target.dataset.demoClicking === "true";
        const isPoint = record.attributeName === "data-demo-pointing" && target.dataset.demoPointing === "true";
        if (!isClick && !isPoint) continue;
        const cursor = document.querySelector<HTMLElement>(".public-demo-cursor");
        if (!cursor) continue;
        const matrix = new DOMMatrixReadOnly(getComputedStyle(cursor).transform);
        const rect = target.getBoundingClientRect();
        const distance = Math.hypot(matrix.m41 - (rect.left + rect.width / 2), matrix.m42 - (rect.top + rect.height / 2));
        const sample: ClickSample = {
          target: target.dataset.demoTarget ?? "",
          distance,
          cursor: [matrix.m41, matrix.m42],
          center: [rect.left + rect.width / 2, rect.top + rect.height / 2],
          callout: isPoint
            ? document.querySelector<HTMLElement>(".public-demo-cursor-callout")?.textContent?.trim()
            : undefined
        };
        (isPoint ? pointSamples : samples).push(sample);
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-demo-clicking", "data-demo-pointing"],
      subtree: true
    });
  });

  const popups: Page[] = [];
  page.on("popup", (popup) => popups.push(popup));
  await page.getByRole("button", { name: "启动自动演示" }).click();
  await expect(page.locator(".public-demo-cursor")).toHaveClass(/public-demo-cursor-visible/, { timeout: 4000 });
  await expect(page.getByRole("heading", { name: "购物清单共 4 件" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("冻结快照已进入真实购物清单", { exact: true })).toBeVisible();
  await expect(page.getByText("演示清单", { exact: true })).toHaveCount(4);

  const clickSamples = await page.evaluate(() =>
    (window as unknown as { __demoClickSamples: Array<{ target: string; distance: number; cursor: [number, number]; center: [number, number] }> }).__demoClickSamples
  );
  expect(clickSamples.map((sample) => sample.target)).toEqual([
    "scene:example:new-car:0",
    "scene:start",
    "scene:budget",
    "scene:confirm",
    "plan:confirm",
    "search:view-results",
    "results:add:749277654435",
    "results:module:practical-interior",
    "results:alternatives",
    "results:add:966069280059",
    "results:module:cleaning-care",
    "results:add:1058209193158",
    "results:module:storage-organization",
    "results:add:716549824114",
    "results:view-cart"
  ]);
  for (const sample of clickSamples) {
    expect(sample.distance, JSON.stringify(sample)).toBeLessThanOrEqual(12);
  }
  const pointSamples = await page.evaluate(() =>
    (window as unknown as { __demoPointSamples: Array<{ target: string; distance: number; callout?: string }> }).__demoPointSamples
  );
  expect(pointSamples.map((sample) => sample.target)).toEqual(["results:detail:749277654435"]);
  expect(pointSamples[0]?.distance).toBeLessThanOrEqual(12);
  expect(pointSamples[0]?.callout).toBe("本次不演示，可以自己点击跳转到真实链接");
  expect(popups).toHaveLength(0);
});

test("auto tour pauses on any page click and resumes without duplicate cart writes", async ({ page }) => {
  await page.goto("/demo?demoSpeed=fast");
  await page.evaluate(() => {
    const firstTarget = document.querySelector<HTMLElement>('[data-demo-target="scene:example:new-car:0"]');
    (window as unknown as { __firstTargetClickCount: number }).__firstTargetClickCount = 0;
    firstTarget?.addEventListener("click", () => {
      const state = window as unknown as { __firstTargetClickCount: number };
      state.__firstTargetClickCount += 1;
      if (state.__firstTargetClickCount !== 1) return;
      window.setTimeout(() => {
        const pauseButton = [...document.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent?.includes("暂停演示"));
        pauseButton?.click();
      }, 0);
    });
    const pauseAtPlan = (event: Event) => {
      const target = (event.target as Element | null)?.closest<HTMLElement>("[data-demo-target]");
      if (target?.dataset.demoTarget !== "plan:confirm") return;
      document.removeEventListener("click", pauseAtPlan);
      window.setTimeout(() => {
        const pauseButton = [...document.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent?.includes("暂停演示"));
        pauseButton?.click();
      }, 0);
    };
    document.addEventListener("click", pauseAtPlan);
  });
  await page.getByRole("button", { name: "启动自动演示" }).click();
  await expect(page.getByRole("button", { name: "继续演示" })).toBeVisible();
  await page.getByRole("button", { name: "继续演示" }).click();
  await expect(page.getByText("搜索已暂停，已有结果不会丢失", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "继续演示" })).toBeVisible();
  await page.waitForTimeout(600);
  await expect(page.getByText("搜索已暂停，已有结果不会丢失", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "继续演示" }).click();
  await expect(page.getByRole("heading", { name: "购物清单共 4 件" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("演示清单", { exact: true })).toHaveCount(4);
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __firstTargetClickCount: number }).__firstTargetClickCount
  )).toBe(1);

  await page.goto("/demo?demoSpeed=fast");
  await page.evaluate(() => {
    const firstTarget = document.querySelector<HTMLElement>('[data-demo-target="scene:example:new-car:0"]');
    (window as unknown as { __resumeFirstTargetClickCount: number }).__resumeFirstTargetClickCount = 0;
    firstTarget?.addEventListener("click", () => {
      (window as unknown as { __resumeFirstTargetClickCount: number }).__resumeFirstTargetClickCount += 1;
    });
  });
  await page.getByRole("button", { name: "启动自动演示" }).click();
  await page.locator('[data-demo-target="scene:example:new-car:1"]').click();
  await expect(page.locator(".public-demo-narrator")).toHaveAttribute("data-demo-phase", "paused");
  await expect(page.getByRole("button", { name: "继续演示" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "把一句需求，变成买得明白的方案" })).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __resumeFirstTargetClickCount: number }).__resumeFirstTargetClickCount
  )).toBe(0);
  await page.getByRole("button", { name: "继续演示" }).click();
  await expect(page.getByRole("heading", { name: "购物清单共 4 件" })).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __resumeFirstTargetClickCount: number }).__resumeFirstTargetClickCount
  )).toBe(1);
});

test("mobile result and cart layouts have no horizontal overflow", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/demo");
  await page.getByRole("button", { name: "启动自动演示" }).click();
  const mobileNarrator = page.locator(".public-demo-narrator");
  await expect(mobileNarrator).toHaveAttribute("data-demo-phase", "explaining");
  const narratorGeometry = await mobileNarrator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, width: rect.width, height: rect.height };
  });
  expect(narratorGeometry).toEqual({ top: 120, width: 366, height: 56 });
  await page.getByRole("heading", { name: "把一句需求，变成买得明白的方案" }).click();
  await expect(page.getByRole("button", { name: "继续演示" })).toBeVisible();

  await page.goto("/demo?demoSpeed=fast");
  await page.getByRole("button", { name: "启动自动演示" }).click();
  await expect(page.getByRole("heading", { name: "购物清单共 4 件" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "重新自动演示" })).toBeVisible();

  const dimensions = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.innerWidth);

  await page.getByRole("button", { name: "返回上一步继续加购" }).click();
  await expect(page.getByText("为什么推荐它", { exact: true })).toBeVisible();
  const mobileGeometry = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".workflow-content")!.getBoundingClientRect();
    const results = document.querySelector<HTMLElement>('[aria-label="淘宝搜索结果"]')!.getBoundingClientRect();
    const sidebar = document.querySelector<HTMLElement>(".results-cart-sidebar")!.getBoundingClientRect();
    return {
      content: [content.x, content.width],
      resultsBottom: results.bottom,
      sidebar: [sidebar.x, sidebar.width, sidebar.top],
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth
    };
  });
  expect(mobileGeometry.content).toEqual([16, 358]);
  expect(mobileGeometry.sidebar[0]).toBe(16);
  expect(mobileGeometry.sidebar[1]).toBe(358);
  expect(mobileGeometry.sidebar[2]).toBeGreaterThan(mobileGeometry.resultsBottom);
  expect(mobileGeometry.scrollWidth).toBeLessThanOrEqual(mobileGeometry.innerWidth);
  await page.screenshot({ path: testInfo.outputPath("scenecart-demo-results-mobile.png"), fullPage: true });
});

test("reduced motion still completes the real flow without cursor travel", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/demo?demoSpeed=fast");
  const launchButton = page.getByRole("button", { name: "启动自动演示" });
  await expect(launchButton).toHaveCSS("animation-name", "none");
  await launchButton.click();
  await expect(page.getByRole("heading", { name: "购物清单共 4 件" })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".public-demo-cursor")).toHaveCSS("transition-duration", "0s");
});
