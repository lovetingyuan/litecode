import workbenchStyles from "../styles/workbench.module.css";
import { useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { monaco } from "../editor/monaco";
import { editorFontOptions } from "../editor/font";
import { diffOptions } from "../editor/settings";
import { useApp } from "../store/store";
import { actionButtonClass, Icon, IconButton } from "./ui";
import { readConflictDiff, resolveConflict } from "../editor/documents";
import { errorMessage } from "../core/bridge";
import type { DiffRequest } from "../types/types";

export function DiffViewer() {
  const [diff, setDiff] = useState<DiffRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<"reload" | "overwrite" | "refresh">("refresh");
  const [message, setMessage] = useState("");
  const working = useRef(false);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const instance = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const settings = useApp((s) => s.settings);
  useEffect(() => {
    const handler = (event: Event) => {
      if (working.current) {
        return;
      }
      setMessage("");
      setDiff((event as CustomEvent<DiffRequest>).detail);
    };
    window.addEventListener("show-diff", handler);
    return () => window.removeEventListener("show-diff", handler);
  }, []);
  useEffect(() => {
    if (!diff || diff.error || !host) {
      return;
    }
    const before = monaco.editor.createModel(diff.before, diff.language);
    const after = monaco.editor.createModel(diff.after, diff.language);
    const editor = monaco.editor.createDiffEditor(host, {
      ...editorFontOptions(useApp.getState().settings),
      ...diffOptions(useApp.getState().settings),
      ...(diff.conflict ? { renderSideBySide: true, ignoreTrimWhitespace: false } : {}),
      automaticLayout: true,
      theme: "dark-modern",
      readOnly: true,
      originalEditable: false,
      originalAriaLabel: diff.conflict ? "Disk Version" : "Original",
      modifiedAriaLabel: diff.conflict ? "Current Version" : "Modified",
    });
    editor.setModel({ original: before, modified: after });
    instance.current = editor;
    const updated = editor.onDidUpdateDiff(() => editor.revealFirstDiff());
    return () => {
      instance.current = null;
      updated.dispose();
      editor.dispose();
      before.dispose();
      after.dispose();
    };
  }, [diff, host]);
  useEffect(() => {
    instance.current?.updateOptions({
      ...editorFontOptions(settings),
      ...diffOptions(settings),
      ...(diff?.conflict ? { renderSideBySide: true, ignoreTrimWhitespace: false } : {}),
    });
  }, [settings, diff?.conflict]);

  async function choose(action?: "reload" | "overwrite") {
    if (!diff?.conflict || working.current) {
      return;
    }
    working.current = true;
    setBusy(true);
    setPendingAction(action ?? "refresh");
    setMessage("");
    try {
      if (action) {
        await resolveConflict(diff.conflict, action);
        setDiff(null);
      } else {
        setDiff(await readConflictDiff(diff.conflict.id));
      }
    } catch (error) {
      setMessage(errorMessage(error));
      try {
        setDiff(await readConflictDiff(diff.conflict.id));
      } catch (refreshError) {
        setDiff({ ...diff, error: errorMessage(refreshError) });
      }
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  function close() {
    if (!working.current) {
      setDiff(null);
    }
  }
  return (
    <Dialog.Root
      open={!!diff}
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-backdrop fixed inset-0 bg-backdrop z-[150]" />
        <Dialog.Popup
          className={`diff-panel fixed inset-[7%] z-[151] flex flex-col bg-editor border border-strong rounded-[5px] overflow-hidden ${workbenchStyles["diff-panel"]}`}
        >
          <div
            className={`diff-heading flex items-center justify-between py-[10px] px-4 bg-sidebar ${workbenchStyles["diff-heading"]}`}
          >
            <Dialog.Title>{diff?.title}</Dialog.Title>
            <div className="flex items-center gap-2">
              <IconButton
                icon="arrow-up"
                label="Previous Difference"
                disabled={busy || !!diff?.error}
                onClick={() => instance.current?.goToDiff("previous")}
              />
              <IconButton
                icon="arrow-down"
                label="Next Difference"
                disabled={busy || !!diff?.error}
                onClick={() => instance.current?.goToDiff("next")}
              />
              <IconButton icon="close" label="Close Compare" disabled={busy} onClick={close} />
            </div>
          </div>
          <Dialog.Description className="sr-only">
            {diff?.conflict
              ? "Left is the disk version; right is your current version. Choose one version for the entire file."
              : "Read-only comparison. Left is original; right is modified."}
          </Dialog.Description>
          <div className="grid grid-cols-2 gap-4 border-b border-strong px-4 py-2 text-sm">
            <span>{diff?.conflict ? "Disk Version" : "Original"}</span>
            <span>{diff?.conflict ? "Current Version (Unsaved)" : "Modified"}</span>
          </div>
          {message && (
            <p role="alert" className="px-4 py-2 text-sm">
              {message}
            </p>
          )}
          {diff?.error ? (
            <div role="alert" className="flex-1 px-4 py-6 text-sm">
              {diff.error} Your edits have been preserved. Retry loading the disk version.
            </div>
          ) : (
            <div ref={setHost} className="diff-editor flex-1 min-h-0" />
          )}
          {diff?.conflict && (
            <div
              className="flex flex-wrap items-center justify-end gap-2 border-t border-strong p-3"
              aria-busy={busy}
            >
              <button className={actionButtonClass} disabled={busy} onClick={() => void choose()}>
                {busy && pendingAction === "refresh" && (
                  <Icon name="loading" className="animate-spin" />
                )}
                {busy && pendingAction === "refresh" ? "Refreshing…" : "Refresh Comparison"}
              </button>
              <button
                className={actionButtonClass}
                disabled={busy || !!diff.error}
                onClick={() => void choose("reload")}
              >
                {busy && pendingAction === "reload" && (
                  <Icon name="loading" className="animate-spin" />
                )}
                {busy && pendingAction === "reload" ? "Loading…" : "Use Disk Version"}
              </button>
              <button
                className={actionButtonClass}
                disabled={busy || !!diff.error}
                onClick={() => void choose("overwrite")}
              >
                {busy && pendingAction === "overwrite" && (
                  <Icon name="loading" className="animate-spin" />
                )}
                {busy && pendingAction === "overwrite" ? "Saving…" : "Keep Current Version"}
              </button>
              <button className={actionButtonClass} disabled={busy} onClick={close}>
                Cancel
              </button>
            </div>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
