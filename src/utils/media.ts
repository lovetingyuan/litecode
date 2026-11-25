import type { Doc, Group, MediaView, PdfScale } from "../types/types";

export const isTextDocument = (doc: Doc) =>
  !doc.gitDiff && (!doc.kind || doc.kind === "text" || doc.kind === "svg");
export const isMarkdownDocument = (doc: Doc) =>
  isTextDocument(doc) && doc.kind !== "svg" && doc.language === "markdown";
export const isHtmlDocument = (doc: Doc) =>
  isTextDocument(doc) &&
  doc.kind !== "svg" &&
  (doc.path ? /\.html?$/i.test(doc.path) : doc.language === "html");
export const isMarkdownView = (doc: Doc, group?: Group) =>
  isMarkdownDocument(doc) && group?.mediaViews?.[doc.id]?.mode === "markdown";
export const isPackageView = (doc: Doc, group?: Group) =>
  isTextDocument(doc) &&
  /(?:^|[\\/])package\.json$/.test(doc.path ?? "") &&
  group?.mediaViews?.[doc.id]?.mode === "package";
export const isTextView = (doc: Doc, group?: Group) =>
  isTextDocument(doc) &&
  !isMarkdownView(doc, group) &&
  !isPackageView(doc, group) &&
  (doc.kind !== "svg" || group?.mediaViews?.[doc.id]?.mode === "text");
export const isImageView = (doc: Doc, group?: Group) =>
  doc.kind === "image" || (doc.kind === "svg" && !isTextView(doc, group));
export const isPdfView = (doc: Doc) => doc.kind === "pdf";
const zoomLevels = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.5, 2, 3, 5, 7, 10, 15, 20];
export const clampScale = (scale: number) => Math.max(0.1, Math.min(20, scale));
export const stepScale = (scale: number, direction: number) =>
  direction > 0
    ? (zoomLevels.find((level) => level > scale + 0.0001) ?? 20)
    : ([...zoomLevels].reverse().find((level) => level < scale - 0.0001) ?? 0.1);
const pdfZoomLevels = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 5];
export const clampPdfScale = (scale: number) => Math.max(0.25, Math.min(5, scale));
export const stepPdfScale = (scale: number, direction: number) =>
  direction > 0
    ? (pdfZoomLevels.find((level) => level > scale + 0.0001) ?? 5)
    : ([...pdfZoomLevels].reverse().find((level) => level < scale - 0.0001) ?? 0.25);
export const pdfZoomPresets: readonly PdfScale[] = [
  "fit-width",
  "fit-page",
  4,
  3,
  2,
  1.5,
  1.25,
  1,
  0.75,
  0.5,
  0.25,
];
export function formatPdfScale(scale: PdfScale): string {
  if (scale === "fit-width") {
    return "Fit Width";
  }
  if (scale === "fit-page") {
    return "Fit Page";
  }
  return `${Math.round(scale * 100)}%`;
}
export function normalizePdfScale(scale: MediaView["scale"]): PdfScale {
  let normalized: PdfScale = "fit-width";
  if (typeof scale === "number" && Number.isFinite(scale)) {
    normalized = clampPdfScale(scale);
  } else if (scale === "fit-page" || scale === "fit") {
    normalized = "fit-page";
  }
  return normalized;
}
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
