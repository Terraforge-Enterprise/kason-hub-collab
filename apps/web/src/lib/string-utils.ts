/** Title-case a snake_case / lowercase string. */
export function labelFor(value: string): string {
  return value
    .split("_")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}
