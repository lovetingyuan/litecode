import workbenchStyles from "../styles/workbench.module.css";
import mediaPreviewStyles from "./MediaPreview.module.css";
import { Menu } from "@base-ui/react/menu";
import { patchMediaView } from "../editor/documents";
import { previewHtml, useHtmlPreviews } from "../core/htmlPreview";
import { errorMessage } from "../core/bridge";
import { notify, useApp } from "../store/store";
import { isWorkspacePackageDocument } from "../packages/document";
import {
  formatFileSize,
  isHtmlDocument,
  isImageView,
  isMarkdownDocument,
  isMarkdownView,
  isPackageView,
  isTextView,
} from "../utils/media";
import { Icon } from "./ui";
import type { Doc, Group, MediaView } from "../types/types";

export function MediaStatus({ doc, group }: Readonly<{ doc: Doc; group: Group }>) {
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
                <Menu.Popup
                  className={`context-menu text-foreground border border-strong z-[90] ${workbenchStyles["context-menu"]} media-menu min-w-45 p-1 bg-menu rounded-[6px] ${mediaPreviewStyles["media-menu"]}`}
                  aria-label="Select zoom level"
                >
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
          <span className={`status-item ${workbenchStyles["status-item"]}`} title="Image Size">
            {doc.imageSize.width}x{doc.imageSize.height}
          </span>
        </>
      )}
      {doc.fileInfo && (
        <span className={`status-item ${workbenchStyles["status-item"]}`} title="File Size">
          {formatFileSize(doc.fileInfo.size)}
        </span>
      )}
    </>
  );
}

export function EditorViewMenu({ doc, group }: Readonly<{ doc: Doc; group: Group }>) {
  const root = useApp((state) => state.root);
  const packageDocument = isWorkspacePackageDocument(doc, root);
  const html = isHtmlDocument(doc);
  const starting = useHtmlPreviews((state) => state.starting.includes(doc.id));
  const previewStarting = html && starting;
  const markdown = isMarkdownDocument(doc);
  const mode = editorViewMode(doc, group, packageDocument);
  let options: { mode: NonNullable<MediaView["mode"]> | "html" | "markdownRemote"; label: string }[];
  if (packageDocument) {
    options = [
      { mode: "text", label: "Edit" },
      { mode: "package", label: "Manage" },
    ];
  } else if (html) {
    options = [
      { mode: "text", label: "Edit" },
      { mode: "html", label: "HTML Preview" },
    ];
  } else if (markdown) {
    options = [
      { mode: "text", label: "Text Editor" },
      { mode: "markdown", label: "Markdown Preview" },
      { mode: "markdownRemote", label: "Preview with Remote Images" },
    ];
  } else {
    options = [
      { mode: "image", label: "Image Preview" },
      { mode: "text", label: "Text Editor" },
    ];
  }
  let type = "SVG";
  if (packageDocument) {
    type = "package.json";
  } else if (html) {
    type = "HTML";
  } else if (markdown) {
    type = "Markdown";
  }
  return (
    <Menu.Root>
      <Menu.Trigger
        className="editor-view-trigger"
        aria-label={`Select ${type} editor`}
        disabled={previewStarting}
      >
        {options.find((option) => option.mode === mode)?.label}
        <Icon name="chevron-down" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="z-90" side="bottom" align="end" sideOffset={0}>
          <Menu.Popup
            className={`context-menu text-foreground border border-strong z-[90] ${workbenchStyles["context-menu"]} media-menu min-w-45 p-1 bg-menu rounded-[6px] ${mediaPreviewStyles["media-menu"]}`}
            aria-label={`${type} editor type`}
          >
            {options.map((option) => (
              <Menu.Item
                key={option.mode}
                disabled={previewStarting}
                onClick={() => {
                  if (option.mode === "html") {
                    void previewHtml(doc.id).catch((error) => notify(errorMessage(error)));
                  } else {
                    selectPreview(group.id, doc.id, option.mode);
                  }
                }}
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

function selectPreview(
  groupId: string,
  docId: string,
  mode: NonNullable<MediaView["mode"]> | "markdownRemote",
) {
  patchMediaView(groupId, docId, {
    mode: mode === "markdownRemote" ? "markdown" : mode,
    allowRemoteImages: mode === "markdownRemote",
  });
}

function editorViewMode(doc: Doc, group: Group, packageDocument: boolean) {
  if (packageDocument) {
    return isPackageView(doc, group) ? "package" : "text";
  }
  if (isMarkdownView(doc, group)) {
    return group.mediaViews?.[doc.id]?.allowRemoteImages ? "markdownRemote" : "markdown";
  }
  return isTextView(doc, group) ? "text" : "image";
}
