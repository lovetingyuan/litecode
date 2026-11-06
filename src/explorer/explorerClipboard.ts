import type { FileMove } from "./explorerMove";

export type FileClipboard = { sequence: number | null; paths: string[] };
export type CopyReport = {
  copied: { from: string; to: string }[];
  failed: { path: string; message: string }[];
};
type InternalClipboard = FileClipboard & { cut: boolean };
type ClipboardServices = {
  onCutPathsChange?: (paths: string[]) => void;
  read: () => Promise<FileClipboard>;
  copyExternal: (sequence: number, root: string, directory: string) => Promise<CopyReport>;
  pasteInternal: (moves: FileMove[], cut: boolean, signal: AbortSignal) => Promise<CopyReport>;
};

export function pasteDirectory(path: string, directory: boolean) {
  if (!path) {
    return "";
  }
  const clean = path.replace(/\/$/, "");
  return directory ? clean : clean.slice(0, Math.max(0, clean.lastIndexOf("/")));
}

// Events cross the tree's shadow root, so e.target alone misses rename inputs.
export function isEditableTreeEvent(event: { composedPath(): EventTarget[] }) {
  return event
    .composedPath()
    .some(
      (target) =>
        target instanceof HTMLElement &&
        (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable),
    );
}

export function createExplorerClipboard(services: ClipboardServices) {
  let internal: InternalClipboard | null = null;
  function setInternal(value: InternalClipboard | null) {
    internal = value;
    services.onCutPathsChange?.(value?.cut ? value.paths : []);
  }
  let revision = 0;
  let remembering = Promise.resolve();
  return {
    remember(paths: string[], cut: boolean) {
      const request = ++revision;
      setInternal(null);
      remembering = services
        .read()
        .then((snapshot) => {
          if (request === revision) {
            setInternal({ paths: [...new Set(paths)], cut, sequence: snapshot.sequence });
          }
        })
        .finally(() => {
          if (request === revision) {
            remembering = Promise.resolve();
          }
        });
      return remembering;
    },
    async paste(root: string, directory: string, signal: AbortSignal): Promise<CopyReport | null> {
      const request = revision;
      await remembering;
      if (signal.aborted || request !== revision) {
        return null;
      }
      const snapshot = await services.read();
      if (signal.aborted || request !== revision) {
        return null;
      }
      if (internal && internal.sequence !== snapshot.sequence) {
        setInternal(null);
      }
      const source = internal ?? { ...snapshot, cut: false };
      const paths = [...new Set(source.paths)];
      if (!paths.length) {
        return null;
      }
      if (!internal) {
        if (snapshot.sequence === null) {
          return null;
        }
        return services.copyExternal(snapshot.sequence, root, directory);
      }
      const current = await services.read();
      if (signal.aborted || request !== revision) {
        return null;
      }
      if (current.sequence !== snapshot.sequence) {
        setInternal(null);
        throw new Error("The clipboard changed; paste the files again");
      }
      const sources = paths.filter(
        (path) =>
          !paths.some(
            (parent) => parent !== path && path.startsWith(parent.replace(/\/$/, "") + "/"),
          ),
      );
      const moves = sources.map((path) => ({
        from: path,
        to: directory.replace(/\/$/, "") + "/" + path.replace(/\/$/, "").split("/").pop()!,
      }));
      const unchanged = moves.filter(
        (move) => source.cut && move.from.replace(/\/$/, "") === move.to,
      );
      const pending = moves.filter((move) => !unchanged.includes(move));
      const report = pending.length
        ? await services.pasteInternal(pending, source.cut, signal)
        : { copied: [], failed: [] };
      // Keep failed cut sources available for retry; completed moves must not run again.
      if (source.cut && request === revision) {
        const completed = [...report.copied, ...unchanged].map((item) => item.from);
        const remaining = paths.filter(
          (path) =>
            !completed.some(
              (parent) => path === parent || path.startsWith(parent.replace(/\/$/, "") + "/"),
            ),
        );
        setInternal(remaining.length ? { ...source, paths: remaining } : null);
      }
      return report;
    },
  };
}
