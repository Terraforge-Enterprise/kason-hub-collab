import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

function Input({ className, type, onWheel, onKeyDown, ...props }: React.ComponentProps<"input">) {
  // Block wheel-to-increment on number inputs (see form-ui TextInput for the why).
  const handleWheel =
    type === "number"
      ? (e: React.WheelEvent<HTMLInputElement>) => {
          e.currentTarget.blur();
          onWheel?.(e);
        }
      : onWheel;
  // Block "-" on number inputs. Chrome lets the character persist on screen
  // even when it makes the value invalid (value === "" while the input still
  // shows "1200-215"); blocking the keystroke is the cleanest cure.
  const handleKeyDown =
    type === "number"
      ? (e: React.KeyboardEvent<HTMLInputElement>) => {
          if (e.key === "-") e.preventDefault();
          onKeyDown?.(e);
        }
      : onKeyDown;
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
      {...props}
    />
  )
}

export { Input }
