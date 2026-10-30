import quickStyles from "./QuickOpen.module.css";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { useApp, setApp, notify, searchSession } from "../store/store";
import { commands, execute, openFolder } from "../core/commands";
import {
  basename,
  editor,
  openPath,
  relative,
  showDocument,
  splitGroup,
  session,
  checkpoint,
} from "../editor/documents";
import { parseLocation } from "../utils/fuzzy";
import { useQuickFiles } from "../hooks/useQuickFiles";
import { quickFileSettingsKey } from "../utils/quickFileFilters";
import { call, channel, errorMessage } from "../core/bridge";
import { runSearch, openMatch } from "../search/search";
import { FileIcon } from "./EditorGroup";
import { languageFor } from "../editor/monaco";
import { Icon } from "./ui";
import { symbols, type SymbolItem } from "../editor/languages";
import type { SearchMatch } from "../types/types";

type Item = {
  id: string;
  label: string;
  description?: string;
  key?: string;
  path?: string;
  positions?: number[];
  run: (side: boolean, background: boolean) => unknown;
};
export function QuickOpen() {
  const request = useApp((s) => s.quick);
  const docs = useApp((s) => s.docs);
  const fileIndexVersion = useApp((s) => s.fileIndexVersion);
  const root = useApp((s) => s.root);
  const recent = useApp((s) => s.recent);
  const settingsKey = useApp((s) => quickFileSettingsKey(s.settings));
  const picker = typeof request === "object" ? request : null;
  const prefill = typeof request === "string" ? request : request ? "" : null;
  const [value, setValue] = useState(prefill);
  const [previousRequest, setPreviousRequest] = useState(request);
  const [results, setResults] = useState<SearchMatch[]>([]);
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [symbolItems, setSymbolItems] = useState<SymbolItem[]>([]);
  const saved = useRef<ReturnType<typeof session> | null>(null);
  const savedView = useRef<"editor" | "terminal">("editor");
  const activePosition = useRef<{ lineNumber: number; column: number } | null>(null);
  const committed = useRef(false);
  const pendingChoice = useRef<{
    index: number;
    side: boolean;
    background: boolean;
  } | null>(null);
  const composing = useRef(false);
  if (previousRequest !== request) {
    setPreviousRequest(request);
    setValue(prefill);
    setSelected(
      picker
        ? Math.max(
            0,
            picker.items.findIndex((item) => item.id === picker.active),
          )
        : 0,
    );
  }
  const text = value?.trim() ?? "";
  const fileMode =
    !picker &&
    value !== null &&
    !/^[>?:@#%]/.test(text) &&
    !text.startsWith("view ") &&
    text !== "recent" &&
    !text.startsWith("recent ") &&
    !text.startsWith("edt ");
  const parsed = parseLocation(fileMode ? text : "");
  const openPathsKey = useMemo(
    () => JSON.stringify(Object.values(docs).flatMap((d) => (d.path ? [d.path] : []))),
    [docs],
  );
  const { files, busy } = useQuickFiles(
    fileMode ? parsed.query : null,
    root,
    fileIndexVersion,
    openPathsKey,
    settingsKey,
  );
  const busyRef = useRef(busy);
  useLayoutEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  const fileItems = useMemo<Item[]>(
    () =>
      files.map((file) => ({
        id: file.path,
        ...file,
        run: (side, background) =>
          openPath(file.path, {
            pinned: true,
            group: side ? splitGroup() : undefined,
            background,
            line: parsed.line,
            column: parsed.column,
          }),
      })),
    [files, parsed.line, parsed.column],
  );
  function update(next: string) {
    pendingChoice.current = null;
    setValue(next);
    setSelected(0);
  }
  useLayoutEffect(() => {
    pendingChoice.current = null;
  }, [root, fileIndexVersion, openPathsKey, settingsKey]);
  useEffect(() => {
    pendingChoice.current = null;
    if (prefill === null) {
      return;
    }
    if (!saved.current) {
      savedView.current = useApp.getState().view;
      saved.current = structuredClone(session());
      activePosition.current = editor()?.getPosition() ?? null;
      committed.current = false;
    }
    input.current?.focus();
  }, [prefill, request]);
  useEffect(() => {
    if (picker || !value || !["@", "#"].includes(value[0])) {
      return;
    }
    let cancelled = false;
    void symbols(value.slice(1).trim(), value[0] === "#")
      .then((items) => {
        if (!cancelled) {
          setSymbolItems(items);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          notify(errorMessage(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [value, picker]);
  useEffect(() => {
    if (picker || !value?.startsWith("%")) {
      return;
    }
    const requestId = crypto.randomUUID();
    let cancelled = false;
    setResults([]);
    const timer = setTimeout(() => {
      const query = {
        ...searchSession()!.query,
        text: value.slice(1).trim(),
      };
      if (!query.text) {
        return;
      }
      void checkpoint()
        .then(async () => {
          if (cancelled) {
            return;
          }
          const onBatch = channel((batch) => {
            if (cancelled) {
              return;
            }
            setResults((previous) => [...previous, ...batch.matches]);
            void call("search_ack", { requestId, sequence: batch.sequence });
            if (batch.errors.length) {
              notify(batch.errors.join("\n"));
            }
          });
          await call("search_start", { requestId, query, onBatch });
        })
        .catch((e) => {
          if (!cancelled) {
            notify(errorMessage(e));
          }
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      void call("search_cancel", { requestId }).catch(() => {});
    };
  }, [value, picker]);
  const items: Item[] = useMemo(() => {
    if (value === null) {
      return [];
    }
    const query = value.trim();
    if (picker) {
      return picker.items.filter((item) =>
        `${item.label} ${item.id} ${item.description ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      );
    }
    if (query.startsWith(">")) {
      return commands
        .filter((c) => c.label.toLowerCase().includes(query.slice(1).trim().toLowerCase()))
        .map((c) => ({ id: c.id, label: c.label, key: c.key, run: () => execute(c.id) }));
    }
    if (query.startsWith("?")) {
      return [
        [">", "Show and Run Commands"],
        [":", "Go to Line/Column"],
        [":offset ", "Go to Character Offset"],
        ["@", "Go to Symbol in Editor"],
        ["#", "Go to Symbol in Workspace"],
        ["%", "Quick Search"],
        ["edt ", "Show Open Editors"],
        ["view ", "Open a View"],
        ["recent ", "Open Recent Folder"],
      ].map(([prefix, label]) => ({
        id: prefix,
        label: prefix,
        description: label,
        run: () => {
          update(prefix);
          return "keep";
        },
      }));
    }
    if (query.startsWith(":")) {
      const offset = query.startsWith(":offset");
      const values = query
        .replace(offset ? ":offset" : ":", "")
        .trim()
        .split(/[,:]/)
        .map(Number);
      return [
        {
          id: "line",
          label: offset
            ? `Go to offset ${values[0] || 0}`
            : `Go to line ${values[0] || 1}, column ${values[1] || 1}`,
          run: () => {
            const e = editor();
            const m = e?.getModel();
            const position = offset
              ? m?.getPositionAt(Math.max(0, values[0] || 0))
              : { lineNumber: Math.max(1, values[0] || 1), column: Math.max(1, values[1] || 1) };
            if (position) {
              e?.setPosition(position);
              e?.revealPositionInCenter(position);
            }
            e?.focus();
          },
        },
      ];
    }
    if (query.startsWith("@") || query.startsWith("#")) {
      return symbolItems.map((symbol, index) => ({
        id: `symbol-${index}`,
        label: symbol.name,
        description: relative(symbol.path),
        path: symbol.path,
        run: async (side) => {
          await call("language_document", { path: symbol.path });
          await openPath(symbol.path, {
            pinned: true,
            group: side ? splitGroup() : undefined,
            line: symbol.line,
            column: symbol.column,
          });
        },
      }));
    }
    if (query.startsWith("view ")) {
      return ["Explorer", "Search"]
        .filter((label) => label.toLowerCase().includes(query.slice(5).toLowerCase()))
        .map((label) => ({
          id: label,
          label,
          run: () => setApp({ sidebar: label === "Explorer" ? "explorer" : "search" }),
        }));
    }
    if (query === "recent" || query.startsWith("recent ")) {
      return recent
        .filter((path) => path.toLowerCase().includes(query.slice(7).toLowerCase()))
        .map((path) => ({
          id: path,
          label: basename(path),
          description: path,
          run: () => openFolder(false, path),
        }));
    }
    if (query.startsWith("edt ")) {
      return Object.values(docs)
        .filter((d) => d.name.toLowerCase().includes(query.slice(4).toLowerCase()))
        .map((d) => ({
          id: d.id,
          label: d.name,
          description: d.path ? relative(d.path) : "Untitled",
          path: d.path ?? undefined,
          run: () => showDocument(d.id, { pinned: true }),
        }));
    }
    if (query.startsWith("%")) {
      return results.slice(0, 100).map((m, i) => ({
        id: `${i}`,
        label: m.preview,
        description: `${relative(m.path)}:${m.line}:${m.column}`,
        path: m.path,
        run: (side: boolean) => openMatch(m, side, side ? splitGroup() : undefined),
      }));
    }
    const parsed = parseLocation(query);
    const list = fileItems;
    if (!list.length && /^(?:[a-z]:[\\/]|\\\\)/i.test(parsed.query)) {
      return [
        {
          id: "absolute",
          label: `Open ${parsed.query}`,
          run: async (side: boolean) => {
            const path = await call<string>("explicit_open", { path: parsed.query });
            await openPath(path, {
              pinned: true,
              group: side ? splitGroup() : undefined,
              line: parsed.line,
              column: parsed.column,
            });
          },
        },
      ];
    }
    return list;
  }, [value, picker, docs, recent, results, symbolItems, fileItems]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const close = useCallback((accept: boolean) => {
    pendingChoice.current = null;
    composing.current = false;
    if (!accept && saved.current && !committed.current) {
      setApp({
        groups: saved.current.groups,
        activeGroup: saved.current.activeGroup,
        history: saved.current.history,
        historyIndex: saved.current.historyIndex,
        view: savedView.current,
      });
      const position = activePosition.current;
      requestAnimationFrame(() => {
        if (useApp.getState().view === "terminal") {
          void import("../terminal/runtime").then((t) => t.focusTerminal());
          return;
        }
        if (position) {
          editor()?.setPosition(position);
        }
        editor()?.focus();
      });
    }
    saved.current = null;
    setValue(null);
    setApp({ quick: null });
    if (accept) {
      requestAnimationFrame(() => {
        if (useApp.getState().view === "terminal") {
          void import("../terminal/runtime").then((t) => t.focusTerminal());
        } else {
          editor()?.focus();
        }
      });
    }
  }, []);
  const help = !picker && text.startsWith("?");
  const choose = useCallback(
    async (index: number, side = false, background = false) => {
      if (busyRef.current) {
        return;
      }
      const item = items[Math.min(index, items.length - 1)];
      if (!item) {
        return;
      }
      if (help) {
        await item.run(side, background);
        return;
      }
      committed.current = true;
      close(true);
      try {
        await item.run(side, background);
      } catch (e) {
        notify(errorMessage(e));
      }
    },
    [items, help, close],
  );
  const select = useCallback((index: number) => {
    if (!busyRef.current) {
      setSelected(index);
    }
  }, []);
  useEffect(() => {
    if (busy || value === null || !pendingChoice.current) {
      return;
    }
    const { index, side, background } = pendingChoice.current;
    pendingChoice.current = null;
    void choose(index, side, background);
  }, [busy, value, choose]);
  return (
    <Dialog.Root
      open={value !== null}
      onOpenChange={(open) => {
        if (!open) {
          close(false);
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="quick-backdrop fixed inset-[35px_0_22px] bg-transparent z-[110]" />
        <Dialog.Popup
          className={`quick-open fixed top-[38px] left-[50%] w-170 max-w-[90vw] max-h-[70vh] bg-quick border border-strong rounded-[6px] z-[111] flex flex-col text-[15px] outline-none ${quickStyles["quick-open"]}`}
          initialFocus={input}
        >
          <Dialog.Title className="sr-only">{picker?.title ?? "Quick Access"}</Dialog.Title>
          <Dialog.Description className="sr-only">
            {picker
              ? "Type to filter, then press Enter to select. Press Escape to cancel."
              : "Type a file name, command prefix, line number or search query."}
          </Dialog.Description>
          <input
            ref={input}
            aria-label={picker?.title ?? "Quick Access"}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded
            aria-controls="quick-results"
            aria-busy={busy}
            aria-activedescendant={
              !busy && items.length
                ? `quick-option-${Math.min(selected, items.length - 1)}`
                : undefined
            }
            value={value ?? ""}
            placeholder={
              picker?.title ?? "Search files by name (append : to go to line or @ to go to symbol)"
            }
            onChange={(e) => update(e.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(e) => {
              if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) {
                e.stopPropagation();
                return;
              }
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                if (!busy) {
                  setSelected(
                    (i) =>
                      (i + items.length + (e.key === "ArrowDown" ? 1 : -1)) %
                      Math.max(1, items.length),
                  );
                }
              }
              if (e.key === "Enter") {
                e.preventDefault();
                if (busy) {
                  pendingChoice.current = {
                    index: selected,
                    side: e.ctrlKey,
                    background: e.altKey,
                  };
                } else {
                  void choose(selected, e.ctrlKey, e.altKey);
                }
              }
              if (e.key === "Escape") {
                e.preventDefault();
                close(false);
              }
            }}
          />
          {!picker && value?.startsWith("%") && (
            <button
              className="quick-handoff flex justify-between text-[13px] py-[6px] px-2 text-link-hover"
              onClick={() => {
                const text = value.slice(1).trim();
                committed.current = true;
                close(true);
                setApp({ sidebar: "search" });
                void runSearch({ ...searchSession()!.query, text });
              }}
            >
              Open in Search View <Icon name="arrow-right" />
            </button>
          )}
          <div
            ref={list}
            className="quick-results overflow-auto min-h-0 pt-[5px]"
            role="listbox"
            id="quick-results"
            aria-busy={busy}
          >
            <QuickResults
              items={items}
              selected={Math.min(selected, Math.max(0, items.length - 1))}
              command={text.startsWith(">")}
              onSelect={select}
              onChoose={choose}
            />
            {!items.length && (
              <div className="quick-empty py-[6px] px-2">
                {busy ? "Searching…" : "No matching results"}
              </div>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const QuickResults = memo(function QuickResults({
  items,
  selected,
  command,
  onSelect,
  onChoose,
}: {
  items: Item[];
  selected: number;
  command: boolean;
  onSelect: (index: number) => void;
  onChoose: (index: number) => Promise<void>;
}) {
  return items.map((item, i) => (
    <div
      id={`quick-option-${i}`}
      data-index={i}
      role="option"
      aria-selected={selected === i}
      className={`quick-item h-7 flex items-center py-0 px-2 gap-2 rounded-[3px] cursor-pointer whitespace-nowrap overflow-hidden ${quickStyles["quick-item"]} ${selected === i ? "selected" : ""}`}
      key={item.id}
      onMouseMove={() => onSelect(i)}
      onClick={() => void onChoose(i)}
    >
      {item.path ? (
        <FileIcon language={languageFor(item.path)} />
      ) : (
        <Icon name={command ? "terminal" : "arrow-right"} />
      )}
      <span className="quick-label shrink-0 max-w-[70%] overflow-hidden text-ellipsis">
        {item.positions
          ? [...item.label].map((char, index) =>
              item.positions!.includes(index) ? <mark key={index}>{char}</mark> : char,
            )
          : item.label}
      </span>
      <span className="muted text-muted quick-description text-[13px] overflow-hidden text-ellipsis">
        {item.description}
      </span>
      {item.key && <kbd>{item.key}</kbd>}
    </div>
  ));
});
