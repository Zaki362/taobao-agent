import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Badge({
  className,
  variant = "default",
  children
}: {
  className?: string;
  variant?: "default" | "secondary" | "success" | "danger" | "outline";
  children: ReactNode;
}) {
  const styles = {
    default: "bg-primary/10 text-primary",
    secondary: "bg-secondary/85 text-secondary-foreground",
    success: "bg-emerald-50 text-emerald-700",
    danger: "bg-red-50 text-red-700",
    outline: "border border-border/80 bg-white text-foreground"
  };

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-3 py-1 text-xs font-medium",
        "max-w-full whitespace-nowrap",
        styles[variant],
        className
      )}
    >
      {children}
    </span>
  );
}
