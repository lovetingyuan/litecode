import { useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { monaco } from "../editor/monaco";
import { editorFontOptions } from "../editor/font";
import { useApp } from "../store/store";
import { IconButton } from "./ui";
type Diff = { title: string; before: string; after: string; language: string };
export function DiffViewer() {
  const [diff, setDiff] = useState<Diff | null>(null);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const instance = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const settings = useApp((s) => s.settings);
  useEffect(() => {
    const handler = (event: Event) => setDiff((event as CustomEvent<Diff>).detail);
    window.addEventListener("show-diff", handler);
    return () => window.removeEventListener("show-diff", handler);
  }, []);
  useEffect(() => {
    if (!diff || !host) {
      return;
    }
    const before = monaco.editor.createModel(diff.before, diff.language);
    const after = monaco.editor.createModel(diff.after, diff.language);
    const editor = monaco.editor.createDiffEditor(host, {
      ...editorFontOptions(useApp.getState().settings),
      automaticLayout: true,
      theme: "dark-modern",
      readOnly: true,
      originalEditable: false,
    });
    editor.setModel({ original: before, modified: after });
    instance.current = editor;
    return () => {
      instance.current = null;
      editor.dispose();
      before.dispose();
      after.dispose();
    };
  }, [diff, host]);
  useEffect(() => {
    instance.current?.updateOptions(editorFontOptions(settings));
  }, [settings]);
  return (
    <Dialog.Root
      open={!!diff}
      onOpenChange={(open) => {
        if (!open) {
          setDiff(null);
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-backdrop" />
        <Dialog.Popup className="diff-panel">
          <div className="diff-heading">
            <Dialog.Title>{diff?.title}</Dialog.Title>
            <IconButton icon="close" label="Close Compare" onClick={() => setDiff(null)} />
          </div>
          <Dialog.Description className="sr-only">
            Read-only comparison. Left is original; right is modified.
          </Dialog.Description>
          <div ref={setHost} className="diff-editor" />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
