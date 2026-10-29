import type { GitBlameRange, GitFileBlame, GitRepository } from "../types/types";

const visible = (path: string) => path.replace(/^\\\\\?\\UNC\\/i, "//").replace(/^\\\\\?\\/, "").replace(/\\/g, "/").replace(/\/$/, "");

export function blameRepository(path: string, repositories: readonly GitRepository[]) {
  const file = visible(path);
  const ignoreCase = /^[a-z]:\//i.test(file) || file.startsWith("//");
  const key = ignoreCase ? file.toLowerCase() : file;
  let result: { repository: GitRepository; path: string; oldPath: string | null } | null = null;
  let longest = 0;
  for (const repository of repositories) {
    const base = visible(repository.path) + "/";
    const prefix = ignoreCase ? base.toLowerCase() : base;
    if (base.length <= longest || !key.startsWith(prefix)) { continue; }
    const relative = file.slice(base.length);
    const change = repository.changes.find((c) => ignoreCase ? c.path.toLowerCase() === relative.toLowerCase() : c.path === relative);
    result = { repository, path: relative, oldPath: change?.oldPath ?? null };
    longest = base.length;
  }
  return result;
}

export function blameRange(ranges: readonly GitBlameRange[], line: number): GitBlameRange | undefined {
  let low = 0, high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ranges[middle].startLine <= line) { low = middle + 1; }
    else { high = middle; }
  }
  const range = ranges[low - 1];
  return range && line < range.startLine + range.lineCount ? range : undefined;
}

const relativeTime = new Intl.RelativeTimeFormat("en", { numeric: "always" });
export function blameAge(seconds: number, now = Date.now()): string {
  const elapsed = (seconds * 1000 - now) / 1000;
  const age = Math.abs(elapsed);
  if (age < 60) { return "just now"; }
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 365 * 86400], ["month", 30 * 86400], ["day", 86400], ["hour", 3600], ["minute", 60],
  ];
  const [unit, duration] = units.find(([, duration]) => age >= duration)!;
  return relativeTime.format(Math.trunc(elapsed / duration), unit);
}

export type BlameTask = { key: string; read: () => Promise<GitFileBlame | null> };
export type BlameResult = { task: BlameTask; data: GitFileBlame } | null;

// One request at a time. Pending edits replace each other while history is read.
export function createBlameLoader(publish: (result: BlameResult) => void) {
  let latest: BlameTask | null = null;
  let generation = 0;
  let ready = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function run() {
    if (running || !ready || !latest) { return; }
    const task = latest, request = generation;
    ready = false;
    running = true;
    try {
      const data = await task.read();
      if (request === generation) { publish(data ? { task, data } : null); }
    } catch {
      if (request === generation) { publish(null); }
    } finally {
      running = false;
      void run();
    }
  }
  return {
    update(task: BlameTask | null) {
      // A Git watcher refresh can replace the request without changing the
      // document being attributed. Keep its label until the new result arrives.
      if (!task || task.key !== latest?.key) { publish(null); }
      latest = task;
      generation++;
      ready = false;
      clearTimeout(timer);
      if (task) {
        timer = setTimeout(() => { ready = true; void run(); }, 200);
      }
    },
  };
}
