import { useEffect, useRef, useState } from "react";
import gitStyles from "../styles/git.module.css";
import workbenchStyles from "../styles/workbench.module.css";
import { errorMessage } from "../core/bridge";
import { visibleRange } from "../git/changes";
import { HISTORY_ROW_HEIGHT, copyCommitHash } from "../git/history";
import { blameAge } from "../git/lineBlame";
import { useGitHistory } from "../hooks/useGitHistory";
import { notify } from "../store/store";
import type { GitHistoryCommit } from "../types/gitHistory";
import type { GitRepository } from "../types/types";
import { actionButtonClass, Icon, IconButton } from "./ui";

type GitHistoryPanelProps = Readonly<{
  repository: GitRepository;
  root: string | null;
  session: number | null;
  infoVersion: number;
  active: boolean;
  busy: boolean;
}>;

function CommitHistoryRow({
  commit,
  index,
  now,
  copied,
  onCopyHash,
}: Readonly<{
  commit: GitHistoryCommit;
  index: number;
  now: number;
  copied: boolean;
  onCopyHash: (sha: string) => void;
}>) {
  const summary = commit.summary || "(no commit message)";
  const author = commit.author || "Unknown author";
  const shortSha = commit.sha.slice(0, 7);
  const date = new Date(commit.authorTime * 1000);
  const validTime = Number.isFinite(date.getTime());
  const exactTime = validTime ? date.toLocaleString() : "Unknown time";
  const relativeTime = validTime ? blameAge(commit.authorTime, now) : "Unknown time";

  return (
    <li
      className="git-history-row absolute left-0 right-0 flex flex-col justify-center gap-[2px] h-[48px] px-3 py-[6px] border-b border-b-panel hover:bg-hover"
      style={{ top: index * HISTORY_ROW_HEIGHT }}
      data-commit-sha={commit.sha}
    >
      <div
        className={`truncate text-[12px] leading-[18px] ${
          commit.summary ? "text-foreground" : "text-muted italic"
        }`}
        title={summary}
      >
        {summary}
      </div>
      <div className="flex items-center justify-between gap-2 text-[11px] leading-[16px] text-muted">
        <span className="flex items-center gap-1 min-w-0">
          <span className="truncate" title={author}>
            {author}
          </span>
          <span className="shrink-0" aria-hidden="true">
            ·
          </span>
          <time
            className="shrink-0"
            dateTime={validTime ? date.toISOString() : undefined}
            title={exactTime}
          >
            {relativeTime}
          </time>
        </span>
        <span className="inline-flex shrink-0 items-center gap-[2px]">
          <code className="font-mono text-[11px] text-subtle" title={commit.sha}>
            {shortSha}
          </code>
          <IconButton
            icon={copied ? "check" : "copy"}
            label={copied ? `Copied ${shortSha}` : `Copy commit hash ${shortSha}`}
            className={`${gitStyles["git-history-copy"]} ${copied ? "text-git-added" : "text-muted"}`}
            onClick={() => onCopyHash(commit.sha)}
          />
        </span>
      </div>
    </li>
  );
}

function HistoryFooter({
  loadingMore,
  loadMoreError,
  onRetry,
}: Readonly<{
  loadingMore: boolean;
  loadMoreError: string | null;
  onRetry: () => void;
}>) {
  if (loadingMore) {
    return (
      <div
        className="flex items-center justify-center gap-2 py-2 px-3 text-[12px] text-muted"
        role="status"
      >
        <span
          className={`spinner block w-3 h-3 shrink-0 border-[2px] border-button-secondary rounded-full ${workbenchStyles["spinner"]}`}
          aria-hidden="true"
        />
        <span>Loading more…</span>
      </div>
    );
  }
  if (loadMoreError) {
    return (
      <div className="flex flex-col items-center gap-2 py-2 px-3 text-center text-[12px] text-muted">
        <p role="alert" className="m-0 [overflow-wrap:anywhere]">
          {loadMoreError}
        </p>
        <button type="button" className={`${actionButtonClass} compact`} onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }
  return null;
}

export function GitHistoryPanel(props: GitHistoryPanelProps) {
  const { hostRef, history, scrollTop, viewportHeight, handleScroll, loadMore, retry } =
    useGitHistory(props);
  const [now, setNow] = useState(Date.now);
  const [copiedSha, setCopiedSha] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      clearInterval(timer);
      clearTimeout(copyTimerRef.current);
    };
  }, []);

  function handleCopyHash(sha: string) {
    void copyCommitHash(sha)
      .then(() => {
        setCopiedSha(sha);
        clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => setCopiedSha(null), 1500);
      })
      .catch((reason) => notify(errorMessage(reason)));
  }

  const range = visibleRange(
    history.commits.length,
    scrollTop,
    viewportHeight || 260,
    HISTORY_ROW_HEIGHT,
  );

  let body;
  if (history.loading && history.commits.length === 0) {
    body = (
      <p className="py-3 px-3 text-[12px] text-muted" role="status">
        Loading history…
      </p>
    );
  } else if (history.error && history.commits.length === 0) {
    body = (
      <div
        className={`git-empty py-[25px] px-[14px] text-center text-muted text-[12px] ${gitStyles["git-empty"]}`}
      >
        <p role="alert" className="[overflow-wrap:anywhere]">
          {history.error}
        </p>
        <button type="button" className={`${actionButtonClass} compact`} onClick={retry}>
          Retry
        </button>
      </div>
    );
  } else if (history.commits.length === 0) {
    body = (
      <div
        className={`git-empty py-[25px] px-[14px] text-center text-muted text-[12px] ${gitStyles["git-empty"]}`}
      >
        <Icon name="history" />
        <p>No commits yet.</p>
      </div>
    );
  } else {
    body = (
      <>
        <ul
          className="relative m-0 p-0 list-none"
          style={{ height: history.commits.length * HISTORY_ROW_HEIGHT }}
          aria-label="Commit history"
        >
          {history.commits.slice(range.first, range.end).map((commit, offset) => (
            <CommitHistoryRow
              key={commit.sha}
              commit={commit}
              index={range.first + offset}
              now={now}
              copied={copiedSha === commit.sha}
              onCopyHash={handleCopyHash}
            />
          ))}
        </ul>
        <HistoryFooter
          loadingMore={history.loadingMore}
          loadMoreError={history.loadMoreError}
          onRetry={loadMore}
        />
      </>
    );
  }

  return (
    <div
      ref={hostRef}
      id="git-panel-history"
      role="tabpanel"
      aria-labelledby="git-tab-history"
      className="git-panel-content overflow-auto flex-1 min-h-0 pb-[18px]"
      onScroll={(event) => handleScroll(event.currentTarget.scrollTop)}
    >
      {body}
    </div>
  );
}
