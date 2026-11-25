import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PasswordResponses, type PDFDocumentLoadingTask, type PDFDocumentProxy } from "pdfjs-dist";
import { patchDoc, patchMediaView } from "../editor/documents";
import {
  PDF_STAGE_PADDING,
  computePdfLayout,
  computeVisiblePages,
  openPdfLoadingTask,
  type PdfPageSize,
} from "../pdf/runtime";
import { clampPdfScale, normalizePdfScale, stepPdfScale } from "../utils/media";
import { Icon, actionButtonClass } from "./ui";
import { PdfPage } from "./PdfPage";
import { PdfToolbar } from "./PdfToolbar";
import type { Doc, Group, PdfRotation, PdfScale } from "../types/types";

type PdfPreviewProps = Readonly<{
  doc: Doc;
  group: Group;
  source: string;
  onReady(): void;
  onError(): void;
}>;

type PasswordPrompt = {
  incorrect: boolean;
  submit: (password: string) => void;
};

const DEFAULT_PAGE_SIZE: PdfPageSize = { width: 612, height: 792 };

function nextRotation(rotation: PdfRotation): PdfRotation {
  if (rotation === 0) {
    return 90;
  }
  if (rotation === 90) {
    return 180;
  }
  if (rotation === 180) {
    return 270;
  }
  return 0;
}

export function PdfPreview({ doc, group, source, onReady, onError }: PdfPreviewProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [defaultSize, setDefaultSize] = useState<PdfPageSize>(DEFAULT_PAGE_SIZE);
  const [pageSizes, setPageSizes] = useState<ReadonlyMap<number, PdfPageSize>>(() => new Map());
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [passwordPrompt, setPasswordPrompt] = useState<PasswordPrompt | null>(null);
  const [passwordValue, setPasswordValue] = useState("");
  const [visible, setVisible] = useState({ startIndex: 0, endIndex: 0, currentPage: 1 });

  const view = group.mediaViews?.[doc.id];
  const scaleMode = normalizePdfScale(view?.scale);
  const rotation: PdfRotation = view?.rotation ?? 0;

  const callbacksRef = useRef({ onReady, onError });
  callbacksRef.current = { onReady, onError };

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;

    setPdf(null);
    setPageSizes(new Map());
    setPasswordPrompt(null);
    setPasswordValue("");

    void (async () => {
      try {
        loadingTask = await openPdfLoadingTask(
          source,
          controller.signal,
          (updatePassword, reason) => {
            if (disposed) {
              return;
            }
            setPasswordValue("");
            setPasswordPrompt({
              incorrect: reason === PasswordResponses.INCORRECT_PASSWORD,
              submit: updatePassword,
            });
            callbacksRef.current.onReady();
          },
        );
        if (disposed) {
          void loadingTask.destroy();
          return;
        }
        const loaded = await loadingTask.promise;
        if (disposed) {
          void loadingTask.destroy();
          return;
        }
        const firstPage = await loaded.getPage(1);
        if (disposed) {
          return;
        }
        const firstViewport = firstPage.getViewport({ scale: 1 });
        setPasswordPrompt(null);
        setDefaultSize({ width: firstViewport.width, height: firstViewport.height });
        setPdf(loaded);
        patchDoc(doc.id, { pdfInfo: { pageCount: loaded.numPages } });
        callbacksRef.current.onReady();
      } catch {
        if (!disposed && !controller.signal.aborted) {
          patchDoc(doc.id, { pdfInfo: undefined });
          callbacksRef.current.onError();
        }
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
      if (loadingTask) {
        void loadingTask.destroy();
      }
    };
  }, [source, doc.id]);

  const pageCount = pdf?.numPages ?? 0;
  const layout = computePdfLayout(
    pageCount,
    defaultSize,
    pageSizes,
    scaleMode,
    viewport.width,
    viewport.height,
    rotation,
  );
  const stageWidth = Math.max(viewport.width, layout.maxWidth + PDF_STAGE_PADDING * 2);

  const zoomRef = useRef({ effectiveScale: layout.scale, groupId: group.id, id: doc.id });
  useLayoutEffect(() => {
    zoomRef.current = { effectiveScale: layout.scale, groupId: group.id, id: doc.id };
  }, [layout.scale, group.id, doc.id]);

  const savedView = useRef({
    left: view?.scrollLeft ?? 0,
    top: view?.scrollTop ?? 0,
    page: view?.page,
  });
  const restoring = useRef(true);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(scrollTimer.current), []);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      setViewport({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const current = zoomRef.current;
      patchMediaView(current.groupId, current.id, {
        scale: clampPdfScale(current.effectiveScale * (event.deltaY > 0 ? 0.925 : 1.075)),
      });
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      observer.disconnect();
      element.removeEventListener("wheel", onWheel);
    };
  }, [pdf]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!pdf || !viewport.height || !element) {
      return;
    }
    if (restoring.current) {
      element.scrollLeft = savedView.current.left;
      element.scrollTop = savedView.current.top;
      restoring.current = false;
    }
    const next = computeVisiblePages(layout.pages, element.scrollTop, viewport.height);
    setVisible((current) =>
      current.startIndex === next.startIndex &&
      current.endIndex === next.endIndex &&
      current.currentPage === next.currentPage
        ? current
        : next,
    );
  }, [pdf, viewport.height, layout.pages]);

  function handleMeasure(pageNumber: number, size: PdfPageSize) {
    setPageSizes((current) => {
      const existing = current.get(pageNumber) ?? defaultSize;
      if (
        Math.abs(existing.width - size.width) < 0.5 &&
        Math.abs(existing.height - size.height) < 0.5
      ) {
        return current;
      }
      const next = new Map(current);
      next.set(pageNumber, size);
      return next;
    });
  }

  function handleScroll(element: HTMLDivElement) {
    const next = computeVisiblePages(layout.pages, element.scrollTop, element.clientHeight);
    setVisible((current) =>
      current.startIndex === next.startIndex &&
      current.endIndex === next.endIndex &&
      current.currentPage === next.currentPage
        ? current
        : next,
    );
    if (restoring.current) {
      return;
    }
    clearTimeout(scrollTimer.current);
    const scrollLeft = element.scrollLeft;
    const scrollTop = element.scrollTop;
    const page = next.currentPage;
    scrollTimer.current = setTimeout(() => {
      patchMediaView(group.id, doc.id, { scrollLeft, scrollTop, page });
    }, 120);
  }

  function jumpToPage(pageNumber: number) {
    const target = layout.pages[pageNumber - 1];
    const element = viewportRef.current;
    if (!target || !element) {
      return;
    }
    element.scrollTop = Math.max(0, target.top - PDF_STAGE_PADDING);
    patchMediaView(group.id, doc.id, { page: pageNumber, scrollTop: element.scrollTop });
  }

  function updateScale(next: PdfScale) {
    patchMediaView(group.id, doc.id, { scale: next });
  }

  if (passwordPrompt) {
    return (
      <form
        className="w-full h-full flex flex-col items-center justify-center p-8 gap-4 text-center"
        onSubmit={(event) => {
          event.preventDefault();
          if (passwordValue) {
            passwordPrompt.submit(passwordValue);
          }
        }}
      >
        <Icon name="lock" className="text-[40px] text-muted" />
        <p className="m-0 text-[15px]">
          {passwordPrompt.incorrect
            ? "Incorrect password. Try again to open this PDF."
            : "This PDF is password protected."}
        </p>
        <div className="flex items-center gap-2">
          <input
            type="password"
            aria-label="PDF password"
            placeholder="Enter password"
            autoFocus
            value={passwordValue}
            onChange={(event) => setPasswordValue(event.target.value)}
            className="w-56"
          />
          <button type="submit" className={`${actionButtonClass} primary bg-button`}>
            Open
          </button>
        </div>
      </form>
    );
  }

  if (!pdf) {
    return null;
  }

  const renderedPages = layout.pages.slice(visible.startIndex, visible.endIndex + 1);

  return (
    <div className="pdf-preview w-full h-full flex flex-col min-h-0 min-w-0">
      <PdfToolbar
        page={visible.currentPage}
        pageCount={pageCount}
        scale={scaleMode}
        effectiveScale={layout.scale}
        onJumpToPage={jumpToPage}
        onZoomStep={(direction) => updateScale(stepPdfScale(layout.scale, direction))}
        onSelectScale={updateScale}
        onRotate={() => patchMediaView(group.id, doc.id, { rotation: nextRotation(rotation) })}
      />
      <div
        ref={viewportRef}
        className="pdf-viewport flex-1 min-h-0 w-full overflow-auto"
        tabIndex={0}
        aria-label={`PDF preview: ${doc.name}`}
        onScroll={(event) => handleScroll(event.currentTarget)}
        onKeyDown={(event) => {
          if (event.target instanceof HTMLInputElement) {
            return;
          }
          if (event.key === "+" || event.key === "=") {
            event.preventDefault();
            updateScale(stepPdfScale(layout.scale, 1));
          } else if (event.key === "-") {
            event.preventDefault();
            updateScale(stepPdfScale(layout.scale, -1));
          } else if (event.key === "0") {
            event.preventDefault();
            updateScale(1);
          }
        }}
      >
        <div
          className="pdf-stage relative"
          style={{ width: stageWidth, height: layout.totalHeight }}
        >
          {renderedPages.map((frame) => (
            <PdfPage
              key={frame.pageNumber}
              pdf={pdf}
              frame={frame}
              left={Math.max(PDF_STAGE_PADDING, Math.round((stageWidth - frame.width) / 2))}
              scale={layout.scale}
              rotation={rotation}
              onMeasure={handleMeasure}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
