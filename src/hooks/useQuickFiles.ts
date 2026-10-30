import { useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from "react";
import FileWorker from "../quick-open/quickFiles.worker.ts?worker";
import { QuickFileSearch } from "../quick-open/quickFileSearch";
import type { QuickFile } from "../quick-open/quickFiles";
import { notify } from "../store/store";
import { call, errorMessage } from "../core/bridge";
import type { IExpression } from "@codingame/monaco-vscode-api/vscode/vs/base/common/glob";

const empty: QuickFile[] = [];
export function useQuickFiles(
  query: string | null,
  root: string | null,
  fileIndexVersion: number,
  openPathsKey: string,
  settingsKey: string,
) {
  const active = query !== null;
  const service = useRef<QuickFileSearch | null>(null);
  const [pending, startTransition] = useTransition();
  const indexInput = useMemo(
    () => ({ root, fileIndexVersion, settingsKey }),
    [root, fileIndexVersion, settingsKey],
  );
  const excludes = useMemo(
    () => (JSON.parse(settingsKey) as { excludes: IExpression }).excludes,
    [settingsKey],
  );
  const [index, setIndex] = useState<{
    input: typeof indexInput;
    paths: string[];
    excludes: IExpression;
  } | null>(null);
  const listing = useRef<{
    input: typeof indexInput;
    promise: Promise<{ root: string | null; paths: string[]; excludes: IExpression }>;
  } | null>(null);
  const effectiveExcludes = index?.input === indexInput ? index.excludes : excludes;
  // Include index inputs in the token; compiler memoization can drop unused dependencies.
  const request = useMemo(
    () => ({ query, indexInput, openPathsKey }),
    [query, indexInput, openPathsKey],
  );
  const latest = useRef(request);
  const [result, setResult] = useState<{ request: typeof request; files: QuickFile[] } | null>(
    null,
  );
  // Invalidate responses before the browser can deliver the next worker message.
  useLayoutEffect(() => {
    latest.current = request;
  }, [request]);
  useEffect(() => {
    return () => {
      service.current?.dispose();
      service.current = null;
    };
  }, []);
  useEffect(() => {
    if (active && !service.current) {
      service.current = new QuickFileSearch(new FileWorker(), () =>
        notify("File search worker failed. Reload the window to retry."),
      );
    }
  }, [active]);
  useEffect(() => {
    if (!active || index?.input === indexInput) {
      return;
    }
    let cancelled = false;
    service.current?.cancel();
    if (!root) {
      setIndex({ input: indexInput, paths: [], excludes });
      return;
    }
    if (listing.current?.input !== indexInput) {
      listing.current = { input: indexInput, promise: call("quick_file_paths") };
    }
    const task = listing.current;
    void task.promise
      .then((snapshot) => {
        if (cancelled) {
          return;
        }
        if (snapshot.root !== root) {
          throw new Error("Workspace changed while listing files. Refresh the workspace to retry.");
        }
        setIndex({ input: indexInput, paths: snapshot.paths, excludes: snapshot.excludes });
      })
      .catch((error) => {
        if (listing.current === task) {
          listing.current = null;
        }
        if (cancelled) {
          return;
        }
        notify(errorMessage(error));
        setIndex({ input: indexInput, paths: [], excludes });
      });
    return () => {
      cancelled = true;
    };
  }, [root, indexInput, excludes, active, index]);
  useEffect(() => {
    // Replay both snapshots when file search first creates the worker or reopens.
    if (active && index?.input === indexInput) {
      service.current?.update({
        kind: "workspace",
        root,
        paths: index.paths,
        excludes: effectiveExcludes,
      });
    }
  }, [active, index, indexInput, root, effectiveExcludes]);
  useEffect(() => {
    if (!active) {
      return;
    }
    service.current?.update({
      kind: "open",
      root,
      paths: JSON.parse(openPathsKey) as string[],
      excludes: effectiveExcludes,
    });
  }, [active, root, openPathsKey, effectiveExcludes]);
  useEffect(() => {
    if (query === null || index?.input !== indexInput) {
      service.current?.cancel();
      return;
    }
    service.current?.search(query, (files) => {
      if (latest.current !== request) {
        return;
      }
      startTransition(() => setResult({ request, files }));
    });
    return () => service.current?.cancel();
  }, [request, query, index, indexInput]);
  return {
    files:
      result?.request.indexInput === indexInput && result.request.openPathsKey === openPathsKey
        ? result.files
        : empty,
    busy: query !== null && (pending || index?.input !== indexInput || result?.request !== request),
  };
}
