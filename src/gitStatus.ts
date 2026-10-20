import type { GitEntry } from './types';

type IgnoreIndex = {
  statuses: Map<string, GitEntry['status']>;
  directories: Set<string>;
  results: Map<string, boolean>;
};

// A snapshot is immutable. Let old indexes be collected when it is replaced.
const indexes = new WeakMap<readonly GitEntry[], Map<boolean, IgnoreIndex>>();
const visible = (path: string) => path.replace(/^\\\\\?\\UNC\\/i, '//').replace(/^\\\\\?\\/, '').replace(/\\/g, '/');

function indexFor(entries: readonly GitEntry[], ignoreCase: boolean): IgnoreIndex {
  let modes = indexes.get(entries);
  if (!modes) { modes = new Map(); indexes.set(entries, modes); }
  let index = modes.get(ignoreCase);
  if (!index) {
    index = { statuses: new Map(), directories: new Set(), results: new Map() };
    for (const entry of entries) {
      const path = entry.path.replace(/\\/g, '/');
      const key = ignoreCase ? path.toLowerCase() : path;
      index.statuses.set(key, entry.status);
      if (entry.status === 'ignored' && key.endsWith('/')) index.directories.add(key);
    }
    modes.set(ignoreCase, index);
  }
  return index;
}

export function isGitIgnored(path: string | null, root: string | null, treeRoot: string | null, entries: readonly GitEntry[]): boolean {
  if (!path || !root || treeRoot !== root || entries.length === 0) return false;
  const base = visible(root).replace(/\/$/, '') + '/';
  const value = visible(path);
  const ignoreCase = /^[a-z]:\//i.test(base) || base.startsWith('//');
  const key = ignoreCase ? value.toLowerCase() : value;
  const prefix = ignoreCase ? base.toLowerCase() : base;
  if (!key.startsWith(prefix)) return false;
  const relative = key.slice(prefix.length);
  if (!relative) return false;
  const index = indexFor(entries, ignoreCase);
  const cached = index.results.get(relative);
  if (cached !== undefined) return cached;
  const status = index.statuses.get(relative);
  let ignored = status === 'ignored';
  if (status === undefined) {
    for (let slash = relative.lastIndexOf('/'); slash >= 0; slash = relative.lastIndexOf('/', slash - 1)) {
      if (index.directories.has(relative.slice(0, slash + 1))) { ignored = true; break; }
      if (slash === 0) break;
    }
  }
  index.results.set(relative, ignored);
  return ignored;
}
