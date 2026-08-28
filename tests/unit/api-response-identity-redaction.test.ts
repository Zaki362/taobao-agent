import { describe, expect, it } from "vitest";
import { apiOk, publicApiPayload } from "@/lib/api/responses";

describe("public API identity boundary", () => {
  it("removes owner identifiers recursively without changing business data", async () => {
    const payload = {
      owner_id: "server-owner",
      session_id: "session-1",
      nested: {
        user_id: "server-owner",
        title: "购物任务"
      },
      items: [{ user_id: "server-owner", product_id: "product-1" }]
    };

    expect(publicApiPayload(payload)).toEqual({
      session_id: "session-1",
      nested: { title: "购物任务" },
      items: [{ product_id: "product-1" }]
    });

    const response = apiOk(payload);
    const serialized = JSON.stringify(await response.json());
    expect(serialized).not.toContain("server-owner");
    expect(serialized).not.toContain("owner_id");
    expect(serialized).not.toContain("user_id");
    expect(serialized).toContain("product-1");
  });
});
