import { readFileSync, writeFileSync } from "node:fs";
import { creationPatches, installCreationModules } from "./patch-trees-creation.mjs";
import { stripLegacyCreation } from "./trees/legacyCreation.mjs";

// Keep the beta.6 fixes reproducible: sticky scroll, padding, ignore inheritance and an
// application-owned drop request so confirmation never needs an optimistic move.
const root = new URL("../node_modules/@pierre/trees/", import.meta.url);
const { version } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
if (version !== "1.0.0-beta.6") {
  throw new Error("Review the trees scroll and drag patches before upgrading @pierre/trees.");
}

const patches = [
  [
    "dist/model/layout.js",
    [
      [
        "const totalHeight = totalRowCount * metrics.itemHeight;",
        "const totalHeight = totalRowCount * metrics.itemHeight + Math.max(0, metrics.paddingBottom ?? 0);",
      ],
    ],
  ],
  [
    "dist/render/FileTreeView.js",
    [
      // Positive and negative ancestor matches belong to the current ignore set.
      [
        "const ignoredInheritanceCache = useMemo(() => /* @__PURE__ */ new Map(), []);",
        "const ignoredInheritanceCache = useMemo(() => /* @__PURE__ */ new Map(), [ignoredGitDirectories]);",
      ],
      [
        '"data-file-tree-virtualized-root": "true",',
        '"data-file-tree-root-drag-target": dragTarget?.kind === "root" ? "true" : void 0,\n\t\t"data-file-tree-virtualized-root": "true",',
      ],
      [
        "if (!(rowButton instanceof HTMLElement)) return null;",
        'if (!(rowButton instanceof HTMLElement)) return target?.closest?.("[data-file-tree-virtualized-scroll]") ? { kind: "root", directoryPath: null, flattenedSegmentPath: null, hoveredPath: null } : null;',
      ],
      [
        "if (shouldUseCustomPointerDragImage()) {\n\t\t\t\tconst preview = createDragPreviewElement(dragSource);",
        'if (shouldUseCustomPointerDragImage()) {\n\t\t\t\tconst preview = createDragPreviewElement(dragSource);\n\t\t\t\tconst count = controller.getDragSession()?.draggedPaths.length ?? 1;\n\t\t\t\tif (count > 1) {\n\t\t\t\t\tconst badge = document.createElement("span");\n\t\t\t\t\tbadge.textContent = String(count);\n\t\t\t\t\tbadge.dataset.fileTreeDragCount = "true";\n\t\t\t\t\tObject.assign(badge.style, { marginLeft: "12px", borderRadius: "12px", background: "#0078d4", color: "white", padding: "0 7px", lineHeight: "22px" });\n\t\t\t\t\tpreview.append(badge);\n\t\t\t\t}',
      ],
      [
        'updateDragPoint(event.clientX, event.clientY);\n\t\tif (event.dataTransfer != null) event.dataTransfer.dropEffect = "move";',
        'updateDragPoint(event.clientX, event.clientY);\n\t\tif (event.dataTransfer != null) event.dataTransfer.dropEffect = controller.getDragSession()?.target == null ? "none" : "move";',
      ],
      [
        "if (rootNode instanceof ShadowRoot && (element == null || !rootNode.contains(element))) return getShadowPointElementByGeometry(rootNode, clientX, clientY);",
        'if (rootNode instanceof ShadowRoot && (element == null || !rootNode.contains(element))) {\n\t\tconst row = getShadowPointElementByGeometry(rootNode, clientX, clientY);\n\t\tif (row) return row;\n\t\tconst scroller = rootNode.querySelector("[data-file-tree-virtualized-scroll]");\n\t\tconst rect = scroller?.getBoundingClientRect();\n\t\treturn rect && clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom ? scroller : null;\n\t}',
      ],
      [
        "function computeFileTreeViewLayoutState({ controller, itemHeight, overscan, scrollTop, stickyFolders, viewportHeight }) {",
        "function computeFileTreeViewLayoutState({ controller, itemHeight, overscan, scrollTop, stickyFolders, viewportHeight, paddingBottom = 0 }) {",
      ],
      // Constrain the layout itself, so occlusion and focus use the rendered stack.
      [
        "function computeFileTreeViewLayoutState(",
        `// Match VS Code's default tree sticky scroll limits.
function getStickyRowCount(itemHeight, viewportHeight) {
\treturn Math.max(0, Math.min(7, Math.floor(viewportHeight * 0.4 / itemHeight)));
}
function constrainStickyRows(rows, itemHeight, viewportHeight) {
\treturn rows.slice(0, getStickyRowCount(itemHeight, viewportHeight));
}
function computeFileTreeViewLayoutState(`,
      ],
      [
        "stickyRows: stickyCandidates == null ? void 0 : computeStickyRowsFromCandidates(stickyCandidates, scrollTop, itemHeight, visibleCount),",
        "stickyRows: constrainStickyRows(stickyCandidates == null ? computeStickyRows(visibleRows, scrollTop, itemHeight) : computeStickyRowsFromCandidates(stickyCandidates, scrollTop, itemHeight, visibleCount), itemHeight, viewportHeight),",
      ],
      [
        "const overlayRows = previewStickyCandidates != null && scrollTop <= 0 ? computeStickyRowsFromCandidates(previewStickyCandidates, 1, itemHeight, visibleCount) : stickyFolders && scrollTop <= 0 && visibleRows.length > 0 ? computeStickyRows(visibleRows, 1, itemHeight) : snapshot.sticky.rows;",
        "const overlayRows = constrainStickyRows(previewStickyCandidates != null && scrollTop <= 0 ? computeStickyRowsFromCandidates(previewStickyCandidates, 1, itemHeight, visibleCount) : stickyFolders && scrollTop <= 0 && visibleRows.length > 0 ? computeStickyRows(visibleRows, 1, itemHeight) : snapshot.sticky.rows, itemHeight, viewportHeight);",
      ],
      [
        'targetOffset === "sticky-parents" ? focusedRow.ancestorPaths.length * itemHeight',
        'targetOffset === "sticky-parents" ? Math.min(focusedRow.ancestorPaths.length, getStickyRowCount(itemHeight, liveViewportHeight)) * itemHeight',
      ],
      [
        "initialFocusedRow.ancestorPaths.length * itemHeight",
        "Math.min(initialFocusedRow.ancestorPaths.length, getStickyRowCount(itemHeight, initialViewportHeightPx)) * itemHeight",
      ],
      [
        "scrollRequestRow.ancestorPaths.length * itemHeight",
        "Math.min(scrollRequestRow.ancestorPaths.length, getStickyRowCount(itemHeight, resolvedViewportHeight)) * itemHeight",
      ],
      [
        'const shouldToggleDirectory = plan.toggleDirectory && row.kind === "directory";',
        'const shouldToggleDirectory = plan.toggleDirectory && row.kind === "directory" && (mode !== "sticky" || event.target instanceof Element && event.target.closest(\'[data-item-section="icon"]\') != null);',
      ],
      [
        "\t\titemHeight,\n\t\toverscan,\n\t\tscrollTop,\n\t\tstickyRows:",
        "\t\titemHeight,\n\t\toverscan,\n\t\tpaddingBottom,\n\t\tscrollTop,\n\t\tstickyRows:",
      ],
      [
        "const maxScrollTop = Math.max(0, nextItemCount * itemHeight - nextViewportHeight);",
        'const paddingBottom = Math.max(0, parseFloat(getComputedStyle(scrollElement).getPropertyValue("--trees-scroll-padding-bottom")) || 0);\n\t\t\tconst maxScrollTop = Math.max(0, nextItemCount * itemHeight + paddingBottom - nextViewportHeight);',
      ],
      [
        "\t\t\t\tviewportHeight: nextViewportHeight\n",
        "\t\t\t\tviewportHeight: nextViewportHeight,\n\t\t\t\tpaddingBottom\n",
      ],
      [
        "const windowHeight = layoutSnapshot.window.height;",
        "const windowHeight = layoutSnapshot.window.height + (layoutSnapshot.window.endIndex === layoutSnapshot.physical.totalRowCount - 1 ? Math.max(0, totalScrollableHeight - layoutSnapshot.physical.totalRowCount * itemHeight) : 0);",
      ],
    ],
  ],
  [
    "dist/model/publicTypes.d.ts",
    [
      [
        "onDropComplete?: (event: FileTreeDropResult) => void;",
        "onDropRequest?: (event: FileTreeDropContext) => void;\n  onDropComplete?: (event: FileTreeDropResult) => void;",
      ],
    ],
  ],
  [
    "dist/model/FileTreeController.js",
    [
      [
        "if (this.#dragSession != null && isPathMutationEvent(event)) this.#dragSession = null;",
        'if (this.#dragSession != null && isPathMutationEvent(event) && event.operation !== "add" && !(event.operation === "batch" && event.events.every(child => child.operation === "add"))) this.#dragSession = null;',
      ],
      [
        "const dropPlan = buildDropOperations(dragSession.draggedPaths, target);",
        "if (this.#dragAndDropConfig?.onDropRequest != null) {\n\t\t\tthis.#emit();\n\t\t\tthis.#dragAndDropConfig.onDropRequest(dropContext);\n\t\t\treturn true;\n\t\t}\n\t\tconst dropPlan = buildDropOperations(dragSession.draggedPaths, target);",
      ],
    ],
  ],
];

// Validate every hunk before writing either file; safe to run again after install.
const grouped = new Map();
for (const [path, replacements] of [...patches, ...creationPatches]) {
  grouped.set(path, [...(grouped.get(path) ?? []), ...replacements]);
}
const updates = [...grouped].map(([path, replacements]) => {
  const file = new URL(path, root);
  let source = stripLegacyCreation(path, readFileSync(file, "utf8"));
  for (const [before, after] of replacements) {
    if (source.includes(after)) {
      continue;
    }
    const matches =
      before instanceof RegExp ? source.match(before)?.length : source.split(before).length - 1;
    if (matches !== 1) {
      throw new Error(
        `Cannot apply trees scroll/drag patch to ${path}: ${String(before).slice(0, 90)}`,
      );
    }
    source = source.replace(before, after);
  }
  return { file, source };
});
for (const { file, source } of updates) {
  writeFileSync(file, source);
}
installCreationModules(root);
