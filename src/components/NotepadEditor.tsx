import notepadStyles from "../styles/notepad.module.css";
import workbenchStyles from "../styles/workbench.module.css";
import { useEffect, useRef } from "react";
import { Menu } from "@base-ui/react/menu";
import { monaco } from "../editor/monaco";
import { editorFontOptions } from "../editor/font";
import { settingValue } from "../utils/settings";
import { useApp } from "../store/store";
import {
  computeTextStats,
  displayNoteName,
  NOTEPAD_FORMATS,
  resolveFormat,
} from "../notepad/formats";
import {
  changeNoteFormat,
  createNote,
  ensureNoteContentLoaded,
  ensureNotepadModel,
  registerNotepadEditor,
  restoreNotepadViewState,
  saveNotepadViewState,
  toggleNotepadWordWrap,
} from "../notepad/runtime";
import { isSyntaxHighlightEnabled, useNotepad } from "../notepad/state";
import { runNotepadAction } from "../notepad/actions";
import { NotepadTabBar } from "./NotepadTabBar";
import { NotepadMarkdownPreview } from "./NotepadMarkdownPreview";
import { Icon } from "./ui";

function notepadEditorOptions(
  settings: Record<string, unknown>,
  wordWrap: boolean,
  syntaxHighlight: boolean,
): monaco.editor.IStandaloneEditorConstructionOptions {
  const fontSize = settingValue(settings, "editor.fontSize");
  const lineHeight = settingValue(settings, "editor.lineHeight");
  const fontWeight = settingValue(settings, "editor.fontWeight");
  return {
    theme: "dark-modern",
    ...editorFontOptions(settings),
    fontSize: typeof fontSize === "number" ? fontSize : 14,
    lineHeight: typeof lineHeight === "number" ? lineHeight : 22,
    fontWeight:
      typeof fontWeight === "string" || typeof fontWeight === "number" ? String(fontWeight) : "400",
    wordWrap: wordWrap ? "on" : "off",
    copyWithSyntaxHighlighting: syntaxHighlight,
    bracketPairColorization: { enabled: syntaxHighlight },
    colorDecorators: syntaxHighlight,
    minimap: { enabled: false },
    lineNumbers: "on",
    lineNumbersMinChars: 3,
    folding: true,
    renderLineHighlight: "line",
    smoothScrolling: true,
    scrollBeyondLastLine: false,
    padding: { top: 10, bottom: 10 },
    automaticLayout: true,
    fixedOverflowWidgets: true,
    unicodeHighlight: { ambiguousCharacters: false },
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    parameterHints: { enabled: false },
    hover: { enabled: "off" },
  };
}

export function NotepadEditor() {
  const notes = useNotepad((s) => s.notes);
  const activeId = useNotepad((s) => s.activeId);
  const contents = useNotepad((s) => s.contents);
  const wordWrap = useNotepad((s) => s.wordWrap);
  const syntaxHighlight = useNotepad((s) =>
    isSyntaxHighlightEnabled(s.syntaxHighlight, s.activeId),
  );
  const saving = useNotepad((s) => s.saving);
  const cursor = useNotepad((s) => s.cursor);
  const stats = useNotepad((s) => s.stats);
  const previewing = useNotepad((s) => (s.activeId ? !!s.markdownPreview[s.activeId] : false));
  const settings = useApp((s) => s.settings);

  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const previousIdRef = useRef<string | null>(null);

  const activeNote = activeId ? notes.find((n) => n.id === activeId) : undefined;
  const activeText = activeId ? (contents[activeId] ?? "") : "";
  const showPreview = !!activeNote && activeNote.format === "md" && previewing;

  useEffect(() => {
    if (!hostRef.current) {
      return;
    }
    const state = useNotepad.getState();
    const instance = monaco.editor.create(hostRef.current, {
      model: null,
      ...notepadEditorOptions(
        useApp.getState().settings,
        state.wordWrap,
        isSyntaxHighlightEnabled(state.syntaxHighlight, state.activeId),
      ),
    });
    editorRef.current = instance;
    registerNotepadEditor(instance);

    const selectionListener = instance.onDidChangeCursorSelection((event) => {
      const model = instance.getModel();
      useNotepad.setState({
        cursor: {
          line: event.selection.positionLineNumber,
          column: event.selection.positionColumn,
          selected: model?.getValueLengthInRange(event.selection) ?? 0,
        },
      });
    });

    return () => {
      const currentId = previousIdRef.current;
      if (currentId) {
        saveNotepadViewState(currentId, instance.saveViewState());
      }
      selectionListener.dispose();
      registerNotepadEditor(null);
      instance.dispose();
      editorRef.current = null;
      previousIdRef.current = null;
    };
  }, []);

  useEffect(() => {
    editorRef.current?.updateOptions(notepadEditorOptions(settings, wordWrap, syntaxHighlight));
  }, [settings, wordWrap, syntaxHighlight]);

  useEffect(() => {
    const instance = editorRef.current;
    if (!instance) {
      return;
    }
    if (previousIdRef.current && previousIdRef.current !== activeId) {
      saveNotepadViewState(previousIdRef.current, instance.saveViewState());
    }
    if (!activeNote || showPreview) {
      if (!activeNote) {
        instance.setModel(null);
      }
      previousIdRef.current = activeNote?.id ?? null;
      return;
    }

    let cancelled = false;
    const attach = (text: string) => {
      if (cancelled || editorRef.current !== instance) {
        return;
      }
      const model = ensureNotepadModel(activeNote.id, activeNote.format, text);
      if (instance.getModel() !== model) {
        instance.setModel(model);
        const saved = restoreNotepadViewState(activeNote.id);
        if (saved) {
          instance.restoreViewState(saved);
        }
      }
      const selection = instance.getSelection();
      useNotepad.setState({
        stats: computeTextStats(model.getValue()),
        ...(selection
          ? {
              cursor: {
                line: selection.positionLineNumber,
                column: selection.positionColumn,
                selected: model.getValueLengthInRange(selection),
              },
            }
          : {}),
      });
      previousIdRef.current = activeNote.id;
    };

    const cached = useNotepad.getState().contents[activeNote.id];
    if (cached !== undefined) {
      attach(cached);
    } else {
      runNotepadAction(
        ensureNoteContentLoaded(activeNote.id).then((loadedText) => {
          attach(loadedText);
        }),
      );
    }

    return () => {
      cancelled = true;
    };
  }, [activeId, activeNote, showPreview]);

  const currentFormat = activeNote ? resolveFormat(activeNote.format) : undefined;

  return (
    <div className="notepad-editor-pane flex flex-col flex-1 min-w-0 min-h-0 h-full bg-editor overflow-hidden">
      <NotepadTabBar activeNote={activeNote} />

      <div className="relative flex-1 flex min-w-0 min-h-0 overflow-hidden">
        <div
          ref={hostRef}
          className={`flex-1 min-w-0 min-h-0 ${!activeNote || showPreview ? "hidden" : ""}`}
          onCopy={(event) => {
            if (!syntaxHighlight) {
              event.clipboardData.clearData("text/html");
            }
          }}
          onCut={(event) => {
            if (!syntaxHighlight) {
              event.clipboardData.clearData("text/html");
            }
          }}
        />
        {showPreview && activeNote && (
          <NotepadMarkdownPreview
            title={displayNoteName(activeNote.title, activeNote.format)}
            text={activeText}
            syntaxHighlight={syntaxHighlight}
          />
        )}
        {!activeNote && (
          <div
            className={`notepad-empty flex-1 flex flex-col gap-3 items-center justify-center text-subtle select-none ${notepadStyles["notepad-empty"]}`}
          >
            <Icon name="note" />
            <p className="m-0">No note selected.</p>
            <button type="button" onClick={() => runNotepadAction(createNote())}>
              New Note
            </button>
          </div>
        )}
      </div>

      {activeNote && currentFormat && (
        <div
          className={`notepad-footer h-[24px] min-h-[24px] flex items-center justify-between px-2 bg-sidebar border-t border-t-panel text-[12px] text-muted select-none ${notepadStyles["notepad-footer"]}`}
        >
          <div className="flex items-center gap-3 min-w-0 overflow-hidden">
            {!showPreview && (
              <span className="whitespace-nowrap">
                Ln {cursor.line}, Col {cursor.column}
                {cursor.selected > 0 ? ` (${cursor.selected} selected)` : ""}
              </span>
            )}
            <span className="whitespace-nowrap">
              {stats.words} {stats.words === 1 ? "word" : "words"} · {stats.chars}{" "}
              {stats.chars === 1 ? "char" : "chars"} · {stats.lines}{" "}
              {stats.lines === 1 ? "line" : "lines"}
            </span>
          </div>
          <div className="flex items-center h-full shrink-0">
            <span className="inline-flex items-center gap-1 px-2 text-[11px]" role="status">
              <Icon name={saving ? "loading" : "check"} className={saving ? "animate-spin" : ""} />
              {saving ? "Saving…" : "Synced"}
            </span>
            <button type="button" title="Toggle Word Wrap (Alt+Z)" onClick={toggleNotepadWordWrap}>
              Wrap: {wordWrap ? "On" : "Off"}
            </button>
            <Menu.Root>
              <Menu.Trigger
                title="Change Note Format"
                aria-label={`Format: ${currentFormat.label} (.${currentFormat.id})`}
              >
                <span>
                  {currentFormat.label} (.{currentFormat.id})
                </span>
                <Icon name="chevron-down" />
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Positioner className="z-90" side="top" align="end" sideOffset={4}>
                  <Menu.Popup
                    className={`context-menu bg-editor text-foreground p-1 border border-strong rounded-[5px] min-w-[210px] z-[90] ${workbenchStyles["context-menu"]} ${notepadStyles["notepad-format-menu"]}`}
                  >
                    {NOTEPAD_FORMATS.map((fmt) => (
                      <Menu.Item
                        key={fmt.id}
                        onClick={() => runNotepadAction(changeNoteFormat(activeNote.id, fmt.id))}
                      >
                        <span>
                          {fmt.label} (.{fmt.id})
                        </span>
                        {fmt.id === currentFormat.id && <Icon name="check" />}
                      </Menu.Item>
                    ))}
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
          </div>
        </div>
      )}
    </div>
  );
}
