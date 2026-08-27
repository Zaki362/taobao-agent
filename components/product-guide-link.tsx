"use client";

import { useState } from "react";
import { BookOpenText } from "lucide-react";
import { ProductGuideDialog, type ProductGuideMode } from "@/components/product-guide";
import { cn } from "@/lib/utils";

export function ProductGuideLink({
  compactOnMobile = false,
  className,
  mode = "formal",
  onBeforeOpen
}: {
  compactOnMobile?: boolean;
  className?: string;
  mode?: ProductGuideMode;
  onBeforeOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className={cn("header-doc-link", compactOnMobile && "header-doc-link-compact", className)}
        aria-label="产品说明"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { onBeforeOpen?.(); setOpen(true); }}
      >
        <BookOpenText className="h-4 w-4" aria-hidden="true" />
        <span className={compactOnMobile ? "hidden min-[380px]:inline" : undefined}>产品说明</span>
      </button>
      <ProductGuideDialog mode={mode} open={open} onOpenChange={setOpen} />
    </>
  );
}
