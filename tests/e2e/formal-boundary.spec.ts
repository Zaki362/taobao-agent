import { expect, test } from "@playwright/test";

test("formal product does not expose the frozen Demo route", async ({ request }) => {
  const response = await request.get("/demo");

  expect(response.status()).toBe(404);
});
