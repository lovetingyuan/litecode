import { readFileSync, writeFileSync } from "node:fs";
import { editingMethods } from "./trees/controller.mjs";

const types = `
interface FileTreeCreationOptions {
  parentPath: string;
  kind: 'newFile' | 'newFolder';
  validateSync?: (value: string) => string | null;
  validate: (value: string) => string | null | Promise<string | null>;
  onCommit: (value: string) => Promise<void>;
  onCancel?: () => void;
  onFinish?: () => void;
}
`;
const methods = `
  startCreating(options: FileTreeCreationOptions): string | null;
  cancelCreating(): void;
  getCreatingPath(): string | null;
  cancelEditing(): void;
  getEditingPath(): string | null;
`;

export const creationPatches = [
  [
    "dist/render/FileTree.d.ts",
    [
      [
        /(?:interface FileTreeCreationOptions \{[\s\S]*?\}\n)?declare class FileTree/,
        types + "declare class FileTree",
      ],
      ["  startRenaming(", methods + "  startRenaming("],
    ],
  ],
  [
    "dist/model/publicTypes.d.ts",
    [
      [
        /interface FileTreeRenamingConfig \{\n(?:  onStart\?:[\s\S]*?\} \| null;\n)?/,
        `interface FileTreeRenamingConfig {
  onStart?: (item: FileTreeRenamingItem) => {
    validateSync?: (value: string) => string | null;
    validate: (value: string) => string | null | Promise<string | null>;
    onCommit: (value: string) => Promise<void>;
    onCancel?: () => void;
    onFinish?: () => void;
  } | null;
`,
      ],
    ],
  ],
  [
    "dist/render/FileTree.js",
    [
      [
        "\tstartRenaming(path, options) {",
        `
\tstartCreating(options) { return this.#controller.startCreating(options); }
\tcancelCreating() { this.#controller.cancelCreating(); }
\tgetCreatingPath() { return this.#controller.getCreatingPath(); }
\tcancelEditing() { this.#controller.cancelEditing(); }
\tgetEditingPath() { return this.#controller.getEditingPath(); }
\tstartRenaming(path, options) {`,
      ],
    ],
  ],
  [
    "dist/model/FileTreeController.js",
    [
      [
        "import { PathStore }",
        'import { InlineEditSession } from "./inlineEdit.js";\nimport { PathStore }',
      ],
      ["\t#baseOptions;", "\t#editSession = null;\n\t#renameStart;\n\t#baseOptions;"],
      ["getPath: () => this.#renamingPath,", "getPath: () => this.#editSession?.path ?? null,"],
      ["getValue: () => this.#renamingValue,", 'getValue: () => this.#editSession?.value ?? "",'],
      ["isActive: () => this.#renamingPath != null,", "isActive: () => this.#editSession != null,"],
      [
        "\t\t\tthis.#renameCanRename = renaming.canRename;",
        "\t\t\tthis.#renameStart = renaming.onStart;\n\t\t\tthis.#renameCanRename = renaming.canRename;",
      ],
      ["\tdestroy() {", "\tdestroy() {\n\t\tthis.cancelEditing();"],
      [
        /(?:\n\tget(?:EditSession|Creation)\(\)[\s\S]*?)?\tstartRenaming\(path =[\s\S]*?\tresetPaths\(pathsOrOptions, maybeOptions = \{\}\) \{(?:\n\t\tthis\.cancelEditing\(\);)?/,
        editingMethods,
      ],
      [
        /\t#renamingPath = null;\n\t#renamingValue = "";\n\t#removeRenamingPathIfCanceled = false;/,
        "\t// InlineEditSession owns input state and cancellation.",
      ],
      [
        "\t\tconst previousRenamingPath = this.#renamingPath;",
        "\t\t// Path resets dispose the current inline session.",
      ],
      [
        /\t\tthis\.#renamingPath = previousRenamingPath[^\n]*\n\t\tif \(this\.#renamingPath == null\) \{[\s\S]*?\n\t\t\}/,
        "\t\t// No edit state is carried across a full reset.",
      ],
      [
        /\t\tconst nextRenamingPath = remapPathThroughMutation\(this\.#renamingPath, event\);[\s\S]*?\t\tthis\.#renamingPath = nextRenamingPath;/,
        "\t\t// An external source removal cancels editing in #emit().",
      ],
      [
        "\t#emit() {",
        "\t#emit() {\n\t\tif (this.#editSession && !this.#editSession.busy && this.#store.getVisibleIndex(this.#editSession.path) == null) this.cancelEditing();",
      ],
      [
        "\t\tif (this.#dragAndDropConfig == null) return false;",
        "\t\tif (this.#dragAndDropConfig == null || this.#editSession) return false;",
      ],
    ],
  ],
  [
    "dist/path-store/src/canonical.js",
    [
      [
        "import { applyChildAggregateDelta",
        'import { creationNames } from "../../model/inlineEdit.js";\nimport { applyChildAggregateDelta',
      ],
      [
        "\tconst comparison = compareSegmentSortKeys(",
        `\tconst leftDraft = creationNames.has(getSegmentValue(state.snapshot.segmentTable, leftNode.nameId));
\tconst rightDraft = creationNames.has(getSegmentValue(state.snapshot.segmentTable, rightNode.nameId));
\tif (leftDraft !== rightDraft) return leftDraft ? -1 : 1;
\tconst comparison = compareSegmentSortKeys(`,
      ],
    ],
  ],
  [
    "dist/render/FileTreeView.js",
    [
      // JSX runtime keys must be separate from DOM props to preserve a focused input.
      ["\n\t\t}),\n\t\tkey,\n\t\tonContextMenu:", "\n\t\t}),\n\t\tonContextMenu:"],
      [
        "\t\tchildren: rowContent\n\t});\n\treturn",
        "\t\tchildren: rowContent\n\t}, key);\n\treturn",
      ],
      [
        "\t\tchildren: rowContent\n\t});\n}\nfunction renderRangeChildren",
        "\t\tchildren: rowContent\n\t}, key);\n}\nfunction renderRangeChildren",
      ],
      [
        ".map((row, slotIndex) => renderStyledRow(frame, row, range.start + slotIndex))",
        ".map((row) => renderStyledRow(frame, row, getFileTreeRowPath(row)))",
      ],
      [
        'import { RenameInput } from "./RenameInput.js";',
        'import { InlineEditInput } from "./InlineEditInput.js";',
      ],
      [
        /\tconst renamingValue = isRenamingRow[^\n]*\n\tconst renameInput =[\s\S]*?\n\tconst rowContent =/,
        "\tconst renameInput = isSticky || !isRenamingRow ? null : jsx(InlineEditInput, { session: controller.getEditSession(), registerInput: registerRenameInput });\n\tconst rowContent =",
      ],
      [
        "const commonProps = {",
        'const commonProps = {\n\t\t"data-file-tree-editing": controller.getEditingPath() === targetPath ? "true" : undefined,\n\t\t"data-file-tree-creating": controller.getCreatingPath() === targetPath ? "true" : undefined,',
      ],
      [
        "ariaLabel: getFileTreeRowAriaLabel(row),",
        'ariaLabel: controller.getCreatingPath() === targetPath ? "New item" : getFileTreeRowAriaLabel(row),',
      ],
      [
        "\t\t\t\t\tinput.select();",
        "\t\t\t\t\tconst selection = controller.getEditSession()?.selection;\n\t\t\t\t\tif (selection) input.setSelectionRange(...selection); else input.select();",
      ],
      [
        'case "reveal-canonical":',
        'case "reveal-canonical":\n\t\t\t\t// A successful async rename can remove the source before the session closes.\n\t\t\t\tif (controller.getEditSession()?.busy) return;',
      ],
    ],
  ],
];

export function installCreationModules(root) {
  for (const [source, target] of [
    ["inlineEdit.js", "dist/model/inlineEdit.js"],
    ["InlineEditInput.js", "dist/render/InlineEditInput.js"],
  ]) {
    writeFileSync(new URL(target, root), readFileSync(new URL(`trees/${source}`, import.meta.url)));
  }
}
