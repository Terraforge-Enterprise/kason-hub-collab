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
        "h-10 w-full min-w-0 rounded-lg border border-input bg-white px-3 py-2 text-base text-[var(--navy-text)] shadow-sm transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-[var(--text-secondary)] focus-visible:border-[var(--gold)] focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-card dark:text-foreground dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
      {...props}
    />
  )
}

export { Input }
