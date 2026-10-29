// Upgrade an already-installed creation-only patch without requiring npm reinstall.
export function stripLegacyCreation(path, source) {
  if (
    path === "dist/model/FileTreeController.js" &&
    source.includes("getCreation() { return this.#creation; }")
  ) {
    source = source
      .replace('import { CreationSession } from "./creation.js";\n', "")
      .replace("\t#creation = null;\n", "")
      .replace("this.#creation?.path ?? this.#renamingPath", "this.#renamingPath")
      .replace("this.#creation?.value ?? this.#renamingValue", "this.#renamingValue")
      .replace("this.#creation != null || this.#renamingPath != null", "this.#renamingPath != null")
      .replaceAll("\t\tthis.cancelCreating();\n", "")
      .replace(/\t\tif \(this\.#creation && this\.#store\.getVisibleIndex[^\n]*\n/, "")
      .replace(
        "this.#dragAndDropConfig == null || this.#creation",
        "this.#dragAndDropConfig == null",
      );
  }
  if (path === "dist/render/FileTreeView.js" && source.includes("import { CreationInput }")) {
    source = source
      .replace('import { CreationInput } from "./CreationInput.js";\n', "")
      .replace(
        '\n\t\t"data-file-tree-creating": controller.getCreatingPath() === targetPath ? "true" : undefined,',
        "",
      );
  }
  if (path === "dist/render/FileTree.js" && !source.includes("getEditingPath()")) {
    source = source.replace(
      /\n\tstartCreating\(options\)[\s\S]*?(?=\tstartRenaming\(path, options\))/,
      "\n",
    );
  }
  if (path === "dist/render/FileTree.d.ts" && !source.includes("getEditingPath()")) {
    source = source.replace(
      /\n  startCreating\(options: FileTreeCreationOptions\)[\s\S]*?(?=  startRenaming\()/,
      "\n",
    );
  }
  return source;
}
