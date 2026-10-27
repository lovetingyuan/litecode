import { createModelReference } from "@codingame/monaco-vscode-api/monaco";
import { monaco } from "./monaco";
import type { GitDiffContent } from "../types/types";

export async function createGitDiffModels(
  content: Pick<GitDiffContent, "before" | "after">,
  language: string,
  shared?: monaco.editor.ITextModel,
) {
  const owned: { model: monaco.editor.ITextModel; reference?: monaco.IDisposable }[] = [];
  const dispose = () => {
    for (const { model, reference } of owned.splice(0)) {
      if (reference) {
        reference.dispose();
      } else {
        model.dispose();
      }
    }
  };
  try {
    const original = monaco.editor.createModel(content.before, language);
    owned.push({ model: original });
    const modified = shared ?? monaco.editor.createModel(content.after, language);
    if (!shared) {
      owned.push({ model: modified });
    }
    // VS Code's transient focus/selection references can otherwise release an
    // in-memory text model while the diff editor is still displaying it.
    for (const entry of owned) {
      entry.reference = await createModelReference(entry.model.uri);
    }
    return { original, modified, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
