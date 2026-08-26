import type { Metadata } from "next";
import type { ReactNode } from "react";

import "../../../app/globals.css";

export const metadata: Metadata = {
  title: "SceneCart · 公开体验",
  description: "通过冻结数据体验 SceneCart 的场景理解、购物规划与组合推荐流程"
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN" className="h-full" suppressHydrationWarning>
      <body className="min-h-full bg-background font-sans text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
