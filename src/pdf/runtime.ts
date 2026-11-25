import {
  GlobalWorkerOptions,
  PDFDataRangeTransport,
  VerbosityLevel,
  getDocument,
  type PDFDocumentLoadingTask,
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { clampPdfScale } from "../utils/media";
import type { PdfRotation, PdfScale } from "../types/types";

export const PDF_PAGE_GAP = 16;
export const PDF_STAGE_PADDING = 16;
const RANGE_STREAM_THRESHOLD = 256 * 1024;
const RANGE_CHUNK_SIZE = 65536;
const MAX_CONCURRENT_RANGES = 2;
const MAX_CANVAS_PIXELS = 16_777_216;

let workerConfigured = false;
function ensurePdfWorker() {
  if (!workerConfigured) {
    GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    workerConfigured = true;
  }
}

export type PdfPageSize = { width: number; height: number };

export type PdfPageFrame = {
  pageNumber: number;
  width: number;
  height: number;
  top: number;
};

export type PdfLayout = {
  scale: number;
  pages: PdfPageFrame[];
  totalHeight: number;
  maxWidth: number;
};

export function rotatedPageSize(size: PdfPageSize, rotation: PdfRotation): PdfPageSize {
  return rotation === 90 || rotation === 270 ? { width: size.height, height: size.width } : size;
}

export function resolvePdfScale(
  mode: PdfScale,
  baseSize: PdfPageSize,
  viewportWidth: number,
  viewportHeight: number,
  rotation: PdfRotation,
): number {
  if (typeof mode === "number") {
    return clampPdfScale(mode);
  }
  const rotated = rotatedPageSize(baseSize, rotation);
  const availableWidth = Math.max(120, viewportWidth - PDF_STAGE_PADDING * 2);
  const availableHeight = Math.max(120, viewportHeight - PDF_STAGE_PADDING * 2);
  if (mode === "fit-page") {
    return clampPdfScale(
      Math.min(availableWidth / rotated.width, availableHeight / rotated.height),
    );
  }
  return clampPdfScale(availableWidth / rotated.width);
}

export function computePdfLayout(
  pageCount: number,
  defaultSize: PdfPageSize,
  overrides: ReadonlyMap<number, PdfPageSize>,
  mode: PdfScale,
  viewportWidth: number,
  viewportHeight: number,
  rotation: PdfRotation,
): PdfLayout {
  const scale = resolvePdfScale(mode, defaultSize, viewportWidth, viewportHeight, rotation);
  const pages: PdfPageFrame[] = [];
  let top = PDF_STAGE_PADDING;
  let maxWidth = 0;
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    const raw = overrides.get(pageNumber) ?? defaultSize;
    const rotated = rotatedPageSize(raw, rotation);
    const width = Math.max(1, Math.round(rotated.width * scale));
    const height = Math.max(1, Math.round(rotated.height * scale));
    pages.push({ pageNumber, width, height, top });
    if (width > maxWidth) {
      maxWidth = width;
    }
    top += height + PDF_PAGE_GAP;
  }
  const totalHeight =
    pageCount > 0 ? top - PDF_PAGE_GAP + PDF_STAGE_PADDING : PDF_STAGE_PADDING * 2;
  return { scale, pages, totalHeight, maxWidth };
}

export function computeVisiblePages(
  pages: readonly PdfPageFrame[],
  scrollTop: number,
  viewportHeight: number,
  overscanPx = 700,
): { startIndex: number; endIndex: number; currentPage: number } {
  if (pages.length === 0) {
    return { startIndex: 0, endIndex: -1, currentPage: 1 };
  }
  const windowTop = Math.max(0, scrollTop - overscanPx);
  const windowBottom = scrollTop + Math.max(1, viewportHeight) + overscanPx;
  const focusY = scrollTop + Math.max(1, viewportHeight) * 0.35;

  let low = 0;
  let high = pages.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (pages[mid].top + pages[mid].height < windowTop) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  const startIndex = low;

  let endIndex = startIndex;
  while (endIndex + 1 < pages.length && pages[endIndex + 1].top <= windowBottom) {
    endIndex++;
  }

  let currentLow = 0;
  let currentHigh = pages.length - 1;
  while (currentLow < currentHigh) {
    const mid = (currentLow + currentHigh) >> 1;
    if (pages[mid].top + pages[mid].height < focusY) {
      currentLow = mid + 1;
    } else {
      currentHigh = mid;
    }
  }

  return {
    startIndex,
    endIndex,
    currentPage: pages[currentLow].pageNumber,
  };
}

export function computeCanvasOutputScale(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
): number {
  const safeDpr = Math.max(1, Math.min(devicePixelRatio || 1, 2.5));
  const area = Math.max(1, cssWidth) * Math.max(1, cssHeight);
  const maxScaleForMemory = Math.sqrt(MAX_CANVAS_PIXELS / area);
  return Math.max(0.5, Math.min(safeDpr, maxScaleForMemory));
}

type RangeRequest = { begin: number; end: number };

class MediaRangeTransport extends PDFDataRangeTransport {
  private readonly controller = new AbortController();
  private readonly queue: RangeRequest[] = [];
  private active = 0;
  private aborted = false;

  constructor(
    private readonly url: string,
    length: number,
  ) {
    super(length, null);
  }

  override requestDataRange(begin: number, end: number) {
    if (this.aborted) {
      return;
    }
    this.queue.push({ begin, end });
    this.pump();
  }

  override abort() {
    this.aborted = true;
    this.queue.length = 0;
    this.controller.abort();
  }

  private pump() {
    while (!this.aborted && this.active < MAX_CONCURRENT_RANGES && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.active++;
      void this.fetchRange(next.begin, next.end).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  private async fetchRangeAttempt(
    begin: number,
    inclusiveEnd: number,
  ): Promise<{ kind: "ok"; bytes: Uint8Array } | { kind: "retry" | "fail" }> {
    try {
      const response = await fetch(this.url, {
        headers: { Range: `bytes=${begin}-${inclusiveEnd}` },
        signal: this.controller.signal,
      });
      if (response.status === 503) {
        return { kind: "retry" };
      }
      if (!response.ok) {
        return { kind: "fail" };
      }
      return { kind: "ok", bytes: new Uint8Array(await response.arrayBuffer()) };
    } catch {
      return { kind: "retry" };
    }
  }

  private async fetchRange(begin: number, end: number) {
    const inclusiveEnd = Math.max(begin, end - 1);
    for (let attempt = 0; attempt < 3 && !this.aborted; attempt++) {
      const result = await this.fetchRangeAttempt(begin, inclusiveEnd);
      if (this.aborted) {
        return;
      }
      if (result.kind === "ok") {
        this.onDataRange(begin, result.bytes);
        return;
      }
      if (result.kind === "fail" || attempt === 2) {
        this.onDataRange(begin, null);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
    }
  }
}

export async function openPdfLoadingTask(
  source: string,
  signal: AbortSignal,
  onPassword?: (updatePassword: (password: string) => void, reason: number) => void,
): Promise<PDFDocumentLoadingTask> {
  ensurePdfWorker();
  const baseOptions = {
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    iccUrl: "/pdfjs/iccs/",
    wasmUrl: "/pdfjs/wasm/",
    useWasm: true,
    enableHWA: true,
    disableWorkerRendering: true,
    verbosity: VerbosityLevel.ERRORS,
  };

  const head = await fetch(source, { method: "HEAD", signal });
  if (!head.ok) {
    throw new Error(`Failed to read PDF metadata (HTTP ${head.status}).`);
  }
  const length = Number(head.headers.get("content-length") ?? "");
  if (!Number.isFinite(length) || length <= 0) {
    throw new Error("PDF file is empty.");
  }
  const supportsRanges = head.headers.get("accept-ranges")?.toLowerCase() === "bytes";

  let task: PDFDocumentLoadingTask;
  if (supportsRanges && length > RANGE_STREAM_THRESHOLD) {
    const transport = new MediaRangeTransport(source, length);
    task = getDocument({
      ...baseOptions,
      range: transport,
      rangeChunkSize: RANGE_CHUNK_SIZE,
      disableAutoFetch: true,
      disableStream: true,
    });
  } else {
    const response = await fetch(source, { signal });
    if (!response.ok) {
      throw new Error(`Failed to load PDF file (HTTP ${response.status}).`);
    }
    const data = new Uint8Array(await response.arrayBuffer());
    task = getDocument({
      ...baseOptions,
      data,
    });
  }
  if (onPassword) {
    task.onPassword = onPassword;
  }
  return task;
}
