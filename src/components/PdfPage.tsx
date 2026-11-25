import pdfStyles from "./PdfPreview.module.css";
import { useEffect, useRef } from "react";
import { TextLayer, setLayerDimensions, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import { computeCanvasOutputScale, type PdfPageFrame, type PdfPageSize } from "../pdf/runtime";
import type { PdfRotation } from "../types/types";

type PdfPageProps = Readonly<{
  pdf: PDFDocumentProxy;
  frame: PdfPageFrame;
  left: number;
  scale: number;
  rotation: PdfRotation;
  onMeasure(pageNumber: number, size: PdfPageSize): void;
}>;

function isCancelledRender(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "RenderingCancelledException" || error.name === "AbortException")
  );
}

export function PdfPage({ pdf, frame, left, scale, rotation, onMeasure }: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef(onMeasure);
  measureRef.current = onMeasure;

  useEffect(() => {
    const canvas = canvasRef.current;
    const textHost = textLayerRef.current;
    if (!canvas || !textHost) {
      return;
    }

    let cancelled = false;
    let renderTask: RenderTask | null = null;
    let textLayer: TextLayer | null = null;

    void (async () => {
      try {
        const page = await pdf.getPage(frame.pageNumber);
        if (cancelled) {
          return;
        }
        const baseViewport = page.getViewport({ scale: 1 });
        measureRef.current(frame.pageNumber, {
          width: baseViewport.width,
          height: baseViewport.height,
        });

        const totalRotation = (page.rotate + rotation) % 360;
        const viewport = page.getViewport({ scale, rotation: totalRotation });
        const outputScale = computeCanvasOutputScale(
          viewport.width,
          viewport.height,
          window.devicePixelRatio || 1,
        );

        canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
        canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        const transform = outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0];
        renderTask = page.render({ canvas, viewport, transform });
        await renderTask.promise;
        if (cancelled) {
          return;
        }

        textHost.replaceChildren();
        textHost.style.setProperty("--total-scale-factor", String(viewport.scale));
        setLayerDimensions(textHost, viewport);
        textLayer = new TextLayer({
          textContentSource: page.streamTextContent(),
          container: textHost,
          viewport,
        });
        await textLayer.render();
      } catch (error) {
        if (!cancelled && !isCancelledRender(error)) {
          // Individual page render errors stay isolated so remaining pages stay readable.
        }
      }
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
      textHost.replaceChildren();
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [pdf, frame.pageNumber, scale, rotation]);

  return (
    <div
      className={`pdf-page absolute overflow-hidden ${pdfStyles["pdf-page"]}`}
      data-page-number={frame.pageNumber}
      style={{
        top: frame.top,
        left,
        width: frame.width,
        height: frame.height,
      }}
    >
      <canvas ref={canvasRef} />
      <div ref={textLayerRef} className={`pdf-text-layer ${pdfStyles["pdf-text-layer"]}`} />
    </div>
  );
}
