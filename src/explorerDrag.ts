export const explorerDragType = 'application/litecode-tree';

export function explorerDragFiles(raw: string, root: string | null, paths: readonly string[]): string[] {
  if (!root) return [];
  try {
    const payload = JSON.parse(raw);
    if (payload?.root !== root || !Array.isArray(payload.paths)) return [];
    const files = new Set(paths.filter(path => !path.endsWith('/')));
    return [...new Set<string>(payload.paths.filter((path: unknown): path is string => typeof path === 'string' && files.has(path)))];
  } catch { return []; }
}
