import { call, errorMessage } from "../core/bridge";
import {
  beginDocumentDelete,
  beginDocumentMove,
  closeDeletedDocuments,
  documentsAtPaths,
  relative,
  renameDocuments,
} from "../editor/documents";
import { ask } from "../components/dialog";
import type { FileMove } from "./explorerMove";
import type { CopyReport } from "./explorerClipboard";

export async function deleteInternalFiles(paths: string[], onDeleted: (path: string) => void) {
  if (!paths.length) {
    return;
  }
  const warning = documentsAtPaths(paths).some((doc) => doc.dirty)
    ? "\n\n包含未保存修改，删除后这些修改将丢失。"
    : "";
  if (
    (await ask("Move to Recycle Bin?", paths.map((path) => relative(path)).join("\n") + warning, [
      "Move to Recycle Bin",
      "Cancel",
    ])) !== "Move to Recycle Bin"
  ) {
    return;
  }
  const release = await beginDocumentDelete(paths);
  let failure: unknown;
  try {
    for (const path of paths) {
      await call("file_operation", { operation: { kind: "delete", path } });
      closeDeletedDocuments([path]);
      onDeleted(path);
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    release(failure);
  }
}

// A cut reserves the entire batch before any disk change. Keep the barrier until
// every successful move has been rebound, including after cancellation/failure.
export async function pasteInternalFiles(
  moves: FileMove[],
  cut: boolean,
  signal: AbortSignal,
): Promise<CopyReport> {
  const report: CopyReport = { copied: [], failed: [] };
  if (signal.aborted) {
    return report;
  }
  let release: ((error?: unknown) => void) | undefined;
  let failure: unknown;
  try {
    if (cut) {
      release = await beginDocumentMove(moves);
    }
    for (const move of moves) {
      if (signal.aborted) {
        break;
      }
      try {
        const destination = await call<string | null>("file_operation", {
          operation: { kind: cut ? "rename" : "copy", path: move.from, destination: move.to },
        });
        if (!cut && !destination) {
          throw new Error("Copy did not return a destination");
        }
        report.copied.push({ from: move.from, to: destination ?? move.to });
      } catch (error) {
        failure ??= error;
        report.failed.push({ path: move.from, message: errorMessage(error) });
      }
    }
    if (cut) {
      await renameDocuments(report.copied);
    }
    return report;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    release?.(failure);
  }
}
