import type { ButtonHTMLAttributes } from "react";
export function Icon({ name, className = "" }: { name: string; className?: string }) {
  return <span className={`codicon codicon-${name} ${className}`} aria-hidden="true" />;
}
export function IconButton({
  icon,
  label,
  ...props
}: { icon: string; label: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`icon-button ${props.className ?? ""}`}
      {...props}
      title={label}
      aria-label={label}
    >
      <Icon name={icon} />
    </button>
  );
}
