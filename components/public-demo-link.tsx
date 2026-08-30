import { Play } from "lucide-react";
import { PUBLIC_DEMO_AUTOPLAY_URL } from "@/lib/public-demo-url";
import { cn } from "@/lib/utils";

export function PublicDemoLink({
  className,
  compactOnMobile = false,
  descriptive = false
}: {
  className?: string;
  compactOnMobile?: boolean;
  descriptive?: boolean;
}) {
  return (
    <a
      href={PUBLIC_DEMO_AUTOPLAY_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "header-demo-link",
        compactOnMobile && "header-demo-link-compact",
        descriptive && "header-demo-link-descriptive",
        className
      )}
      aria-label="观看 Demo 自动演示（公开冻结、无需登录、不连接场景购账户或淘宝）"
      title="公开冻结 Demo：无需登录，不连接你的场景购账户或淘宝"
    >
      <Play className="h-4 w-4 shrink-0" fill="currentColor" aria-hidden="true" />
      <span className={compactOnMobile ? "hidden sm:block" : "block"}>
        <strong className="block font-semibold leading-none">观看 Demo</strong>
        {descriptive ? (
          <small className="mt-1 block text-[10px] font-medium leading-none text-white/80">
            公开冻结 · 无需登录
          </small>
        ) : null}
      </span>
    </a>
  );
}
