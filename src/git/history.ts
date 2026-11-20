import { desktop } from "../core/bridge";
import type { GitHistoryCommit, GitHistoryPage } from "../types/gitHistory";

export const HISTORY_PAGE_SIZE = 50;
export const HISTORY_ROW_HEIGHT = 48;
export const HISTORY_LOAD_THRESHOLD = 240;

export function appendHistoryCommits(
  existing: readonly GitHistoryCommit[],
  incoming: readonly GitHistoryCommit[],
): GitHistoryCommit[] {
  if (!incoming.length) {
    return [...existing];
  }
  const seen = new Set(existing.map((commit) => commit.sha));
  const appended = incoming.filter((commit) => !seen.has(commit.sha));
  return appended.length ? [...existing, ...appended] : [...existing];
}

export function shouldKeepHistoryOnRefresh(
  currentHead: string | null,
  currentCount: number,
  incoming: GitHistoryPage,
): boolean {
  return (
    currentHead !== null && incoming.head === currentHead && currentCount >= incoming.commits.length
  );
}

export function shouldLoadMoreHistory(
  scrollTop: number,
  viewportHeight: number,
  totalCount: number,
): boolean {
  return (
    viewportHeight > 0 &&
    scrollTop + viewportHeight >= totalCount * HISTORY_ROW_HEIGHT - HISTORY_LOAD_THRESHOLD
  );
}

export async function copyCommitHash(sha: string) {
  if (desktop) {
    await (await import("@tauri-apps/plugin-clipboard-manager")).writeText(sha);
  } else {
    await navigator.clipboard.writeText(sha);
  }
}
