import { useEffect, useRef, useState } from "react";
import { monaco, loadSyntax } from "../editor/monaco";
import { diffOptions, editorOptions } from "../editor/settings";
import { editors, diffEditors, models, autoSave } from "../editor/documents";
import { installMergeConflictEditor } from "../editor/mergeConflictEditor";
import { createGitDiffModels } from "../editor/gitDiffModels";
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
  const inlineState = useRef(false);
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
    const container = host.current;
    if (!container || !content || content.summary || error) {
      return;
    }
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void (async () => {
      let pair: Awaited<ReturnType<typeof createGitDiffModels>> | undefined;
      try {
        const source = useApp.getState().docs[doc.id]?.gitDiff?.sourceId;
        const shared = content.source && source ? models.get(source) : undefined;
        pair = await createGitDiffModels(content, doc.language, shared);
        if (cancelled || shared?.isDisposed()) {
          pair.dispose();
          return;
        }
        const { original, modified, dispose: disposeModels } = pair;
        const editor = monaco.editor.createDiffEditor(container, {
          ...editorOptions(useApp.getState().settings),
          ...diffOptions(useApp.getState().settings),
          automaticLayout: true,
          theme: "dark-modern",
          originalEditable: false,
          readOnly: !shared,
          renderSideBySide: !inlineState.current,
          renderSideBySideInlineBreakpoint: 0,
          originalAriaLabel: staged
            ? "HEAD version"
            : conflicted
              ? "Local version before conflict"
              : "Index version",
          modifiedAriaLabel: staged ? "Index version" : "Working tree version",
        });
        const code = editor.getModifiedEditor();
        let viewModel: monaco.editor.IDiffEditorViewModel | undefined;
        const subscriptions: monaco.IDisposable[] = [];
        dispose = () => {
          if (instance.current === editor) {
            const view = editor.saveViewState();
            setApp((s) => ({
              groups: s.groups.map((g) =>
                g.id === group.id && g.tabs.includes(doc.id)
                  ? { ...g, views: { ...g.views, [doc.id]: view } }
                  : g,
              ),
            }));
            instance.current = null;
          }
          if (editors.get(group.id) === code) {
            editors.delete(group.id);
          }
          if (diffEditors.get(group.id)?.editor === editor) {
            diffEditors.delete(group.id);
          }
          subscriptions.forEach((s) => s.dispose());
          // Cancel diff workers before releasing either retained text model.
          editor.setModel(null);
          viewModel?.dispose();
          editor.dispose();
          disposeModels();
        };
        viewModel = editor.createViewModel({ original, modified });
        editor.setModel(viewModel);
        instance.current = editor;
        diffEditors.set(group.id, { editor, viewModel });
        editors.set(group.id, code);
        subscriptions.push(installMergeConflictEditor(code, () => {}));
        subscriptions.push(code.onDidFocusEditorText(() => setApp({ activeGroup: group.id })));
        subscriptions.push(code.onDidBlurEditorWidget(() => {
          if (source) {
            void autoSave("onFocusChange", source);
          }
        }));
        subscriptions.push(code.onDidChangeCursorSelection((event) => {
          if (useApp.getState().activeGroup === group.id) {
            setApp({
              cursor: {
                line: event.selection.positionLineNumber,
                column: event.selection.positionColumn,
                selected: modified.getValueLengthInRange(event.selection),
              },
            });
          }
        }));
        const view = useApp.getState().groups.find((g) => g.id === group.id)?.views[doc.id];
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
          subscriptions.push(updated);
        }
        void loadSyntax(doc.language);
      } catch (error) {
        if (dispose) {
          dispose();
          dispose = undefined;
        } else {
          pair?.dispose();
        }
        if (!cancelled) {
          setError(errorMessage(error));
        }
      }
    })();
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [doc.id, doc.language, content, error, group.id, staged, conflicted]);

  useEffect(() => {
    inlineState.current = inline;
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
