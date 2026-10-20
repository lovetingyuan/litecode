export type Ranked = { path: string; score: number; positions: number[] };
export function rankPath(path: string, query: string, recent = false): Ranked | null {
  const haystack = path.toLowerCase().replace(/\\/g, '/');
  const needle = query.toLowerCase().replace(/\\/g, '/');
  return rankPreparedPath(path, haystack, needle, recent);
}
export function rankPreparedPath(path: string, haystack: string, needle: string, recent = false, filename = haystack.lastIndexOf('/')): Ranked | null {
  if (!needle) {return { path, score: recent ? 100 : 0, positions: [] };}
  const positions: number[] = []; let cursor = 0; let score = recent ? 8 : 0;
  for (const c of needle) {
    const index = haystack.indexOf(c, cursor); if (index < 0) {return null;}
    score += index === cursor ? 6 : 0;
    score += index === 0 || /[/._\- ]/.test(haystack[index - 1]) ? 10 : 0;
    score += index > filename ? 3 : 0;
    score -= (index - cursor) * 0.1; positions.push(index); cursor = index + 1;
  }
  score -= path.length * 0.02;
  return { path, score, positions };
}
export function parseLocation(value: string) {
  const match = value.match(/^(.*?)(?::(\d+))(?::(\d+))?$/);
  return match ? { query: match[1], line: Math.max(1, Number(match[2])), column: Math.max(1, Number(match[3] ?? 1)) } : { query: value };
}
