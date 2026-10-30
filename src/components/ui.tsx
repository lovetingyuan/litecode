import workbenchStyles from "../styles/workbench.module.css";
import type { ButtonHTMLAttributes } from "react";
// Shared button geometry and states stay consistent across dialogs and toolbars.
export const actionButtonClass = `action-button inline-flex items-center justify-center shrink-0 gap-[6px] h-8 py-0 px-3 border border-strong rounded-[3px] [&.primary]:rounded-[2px] bg-button-secondary text-foreground text-[13px] font-semibold whitespace-nowrap ${workbenchStyles["action-button"]}`;

export function Icon({ name, className = "" }: { name: string; className?: string }) {
  return (
    <span
      className={`codicon text-[16px] align-middle shrink-0 codicon-${name} ${className}`}
      aria-hidden="true"
    />
  );
}
export function FileIcon({ language }: { language: string }) {
  const icons: Record<string, [string, string]> = {
    typescript: ["symbol-color", "text-file-typescript"],
    javascript: ["symbol-color", "text-file-javascript"],
    rust: ["settings-gear", "text-file-rust"],
    json: ["json", "text-file-json"],
    css: ["symbol-color", "text-file-css"],
    html: ["code", "text-file-html"],
    markdown: ["markdown", "text-file-markdown"],
  };
  const [name, className] = icons[language.replace(/react$/, "")] ?? ["file", "text-file-default"];
  return (
    <span className={className}>
      <Icon name={name} />
    </span>
  );
}
export function IconButton({
  icon,
  label,
  className = "",
  ...props
}: { icon: string; label: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`icon-button w-6 h-6 p-1 inline-flex items-center justify-center ${className}`}
      {...props}
      title={label}
      aria-label={label}
    >
      <Icon name={icon} />
    </button>
  );
}
