import { call, errorMessage } from './bridge';
import { useApp, setApp, notify } from './store';
import type { TreeSnapshot } from './types';

const scans = new Map<string, { pending: boolean; promise: Promise<void> }>();

export function refreshTree(): Promise<void> {
  const root = useApp.getState().root;
  if (!root) {return Promise.resolve();}
  const previous = scans.get(root);
  if (previous) {
    previous.pending = true;
    return previous.promise;
  }
  const scan = { pending: true, promise: Promise.resolve() };
  scans.set(root, scan);
  scan.promise = (async () => {
    try {
      // Coalesce events during a scan into one follow-up, so the final event
      // cannot be lost while scan_workspace is still reading ignore rules.
      while (scan.pending && useApp.getState().root === root) {
        scan.pending = false;
        try {
          const tree = await call<TreeSnapshot>('scan_workspace');
          if (useApp.getState().root === root) {setApp({ tree, treeRoot: root });}
        } catch (error) {
          if (useApp.getState().root === root) {notify(errorMessage(error));}
        }
      }
    } finally {
      scans.delete(root);
    }
  })();
  return scan.promise;
}
