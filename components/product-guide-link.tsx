import { BookOpenText } from "lucide-react";
import { cn } from "@/lib/utils";

export function ProductGuideLink({
  href = "/product-guide",
  compactOnMobile = false,
  className
}: {
  href?: string;
  compactOnMobile?: boolean;
  className?: string;
}) {
  return (
    <a
      href={href}
      className={cn("header-doc-link", compactOnMobile && "header-doc-link-compact", className)}
      aria-label="产品说明"
    >
      <BookOpenText className="h-4 w-4" aria-hidden="true" />
      <span className={compactOnMobile ? "hidden min-[380px]:inline" : undefined}>产品说明</span>
    </a>
  );
}
