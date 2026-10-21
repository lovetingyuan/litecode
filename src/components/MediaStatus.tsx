import { Menu } from "@base-ui/react/menu";
import { patchMediaView } from "../editor/documents";
import {
  formatFileSize,
  isImageView,
  isMarkdownDocument,
  isMarkdownView,
  isTextView,
} from "../utils/media";
import { Icon } from "./ui";
import type { Doc, Group, MediaView } from "../types/types";

export function MediaStatus({ doc, group }: { doc: Doc; group: Group }) {
  const scale = group.mediaViews?.[doc.id]?.scale ?? "fit";
  const label = (value: number | "fit") =>
    value === "fit" ? "Whole Image" : `${Math.round(value * 100)}%`;
  const sizes: (number | "fit")[] = [10, 5, 2, 1, 0.5, 0.2, "fit"];
  if (!sizes.includes(scale)) {
    sizes.unshift(scale);
  }
  return (
    <>
      {isImageView(doc, group) && !doc.deleted && doc.imageSize && (
        <>
          <Menu.Root>
            <Menu.Trigger title="Image Zoom" aria-label={`Image Zoom: ${label(scale)}`}>
              {label(scale)}
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner className="z-90" side="top" align="end" sideOffset={4}>
                <Menu.Popup className="context-menu media-menu" aria-label="Select zoom level">
                  {sizes.map((value) => (
                    <Menu.Item
                      key={value}
                      onClick={() => patchMediaView(group.id, doc.id, { scale: value })}
                    >
                      <Icon name={value === scale ? "check" : "blank"} />
                      <span>{label(value)}</span>
                    </Menu.Item>
                  ))}
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
          <span className="status-item" title="Image Size">
            {doc.imageSize.width}x{doc.imageSize.height}
          </span>
        </>
      )}
      {doc.fileInfo && (
        <span className="status-item" title="File Size">
          {formatFileSize(doc.fileInfo.size)}
        </span>
      )}
    </>
  );
}

export function EditorViewMenu({ doc, group }: { doc: Doc; group: Group }) {
  const markdown = isMarkdownDocument(doc);
  const mode = markdown
    ? isMarkdownView(doc, group)
      ? "markdown"
      : "text"
    : isTextView(doc, group)
      ? "text"
      : "image";
  const options: { mode: NonNullable<MediaView["mode"]>; label: string }[] = markdown
    ? [
        { mode: "text", label: "Text Editor" },
        { mode: "markdown", label: "Markdown Preview" },
      ]
    : [
        { mode: "image", label: "Image Preview" },
        { mode: "text", label: "Text Editor" },
      ];
  const type = markdown ? "Markdown" : "SVG";
  return (
    <Menu.Root>
      <Menu.Trigger className="editor-view-trigger" aria-label={`Select ${type} editor`}>
        {options.find((option) => option.mode === mode)?.label}
        <Icon name="chevron-down" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="z-90" side="bottom" align="end" sideOffset={0}>
          <Menu.Popup className="context-menu media-menu" aria-label={`${type} editor type`}>
            {options.map((option) => (
              <Menu.Item
                key={option.mode}
                onClick={() => patchMediaView(group.id, doc.id, { mode: option.mode })}
              >
                <Icon name={option.mode === mode ? "check" : "blank"} />
                <span>{option.label}</span>
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
