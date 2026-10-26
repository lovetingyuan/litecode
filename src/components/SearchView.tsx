import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useApp, notify, patchSearch, primarySearchId, searchSession } from "../store/store";
import { activateSearchTab, cancelSearch, cancelReplacementPlan, closeSearchTab, createSearchTab, openMatch, replaceMatches, runSearch } from "../search/search";
import { basename, relative, splitGroup } from "../editor/documents";
import { Icon, IconButton } from "./ui";
import { errorMessage, desktop } from "../core/bridge";
import { ask } from "./dialog";
import { revealInTree } from "./Explorer";
import { EditorTabsScrollbar, FileIcon } from "./EditorGroup";
import { languageFor } from "../editor/monaco";
import { searchPreview } from "../utils/searchPreview";
import {
  buildSearchResults,
  searchResultRows,
  searchRowMatches,
  type ResultRow,
} from "../utils/searchResults";
import type { Query, SearchMatch } from "../types/types";

const resultHeight = 26;
const resultBottomPadding = 48;
export function SearchView() {
  const sessions = useApp((s) => s.searchSessions);
  const root = useApp((s) => s.root);
  useEffect(() => {
    void runSearch(undefined, primarySearchId);
  }, []);
  return (
    <section className="view search-view" aria-label="Search"
      style={{ "--search-result-height": `${resultHeight}px` } as CSSProperties}>
      {sessions.map((session) => <SearchPanel key={`${root}:${session.id}`} id={session.id} />)}
    </section>
  );
}

function SearchTabs() {
  const sessions = useApp((s) => s.searchSessions);
  const activeId = useApp((s) => s.activeSearchId);
  const tabs = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = tabs.current;
    const active = element?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!element || !active) { return; }
    const reveal = () => {
      const bounds = active.getBoundingClientRect();
      const viewport = element.getBoundingClientRect();
      if (bounds.left < viewport.left) { element.scrollLeft -= viewport.left - bounds.left; }
      else if (bounds.right > viewport.right) { element.scrollLeft += bounds.right - viewport.right; }
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(element);
    observer.observe(active);
    return () => observer.disconnect();
  }, [activeId]);
  if (sessions.length === 1) { return null; }
  return (
    <div className="search-tabs-toolbar">
    <div ref={tabs} role="tablist" aria-label="Search tabs" className="tabs search-tabs"
      onKeyDown={(event) => {
        const index = sessions.findIndex((session) => session.id === activeId);
        const next = event.key === "Home" ? 0 : event.key === "End" ? sessions.length - 1
          : event.key === "ArrowRight" ? (index + 1) % sessions.length
          : event.key === "ArrowLeft" ? (index + sessions.length - 1) % sessions.length : -1;
        if (next < 0 || !(event.target as HTMLElement).closest('[role="tab"]')) { return; }
        event.preventDefault();
        const id = sessions[next].id;
        activateSearchTab(id);
        requestAnimationFrame(() => document.getElementById(`search-tab-${id}`)?.focus());
      }}>
      {sessions.map((session) => {
        const title = session.id === primarySearchId ? "Search" : session.query.text || `Search ${session.number}`;
        return (
          <Fragment key={session.id}>
            <button id={`search-tab-${session.id}`} role="tab" type="button"
              className={`tab${session.id === activeId ? " tab-active" : ""}`}
              aria-selected={session.id === activeId} aria-controls={`search-panel-${session.id}`}
              tabIndex={session.id === activeId ? 0 : -1} title={title}
              onClick={() => activateSearchTab(session.id)}>
              <span>{title.replace(/\s+/g, " ")}</span>
            </button>
            {session.id !== primarySearchId && <IconButton icon="close" label={`Close search: ${title}`}
              onClick={() => closeSearchTab(session.id)} />}
          </Fragment>
        );
      })}
    </div>
    <EditorTabsScrollbar viewportRef={tabs} tabIds={sessions.map((session) => session.id)} />
    </div>
  );
}

function SearchPanel({ id }: { id: string }) {
  const session = useApp((s) => s.searchSessions.find((search) => search.id === id)!);
  const active = useApp((s) => s.activeSearchId === id);
  const multiple = useApp((s) => s.searchSessions.length > 1);
  const { query, results, searching, searchErrors: errors, limited } = session;
  const replacementPhase = useApp((s) => s.replacementPhase);
  const root = useApp((s) => s.root);
  const history = useApp((s) => s.searchHistory);
  const [replace, setReplace] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [preserve, setPreserve] = useState(false);
  const [details, setDetails] = useState(false);
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [listMode, setListMode] = useState(true);
  const [scroll, setScroll] = useState(0);
  const scrollTop = useRef(0);
  const wasActive = useRef(false);
  const [height, setHeight] = useState(400);
  const [selected, setSelected] = useState(-1);
  const [menu, setMenu] = useState<{ x: number; y: number; row: ResultRow } | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const pendingSearch = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(pendingSearch.current), []);
  useEffect(() => {
    const focus = () => {
      if (useApp.getState().activeSearchId !== id) { return; }
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener("focus-search", focus);
    const observer = new ResizeObserver((entries) => {
      if (entries[0].contentRect.height > 0) { setHeight(entries[0].contentRect.height); }
    });
    if (viewport.current) {
      observer.observe(viewport.current);
    }
    return () => {
      window.removeEventListener("focus-search", focus);
      observer.disconnect();
    };
  }, [id]);
  useEffect(() => {
    if (!active) { setMenu(null); }
  }, [active]);
  useEffect(() => {
    if (!menu) {
      return;
    }
    const close = () => setMenu(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menu]);
  const { files, tree, paths } = useMemo(() => buildSearchResults(results, root), [results, root]);
  const nodes = listMode ? files : tree;
  const allCollapsed = nodes.length > 0 && nodes.every((node) => collapsed.has(node.path));
  const rows = useMemo(() => searchResultRows(nodes, collapsed), [nodes, collapsed]);
  const contentHeight = rows.length ? rows.length * resultHeight + resultBottomPadding : 0;
  useLayoutEffect(() => {
    const resumed = active && !wasActive.current;
    wasActive.current = active;
    if (!active) { return; }
    const top = Math.min(
      resumed ? scrollTop.current : viewport.current?.scrollTop ?? 0,
      Math.max(0, contentHeight - height),
    );
    if (viewport.current) {
      viewport.current.scrollTop = top;
    }
    setScroll(top);
    scrollTop.current = top;
    if (selected >= rows.length) {
      setSelected(-1);
    }
  }, [active, contentHeight, rows.length, height, selected]);
  function resetSelection() {
    setSelected(-1);
    setScroll(0);
    scrollTop.current = 0;
    if (viewport.current) {
      viewport.current.scrollTop = 0;
    }
  }
  function search() {
    clearTimeout(pendingSearch.current);
    resetSelection();
    void runSearch(undefined, id);
  }
  function clearResults() {
    if (id === primarySearchId) { cancelReplacementPlan(); }
    clearTimeout(pendingSearch.current);
    cancelSearch(id);
    patchSearch(id, { results: [], searchErrors: [], limited: false });
    resetSelection();
  }
  function update(patch: Partial<Query>) {
    if (id === primarySearchId) { cancelReplacementPlan(); }
    clearTimeout(pendingSearch.current);
    cancelSearch(id);
    resetSelection();
    const next = { ...query, ...patch };
    patchSearch(id, {
      query: next,
      requestId: null,
      results: [],
      searchErrors: [],
      limited: false,
    });
    pendingSearch.current = setTimeout(() => {
      if (useApp.getState().root === root && searchSession(id)?.query === next) {
        void runSearch(next, id);
      }
    }, 250);
  }
  function toggle(path: string) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }
  function removeRow(row: ResultRow) {
    const removed = new Set(searchRowMatches(row));
    patchSearch(id, { results: results.filter((match) => !removed.has(match)) });
  }
  async function replaceRows(matches: SearchMatch[], preview = false) {
    if (id !== primarySearchId || useApp.getState().replacementPhase) { return; }
    if (
      !preview &&
      matches.length > 1 &&
      (await ask(
        "Replace search results?",
        `Replace ${matches.length} occurrence(s)? Closed files will be saved. Open editors keep unsaved changes. Use Undo Workspace Replacement to undo this operation.`,
        ["Replace", "Cancel"],
      )) !== "Replace"
    ) {
      return;
    }
    if (useApp.getState().root !== root || searchSession(id)?.query !== query) { return; }
    try {
      const errors = await replaceMatches(matches, replacement, preserve, query, preview);
      if (!preview && errors !== null && !errors?.length && useApp.getState().root === root && searchSession(id)?.query === query) {
        await runSearch(query, id);
      }
    } catch (e) {
      notify(errorMessage(e));
    }
  }
  async function copy(text: string) {
    if (desktop) {
      await (await import("@tauri-apps/plugin-clipboard-manager")).writeText(text);
    } else {
      await navigator.clipboard.writeText(text);
    }
  }
  const first = Math.max(0, Math.floor(scroll / resultHeight) - 5);
  const visible = rows.slice(first, first + Math.ceil(height / resultHeight) + 12);
  return (
    <div className="view search-panel" hidden={!active}>
      <div className="view-title">
        <span>Search</span>
        <div className="actions">
          {id === primarySearchId && replacementPhase === "planning" && (
            <IconButton icon="search-stop" label="Cancel Replacement Planning" onClick={cancelReplacementPlan} />
          )}
          <IconButton
            icon={searching ? "search-stop" : "refresh"}
            label={searching ? "Cancel Search" : "Refresh Search"}
            onClick={searching ? () => cancelSearch(id) : search}
          />
          <IconButton icon="clear-all" label="Clear Search Results" onClick={clearResults} />
          <IconButton
            icon="new-file"
            label="New Search"
            onClick={() => createSearchTab()}
          />
          <IconButton
            icon={listMode ? "list-flat" : "list-tree"}
            label={listMode ? "View as Tree" : "View as List"}
            onClick={() => {
              setListMode(!listMode);
              resetSelection();
            }}
          />
          <IconButton
            icon={allCollapsed ? "expand-all" : "collapse-all"}
            label={allCollapsed ? "Expand All Results" : "Collapse All Results"}
            onClick={() => {
              setCollapsed(
                allCollapsed
                  ? new Set<string>()
                  : new Set(listMode ? files.map((file) => file.path) : paths),
              );
              resetSelection();
            }}
          />
        </div>
      </div>
      {active && <SearchTabs />}
      <div className="search-panel-content" id={`search-panel-${id}`} role="tabpanel"
        aria-labelledby={multiple ? `search-tab-${id}` : undefined}
        aria-label={id === primarySearchId ? "Search" : query.text || `Search ${session.number}`}>
      <div className="search-form">
        <div className="search-inputs">
          {id === primarySearchId && <IconButton
            className="icon-button search-replace-toggle"
            icon={replace ? "chevron-down" : "chevron-right"}
            label="Toggle Replace"
            aria-expanded={replace}
            aria-controls={`search-replace-row-${id}`}
            onClick={() => setReplace(!replace)}
          />}
          <div className="search-query-row">
            <div className="input-options">
              <textarea
                ref={input}
                value={query.text}
                rows={Math.min(6, query.text.split("\n").length)}
                placeholder="Search"
                aria-label="Search text"
                onChange={(e) => update({ text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey) {
                    e.preventDefault();
                    search();
                  }
                  if (e.key === "Escape") {
                    if (id === primarySearchId) { cancelReplacementPlan(); }
                    clearTimeout(pendingSearch.current);
                    cancelSearch(id);
                  }
                  if (e.altKey && e.key === "ArrowUp" && history.length) {
                    update({
                      text: history[Math.min(history.indexOf(query.text) + 1, history.length - 1)],
                    });
                  }
                }}
              />
              <div className="actions">
                <IconButton
                  className={`icon-button option${query.caseSensitive ? " active" : ""}`}
                  icon="case-sensitive"
                  label="Match Case (Alt+C)"
                  aria-pressed={query.caseSensitive}
                  onClick={() => update({ caseSensitive: !query.caseSensitive })}
                />
                <IconButton
                  className={`icon-button option${query.wholeWord ? " active" : ""}`}
                  icon="whole-word"
                  label="Match Whole Word (Alt+W)"
                  aria-pressed={query.wholeWord}
                  onClick={() => update({ wholeWord: !query.wholeWord })}
                />
                <IconButton
                  className={`icon-button option${query.regex ? " active" : ""}`}
                  icon="regex"
                  label="Use Regular Expression (Alt+R)"
                  aria-pressed={query.regex}
                  onClick={() => update({ regex: !query.regex })}
                />
              </div>
            </div>
          </div>
          {replace && (
            <div className="search-query-row" id={`search-replace-row-${id}`}>
              <div className="input-options">
                <input
                  placeholder="Replace"
                  aria-label="Replace text"
                  value={replacement}
                  onChange={(e) => setReplacement(e.target.value)}
                />
                <IconButton
                  className={`icon-button option${preserve ? " active" : ""}`}
                  icon="preserve-case"
                  label="Preserve Case"
                  aria-pressed={preserve}
                  onClick={() => setPreserve(!preserve)}
                />
              </div>
              <IconButton
                className="icon-button search-replace-all"
                icon="replace-all"
                label="Replace All"
                disabled={!results.length || !!replacementPhase}
                onClick={() => void replaceRows(results)}
              />
            </div>
          )}
        </div>
        <div className="search-options-row">
          <IconButton
            icon="ellipsis"
            label="Toggle Search Details"
            aria-expanded={details}
            aria-controls={`search-details-${id}`}
            onClick={() => setDetails(!details)}
          />
        </div>
        {details && (
          <div className="search-details" id={`search-details-${id}`}>
            <label htmlFor={`search-include-${id}`}>files to include</label>
            <div className="input-options">
              <input
                id={`search-include-${id}`}
                value={query.include}
                onChange={(e) => update({ include: e.target.value })}
                placeholder="e.g. *.ts, src/**/include"
              />
              <div className="actions">
                <IconButton
                  className={`icon-button option${query.changedOnly ? " active" : ""}`}
                  icon="edit-code"
                  label="Search only Changed Files"
                  aria-pressed={query.changedOnly}
                  onClick={() => update({ changedOnly: !query.changedOnly })}
                />
                <IconButton
                  className={`icon-button option${query.openOnly ? " active" : ""}`}
                  icon="book"
                  label="Search only in Open Editors"
                  aria-pressed={query.openOnly}
                  onClick={() => update({ openOnly: !query.openOnly })}
                />
              </div>
            </div>
            <label htmlFor={`search-exclude-${id}`}>files to exclude</label>
            <div className="input-options">
              <input
                id={`search-exclude-${id}`}
                value={query.exclude}
                onChange={(e) => update({ exclude: e.target.value })}
              />
              <div className="actions">
                <IconButton
                  className={`icon-button option${query.useIgnore ? " active" : ""}`}
                  icon="exclude"
                  label="Use Exclude Settings and Ignore Files"
                  aria-pressed={query.useIgnore}
                  onClick={() => update({ useIgnore: !query.useIgnore })}
                />
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="search-summary" aria-live="polite">
        {id === primarySearchId && replacementPhase
          ? replacementPhase === "planning" ? "Planning replacements…" : "Applying replacements…"
          : searching
          ? "Searching…"
          : query.text
            ? results.length
              ? `${results.length} results in ${files.length} files`
              : "No results found."
            : "Search across files in your workspace."}
      </div>
      {limited && (
        <p className="inline-warning">
          Results capped at 20,000. Refine your search. Files over 20 MiB are excluded.
        </p>
      )}
      {errors.map((e, i) => (
        <p key={i} className="inline-error" role="alert">
          {e}
        </p>
      ))}
      <div
        className="search-results"
        ref={viewport}
        tabIndex={0}
        role="tree"
        aria-label="Search results"
        onScroll={(e) => {
          if (active) {
            scrollTop.current = e.currentTarget.scrollTop;
            setScroll(scrollTop.current);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!rows.length) {
              return;
            }
            const index = Math.min(
              rows.length - 1,
              Math.max(0, selected < 0 ? 0 : selected + (e.key === "ArrowDown" ? 1 : -1)),
            );
            setSelected(index);
            const top = viewport.current?.scrollTop ?? 0;
            if (index * resultHeight < top) {
              viewport.current?.scrollTo({ top: index * resultHeight });
            } else if ((index + 1) * resultHeight > top + height) {
              viewport.current?.scrollTo({ top: (index + 1) * resultHeight - height });
            }
          }
          const row = rows[selected];
          if (!row) {
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            if (row.kind !== "match") {
              toggle(row.path);
            } else {
              void openMatch(row.match).catch((e) => notify(errorMessage(e)));
            }
          }
          if (e.key === "ArrowRight" && row.kind !== "match") {
            e.preventDefault();
            if (collapsed.has(row.path)) {
              toggle(row.path);
            }
          }
          if (e.key === "ArrowLeft" && row.kind !== "match") {
            e.preventDefault();
            if (!collapsed.has(row.path)) {
              toggle(row.path);
            }
          }
          if (e.key === "Delete") {
            removeRow(row);
          }
        }}
      >
        <div style={{ height: contentHeight, position: "relative" }}>
          {visible.map((row, offset) => (
            <div
              role="treeitem"
              aria-level={row.depth + 1}
              aria-selected={selected === first + offset}
              aria-expanded={row.kind !== "match" ? !collapsed.has(row.path) : undefined}
              aria-label={
                row.kind !== "match"
                  ? `${row.name}, ${row.count} matches`
                  : `${basename(row.match.path)}:${row.match.line}:${row.match.column}: ${row.match.preview}`
              }
              key={row.kind !== "match" ? row.path : `${row.index}:${row.match.path}`}
              className={`result-row ${row.kind} ${selected === first + offset ? "selected" : ""}`}
              style={{
                top: (first + offset) * resultHeight,
                paddingLeft: 18 + row.depth * 12 + (row.kind === "match" ? 18 : 0),
              }}
              onClick={() => {
                setSelected(first + offset);
                viewport.current?.focus();
                if (row.kind !== "match") {
                  toggle(row.path);
                } else {
                  void openMatch(row.match).catch((e) => notify(errorMessage(e)));
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, row });
              }}
            >
              {!listMode &&
                Array.from({ length: row.depth }, (_, level) => (
                  <span
                    key={level}
                    className="result-indent-guide"
                    aria-hidden="true"
                    style={{ left: 26 + level * 12 }}
                  />
                ))}
              {row.kind !== "match" ? (
                <>
                  <Icon name={collapsed.has(row.path) ? "chevron-right" : "chevron-down"} />
                  {row.kind === "file" && (
                    <span className="result-file-icon">
                      <FileIcon language={languageFor(row.path)} />
                    </span>
                  )}
                  <span className="result-filename" title={row.name}>
                    {row.name}
                  </span>
                  {listMode && (
                    <span className="muted result-path" title={relative(row.path)}>
                      {relative(row.path).split(/[\\/]/).slice(0, -1).join("\\")}
                    </span>
                  )}
                  <span className="count">{row.count}</span>
                </>
              ) : (
                <>
                  <span
                    className="result-preview"
                    title={`${relative(row.match.path)}:${row.match.line}:${row.match.column}\n${row.match.preview}`}
                  >
                    {highlight(row.match)}
                  </span>
                  {replace && (
                    <button
                      className="inline-action"
                      aria-label="Replace Match"
                      title="Replace Match"
                      disabled={!!replacementPhase}
                      onClick={(e) => {
                        e.stopPropagation();
                        void replaceRows([row.match]);
                      }}
                    >
                      <Icon name="replace" />
                    </button>
                  )}
                  <button
                    className="inline-action"
                    aria-label="Remove Result"
                    title="Remove Result"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeRow(row);
                    }}
                  >
                    <Icon name="close" />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
      {menu && (
        <div
          className="context-menu floating-menu"
          role="menu"
          style={{
            left: Math.min(menu.x, window.innerWidth - 230),
            top: Math.min(menu.y, window.innerHeight - 280),
          }}
        >
          {(() => {
            const row = menu.row;
            const matches = searchRowMatches(row);
            const path = row.kind !== "match" ? row.path : row.match.path;
            const folder =
              row.kind === "folder"
                ? relative(path)
                : relative(path).split("/").slice(0, -1).join("/");
            return (
              <>
                <button onClick={() => void openMatch(matches[0], true, splitGroup())}>
                  Open to the Side
                </button>
                <button
                  onClick={() =>
                    void copy(
                      matches
                        .map((m) => `${relative(m.path)}:${m.line}:${m.column}: ${m.preview}`)
                        .join("\n"),
                    )
                  }
                >
                  Copy Match
                </button>
                <button onClick={() => void copy(path)}>Copy Path</button>
                <button
                  onClick={() =>
                    void copy(
                      results
                        .map((m) => `${m.path}:${m.line}:${m.column}: ${m.preview}`)
                        .join("\n"),
                    )
                  }
                >
                  Copy All
                </button>
                <button onClick={() => revealInTree(path)}>Reveal in Explorer</button>
                <button onClick={() => update({ include: `${folder}/**` })}>
                  Restrict Search to Folder
                </button>
                {row.kind !== "folder" && (
                  <button
                    onClick={() =>
                      update({
                        exclude: [query.exclude, `**/*.${path.split(".").pop()}`]
                          .filter(Boolean)
                          .join(","),
                      })
                    }
                  >
                    Exclude File Type
                  </button>
                )}
                {replace && (
                  <>
                    <button disabled={!!replacementPhase} onClick={() => void replaceRows(matches, true)}>
                      Preview Replacement
                    </button>
                    <button disabled={!!replacementPhase} onClick={() => void replaceRows(matches)}>Replace</button>
                  </>
                )}
                <button onClick={() => removeRow(row)}>Remove Result</button>
              </>
            );
          })()}
        </div>
      )}
      </div>
    </div>
  );
}

function highlight(match: SearchMatch) {
  const preview = searchPreview(match);
  return (
    <>
      {preview.clipped && "…"}
      {preview.before}
      <mark>{preview.matched}</mark>
      {preview.after}
    </>
  );
}
