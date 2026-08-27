import type { Metadata } from "next";
import { ProductGuide } from "@/components/product-guide";

export const metadata: Metadata = {
  title: "产品说明 | SceneCart AI",
  description: "了解 SceneCart AI 如何把模糊购物场景组织成可执行的购物方案"
};

export default function ProductGuidePage() {
  return <ProductGuide mode="formal" />;
}
