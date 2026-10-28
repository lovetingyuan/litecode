import { useEffect, useMemo, useState } from "react";
import { call } from "../core/bridge";
import { models } from "../editor/documents";
import { blameAge, blameRange, blameRepository, createBlameLoader, type BlameResult, type BlameTask } from "../git/lineBlame";
import { useApp } from "../store/store";
import type { Doc, GitFileBlame } from "../types/types";
import { Icon } from "./ui";

export function GitLineStatus({ doc }: { doc?: Doc }) {
  const root = useApp((s) => s.root);
  const snapshot = useApp((s) => s.gitState);
  const activeGroup = useApp((s) => s.activeGroup);
  const line = useApp((s) => s.cursor.line);
  const [result, setResult] = useState<BlameResult>(null);
  const [now, setNow] = useState(Date.now);
  const loader = useMemo(() => createBlameLoader(setResult), []);
  const task = useMemo<BlameTask | null>(() => {
    if (!doc) { return null; }
    const file = doc.path && blameRepository(doc.path, snapshot.repositories ?? []);
    if (!root || snapshot.root !== root || snapshot.session === null || !file || doc.deleted || doc.large) { return null; }
    return {
      read: () => {
        const state = useApp.getState();
        const model = models.get(doc.id);
        // Read the version explicitly: React Compiler can otherwise stabilize
        // this task across edits to a document with the same path and encoding.
        if (!model || model.isDisposed() || state.activeGroup !== activeGroup ||
          state.docs[doc.id]?.version !== doc.version || state.docs[doc.id]?.revision !== doc.revision ||
          model.getValueLength() > 20 * 1024 * 1024) { return Promise.resolve(null); }
        return call<GitFileBlame | null>("git_blame_file", {
          expectedRoot: root, session: snapshot.session, repository: file.repository.path,
          path: file.path, oldPath: file.oldPath, contents: model.getValue(), encoding: doc.encoding,
        });
      },
    };
  }, [root, snapshot, doc, activeGroup]);
  useEffect(() => {
    loader.update(task);
    return () => loader.update(null);
  }, [loader, task]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const data = result?.task === task ? result?.data : null;
  const range = data && blameRange(data.ranges, line);
  if (!range) { return null; }
  const commit = range.commit && data?.commits[range.commit];
  if (range.commit && !commit) { return null; }
  const author = commit ? commit.author || "Unknown author" : "";
  const age = commit ? blameAge(commit.authorTime, now) : "";
  const label = commit ? `${author} (${age})` : "尚未提交";
  const title = commit
    ? `${author}, ${age} (${new Date(commit.authorTime * 1000).toLocaleString()})\n${commit.summary}\n${range.commit?.slice(0, 8)}`
    : "尚未提交：当前行尚未包含在 HEAD 提交中";
  return (
    <span className="status-item git-line-status" title={title} aria-label={`Current line Git: ${label}`}>
      <Icon name="git-commit" />
      <span className="git-line-label">{label}</span>
    </span>
  );
}
