import { describe, expect, it } from "vitest";
import { normalizeTaobaoImageUrl } from "@/lib/product-image";

describe("product image URL policy", () => {
  it("normalizes Taobao CDN images to HTTPS", () => {
    expect(normalizeTaobaoImageUrl("http://img.alicdn.com/item.jpg"))
      .toBe("https://img.alicdn.com/item.jpg");
    expect(normalizeTaobaoImageUrl("//gw.alicdn.com/item.jpg"))
      .toBe("https://gw.alicdn.com/item.jpg");
  });

  it("allows only the bundled public-demo image directory as a local source", () => {
    expect(normalizeTaobaoImageUrl("/demo-products/phone-holder.webp"))
      .toBe("/demo-products/phone-holder.webp");
    expect(normalizeTaobaoImageUrl("/private/item.jpg")).toBeUndefined();
    expect(normalizeTaobaoImageUrl("/demo-products/\\evil.example/item.jpg")).toBeUndefined();
  });

  it("rejects untrusted hosts and embedded credentials", () => {
    expect(normalizeTaobaoImageUrl("https://example.com/item.jpg")).toBeUndefined();
    expect(normalizeTaobaoImageUrl("https://user:pass@img.alicdn.com/item.jpg")).toBeUndefined();
  });
});
