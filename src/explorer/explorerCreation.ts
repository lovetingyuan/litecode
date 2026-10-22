import { pasteDirectory } from "./explorerClipboard";

export type CreationKind = "newFile" | "newFolder";
export type CreatedEntry = { path: string; relativePath: string; kind: CreationKind };
export type RenamedEntry = { from: string; to: string; relativePath: string; isDirectory: boolean; changed: boolean };

export const creationParent = (path: string, directory: boolean) => pasteDirectory(path, directory);

// Disk validation remains authoritative. This check gives immediate feedback
// without waiting for IPC; separators describe nested relative paths.
export function validateCreationName(name: string, windows: boolean): string | null {
  if (/^[\\/]/.test(name) || name.includes(":")) { return "Enter a relative path inside this folder."; }
  const parts = name.split(/[\\/]/).filter(Boolean);
  if (!parts.length) { return "A file or folder name must be provided."; }
  for (const part of parts) {
    if (!part.trim() || part === "." || part === ".." || part.includes("\0") ||
      (windows && (/[<>:"|?*]/.test(part) || [...part].some((character) => character.charCodeAt(0) < 32) || /[ .]$/.test(part) || part.length > 255))) {
      return `The name '${part}' is not valid as a file or folder name.`;
    }
    if (windows && /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)) {
      return `The name '${part}' is reserved by Windows.`;
    }
  }
  return null;
}

export function validateRenameName(name: string, windows: boolean, directory: boolean): string | null {
  if (!directory && /[\\/]$/.test(name)) { return "A file name cannot end with a directory separator."; }
  return validateCreationName(name, windows);
}
