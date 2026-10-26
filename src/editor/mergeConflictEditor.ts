import { monaco } from "./monaco";
import { useApp, notify } from "../store/store";
import { settingValue } from "../utils/settings";
import { conflictReplacement, parseMergeConflicts, type ConflictChoice, type ConflictSpan, type InlineMergeConflict } from "./mergeConflicts";
import "./mergeConflicts.css";

type CodeEditor = monaco.editor.IStandaloneCodeEditor;
type ConflictReference = { uri: string; modelId: string; version: number; start: number; tracking?: string; content?: string };
const snapshots = new WeakMap<monaco.editor.ITextModel, { version: number; text: string; conflicts: InlineMergeConflict[] }>();
const controllers = new Map<CodeEditor, () => void>();
let focused: CodeEditor | undefined;
let registrations: monaco.IDisposable[] = [];
let lensChanged: monaco.Emitter<monaco.languages.CodeLensProvider> | undefined;
let codeLensProvider: monaco.languages.CodeLensProvider | undefined;

function snapshot(model: monaco.editor.ITextModel) {
  let value = snapshots.get(model);
  if (!value || value.version !== model.getVersionId()) {
    const text = model.getValue();
    value = { version: model.getVersionId(), text, conflicts: text.includes("<<<<<<<") ? parseMergeConflicts(text) : [] };
    snapshots.set(model, value);
  }
  return value;
}

function range(model: monaco.editor.ITextModel, span: ConflictSpan) {
  return monaco.Range.fromPositions(model.getPositionAt(span.start), model.getPositionAt(span.end));
}

export function acceptInlineConflict(editor: CodeEditor, choice: ConflictChoice, reference?: ConflictReference): boolean {
  const model = editor.getModel();
  if (!model || editor.getOption(monaco.editor.EditorOption.readOnly)) { return false; }
  const current = snapshot(model);
  let start = reference?.start;
  if (reference) {
    const tracked = reference.tracking ? model.getDecorationRange(reference.tracking) : null;
    if (reference.uri !== model.uri.toString() || reference.modelId !== model.id || (reference.version !== current.version &&
      (!tracked || reference.content !== model.getValueInRange(tracked)))) {
      editor.focus();
      controllers.get(editor)?.();
      notify("The conflict changed. Review the updated content and try again.");
      return false;
    }
    if (tracked) { start = model.getOffsetAt(tracked.getStartPosition()); }
  }
  const offset = model.getOffsetAt(editor.getPosition() ?? { lineNumber: 1, column: 1 });
  const conflict = current.conflicts.find((item) => reference ? item.range.start === start : item.range.start <= offset && offset < item.range.end);
  if (!conflict) {
    notify("Editor cursor is not within a merge conflict");
    return false;
  }
  editor.pushUndoStop();
  const applied = editor.executeEdits("merge-conflict", [{
    range: range(model, conflict.range), text: conflictReplacement(current.text, conflict, choice), forceMoveMarkers: true,
  }]);
  editor.pushUndoStop();
  editor.focus();
  return applied;
}

export function navigateInlineConflict(editor: CodeEditor, direction: "next" | "previous") {
  const model = editor.getModel();
  if (!model) { return; }
  const conflicts = snapshot(model).conflicts;
  if (!conflicts.length) { return; }
  const offset = model.getOffsetAt(editor.getPosition() ?? { lineNumber: 1, column: 1 });
  const target = direction === "next"
    ? conflicts.find((conflict) => conflict.range.start > offset) ?? conflicts[0]
    : [...conflicts].reverse().find((conflict) => conflict.range.start < offset) ?? conflicts[conflicts.length - 1];
  const position = model.getPositionAt(target.range.start);
  editor.setPosition(position);
  editor.revealPositionInCenter(position);
  editor.focus();
}

function registerCodeLenses() {
  lensChanged = new monaco.Emitter<monaco.languages.CodeLensProvider>();
  const choices = [
    ["current", "Accept Current Change"], ["incoming", "Accept Incoming Change"], ["both", "Accept Both Changes"],
  ] as const;
  const provider: monaco.languages.CodeLensProvider = {
    onDidChange: lensChanged.event,
    provideCodeLenses(model) {
      if (!settingValue(useApp.getState().settings, "merge-conflict.codeLens.enabled") ||
        ![...controllers.keys()].some((editor) => editor.getModel() === model)) { return { lenses: [], dispose() {} }; }
      const current = snapshot(model);
      const tracking = model.deltaDecorations([], current.conflicts.map((conflict) => ({
        range: range(model, conflict.range), options: { stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
      })));
      return {
        lenses: current.conflicts.flatMap((conflict, index) => choices.map(([choice, title]) => ({
          range: range(model, conflict.current.header),
          command: { id: `merge-conflict.accept.${choice}`, title,
            arguments: [{ uri: model.uri.toString(), modelId: model.id, version: current.version, start: conflict.range.start,
              tracking: tracking[index], content: current.text.slice(conflict.range.start, conflict.range.end) } satisfies ConflictReference] },
        }))),
        dispose() { if (!model.isDisposed()) { model.deltaDecorations(tracking, []); } },
      };
    },
  };
  codeLensProvider = provider;
  registrations = [lensChanged, monaco.languages.registerCodeLensProvider("*", provider), ...choices.map(([choice]) =>
    monaco.editor.registerCommand(`merge-conflict.accept.${choice}`, (_accessor, reference: ConflictReference) => {
      if (!reference || typeof reference.uri !== "string") { return; }
      const editors = [...controllers.keys()].filter((editor) => editor.getModel()?.uri.toString() === reference.uri);
      const target = focused && editors.includes(focused) ? focused : editors.find((editor) => editor.hasWidgetFocus());
      if (target) { acceptInlineConflict(target, choice, reference); }
    })),
  ];
}

function decorations(model: monaco.editor.ITextModel, conflicts: InlineMergeConflict[]): monaco.editor.IModelDeltaDecoration[] {
  return conflicts.flatMap((conflict) => ([
    [conflict.current, "current", "Current Change"],
    ...conflict.ancestors.map((ancestor) => [ancestor, "common", "Common Ancestor"] as const),
    [conflict.incoming, "incoming", "Incoming Change"],
  ] as const).flatMap(([section, kind, label]) => {
    const result: monaco.editor.IModelDeltaDecoration[] = [{
      range: range(model, section.header),
      options: { isWholeLine: true, className: `merge-conflict-${kind}-header`,
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        after: kind === "common" ? undefined : { content: ` (${label})`, inlineClassName: "merge-conflict-label" } },
    }];
    if (section.content.end > section.content.start) {
      result.push({
        range: range(model, { start: section.content.start, end: Math.max(section.content.start, section.content.end - model.getEOL().length) }),
        options: { isWholeLine: true, className: `merge-conflict-${kind}-content`,
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
      });
    }
    return result;
  }));
}

export function installMergeConflictEditor(editor: CodeEditor, onCount: (count: number) => void): monaco.IDisposable {
  const collection = editor.createDecorationsCollection();
  const refresh = () => {
    const model = editor.getModel();
    const conflicts = model ? snapshot(model).conflicts : [];
    collection.set(model && settingValue(useApp.getState().settings, "merge-conflict.decorators.enabled") ? decorations(model, conflicts) : []);
    onCount(conflicts.length);
    if (codeLensProvider) { lensChanged?.fire(codeLensProvider); }
  };
  controllers.set(editor, refresh);
  if (controllers.size === 1) { registerCodeLenses(); }
  const subscriptions = [
    editor.onDidChangeModel(refresh), editor.onDidChangeModelContent(refresh),
    editor.onDidFocusEditorWidget(() => { focused = editor; }),
  ];
  const node = editor.getDomNode();
  const pointerDown = () => { focused = editor; };
  node?.addEventListener("pointerdown", pointerDown, true);
  const unsubscribe = useApp.subscribe((state, previous) => { if (state.settings !== previous.settings) { refresh(); } });
  refresh();
  return { dispose() {
    subscriptions.forEach((subscription) => subscription.dispose());
    unsubscribe();
    node?.removeEventListener("pointerdown", pointerDown, true);
    collection.clear();
    controllers.delete(editor);
    if (focused === editor) { focused = undefined; }
    if (!controllers.size) {
      registrations.forEach((registration) => registration.dispose());
      registrations = [];
      lensChanged = undefined;
      codeLensProvider = undefined;
    }
  } };
}
