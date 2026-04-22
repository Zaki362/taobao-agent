import * as React from "react";
import { cn } from "@/lib/utils";

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={cn(
        "min-h-32 w-full rounded-[24px] border border-input bg-white px-5 py-4 text-[15px] leading-7 text-foreground outline-none ring-0 placeholder:text-muted-foreground/90 transition-colors focus:border-primary focus:shadow-sm",
        props.className
      )}
    />
  );
}
