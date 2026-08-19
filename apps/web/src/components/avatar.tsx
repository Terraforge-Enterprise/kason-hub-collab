type AvatarProps = {
  src: string | null;
  name: string;
  size: "sm" | "md" | "lg";
  className?: string;
};

const SIZE_CLASS: Record<AvatarProps["size"], string> = {
  sm: "h-8 w-8 text-xs",
  md: "h-12 w-12 text-sm",
  lg: "h-20 w-20 text-lg",
};

function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Avatar({ src, name, size, className }: AvatarProps) {
  const sizeClass = SIZE_CLASS[size];
  if (src) {
    return (
      <img
        src={src}
        alt={name}
        className={`${sizeClass} rounded-full object-cover ${className ?? ""}`}
      />
    );
  }
  return (
    <div
      aria-label={name || "Avatar"}
      className={`${sizeClass} rounded-full bg-[var(--card-bg)] border border-[var(--card-border)] flex items-center justify-center font-medium text-[var(--text-primary)] ${className ?? ""}`}
    >
      {initials(name)}
    </div>
  );
}
