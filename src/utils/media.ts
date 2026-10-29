import type { Doc, Group } from "../types/types";

export const isTextDocument = (doc: Doc) =>
  !doc.gitDiff && (!doc.kind || doc.kind === "text" || doc.kind === "svg");
export const isMarkdownDocument = (doc: Doc) =>
  isTextDocument(doc) && doc.kind !== "svg" && doc.language === "markdown";
export const isMarkdownView = (doc: Doc, group?: Group) =>
  isMarkdownDocument(doc) && group?.mediaViews?.[doc.id]?.mode === "markdown";
export const isTextView = (doc: Doc, group?: Group) =>
  isTextDocument(doc) &&
  !isMarkdownView(doc, group) &&
  (doc.kind !== "svg" || group?.mediaViews?.[doc.id]?.mode === "text");
export const isImageView = (doc: Doc, group?: Group) =>
  doc.kind === "image" || (doc.kind === "svg" && !isTextView(doc, group));
export const zoomLevels = [
  0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.5, 2, 3, 5, 7, 10, 15, 20,
];
export const clampScale = (scale: number) => Math.max(0.1, Math.min(20, scale));
export const stepScale = (scale: number, direction: number) =>
  direction > 0
    ? (zoomLevels.find((level) => level > scale + 0.0001) ?? 20)
    : ([...zoomLevels].reverse().find((level) => level < scale - 0.0001) ?? 0.1);
export function formatFileSize(bytes: number) {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index++;
  }
  return `${size.toFixed(2)}${units[index]}`;
}
