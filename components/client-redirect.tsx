"use client";

import { useEffect } from "react";

export function ClientRedirect({
  pathname,
  query = {},
  label = "正在返回 SceneCart…"
}: {
  pathname: string;
  query?: Record<string, string>;
  label?: string;
}) {
  useEffect(() => {
    const destination = new URL(window.location.href);
    destination.pathname = pathname;
    for (const [key, value] of Object.entries(query)) {
      destination.searchParams.set(key, value);
    }
    window.location.replace(`${destination.pathname}${destination.search}${destination.hash}`);
  }, [pathname, query]);

  return (
    <main className="flex min-h-screen items-center justify-center px-6" aria-label="SceneCart 兼容入口">
      <p role="status" className="text-sm text-muted-foreground">{label}</p>
    </main>
  );
}
