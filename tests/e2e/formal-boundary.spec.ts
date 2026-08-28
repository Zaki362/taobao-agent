import { expect, test } from "@playwright/test";
import { appOrigin } from "./single-user-fixture";

async function expectNavigationFitsViewport(page: import("@playwright/test").Page, selector: string) {
  const geometry = await page.locator(selector).evaluate((navigation) => ({
    viewportWidth: window.innerWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    navigation: (() => {
      const rect = navigation.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    })(),
    controls: Array.from(navigation.querySelectorAll<HTMLElement>("a, button"))
      .map((control) => {
        const rect = control.getBoundingClientRect();
        return {
          label: control.getAttribute("aria-label") || control.textContent?.trim() || control.tagName,
          left: rect.left,
          right: rect.right,
          width: rect.width,
          height: rect.height
        };
      })
      .filter((control) => control.width > 0 && control.height > 0)
  }));

  expect(geometry.documentScrollWidth).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.navigation.left).toBeGreaterThanOrEqual(0);
  expect(geometry.navigation.right).toBeLessThanOrEqual(geometry.viewportWidth);
  const clippedControls = geometry.controls.filter((control) =>
    control.left < -0.5 || control.right > geometry.viewportWidth + 0.5
  );
  expect(clippedControls, JSON.stringify(geometry)).toEqual([]);
}

test("formal compatibility routes point to the public Demo and in-place guide", async ({ request }) => {
  const demoResponse = await request.get("/demo", { maxRedirects: 0 });
  expect([307, 308]).toContain(demoResponse.status());
  expect(demoResponse.headers().location).toBe("https://scenecart-public-demo.vercel.app/");

  const guideResponse = await request.get("/product-guide", { maxRedirects: 0 });
  expect([307, 308]).toContain(guideResponse.status());
  expect(guideResponse.headers().location).toBe("/?guide=1");
});

test("formal fixed-owner navigation has no interactive login and opens the independent public Demo", async ({ page }) => {
  const expectedUrl = "https://scenecart-public-demo.vercel.app/?autoplay=1";

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByLabel("邮箱")).toHaveCount(0);
  await expect(page.getByLabel("密码")).toHaveCount(0);
  await expectNavigationFitsViewport(page, ".landing-nav");

  const login = await page.request.post("/api/auth/login", {
    headers: { Origin: appOrigin },
    data: { email: "disabled@example.com", password: "not-used" }
  });
  const loginPayload = await login.json();
  expect(login.status(), JSON.stringify(loginPayload)).toBe(410);
  expect(loginPayload).toMatchObject({ code: "interactive_authentication_disabled" });

  const registered = await page.request.post("/api/auth/register", {
    headers: { Origin: appOrigin },
    data: { email: "disabled@example.com", password: "not-used" }
  });
  const registeredPayload = await registered.json();
  expect(registered.status(), JSON.stringify(registeredPayload)).toBe(410);
  expect(registeredPayload).toMatchObject({ code: "interactive_authentication_disabled" });

  const registerPage = await page.request.get("/register", { maxRedirects: 0 });
  expect([404, 410]).toContain(registerPage.status());

  const authStateResponse = await page.request.get("/api/auth/me");
  const authState = await authStateResponse.json() as Record<string, unknown>;
  expect(authStateResponse.ok(), JSON.stringify(authState)).toBe(true);
  expect(authState).toMatchObject({
    authenticated: true,
    access_mode: "single_user",
    persistence_scope: "single_user"
  });
  expect(authState).not.toHaveProperty("user");
  expect(authState).not.toHaveProperty("owner_id");

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "把一句需求，变成买得明白的方案" })).toBeVisible();
  const productDemoLink = page.getByRole("link", { name: /^观看 Demo 自动演示/ });
  await expect(productDemoLink).toBeVisible();
  await expect(productDemoLink).toHaveAttribute("href", expectedUrl);
  await expect(productDemoLink).toHaveAttribute("target", "_blank");
  await expect(productDemoLink).toHaveAttribute("rel", "noopener noreferrer");
  await expectNavigationFitsViewport(page, ".landing-nav");

  await page.goto("/settings/executor");
  await expect(page).toHaveURL(/\/settings\/executor$/);
  await expect(page.getByText("正式单用户模式已关闭网页注册", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "注册当前设备" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "保存一次性设备令牌" })).toHaveCount(0);

  await page.goto("/");
  await page.locator('[data-demo-target="scene:example:new-car:0"]').click();
  const requirementInput = page.getByRole("textbox", { name: "描述你的购物场景" });
  const requirementBeforeGuide = await requirementInput.inputValue();
  const productGuideButton = page.getByRole("button", { name: "产品说明" });
  await productGuideButton.click();
  await expect(page.getByRole("dialog", { name: "SceneCart AI 产品说明" })).toBeVisible();
  const formalAccessCopy =
    "固定域名直接进入并绑定固定 owner；当前 Production 未启用 Vercel 外层保护";
  await expect(page.getByText(formalAccessCopy, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "正式产品与 Demo" }).click();
  const fixedOwnerAccessCopy = page.getByText(formalAccessCopy, { exact: true });
  await expect(fixedOwnerAccessCopy).toHaveCount(2);
  await expect(fixedOwnerAccessCopy.last()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "SceneCart AI 产品说明" })).toBeHidden();
  await expect(productGuideButton).toBeFocused();
  await expect(requirementInput).toHaveValue(requirementBeforeGuide);

  await page.locator('[data-demo-target="scene:start"]').click();
  const workflowDemoLink = page.getByRole("link", { name: /^观看 Demo 自动演示/ });
  await expect(workflowDemoLink).toBeVisible();
  await expect(workflowDemoLink).toHaveAttribute("href", expectedUrl);
  await expectNavigationFitsViewport(page, ".workflow-header");
});
