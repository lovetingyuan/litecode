import { useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { monaco } from "../editor/monaco";
import { editorFontOptions } from "../editor/font";
import { diffOptions } from "../editor/settings";
import { useApp } from "../store/store";
import { IconButton } from "./ui";
import { readConflictDiff, resolveConflict } from "../editor/documents";
import { errorMessage } from "../core/bridge";
import type { DiffRequest } from "../types/types";

export function DiffViewer() {
  const [diff, setDiff] = useState<DiffRequest | null>(null);
  const [busy, setBusy] = useState(false);
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
      originalAriaLabel: diff.conflict ? "磁盘版本" : "Original",
      modifiedAriaLabel: diff.conflict ? "当前编辑版本" : "Modified",
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
        <Dialog.Backdrop className="modal-backdrop" />
        <Dialog.Popup className="diff-panel">
          <div className="diff-heading">
            <Dialog.Title>{diff?.title}</Dialog.Title>
            <div className="flex items-center gap-2">
              <IconButton
                icon="arrow-up"
                label="上一个差异"
                disabled={busy || !!diff?.error}
                onClick={() => instance.current?.goToDiff("previous")}
              />
              <IconButton
                icon="arrow-down"
                label="下一个差异"
                disabled={busy || !!diff?.error}
                onClick={() => instance.current?.goToDiff("next")}
              />
              <IconButton icon="close" label="Close Compare" disabled={busy} onClick={close} />
            </div>
          </div>
          <Dialog.Description className="sr-only">
            {diff?.conflict
              ? "左侧是磁盘版本，右侧是当前编辑版本。选择一版作为整个文件的最终结果。"
              : "Read-only comparison. Left is original; right is modified."}
          </Dialog.Description>
          <div className="grid grid-cols-2 gap-4 border-b border-base-300 px-4 py-2 text-sm">
            <span>{diff?.conflict ? "磁盘版本" : "Original"}</span>
            <span>{diff?.conflict ? "当前编辑版本（未保存）" : "Modified"}</span>
          </div>
          {message && (
            <p role="alert" className="px-4 py-2 text-sm">
              {message}
            </p>
          )}
          {diff?.error ? (
            <div role="alert" className="flex-1 px-4 py-6 text-sm">
              {diff.error} 当前编辑内容已保留，请重试读取磁盘版本。
            </div>
          ) : (
            <div ref={setHost} className="diff-editor" />
          )}
          {diff?.conflict && (
            <div
              className="flex flex-wrap items-center justify-end gap-2 border-t border-base-300 p-3"
              aria-busy={busy}
            >
              <button className="btn btn-sm" disabled={busy} onClick={() => void choose()}>
                刷新对比
              </button>
              <button
                className="btn btn-sm"
                disabled={busy || !!diff.error}
                onClick={() => void choose("reload")}
              >
                使用磁盘版本
              </button>
              <button
                className="btn btn-sm"
                disabled={busy || !!diff.error}
                onClick={() => void choose("overwrite")}
              >
                保留当前版本
              </button>
              <button className="btn btn-sm" disabled={busy} onClick={close}>
                取消
              </button>
            </div>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
