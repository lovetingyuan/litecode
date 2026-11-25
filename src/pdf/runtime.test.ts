import { afterEach, describe, expect, it, vi } from "vitest";

const getDocumentMock = vi.hoisted(() => vi.fn());

vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "/pdf.worker.min.mjs" }));
vi.mock("pdfjs-dist", () => {
  class MockPDFDataRangeTransport {
    length: number;
    initialData: Uint8Array | null;
    chunks: Array<{ begin: number; chunk: Uint8Array | null }> = [];
    constructor(length: number, initialData: Uint8Array | null) {
      this.length = length;
      this.initialData = initialData;
    }
    onDataRange(begin: number, chunk: Uint8Array | null) {
      this.chunks.push({ begin, chunk });
    }
    requestDataRange(_begin: number, _end: number) {}
    abort() {}
  }
  return {
    GlobalWorkerOptions: { workerSrc: "" },
    PDFDataRangeTransport: MockPDFDataRangeTransport,
    VerbosityLevel: { ERRORS: 0 },
    getDocument: getDocumentMock,
  };
});

import {
  PDF_PAGE_GAP,
  PDF_STAGE_PADDING,
  computeCanvasOutputScale,
  computePdfLayout,
  computeVisiblePages,
  openPdfLoadingTask,
} from "./runtime";

afterEach(() => {
  vi.unstubAllGlobals();
  getDocumentMock.mockReset();
});

describe("PDF layout and virtualization", () => {
  it("computes fit-width, fit-page, mixed page sizes, and rotation offsets", () => {
    const overrides = new Map([[2, { width: 800, height: 600 }]]);
    const fitWidth = computePdfLayout(
      3,
      { width: 600, height: 800 },
      overrides,
      "fit-width",
      632,
      900,
      0,
    );
    expect(fitWidth.scale).toBe(1);
    expect(fitWidth.pages).toEqual([
      { pageNumber: 1, width: 600, height: 800, top: PDF_STAGE_PADDING },
      {
        pageNumber: 2,
        width: 800,
        height: 600,
        top: PDF_STAGE_PADDING + 800 + PDF_PAGE_GAP,
      },
      {
        pageNumber: 3,
        width: 600,
        height: 800,
        top: PDF_STAGE_PADDING + 800 + PDF_PAGE_GAP + 600 + PDF_PAGE_GAP,
      },
    ]);
    expect(fitWidth.maxWidth).toBe(800);

    const rotated = computePdfLayout(
      1,
      { width: 600, height: 800 },
      new Map(),
      "fit-page",
      832,
      432,
      90,
    );
    // Rotated page is 800x600; available height is 400 -> scale = 400 / 600 = 0.6667
    expect(rotated.scale).toBeCloseTo(400 / 600, 4);
    expect(rotated.pages[0].width).toBe(Math.round(800 * (400 / 600)));
    expect(rotated.pages[0].height).toBe(400);
  });

  it("binary-searches visible page ranges and tracks current page across large documents", () => {
    const layout = computePdfLayout(500, { width: 600, height: 800 }, new Map(), 1, 900, 800, 0);
    const targetPage = layout.pages[249]; // Page 250
    const visible = computeVisiblePages(layout.pages, targetPage.top, 800, 700);
    expect(visible.currentPage).toBe(250);
    expect(visible.startIndex).toBe(248);
    expect(visible.endIndex).toBe(250);
    expect(visible.endIndex - visible.startIndex + 1).toBe(3);
  });

  it("caps backing canvas scale to keep GPU memory bounded at high zoom", () => {
    expect(computeCanvasOutputScale(800, 1000, 2)).toBe(2);
    const capped = computeCanvasOutputScale(4000, 5000, 2);
    expect(capped).toBeLessThan(2);
    expect(4000 * capped * 5000 * capped).toBeLessThanOrEqual(16_777_216 + 1);
  });
});

describe("PDF loading strategy", () => {
  it("loads small PDFs in a single GET without range streaming", async () => {
    const bytes = new Uint8Array([37, 80, 68, 70, 45]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { "Content-Length": String(bytes.byteLength), "Accept-Ranges": "bytes" },
        }),
      )
      .mockResolvedValueOnce(new Response(bytes, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const task = { onPassword: undefined };
    getDocumentMock.mockReturnValueOnce(task);

    await openPdfLoadingTask("http://media.localhost/small.pdf", new AbortController().signal);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: bytes,
        cMapUrl: "/pdfjs/cmaps/",
        standardFontDataUrl: "/pdfjs/standard_fonts/",
      }),
    );
  });

  it("streams large PDFs via Range transport without reading the full file", async () => {
    const chunkBytes = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { "Content-Length": String(50 * 1024 * 1024), "Accept-Ranges": "bytes" },
        }),
      )
      .mockResolvedValueOnce(new Response(chunkBytes, { status: 206 }));
    vi.stubGlobal("fetch", fetchMock);
    const task = { onPassword: undefined };
    getDocumentMock.mockReturnValueOnce(task);

    await openPdfLoadingTask("http://media.localhost/large.pdf", new AbortController().signal);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const options = getDocumentMock.mock.calls[0][0];
    expect(options.disableAutoFetch).toBe(true);
    expect(options.disableStream).toBe(true);
    expect(options.range).toBeDefined();

    options.range.requestDataRange(0, 4);
    await vi.waitFor(() => expect(options.range.chunks).toHaveLength(1));
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://media.localhost/large.pdf",
      expect.objectContaining({ headers: { Range: "bytes=0-3" } }),
    );
    expect(options.range.chunks[0]).toEqual({ begin: 0, chunk: chunkBytes });
  });
});
