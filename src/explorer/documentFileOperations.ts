import { call, errorMessage } from "../core/bridge";
import { beginDocumentMove, renameDocuments } from "../editor/documents";
import type { FileMove } from "./explorerMove";
import type { CopyReport } from "./explorerClipboard";

// A cut reserves the entire batch before any disk change. Keep the barrier until
// every successful move has been rebound, including after cancellation/failure.
export async function pasteInternalFiles(moves: FileMove[], cut: boolean, signal: AbortSignal): Promise<CopyReport> {
  const report: CopyReport = { copied: [], failed: [] };
  if (signal.aborted) { return report; }
  let release: ((error?: unknown) => void) | undefined;
  let failure: unknown;
  try {
    if (cut) { release = await beginDocumentMove(moves); }
    for (const move of moves) {
      if (signal.aborted) { break; }
      try {
        await call("file_operation", { operation: { kind: cut ? "rename" : "copy", path: move.from, destination: move.to } });
        report.copied.push(move);
      } catch (error) {
        failure ??= error;
        report.failed.push({ path: move.from, message: errorMessage(error) });
      }
    }
    if (cut) { await renameDocuments(report.copied); }
    return report;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    release?.(failure);
  }
}
