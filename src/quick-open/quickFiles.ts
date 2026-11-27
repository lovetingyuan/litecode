import {
  compareItemsByFuzzyScore,
  prepareQuery,
  scoreItemFuzzy,
  type FuzzyScorerCache,
  type IItemAccessor,
  type IItemScore,
  type IPreparedQuery,
} from "@codingame/monaco-vscode-api/vscode/vs/base/common/fuzzyScorer";
import type { IMatch } from "@codingame/monaco-vscode-api/vscode/vs/base/common/filters";
import { sep } from "@codingame/monaco-vscode-api/vscode/vs/base/common/path";
import type {
  FileSearchMessage,
  FileSearchReply,
  MatchRange,
  QuickFile,
} from "../types/quickOpen";

export type { FileSearchMessage, FileSearchReply, MatchRange, QuickFile };

type Candidate = {
  path: string;
  key: string;
  label: string;
  description: string;
  scorerPath: string;
  haystack: string;
};

const MAX_RESULTS = 100;

const accessor: IItemAccessor<Candidate> = {
  getItemLabel: (file) => file.label,
  getItemDescription: (file) => file.description || undefined,
  getItemPath: (file) => file.scorerPath,
};

const visible = (path: string) =>
  path
    .replace(/^\\\\\?\\UNC\\/i, "//")
    .replace(/^\\\\\?\\/, "")
    .replace(/\\/g, "/");

const isWindowsPath = (value: string) => /^(?:[a-z]:\/|\/\/)/i.test(value);

const canonicalKey = (value: string) => (isWindowsPath(value) ? value.toLowerCase() : value);

function isSubsequence(haystack: string, needle: string): boolean {
  let cursor = 0;
  for (let i = 0; i < needle.length; i++) {
    cursor = haystack.indexOf(needle[i], cursor);
    if (cursor < 0) {
      return false;
    }
    cursor++;
  }
  return true;
}

function clampMatches(matches: readonly IMatch[] | undefined, length: number): MatchRange[] {
  if (!matches?.length || length <= 0) {
    return [];
  }
  const result: MatchRange[] = [];
  for (const match of matches) {
    const start = Math.max(0, match.start);
    const end = Math.min(length, match.end);
    if (start < end) {
      result.push({ start, end });
    }
  }
  return result;
}

export function prepareQuickFiles(paths: string[], root: string | null): Candidate[] {
  const base = root ? visible(root).replace(/\/$/, "") + "/" : null;
  const baseFolded = base && isWindowsPath(base) ? base.toLowerCase() : null;
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const path of paths) {
    const value = visible(path);
    const key = canonicalKey(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const within = baseFolded
      ? value.toLowerCase().startsWith(baseFolded)
      : base !== null && value.startsWith(base);
    const relative = within && base ? value.slice(base.length) : value;
    const offset = relative.lastIndexOf("/") + 1;
    candidates.push({
      path,
      key,
      label: relative.slice(offset),
      description: relative.slice(0, Math.max(0, offset - 1)),
      scorerPath: sep === "/" ? relative : relative.replace(/\//g, sep),
      haystack: relative.toLowerCase(),
    });
  }
  return candidates;
}

type RankedCandidate = { file: Candidate; score: IItemScore };

function emptyQueryResults(
  workspace: Candidate[],
  open: Candidate[],
  opened: Set<string>,
): QuickFile[] {
  const results: QuickFile[] = [];
  const push = (file: Candidate) => {
    results.push({
      path: file.path,
      label: file.label,
      description: file.description,
      labelMatches: [],
      descriptionMatches: [],
    });
  };
  for (const file of open) {
    if (results.length === MAX_RESULTS) {
      return results;
    }
    push(file);
  }
  for (const file of workspace) {
    if (results.length === MAX_RESULTS) {
      return results;
    }
    if (!opened.has(file.key)) {
      push(file);
    }
  }
  return results;
}

function matchesAllPieces(haystack: string, pieces: readonly string[]): boolean {
  for (const piece of pieces) {
    if (!isSubsequence(haystack, piece)) {
      return false;
    }
  }
  return true;
}

function insertRanked(
  best: RankedCandidate[],
  file: Candidate,
  itemScore: IItemScore,
  prepared: IPreparedQuery,
  cache: FuzzyScorerCache,
) {
  if (best.length === MAX_RESULTS) {
    const worst = best[MAX_RESULTS - 1];
    if (
      itemScore.score < worst.score.score ||
      (itemScore.score === worst.score.score &&
        compareItemsByFuzzyScore(worst.file, file, prepared, true, accessor, cache) <= 0)
    ) {
      return;
    }
  }
  let lo = 0;
  let hi = best.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const cmp = compareItemsByFuzzyScore(best[mid].file, file, prepared, true, accessor, cache);
    if (cmp <= 0) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  best.splice(lo, 0, { file, score: itemScore });
  if (best.length > MAX_RESULTS) {
    best.pop();
  }
}

export function searchQuickFiles(
  workspace: Candidate[],
  open: Candidate[],
  query: string,
): QuickFile[] {
  const prepared = prepareQuery(query);
  const opened = new Set(open.map((file) => file.key));
  if (!prepared.normalized) {
    return emptyQueryResults(workspace, open, opened);
  }

  const pieces =
    prepared.values && prepared.values.length > 1
      ? prepared.values.map((piece) => piece.normalizedLowercase.replace(/\\/g, "/"))
      : [prepared.normalizedLowercase.replace(/\\/g, "/")];
  const cache: FuzzyScorerCache = Object.create(null);
  const best: RankedCandidate[] = [];

  function consider(file: Candidate) {
    if (!matchesAllPieces(file.haystack, pieces)) {
      return;
    }
    const itemScore = scoreItemFuzzy(file, prepared, true, accessor, cache);
    if (itemScore.score) {
      insertRanked(best, file, itemScore, prepared, cache);
    }
  }

  for (const file of open) {
    consider(file);
  }
  for (const file of workspace) {
    if (!opened.has(file.key)) {
      consider(file);
    }
  }

  return best.map(({ file, score }) => ({
    path: file.path,
    label: file.label,
    description: file.description,
    labelMatches: clampMatches(score.labelMatch, file.label.length),
    descriptionMatches: clampMatches(score.descriptionMatch, file.description.length),
  }));
}
