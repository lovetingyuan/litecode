import { rankPreparedPath } from './fuzzy';

type Candidate = { path: string; relative: string; haystack: string; filename: number };
export type QuickFile = { path: string; label: string; description: string; positions: number[] };
export type FileSearchMessage =
  | { kind: 'workspace'; root: string | null; paths: string[] }
  | { kind: 'open'; root: string | null; paths: string[] }
  | { kind: 'search'; id: number; version: number; query: string };
export type FileSearchReply = { id: number; version: number; files: QuickFile[] };

const visible = (path: string) => path.replace(/^\\\\\?\\UNC\\/, '\\\\').replace(/^\\\\\?\\/, '').replace(/\\/g, '/');
export function prepareQuickFiles(paths: string[], root: string | null): Candidate[] {
  const base = root ? visible(root).replace(/\/$/, '').toLowerCase() + '/' : null;
  return [...new Set(paths)].map(path => {
    const value = visible(path);
    const relative = base && value.toLowerCase().startsWith(base) ? value.slice(base.length) : value;
    const haystack = relative.toLowerCase();
    return { path, relative, haystack, filename: haystack.lastIndexOf('/') };
  });
}

export function searchQuickFiles(workspace: Candidate[], open: Candidate[], query: string): QuickFile[] {
  const needle = query.toLowerCase().replace(/\\/g, '/');
  const opened = new Set(open.map(file => file.path));
  const best: { file: Candidate; score: number; positions: number[] }[] = [];
  function consider(file: Candidate, recent: boolean) {
    const rank = rankPreparedPath(file.relative, file.haystack, needle, recent, file.filename);
    if (!rank || (best.length === 100 && rank.score <= best[99].score)) return;
    let lo = 0; let hi = best.length;
    // Insert after equal scores to preserve the original stable sort order.
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (best[mid].score >= rank.score) lo = mid + 1; else hi = mid; }
    best.splice(lo, 0, { file, score: rank.score, positions: rank.positions });
    if (best.length > 100) best.pop();
  }
  for (const file of open) consider(file, true);
  for (const file of workspace) if (!opened.has(file.path)) consider(file, false);
  return best.map(({ file, positions }) => {
    const offset = file.relative.lastIndexOf('/') + 1;
    return { path: file.path, label: file.relative.slice(offset), description: file.relative.slice(0, Math.max(0, offset - 1)), positions: positions.filter(p => p >= offset).map(p => p - offset) };
  });
}
