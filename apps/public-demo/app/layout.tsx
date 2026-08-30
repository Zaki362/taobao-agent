import type { Metadata } from "next";
import type { ReactNode } from "react";

import "../../../app/globals.css";

export const metadata: Metadata = {
  title: "场景购 · 公开体验",
  description: "通过冻结数据体验场景购的需求拆解、购物规划、搜索比选与组合推荐流程"
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
