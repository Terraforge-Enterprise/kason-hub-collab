import * as React from "react";
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { CheckIcon, MinusIcon } from "lucide-react";

import { cn } from "@/lib/utils";

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "h-4 w-4 shrink-0 rounded border border-[var(--input-border)] bg-[var(--card-bg)]",
        "transition focus:outline-none focus:ring-2 focus:ring-[var(--ring)]",
        "data-checked:border-[var(--primary)] data-checked:bg-[var(--primary)]",
        "data-indeterminate:border-[var(--primary)] data-indeterminate:bg-[var(--primary)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-white"
      >
        <MinusIcon className="hidden data-[indeterminate]:block h-3 w-3" />
        <CheckIcon className="block data-[indeterminate]:hidden h-3 w-3" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
