import type { Metadata } from "next";
import { ProductGuideRoute } from "@/components/product-guide";

export const metadata: Metadata = {
  title: "产品说明 | SceneCart 公开体验",
  description: "了解 SceneCart 如何用场景理解、购物规划与组合决策完成一次购物任务"
};

export default function PublicProductGuidePage() {
  return <ProductGuideRoute mode="demo" />;
}
