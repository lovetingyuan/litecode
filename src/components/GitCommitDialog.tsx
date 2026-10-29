import { useMemo, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { errorMessage } from "../core/bridge";
import { groupChanges } from "../git/changes";
import { runGitOperation, selectedRepository } from "../git/git";
import { notify, setApp, useApp } from "../store/store";
import type { GitRepository } from "../types/types";

export function GitCommitDialog({
  repository,
  workspace,
}: {
  repository: GitRepository;
  workspace: string;
}) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const working = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const busy = useApp((s) => s.gitBusy[repository.path]);
  const message = useApp((s) => s.gitMessages[repository.path] ?? "");
  const grouped = useMemo(() => groupChanges(repository.changes), [repository.changes]);
  const hasCommittableChanges = !!grouped.staged.length && !grouped.conflicts.length;
  const canCommit = hasCommittableChanges && !!message.trim() && !busy && !submitting;

  async function commit() {
    if (
      !canCommit ||
      working.current ||
      useApp.getState().gitBusy[repository.path] ||
      useApp.getState().root !== workspace ||
      selectedRepository()?.path !== repository.path
    ) {
      return;
    }
    working.current = true;
    setSubmitting(true);
    try {
      if (await runGitOperation(repository.path, { kind: "commit", message })) {
        setApp((s) => ({
          gitMessages: {
            ...s.gitMessages,
            [repository.path]:
              s.gitMessages[repository.path] === message
                ? ""
                : (s.gitMessages[repository.path] ?? ""),
          },
        }));
        setOpen(false);
      }
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      working.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!working.current) {
          setOpen(next);
        }
      }}
    >
      <Dialog.Trigger
        ref={trigger}
        className="btn btn-xs btn-primary"
        disabled={!hasCommittableChanges || !!busy || submitting}
      >
        Commit
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-backdrop" />
        <Dialog.Popup
          className="modal-panel git-commit-dialog"
          initialFocus={input}
          finalFocus={trigger}
        >
          <Dialog.Title>Commit Changes</Dialog.Title>
          <Dialog.Description>
            {repository.name} — {repository.branch ?? "No commits yet"}
            {repository.detached ? " (detached)" : ""}
          </Dialog.Description>
          <form
            className="git-commit-form"
            aria-busy={submitting}
            onSubmit={(event) => {
              event.preventDefault();
              void commit();
            }}
          >
            <label htmlFor="git-commit-message">Message</label>
            <textarea
              id="git-commit-message"
              ref={input}
              aria-label="Commit Message"
              placeholder="Message (Ctrl+Enter to commit)"
              value={message}
              disabled={!!busy || submitting}
              rows={5}
              onChange={(event) =>
                setApp((s) => ({
                  gitMessages: { ...s.gitMessages, [repository.path]: event.target.value },
                }))
              }
              onKeyDown={(event) => {
                if (event.ctrlKey && event.key === "Enter") {
                  event.preventDefault();
                  void commit();
                }
              }}
            />
            {grouped.conflicts.length ? (
              <p className="git-commit-hint">Resolve and stage conflicts before committing.</p>
            ) : !grouped.staged.length ? (
              <p className="git-commit-hint">Stage changes before committing.</p>
            ) : null}
            <div className="modal-actions">
              <button type="submit" className="primary" disabled={!canCommit}>
                {submitting && <span className="spinner" aria-hidden="true" />}
                {submitting ? "Committing…" : "Commit"}
              </button>
              <button type="button" disabled={submitting} onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
