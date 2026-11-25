import workbenchStyles from "../styles/workbench.module.css";
import mediaPreviewStyles from "./MediaPreview.module.css";
import pdfStyles from "./PdfPreview.module.css";
import { Menu } from "@base-ui/react/menu";
import { useEffect, useState } from "react";
import { formatPdfScale, pdfZoomPresets } from "../utils/media";
import { Icon, IconButton } from "./ui";
import type { PdfScale } from "../types/types";

type PdfToolbarProps = Readonly<{
  page: number;
  pageCount: number;
  scale: PdfScale;
  effectiveScale: number;
  onJumpToPage(page: number): void;
  onZoomStep(direction: number): void;
  onSelectScale(scale: PdfScale): void;
  onRotate(): void;
}>;

export function PdfToolbar({
  page,
  pageCount,
  scale,
  effectiveScale,
  onJumpToPage,
  onZoomStep,
  onSelectScale,
  onRotate,
}: PdfToolbarProps) {
  const [draftPage, setDraftPage] = useState(String(page));

  useEffect(() => {
    setDraftPage(String(page));
  }, [page]);

  function commitPage() {
    const parsed = Number.parseInt(draftPage.trim(), 10);
    if (Number.isFinite(parsed)) {
      const clamped = Math.max(1, Math.min(pageCount, parsed));
      setDraftPage(String(clamped));
      onJumpToPage(clamped);
    } else {
      setDraftPage(String(page));
    }
  }

  const scaleLabel =
    typeof scale === "number"
      ? formatPdfScale(scale)
      : `${formatPdfScale(scale)} (${Math.round(effectiveScale * 100)}%)`;

  return (
    <div
      className={`pdf-toolbar flex items-center justify-center gap-2 px-3 bg-sidebar border-b border-b-panel text-[12px] text-foreground shrink-0 ${pdfStyles["pdf-toolbar"]}`}
      role="toolbar"
      aria-label="PDF viewer controls"
    >
      <div className="flex items-center gap-1">
        <IconButton
          icon="chevron-up"
          label="Previous Page"
          disabled={page <= 1}
          onClick={() => onJumpToPage(Math.max(1, page - 1))}
        />
        <input
          type="text"
          inputMode="numeric"
          className={`pdf-page-input text-[12px] ${pdfStyles["pdf-page-input"]}`}
          aria-label="Page number"
          value={draftPage}
          onChange={(event) => setDraftPage(event.target.value)}
          onBlur={commitPage}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitPage();
            } else if (event.key === "Escape") {
              setDraftPage(String(page));
              event.currentTarget.blur();
            }
          }}
        />
        <span className="text-muted whitespace-nowrap">/ {pageCount}</span>
        <IconButton
          icon="chevron-down"
          label="Next Page"
          disabled={page >= pageCount}
          onClick={() => onJumpToPage(Math.min(pageCount, page + 1))}
        />
      </div>

      <span className="h-3.5 w-px bg-panel" aria-hidden="true" />

      <div className="flex items-center gap-1">
        <IconButton
          icon="zoom-out"
          label="Zoom Out (-)"
          disabled={effectiveScale <= 0.25}
          onClick={() => onZoomStep(-1)}
        />
        <Menu.Root>
          <Menu.Trigger
            className="h-6 px-2 inline-flex items-center gap-1 text-[12px] rounded-[3px] whitespace-nowrap"
            title="Zoom Level"
            aria-label={`Zoom Level: ${scaleLabel}`}
          >
            <span>{scaleLabel}</span>
            <Icon name="chevron-down" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner className="z-90" side="bottom" align="center" sideOffset={4}>
              <Menu.Popup
                className={`context-menu text-foreground border border-strong z-[90] ${workbenchStyles["context-menu"]} media-menu min-w-40 p-1 bg-menu rounded-[6px] ${mediaPreviewStyles["media-menu"]}`}
                aria-label="Select PDF zoom level"
              >
                {pdfZoomPresets.map((preset) => (
                  <Menu.Item key={String(preset)} onClick={() => onSelectScale(preset)}>
                    <Icon name={preset === scale ? "check" : "blank"} />
                    <span>{formatPdfScale(preset)}</span>
                  </Menu.Item>
                ))}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
        <IconButton
          icon="zoom-in"
          label="Zoom In (+)"
          disabled={effectiveScale >= 5}
          onClick={() => onZoomStep(1)}
        />
      </div>

      <span className="h-3.5 w-px bg-panel" aria-hidden="true" />

      <div className="flex items-center gap-1">
        <IconButton
          icon={scale === "fit-width" ? "screen-normal" : "screen-full"}
          label={scale === "fit-width" ? "Fit Page" : "Fit Width"}
          onClick={() => onSelectScale(scale === "fit-width" ? "fit-page" : "fit-width")}
        />
        <IconButton icon="redo" label="Rotate Clockwise" onClick={onRotate} />
      </div>
    </div>
  );
}
