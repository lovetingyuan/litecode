import { useEffect, useRef, useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { monaco } from './monaco';
import { IconButton } from './ui';
type Diff = { title: string; before: string; after: string; language: string };
export function DiffViewer() {
  const [diff, setDiff] = useState<Diff | null>(null); const host = useRef<HTMLDivElement>(null);
  useEffect(() => { const handler = (event: Event) => setDiff((event as CustomEvent<Diff>).detail); window.addEventListener('show-diff', handler); return () => window.removeEventListener('show-diff', handler); }, []);
  useEffect(() => {
    if (!diff || !host.current) {return;}
    const before = monaco.editor.createModel(diff.before, diff.language); const after = monaco.editor.createModel(diff.after, diff.language);
    const editor = monaco.editor.createDiffEditor(host.current, { automaticLayout: true, theme: 'dark-modern', readOnly: true, originalEditable: false });
    editor.setModel({ original: before, modified: after });
    return () => { editor.dispose(); before.dispose(); after.dispose(); };
  }, [diff]);
  return <Dialog.Root open={!!diff} onOpenChange={open => { if (!open) {setDiff(null);} }}><Dialog.Portal><Dialog.Backdrop className="modal-backdrop" /><Dialog.Popup className="diff-panel"><div className="diff-heading"><Dialog.Title>{diff?.title}</Dialog.Title><IconButton icon="close" label="Close Compare" onClick={() => setDiff(null)} /></div><Dialog.Description className="sr-only">Read-only comparison. Left is original; right is modified.</Dialog.Description><div ref={host} className="diff-editor" /></Dialog.Popup></Dialog.Portal></Dialog.Root>;
}
