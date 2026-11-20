import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { errorMessage } from "../core/bridge";
import { readGitHistory } from "../git/git";
import {
  HISTORY_PAGE_SIZE,
  appendHistoryCommits,
  shouldKeepHistoryOnRefresh,
  shouldLoadMoreHistory,
} from "../git/history";
import { notify } from "../store/store";
import type { GitHistoryCommit } from "../types/gitHistory";
import type { GitRepository } from "../types/types";

type UseGitHistoryOptions = Readonly<{
  repository: GitRepository;
  root: string | null;
  session: number | null;
  infoVersion: number;
  active: boolean;
  busy: boolean;
}>;

type HistoryState = {
  contextKey: string;
  head: string | null;
  commits: GitHistoryCommit[];
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  loadMoreError: string | null;
};

type SnapshotState = {
  contextKey: string;
  head: string | null;
  count: number;
  hasError: boolean;
};

type LoadedKey = {
  contextKey: string;
  infoVersion: number;
  attempt: number;
};

function initialHistoryState(contextKey: string): HistoryState {
  return {
    contextKey,
    head: null,
    commits: [],
    hasMore: false,
    loading: true,
    loadingMore: false,
    error: null,
    loadMoreError: null,
  };
}

function sameLoadedKey(loaded: LoadedKey | null, next: LoadedKey): boolean {
  return (
    loaded !== null &&
    loaded.contextKey === next.contextKey &&
    loaded.infoVersion === next.infoVersion &&
    loaded.attempt === next.attempt
  );
}

export function useGitHistory({
  repository,
  root,
  session,
  infoVersion,
  active,
  busy,
}: UseGitHistoryOptions) {
  const contextKey = JSON.stringify([
    root,
    session,
    repository.path,
    repository.branch,
    repository.detached,
    repository.operation,
  ]);
  const [history, setHistory] = useState<HistoryState>(() => initialHistoryState(contextKey));
  const [attempt, setAttempt] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const hostRef = useRef<HTMLDivElement>(null);
  const generationRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const loadedRef = useRef<LoadedKey | null>(null);
  const snapshotRef = useRef<SnapshotState>({
    contextKey,
    head: null,
    count: 0,
    hasError: false,
  });

  useEffect(() => {
    return () => {
      generationRef.current += 1;
      loadingMoreRef.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    const element = hostRef.current;
    if (!element) {
      return;
    }
    const updateHeight = () => setViewportHeight(element.clientHeight);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (snapshotRef.current.contextKey !== contextKey) {
      generationRef.current += 1;
      loadingMoreRef.current = false;
      loadedRef.current = null;
      snapshotRef.current = { contextKey, head: null, count: 0, hasError: false };
      hostRef.current?.scrollTo({ top: 0 });
      setScrollTop(0);
      setHistory(initialHistoryState(contextKey));
    }
    const loadKey: LoadedKey = { contextKey, infoVersion, attempt };
    if (!active || busy || sameLoadedKey(loadedRef.current, loadKey)) {
      return;
    }

    const generation = ++generationRef.current;
    loadingMoreRef.current = false;
    if (snapshotRef.current.count === 0) {
      setHistory((prev) => ({ ...prev, loading: true, error: null, loadMoreError: null }));
    }

    void readGitHistory(repository.path, { head: null, skip: 0, limit: HISTORY_PAGE_SIZE })
      .then((page) => {
        if (generation !== generationRef.current) {
          return;
        }
        loadedRef.current = loadKey;
        const current = snapshotRef.current;
        if (
          !current.hasError &&
          current.contextKey === contextKey &&
          shouldKeepHistoryOnRefresh(current.head, current.count, page)
        ) {
          setHistory((prev) =>
            prev.loading || prev.loadingMore || prev.error
              ? { ...prev, loading: false, loadingMore: false, error: null }
              : prev,
          );
          return;
        }
        snapshotRef.current = {
          contextKey,
          head: page.head,
          count: page.commits.length,
          hasError: false,
        };
        hostRef.current?.scrollTo({ top: 0 });
        setScrollTop(0);
        setHistory({
          contextKey,
          head: page.head,
          commits: page.commits,
          hasMore: page.hasMore,
          loading: false,
          loadingMore: false,
          error: null,
          loadMoreError: null,
        });
      })
      .catch((reason) => {
        if (generation !== generationRef.current) {
          return;
        }
        loadedRef.current = loadKey;
        const message = errorMessage(reason);
        if (snapshotRef.current.count === 0) {
          snapshotRef.current = { ...snapshotRef.current, hasError: true };
          setHistory((prev) => ({ ...prev, loading: false, loadingMore: false, error: message }));
          return;
        }
        notify(message);
        setHistory((prev) => ({ ...prev, loading: false, loadingMore: false }));
      });
  }, [active, busy, contextKey, infoVersion, attempt, repository.path]);

  function loadMore() {
    if (
      !active ||
      busy ||
      loadingMoreRef.current ||
      history.loading ||
      !history.hasMore ||
      !history.head
    ) {
      return;
    }
    const generation = generationRef.current;
    const head = history.head;
    const existing = history.commits;
    loadingMoreRef.current = true;
    setHistory((prev) => ({ ...prev, loadingMore: true, loadMoreError: null }));

    void readGitHistory(repository.path, {
      head,
      skip: existing.length,
      limit: HISTORY_PAGE_SIZE,
    })
      .then((page) => {
        if (generation !== generationRef.current) {
          return;
        }
        loadingMoreRef.current = false;
        const commits = appendHistoryCommits(existing, page.commits);
        snapshotRef.current = {
          contextKey,
          head,
          count: commits.length,
          hasError: false,
        };
        setHistory((prev) => ({
          ...prev,
          commits,
          hasMore: page.hasMore && page.commits.length > 0,
          loadingMore: false,
          loadMoreError: null,
        }));
      })
      .catch((reason) => {
        if (generation !== generationRef.current) {
          return;
        }
        loadingMoreRef.current = false;
        setHistory((prev) => ({
          ...prev,
          loadingMore: false,
          loadMoreError: errorMessage(reason),
        }));
      });
  }

  const canAutoLoadMore =
    active &&
    !busy &&
    !history.loading &&
    !history.loadingMore &&
    !history.loadMoreError &&
    history.hasMore &&
    history.commits.length > 0 &&
    shouldLoadMoreHistory(scrollTop, viewportHeight, history.commits.length);

  useEffect(() => {
    if (canAutoLoadMore) {
      loadMore();
    }
  });

  function handleScroll(nextScrollTop: number) {
    setScrollTop(nextScrollTop);
    if (
      !history.loadMoreError &&
      shouldLoadMoreHistory(nextScrollTop, viewportHeight, history.commits.length)
    ) {
      loadMore();
    }
  }

  function retry() {
    setAttempt((value) => value + 1);
  }

  return {
    hostRef,
    history,
    scrollTop,
    viewportHeight,
    handleScroll,
    loadMore,
    retry,
  };
}
