"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function AppError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app-error]", error);
  }, [error]);

  return (
    <main className="min-h-screen px-4 py-6 md:px-6">
      <div className="mx-auto flex min-h-[80vh] max-w-[720px] items-center justify-center">
        <Card className="w-full rounded-[30px]">
          <CardHeader>
            <CardTitle>页面暂时无法继续</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm leading-7 text-muted-foreground">
              当前页面遇到异常。你可以先重试，如果问题反复出现，再查看服务端控制台日志。
            </p>
            {error.digest ? (
              <p className="rounded-[18px] bg-secondary/50 px-4 py-3 text-xs text-muted-foreground">
                错误编号：{error.digest}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-3">
              <Button onClick={reset}>重新尝试</Button>
              <Button variant="outline" onClick={() => window.location.assign("/")}>
                回到首页
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

