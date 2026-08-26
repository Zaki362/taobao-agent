import Link from "next/link";

export default function NotFoundPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <section className="w-full max-w-md rounded-[28px] border border-border/80 bg-white/95 p-8 text-center shadow-panel">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">SceneCart Demo</p>
        <h1 className="mt-3 text-3xl font-semibold text-foreground">页面不存在</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          公开体验版只提供完整 Demo 流程，不包含账户、设置或正式产品接口。
        </p>
        <Link
          href="/demo"
          className="mt-6 inline-flex h-11 items-center justify-center rounded-full bg-primary px-6 text-sm font-semibold text-primary-foreground transition hover:opacity-90"
        >
          返回公开体验
        </Link>
      </section>
    </main>
  );
}
