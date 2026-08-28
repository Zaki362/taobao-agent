"use client";

import { useEffect, useRef, useState } from "react";
import { BookOpenText } from "lucide-react";
import { ProductGuideDialog, type ProductGuideMode } from "@/components/product-guide";
import { cn } from "@/lib/utils";

function removeGuideQueryParameter() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("guide")) return;
  url.searchParams.delete("guide");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

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
  const autoOpenHandledRef = useRef(false);
  const beforeOpenRef = useRef(onBeforeOpen);

  useEffect(() => {
    beforeOpenRef.current = onBeforeOpen;
  }, [onBeforeOpen]);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("guide") !== "1") return;

    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        if (autoOpenHandledRef.current) return;
        autoOpenHandledRef.current = true;
        beforeOpenRef.current?.();
        setOpen(true);
        removeGuideQueryParameter();
      });
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, []);

  function openDialog() {
    beforeOpenRef.current?.();
    setOpen(true);
  }

  return (
    <>
      <button
        type="button"
        className={cn("header-doc-link", compactOnMobile && "header-doc-link-compact", className)}
        aria-label="产品说明"
        aria-haspopup="dialog"
        aria-controls="scenecart-product-guide-dialog"
        aria-expanded={open}
        onClick={openDialog}
      >
        <BookOpenText className="h-4 w-4" aria-hidden="true" />
        <span className={compactOnMobile ? "hidden sm:inline" : undefined}>产品说明</span>
      </button>
      <ProductGuideDialog mode={mode} open={open} onOpenChange={setOpen} />
    </>
  );
}
