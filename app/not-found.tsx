import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function NotFoundPage() {
  return (
    <main className="min-h-screen px-4 py-6 md:px-6">
      <div className="mx-auto flex min-h-[80vh] max-w-[720px] items-center justify-center">
        <Card className="w-full rounded-[30px]">
          <CardHeader>
            <CardTitle>没有找到这个页面</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm leading-7 text-muted-foreground">
              这个地址可能已经失效，或者当前版本暂未开放该入口。
            </p>
            <Link
              href="/"
              className="inline-flex h-11 items-center justify-center rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
            >
              回到场景购首页
            </Link>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
