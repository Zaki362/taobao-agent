import type { Metadata } from "next";
import { PublicDemo } from "@/components/public-demo";

export const metadata: Metadata = {
  title: "SceneCart AI · 公开体验",
  description: "通过冻结数据体验 SceneCart 的场景理解、购物规划与组合推荐流程"
};

export const dynamic = "force-static";

export default function DemoPage() {
  return <PublicDemo />;
}
