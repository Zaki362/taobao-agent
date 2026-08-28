import { expect, test } from "@playwright/test";

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

test("formal product does not expose the frozen Demo route", async ({ request }) => {
  const responses = await Promise.all([
    request.get("/demo"),
    request.get("/demo?autoplay=1")
  ]);

  expect(responses.map((response) => response.status())).toEqual([404, 404]);
});

test("formal login and authenticated navigation open the independent public Demo", async ({ page }) => {
  const expectedUrl = "https://scenecart-public-demo.vercel.app/demo?autoplay=1";

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");
  const loginDemoLink = page.getByRole("link", { name: /^观看 Demo 自动演示/ });
  await expect(loginDemoLink).toBeVisible();
  await expect(loginDemoLink).toHaveAttribute("href", expectedUrl);
  await expect(loginDemoLink).toHaveAttribute("target", "_blank");
  await expect(loginDemoLink).toHaveAttribute("rel", "noopener noreferrer");
  await expectNavigationFitsViewport(page, ".landing-nav");

  const registered = await page.request.post("/api/auth/register", {
    headers: { Origin: "http://127.0.0.1:3100" },
    data: {
      email: `demo-entry-${Date.now()}@example.com`,
      password: "e2e-secure-password"
    }
  });
  expect(registered.status(), await registered.text()).toBe(201);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "把一句需求，变成买得明白的方案" })).toBeVisible();
  const productDemoLink = page.getByRole("link", { name: /^观看 Demo 自动演示/ });
  await expect(productDemoLink).toBeVisible();
  await expect(productDemoLink).toHaveAttribute("href", expectedUrl);
  await expect(productDemoLink).toHaveAttribute("target", "_blank");
  await expect(productDemoLink).toHaveAttribute("rel", "noopener noreferrer");
  await expectNavigationFitsViewport(page, ".landing-nav");

  await page.locator('[data-demo-target="scene:example:new-car:0"]').click();
  await page.locator('[data-demo-target="scene:start"]').click();
  const workflowDemoLink = page.getByRole("link", { name: /^观看 Demo 自动演示/ });
  await expect(workflowDemoLink).toBeVisible();
  await expect(workflowDemoLink).toHaveAttribute("href", expectedUrl);
  await expectNavigationFitsViewport(page, ".workflow-header");
});
