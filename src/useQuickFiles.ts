import { useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from 'react';
import FileWorker from './quickFiles.worker?worker';
import { QuickFileSearch } from './quickFileSearch';
import type { QuickFile } from './quickFiles';
import { notify } from './store';

const empty: QuickFile[] = [];
export function useQuickFiles(query: string | null, root: string | null, paths: string[], openPathsKey: string) {
  const service = useRef<QuickFileSearch | null>(null);
  const [pending, startTransition] = useTransition();
  // Include index inputs in the token; compiler memoization can drop unused dependencies.
  const request = useMemo(() => ({ query, root, paths, openPathsKey }), [query, root, paths, openPathsKey]);
  const latest = useRef(request);
  const [result, setResult] = useState<{ request: typeof request; files: QuickFile[] } | null>(null);
  // Invalidate responses before the browser can deliver the next worker message.
  useLayoutEffect(() => { latest.current = request; }, [request]);
  useEffect(() => {
    const search = new QuickFileSearch(new FileWorker(), () => notify('File search worker failed. Reload the window to retry.'));
    service.current = search;
    return () => { search.dispose(); service.current = null; };
  }, []);
  useEffect(() => { service.current?.update({ kind: 'workspace', root, paths }); }, [root, paths]);
  useEffect(() => { service.current?.update({ kind: 'open', root, paths: JSON.parse(openPathsKey) as string[] }); }, [root, openPathsKey]);
  useEffect(() => {
    if (query === null) { service.current?.cancel(); return; }
    service.current?.search(query, files => {
      if (latest.current !== request) return;
      startTransition(() => setResult({ request, files }));
    });
    return () => service.current?.cancel();
  }, [request, query]);
  return { files: result?.files ?? empty, busy: query !== null && (pending || result?.request !== request) };
}
