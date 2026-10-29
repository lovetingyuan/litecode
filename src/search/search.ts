import { call, channel, errorMessage } from "../core/bridge";
import {
  useApp,
  setApp,
  initialSearch,
  primarySearchId,
  searchSession,
  patchSearch,
} from "../store/store";
import {
  checkpoint,
  newDocument,
  openPath,
  models,
  showDocument,
  normalize,
  patchDoc,
  editors,
  patchMediaView,
} from "../editor/documents";
import { monaco } from "../editor/monaco";
import type { SearchMatch, DiskDocument, Query } from "../types/types";
import { isTextDocument } from "../utils/media";

export function focusSearch() {
  setTimeout(() => window.dispatchEvent(new Event("focus-search")), 0);
}

export function activateSearchTab(id: string) {
  if (searchSession(id)) {
    setApp({ activeSearchId: id });
  }
}

export function createSearchTab() {
  const s = useApp.getState();
  const search = initialSearch(crypto.randomUUID(), s.nextSearchNumber);
  setApp({
    searchSessions: [...s.searchSessions, search],
    activeSearchId: search.id,
    nextSearchNumber: s.nextSearchNumber + 1,
    sidebar: "search",
    view: "editor",
  });
  focusSearch();
  return search.id;
}

export function closeSearchTab(id: string) {
  const s = useApp.getState();
  const index = s.searchSessions.findIndex((search) => search.id === id);
  if (id === primarySearchId || index < 0) {
    return;
  }
  cancelSearch(id);
  setApp({
    searchSessions: useApp.getState().searchSessions.filter((search) => search.id !== id),
    activeSearchId: s.activeSearchId === id ? s.searchSessions[index - 1].id : s.activeSearchId,
  });
  if (s.activeSearchId === id) {
    focusSearch();
  }
}

export function resetSearchTabs() {
  const query = searchSession(primarySearchId)!.query;
  for (const search of useApp.getState().searchSessions) {
    cancelSearch(search.id);
  }
  setApp({
    searchSessions: [{ ...initialSearch(), query: { ...query } }],
    activeSearchId: primarySearchId,
  });
}

useApp.subscribe((state, previous) => {
  if (state.root !== previous.root) {
    resetSearchTabs();
  }
});

export async function runSearch(query?: Query, id = useApp.getState().activeSearchId) {
  const search = searchSession(id);
  if (!search) {
    return;
  }
  query ??= search.query;
  cancelSearch(id);
  const requestId = crypto.randomUUID();
  const root = useApp.getState().root;
  let completed = false;
  const current = () =>
    useApp.getState().root === root && searchSession(id)?.requestId === requestId;
  patchSearch(id, {
    ...(query !== search.query ? { query } : {}),
    results: [],
    searching: !!query.text,
    requestId: query.text ? requestId : null,
    limited: false,
    searchErrors: [],
  });
  if (!query.text) {
    return;
  }
  try {
    await checkpoint();
    if (!current()) {
      return;
    }
    const onBatch = channel((batch) => {
      if (!current() || batch.requestId !== requestId) {
        return;
      }
      const s = searchSession(id)!;
      completed = batch.done;
      patchSearch(id, {
        results: [...s.results, ...batch.matches],
        searching: !batch.done,
        limited: batch.limited,
        searchErrors: [...s.searchErrors, ...batch.errors],
        requestId: batch.done ? null : requestId,
      });
      void call("search_ack", { requestId: batch.requestId, sequence: batch.sequence });
    });
    await call("search_start", { requestId, query, onBatch });
    // Cancellation can reach Rust before search_start has registered the task.
    if (!completed && !current()) {
      void call("search_cancel", { requestId }).catch(() => {});
    }
    if (useApp.getState().root === root && searchSession(id)?.query === query) {
      setApp((s) => ({
        searchHistory: [query.text, ...s.searchHistory.filter((q) => q !== query.text)].slice(
          0,
          30,
        ),
      }));
    }
  } catch (e) {
    if (current()) {
      patchSearch(id, { searching: false, requestId: null, searchErrors: [errorMessage(e)] });
    }
  }
}

export function cancelSearch(id = useApp.getState().activeSearchId) {
  const requestId = searchSession(id)?.requestId;
  if (requestId) {
    void call("search_cancel", { requestId }).catch(() => {});
  }
  patchSearch(id, { requestId: null, searching: false });
}

export async function openMatch(match: SearchMatch, side = false, group?: string) {
  const groupId = group ?? useApp.getState().activeGroup;
  if (match.documentId && useApp.getState().docs[match.documentId]?.kind === "svg") {
    patchMediaView(groupId, match.documentId, { mode: "text" });
  }
  if (match.documentId && models.has(match.documentId)) {
    showDocument(match.documentId, {
      pinned: side,
      group: groupId,
      line: match.line,
      column: match.column,
    });
  } else {
    await openPath(match.path, {
      pinned: side,
      group: groupId,
      line: match.line,
      column: match.column,
    });
  }
  // showDocument reveals the position next frame; apply the range after that reveal.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const e = editors.get(groupId);
  const range = new monaco.Range(match.line, match.column, match.endLine, match.endColumn);
  e?.setSelection(range);
  e?.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Immediate);
  if (e && match.line === match.endLine) {
    const start = e.getOffsetForColumn(match.line, match.column);
    const end = e.getOffsetForColumn(match.endLine, match.endColumn);
    const layout = e.getLayoutInfo();
    if (
      start >= 0 &&
      end >= 0 &&
      Math.max(start, end) <= layout.contentWidth - layout.verticalScrollbarWidth
    ) {
      e.setScrollLeft(0, monaco.editor.ScrollType.Immediate);
    }
  }
}

let navigationResults: SearchMatch[] = [];
let navigationIndex = -1;
export async function nextSearchResult(direction = 1) {
  const results = searchSession()!.results;
  if (!results.length) {
    return;
  }
  if (results !== navigationResults) {
    navigationResults = results;
    navigationIndex = direction > 0 ? -1 : 0;
  }
  navigationIndex = (navigationIndex + direction + results.length) % results.length;
  await openMatch(results[navigationIndex]);
}

export {
  replaceMatches,
  cancelReplacementPlan,
  undoReplacement,
  retryReplacement,
  recoverInterruptedReplacements,
} from "./replacements";

export async function createSearchEditor(
  query = searchSession()!.query,
  matches = searchSession()!.results,
  id?: string,
) {
  const lines = [
    `# Query: ${JSON.stringify(query)}`,
    "# Search results — edits here do not change source files.",
    "",
  ];
  const files = new Map<string, SearchMatch[]>();
  for (const match of matches) {
    let hits = files.get(match.path);
    if (!hits) {
      files.set(match.path, (hits = []));
    }
    hits.push(match);
  }
  for (const [path, hits] of files) {
    lines.push(`${path}:`);
    const context = Math.min(20, Math.max(0, query.context || 0));
    if (!context) {
      for (const hit of hits) {
        lines.push(`  ${hit.line}:${hit.column}: ${hit.preview.replace(/\r?\n/g, "\n      ")}`);
      }
      continue;
    }
    try {
      const doc = hits[0].documentId
        ? useApp.getState().docs[hits[0].documentId]
        : Object.values(useApp.getState().docs).find(
            (d) => d.path && normalize(d.path) === normalize(path),
          );
      if (doc && !isTextDocument(doc)) {
        throw new Error("This file is no longer a text document.");
      }
      const text = doc
        ? models.get(doc.id)!.getValue()
        : (await call<DiskDocument>("read_document", { path })).text;
      const source = text.split(/\r?\n/);
      const included = new Set<number>();
      for (const hit of hits) {
        for (
          let n = Math.max(1, hit.line - context);
          n <= Math.min(source.length, hit.endLine + context);
          n++
        ) {
          included.add(n);
        }
      }
      let previous = 0;
      for (const n of [...included].sort((a, b) => a - b)) {
        if (previous && n > previous + 1) {
          lines.push("  …");
        }
        const hit = hits.find((h) => h.line === n);
        lines.push(hit ? `  ${n}:${hit.column}: ${source[n - 1]}` : `  ${n}: ${source[n - 1]}`);
        previous = n;
      }
    } catch (e) {
      lines.push(`  # Context unavailable: ${errorMessage(e)}`);
    }
  }
  if (id && models.has(id)) {
    const m = models.get(id)!;
    m.pushStackElement();
    m.pushEditOperations(
      [],
      [{ range: m.getFullModelRange(), text: lines.join("\n") }],
      () => null,
    );
    m.pushStackElement();
    patchDoc(id, { searchQuery: query });
    return id;
  }
  return newDocument(lines.join("\n"), "Search.code-search", query);
}
