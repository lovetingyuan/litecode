import type { ButtonHTMLAttributes } from "react";
export function Icon({ name, className = "" }: { name: string; className?: string }) {
  return <span className={`codicon codicon-${name} ${className}`} aria-hidden="true" />;
}
export function FileIcon({ language }: { language: string }) {
  const icons: Record<string, [string, string]> = {
    typescript: ["symbol-color", "#519aba"],
    javascript: ["symbol-color", "#cbcb41"],
    rust: ["settings-gear", "#dea584"],
    json: ["json", "#cbcb41"],
    css: ["symbol-color", "#519aba"],
    html: ["code", "#e37933"],
    markdown: ["markdown", "#519aba"],
  };
  const [name, color] = icons[language.replace(/react$/, "")] ?? ["file", "#a6a6a6"];
  return <span style={{ color }}><Icon name={name} /></span>;
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
