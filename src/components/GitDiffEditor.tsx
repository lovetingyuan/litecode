import { useEffect, useRef, useState } from "react";
import { monaco, loadSyntax } from "../editor/monaco";
import { diffOptions, editorOptions } from "../editor/settings";
import { editors, diffEditors, models, autoSave } from "../editor/documents";
import { installMergeConflictEditor } from "../editor/mergeConflictEditor";
import { useApp, setApp, notify } from "../store/store";
import { attachGitSource, readGitDiff, openGitSource } from "../git/git";
import { errorMessage } from "../core/bridge";
import { IconButton } from "./ui";
import type { Doc, GitDiffContent, Group } from "../types/types";
import "../styles/git.css";

export function GitDiffEditor({ doc, group }: { doc: Doc; group: Group }) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const settings = useApp((s) => s.settings);
  const gitState = useApp((s) => s.gitState);
  const [content, setContent] = useState<GitDiffContent | null>(null);
  const [error, setError] = useState("");
  const [inline, setInline] = useState(false);
  const [loading, setLoading] = useState(true);
  const diff = doc.gitDiff!;
  const { workspace, repository, path, oldPath, staged, conflicted } = diff;
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        if (gitState.session === null) {
          return;
        }
        const current = gitState.repositories
          ?.find((r) => r.path === repository)
          ?.changes.find(
            (c) => (staged ? (c.indexPath ?? c.path) : c.path) === path,
          );
        const next = await readGitDiff({
          workspace,
          repository,
          path,
          oldPath: staged
            ? (current?.indexOldPath ?? null)
            : (current?.worktreeOldPath ?? null),
          staged,
          conflicted: current?.conflicted ?? false,
        });
        if (cancelled) {
          return;
        }
        await attachGitSource(doc.id, next);
        if (!cancelled) {
          setContent(next);
          setError("");
        }
      } catch (error) {
        if (!cancelled) {
          setError(errorMessage(error));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    doc.id,
    repository,
    path,
    oldPath,
    staged,
    conflicted,
    workspace,
    gitState,
  ]);

  useEffect(() => {
    if (!host.current || !content || content.summary || error) {
      return;
    }
    const original = monaco.editor.createModel(content.before, doc.language);
    const source = useApp.getState().docs[doc.id]?.gitDiff?.sourceId;
    const shared = content.source && source ? models.get(source) : undefined;
    const modified =
      shared ?? monaco.editor.createModel(content.after, doc.language);
    const editor = monaco.editor.createDiffEditor(host.current, {
      ...editorOptions(useApp.getState().settings),
      ...diffOptions(useApp.getState().settings),
      automaticLayout: true,
      theme: "dark-modern",
      originalEditable: false,
      readOnly: !shared,
      renderSideBySide: true,
      renderSideBySideInlineBreakpoint: 0,
      originalAriaLabel: staged
        ? "HEAD version"
        : conflicted
          ? "Local version before conflict"
          : "Index version",
      modifiedAriaLabel: staged ? "Index version" : "Working tree version",
    });
    const viewModel = editor.createViewModel({ original, modified });
    editor.setModel(viewModel);
    instance.current = editor;
    diffEditors.set(group.id, { editor, viewModel });
    const code = editor.getModifiedEditor();
    editors.set(group.id, code);
    const merge = installMergeConflictEditor(code, () => {});
    const focused = code.onDidFocusEditorText(() =>
      setApp({ activeGroup: group.id }),
    );
    const blurred = code.onDidBlurEditorWidget(() => {
      if (source) {
        void autoSave("onFocusChange", source);
      }
    });
    const cursor = code.onDidChangeCursorSelection((event) => {
      if (useApp.getState().activeGroup === group.id) {
        setApp({
          cursor: {
            line: event.selection.positionLineNumber,
            column: event.selection.positionColumn,
            selected: modified.getValueLengthInRange(event.selection),
          },
        });
      }
    });
    const view = useApp.getState().groups.find((g) => g.id === group.id)?.views[
      doc.id
    ];
    if (view) {
      editor.restoreViewState(view as monaco.editor.IDiffEditorViewState);
    } else {
      const updated = editor.onDidUpdateDiff(() => {
        if (!editor.getLineChanges()) {
          return;
        }
        editor.revealFirstDiff();
        updated.dispose();
      });
    }
    void loadSyntax(doc.language);
    return () => {
      const view = editor.saveViewState();
      setApp((s) => ({
        groups: s.groups.map((g) =>
          g.id === group.id && g.tabs.includes(doc.id)
            ? { ...g, views: { ...g.views, [doc.id]: view } }
            : g,
        ),
      }));
      if (editors.get(group.id) === code) {
        editors.delete(group.id);
      }
      if (diffEditors.get(group.id)?.editor === editor) {
        diffEditors.delete(group.id);
      }
      instance.current = null;
      merge.dispose();
      focused.dispose();
      blurred.dispose();
      cursor.dispose();
      // Monaco defers disposal of implicit view models; own this one so worker
      // computations are cancelled before either text model is released.
      editor.setModel(null);
      viewModel.dispose();
      editor.dispose();
      original.dispose();
      if (!shared) {
        modified.dispose();
      }
    };
  }, [doc.id, doc.language, content, error, group.id, staged, conflicted]);

  useEffect(() => {
    instance.current?.updateOptions({
      ...editorOptions(settings),
      ...diffOptions(settings),
      renderSideBySide: !inline,
    });
  }, [settings, inline, content]);
  return (
    <div className="git-diff-editor" aria-label={`Git diff: ${diff.path}`}>
      <div className="git-diff-toolbar">
        <span className="truncate" title={`${diff.repository}/${diff.path}`}>
          {diff.staged
            ? "HEAD ↔ Index"
            : diff.conflicted
              ? "Local ↔ Working Tree"
              : "Index ↔ Working Tree"}
        </span>
        <div className="actions">
          <IconButton
            icon="arrow-up"
            label="Previous Change"
            onClick={() => instance.current?.goToDiff("previous")}
          />
          <IconButton
            icon="arrow-down"
            label="Next Change"
            onClick={() => instance.current?.goToDiff("next")}
          />
          <IconButton
            icon={inline ? "split-horizontal" : "list-flat"}
            label={inline ? "Use Side by Side Diff" : "Use Inline Diff"}
            onClick={() => setInline(!inline)}
          />
          <IconButton
            icon="go-to-file"
            label="Open Source File"
            onClick={() =>
              void openGitSource(diff.repository, diff.path).catch((e) =>
                notify(errorMessage(e)),
              )
            }
          />
        </div>
      </div>
      {(error || content?.summary) && (
        <div className="git-diff-summary" role={error ? "alert" : "status"}>
          {error || content?.summary}
        </div>
      )}
      {loading && !content && (
        <div className="git-diff-summary" role="status">
          Loading comparison…
        </div>
      )}
      <div
        className="git-diff-host"
        ref={host}
        hidden={!!error || !!content?.summary}
      />
    </div>
  );
}
