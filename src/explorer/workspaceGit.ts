import { call, errorMessage } from "../core/bridge";
import { setApp, notify } from "../store/store";
import type { GitSnapshot } from "../types/types";
import { directoryPath, type DirectoryCache } from "./directoryCache";
let running: {
  cache: DirectoryCache;
  pending: boolean;
  force: boolean;
  promise: Promise<void>;
} | null = null;
export function refreshGit(cache: DirectoryCache | null, force = false): Promise<void> {
  if (!cache) {
    return Promise.resolve();
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
        task.force = false;
        try {
          const gitState = await call<GitSnapshot>("workspace_git_status", {
            expectedRoot: cache.root,
            session: cache.session,
            ...(force ? { force } : {}),
          });
          if (
            !cache.disposed &&
            gitState.root &&
            directoryPath(gitState.root).toLowerCase() ===
              directoryPath(cache.root).toLowerCase() &&
            (cache.session === null || cache.session === gitState.session)
          ) {
            if (gitState.warnings.length) {
              notify(gitState.warnings.join("\n"));
            } else {
              setApp({ gitState });
            }
          }
        } catch (error) {
          if (!cache.disposed) {
            notify(errorMessage(error));
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
