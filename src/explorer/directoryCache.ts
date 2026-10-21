import type { DirectorySnapshot } from "../types/types";
export type DirectoryState = {
  paths: string[];
  status: "unloaded" | "loading" | "loaded" | "stale" | "failed";
  error?: string;
  warnings: string[];
  dirty: boolean;
  promise?: Promise<void>;
};
export const directoryPath = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");
export const parentDirectory = (path: string) => directoryPath(path).split("/").slice(0, -1).join("/");
const key = (path: string) => directoryPath(path).toLowerCase();
/** A cache belongs to one opening of a workspace, even when the root is reopened. */
export class DirectoryCache {
  readonly directories = new Map<string, DirectoryState>();
  session: number | null = null;
  disposed = false;
  revision = 0;
  private listeners = new Set<(directory?: string, paths?: string[]) => void | Promise<void>>();
  constructor(readonly root: string, private read: (directory: string, session: number | null) => Promise<DirectorySnapshot>) { }
  subscribe(listener: (directory?: string, paths?: string[]) => void | Promise<void>) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  entry(directory: string) {
    const path = directoryPath(directory);
    let entry = this.directories.get(path);
    if (!entry) {
      entry = { paths: [], warnings: [], status: "unloaded", dirty: true };
      this.directories.set(path, entry);
    }
    return entry;
  }
  private async emit(directory?: string, paths?: string[]) {
    await Promise.all([...this.listeners].map((listener) => listener(directory, paths)));
  }
  load(directory: string, force = false): Promise<void> {
    const path = directoryPath(directory);
    const entry = this.entry(path);
    if (force) {
      entry.dirty = true;
    }
    if (entry.promise) {
      return entry.promise;
    }
    if (this.disposed || (!entry.dirty && entry.status === "loaded")) {
      return Promise.resolve();
    }
    entry.promise = (async () => {
      // Yield before emitting so subscribers can never start a duplicate request.
      await Promise.resolve();
      try {
        do {
          entry.dirty = false;
          entry.status = "loading";
          entry.error = undefined;
          await this.emit();
          try {
            const result = await this.read(path, this.session);
            if (this.disposed || this.directories.get(path) !== entry) {
              return;
            }
            if (key(result.root) !== key(this.root) || (this.session !== null && result.session !== this.session)) {
              throw new Error("Workspace changed while reading the directory");
            }
            this.session = result.session;
            // An invalidation after this request started makes its result obsolete.
            if (entry.dirty) {
              continue;
            }
            const next = new Set(result.paths);
            for (const previous of entry.paths) {
              if (previous.endsWith("/") && !next.has(previous)) {
                for (const cached of this.directories.keys()) {
                  if (cached === directoryPath(previous) || cached.startsWith(previous)) {
                    this.directories.delete(cached);
                  }
                }
              }
            }
            if (entry.paths.length !== result.paths.length || entry.paths.some((path) => !next.has(path))) { this.revision++; }
            entry.paths = result.paths;
            entry.warnings = result.warnings;
            await this.emit(path, result.paths);
            if (this.disposed || this.directories.get(path) !== entry) {
              return;
            }
            entry.status = entry.dirty ? "stale" : "loaded";
          }
          catch (error) {
            if (this.disposed || this.directories.get(path) !== entry) {
              return;
            }
            entry.status = "failed";
            entry.error = error instanceof Error ? error.message : String((error as {
              message?: string;
            })?.message ?? error);
          }
        } while (entry.dirty && !this.disposed);
      }
      finally {
        entry.promise = undefined;
        if (!this.disposed) {
          await this.emit();
        }
      }
    })();
    return entry.promise;
  }
  invalidate(directory: string) {
    const entry = this.entry(directory);
    entry.dirty = true;
    if (entry.status === "loaded") {
      entry.status = "stale";
    }
  }
  cachedPath(path: string): string | null {
    const parts = directoryPath(path).split("/").filter(Boolean);
    let parent = "";
    for (let index = 0; index < parts.length; index++) {
      const child = this.directories.get(parent)?.paths.find((candidate) => key(candidate) === key(parent ? `${parent}/${parts[index]}` : parts[index]));
      if (!child || (index < parts.length - 1 && !child.endsWith("/"))) {
        return null;
      }
      if (index === parts.length - 1) {
        return child;
      }
      parent = directoryPath(child);
    }
    return "";
  }
  relocate(from: string, to: string) {
    const matches = (path: string) => path === from || (from.endsWith("/") && path.startsWith(from));
    const moved = [...this.directories].filter(([path]) => matches(path + "/"));
    for (const [path] of moved) {
      this.directories.delete(path);
    }
    for (const [path, entry] of moved) {
      this.directories.set(directoryPath(to + (path + "/").slice(from.length)), {
        ...entry, paths: entry.paths.map((child) => to + child.slice(from.length)),
        promise: undefined, dirty: true, status: "stale",
      });
    }
    for (const entry of this.directories.values()) {
      entry.paths = entry.paths.filter((path) => path !== to && !(path === from && parentDirectory(from) !== parentDirectory(to))).map((path) => matches(path) ? to + path.slice(from.length) : path);
    }
    const destination = this.directories.get(parentDirectory(to));
    if (destination && !destination.paths.includes(to)) {
      destination.paths.push(to);
    }
    this.invalidate(parentDirectory(from));
    this.invalidate(parentDirectory(to));
  }
  async ensurePath(path: string): Promise<string | null> {
    const parts = directoryPath(path).split("/").filter(Boolean);
    let parent = "";
    for (let i = 0; i < parts.length; i++) {
      await this.load(parent);
      if (this.disposed) {
        return null;
      }
      let child = this.entry(parent).paths.find((p) => key(p) === key(parent ? `${parent}/${parts[i]}` : parts[i]));
      if (!child) {
        // A newly created file can be opened before its watcher notification.
        await this.load(parent, true);
        child = this.entry(parent).paths.find((p) => key(p) === key(parent ? `${parent}/${parts[i]}` : parts[i]));
      }
      if (!child || (i < parts.length - 1 && !child.endsWith("/"))) {
        return null;
      }
      parent = directoryPath(child);
      if (i === parts.length - 1) {
        return child;
      }
    }
    return "";
  }
  *paths() {
    for (const entry of this.directories.values()) {
      yield* entry.paths;
    }
  }
  dispose() {
    this.disposed = true;
    this.listeners.clear();
  }
}
