import workbenchStyles from "../styles/workbench.module.css";
import fileIconStyles from "./FileIcon.module.css";
import { createFileTreeIconResolver, getBuiltInSpriteSheet } from "@pierre/trees";
import { treeIcons } from "../explorer/treeIcons";
import type { ButtonHTMLAttributes } from "react";

const fileIconResolver = createFileTreeIconResolver(treeIcons);
// Only bundled SVG definitions are injected; file paths are never used as markup.
const fileIconSprite = {
  __html: getBuiltInSpriteSheet(treeIcons.set ?? "complete") + (treeIcons.spriteSheet ?? ""),
};

// Shared button geometry and states stay consistent across dialogs and toolbars.
export const actionButtonClass = `action-button inline-flex items-center justify-center shrink-0 gap-[6px] h-8 py-0 px-3 border border-strong rounded-[3px] [&.primary]:rounded-[2px] bg-button-secondary text-foreground text-[13px] font-semibold whitespace-nowrap ${workbenchStyles["action-button"]}`;

export function Icon({ name, className = "" }: Readonly<{ name: string; className?: string }>) {
  return (
    <span
      className={`codicon text-[16px] align-middle shrink-0 codicon-${name} ${className}`}
      aria-hidden="true"
    />
  );
}
export function FileIconSprite() {
  return (
    <span
      className="absolute size-0 overflow-hidden pointer-events-none"
      aria-hidden="true"
      dangerouslySetInnerHTML={fileIconSprite}
    />
  );
}

export function FileIcon({ path }: Readonly<{ path: string }>) {
  const icon = fileIconResolver.resolveIcon("file-tree-icon-file", path.replace(/\\/g, "/"));
  return (
    <svg
      className={`inline-block size-[18px] shrink-0 align-middle ${fileIconStyles["file-icon"]}`}
      data-icon-name={icon.name}
      data-icon-token={icon.token}
      style={{ color: `var(--trees-file-icon-color-${icon.token ?? "default"})` }}
      viewBox={icon.viewBox ?? `0 0 ${icon.width ?? 16} ${icon.height ?? 16}`}
      width={18}
      height={18}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <use href={`#${icon.name.replace(/^#/, "")}`} />
    </svg>
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
