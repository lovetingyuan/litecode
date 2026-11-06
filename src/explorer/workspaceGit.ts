import { call, errorMessage } from "../core/bridge";
import { useApp, setApp, notify } from "../store/store";
import type { GitSnapshot } from "../types/types";
import { reconcileGitSnapshot } from "../git/snapshot";
import { directoryPath, type DirectoryCache } from "./directoryCache";
const dirtyInfo = new WeakSet<DirectoryCache>();
let running: {
  cache: DirectoryCache;
  pending: boolean;
  force: boolean;
  promise: Promise<void>;
} | null = null;
function applyGitSnapshot(cache: DirectoryCache, snapshot: GitSnapshot, infoChanged: boolean) {
  if (
    !cache.disposed &&
    snapshot.root &&
    directoryPath(snapshot.root).toLowerCase() === directoryPath(cache.root).toLowerCase() &&
    (cache.session === null || cache.session === snapshot.session)
  ) {
    if (snapshot.warnings.length) {
      notify(snapshot.warnings.join("\n"));
    } else {
      const state = useApp.getState();
      const gitState = reconcileGitSnapshot(state.gitState, snapshot);
      if (gitState !== state.gitState || infoChanged) {
        setApp({ gitState, gitInfoVersion: state.gitInfoVersion + Number(infoChanged) });
      }
      return true;
    }
  }
  return false;
}
export function refreshGit(
  cache: DirectoryCache | null,
  force = false,
  infoChanged = true,
): Promise<void> {
  if (!cache) {
    return Promise.resolve();
  }
  if (infoChanged || force) {
    dirtyInfo.add(cache);
  }
  if (running?.cache === cache) {
    running.pending = true;
    running.force ||= force;
    return running.promise;
  }
  const task = { cache, pending: true, force, promise: Promise.resolve() };
  running = task;
  task.promise = (async () => {
    try {
      while (task.pending && !cache.disposed) {
        task.pending = false;
        const force = task.force;
        const infoChanged = dirtyInfo.delete(cache);
        task.force = false;
        let applied = false;
        try {
          const gitState = await call<GitSnapshot>("workspace_git_status", {
            expectedRoot: cache.root,
            session: cache.session,
            ...(force ? { force } : {}),
          });
          applied = applyGitSnapshot(cache, gitState, infoChanged);
        } catch (error) {
          if (!cache.disposed) {
            notify(errorMessage(error));
          }
        } finally {
          // Retry invalidated metadata on the next refresh after a failed status read.
          if (!applied && infoChanged && !cache.disposed) {
            dirtyInfo.add(cache);
          }
        }
      }
    } finally {
      if (running === task) {
        running = null;
      }
    }
  })();
  return task.promise;
}
