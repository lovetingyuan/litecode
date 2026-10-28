import { useEffect, useMemo, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { call, desktop, errorMessage } from "../core/bridge";
import { models } from "../editor/documents";
import { blameAge, blameRange, blameRepository, createBlameLoader, type BlameResult, type BlameTask } from "../git/lineBlame";
import { useApp } from "../store/store";
import type { Doc, GitBlameCommit, GitCommitDetails, GitFileBlame } from "../types/types";
import { Icon, IconButton } from "./ui";

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
  const repository = doc?.path ? blameRepository(doc.path, snapshot.repositories ?? [])?.repository.path : null;
  if (!range || !root || snapshot.session === null || !repository || !doc) { return null; }
  const commit = range.commit ? data?.commits[range.commit] : undefined;
  if (range.commit && !commit) { return null; }
  const author = commit ? commit.author || "Unknown author" : "";
  const age = commit ? blameAge(commit.authorTime, now) : "";
  const label = commit ? `${author} (${age})` : "尚未提交";
  return (
    <CommitStatus
      key={JSON.stringify([root, snapshot.session, repository, doc.id, doc.path, activeGroup, range.commit])}
      root={root} session={snapshot.session} repository={repository} sha={range.commit} commit={commit} label={label}
    />
  );
}

type CommitContext = { root: string; session: number; repository: string; sha: string };

function CommitStatus({ root, session, repository, sha, commit, label }: Omit<CommitContext, "sha"> & {
  sha: string | null; commit?: GitBlameCommit; label: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="status-item git-line-status" aria-label={`Current line Git: ${label}，查看提交详情`}>
        <Icon name="git-commit" />
        <span className="git-line-label">{label}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className="z-90" side="top" align="end" sideOffset={4} collisionPadding={8}>
          <Popover.Popup
            className="workspace-popup block! w-[400px]! max-h-[min(420px,var(--available-height))]! p-[12px]! text-[12px] leading-[18px] select-text outline-none"
            data-testid="git-commit-popup" initialFocus={false}
          >
            <Popover.Title className="sr-only">{sha ? "提交详情" : "尚未提交"}</Popover.Title>
            <Popover.Close render={<IconButton icon="close" label="关闭提交详情" className="float-right ml-2" />} />
            {open && (sha && commit
              ? <CommitDetails root={root} session={session} repository={repository} sha={sha} commit={commit} />
              : <p>当前行尚未包含在 HEAD 提交中。</p>)}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function CommitDetails({ root, session, repository, sha, commit }: CommitContext & { commit: GitBlameCommit }) {
  const [details, setDetails] = useState<GitCommitDetails | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [copyStatus, setCopyStatus] = useState("");
  useEffect(() => {
    let current = true;
    void call<GitCommitDetails>("git_commit_details", { expectedRoot: root, session, repository, sha }).then(
      (value) => { if (current) { setDetails(value); } },
      (reason) => { if (current) { setError(errorMessage(reason)); } },
    );
    return () => { current = false; };
  }, [root, session, repository, sha, attempt]);
  async function copySha() {
    try {
      if (desktop) {
        await (await import("@tauri-apps/plugin-clipboard-manager")).writeText(sha);
      } else {
        await navigator.clipboard.writeText(sha);
      }
      setCopyStatus("已复制 SHA");
    } catch (reason) {
      setCopyStatus(`复制失败：${errorMessage(reason)}`);
    }
  }
  const time = new Date((details?.authorTime ?? commit.authorTime) * 1000);
  const validTime = Number.isFinite(time.getTime());
  return (
    <>
      <p className="mb-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{details?.message ?? commit.summary}</p>
      <p className="[overflow-wrap:anywhere]">
        {details?.author || commit.author || "Unknown author"}{details?.authorEmail && <span>({details.authorEmail})</span>}
      </p>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <time dateTime={validTime ? time.toISOString() : undefined}>{validTime ? time.toLocaleString() : "未知时间"}</time>
        <span className="inline-flex shrink-0 items-center gap-1">
          <code className="font-mono" title={details?.sha ?? sha}>{(details?.sha ?? sha).slice(0, 8)}</code>
          <IconButton
            icon={copyStatus === "已复制 SHA" ? "check" : "copy"} label="复制 SHA" title={copyStatus || "复制 SHA"}
            className="h-[20px]! w-[20px]! p-0!" onClick={() => void copySha()}
          />
        </span>
      </div>
      <p className={copyStatus.startsWith("复制失败") ? "mt-1 [overflow-wrap:anywhere]" : "sr-only"} role="status">{copyStatus}</p>
      {!details && !error && <p className="mt-3" role="status">正在加载完整提交信息…</p>}
      {error && <div className="mt-3">
        <p role="alert" className="whitespace-pre-wrap [overflow-wrap:anywhere]">无法读取提交详情：{error}</p>
        <button type="button" className="btn btn-ghost btn-xs mt-2" onClick={() => { setError(""); setAttempt((value) => value + 1); }}>重试</button>
      </div>}
    </>
  );
}
