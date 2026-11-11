import searchStyles from "./SearchView.module.css";
import { treeTheme } from "../styles/theme";
import gitStyles from "../styles/git.module.css";
import workbenchStyles from "../styles/workbench.module.css";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { Allotment, type AllotmentHandle } from "allotment";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { treeIcons } from "../explorer/treeIcons";
import { themeToTreeStyles, type GitStatusEntry } from "@pierre/trees";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useApp, setApp, notify } from "../store/store";
import { basename, scheduleBackup } from "../editor/documents";
import { errorMessage } from "../core/bridge";
import { openFolder } from "../core/commands";
import { actionButtonClass, Icon, IconButton, FileIcon } from "./ui";
import { GitCommitDialog } from "./GitCommitDialog";
import { PaneLayout } from "./EditorGrid";
import {
  addPaneWeights,
  changePaneSizes,
  resizedPaneWeights,
  type PaneWeights,
} from "../git/panes";
import { remoteWebUrl } from "../git/remotes";
import {
  branchDifference,
  branchSwitchTarget,
  copyBranchName,
  createBranch,
  switchBranch,
} from "../git/branches";
import {
  changePaths,
  gitContext,
  openGitDiff,
  openGitSource,
  readGitInfo,
  refreshGitPanel,
  runGitOperation,
  selectedRepository,
} from "../git/git";
import { filesUnder, groupChanges, visibleRange, type ChangeGroup } from "../git/changes";
import type { GitChange, GitInfo, GitOperation, GitRepository } from "../types/types";
import sidebarScrollbarCSS from "../styles/sidebar-scrollbar.css?raw";

const groups: [ChangeGroup, string][] = [
  ["conflicts", "Merge Changes"],
  ["staged", "Staged Changes"],
  ["changes", "Changes"],
  ["untracked", "Untracked Files"],
];
const report = (error: unknown) => notify(errorMessage(error));

function gitStatusClass(status: string | undefined) {
  let statusClass;
  if (status === "M" || status === "R") {
    statusClass = "text-git-modified";
  } else {
    if (status === "A" || status === "U") {
      statusClass = "text-git-added";
    } else {
      if (status === "D" || status === "!") {
        statusClass = "text-git-deleted";
      } else {
        statusClass = "";
      }
    }
  }

  return statusClass;
}

function warnIfNoRemotes(remotes: GitInfo["remotes"]) {
  if (!remotes.length) {
    notify("This repository has no configured remote.");
  }
}
function requestForRemote(kind: "fetch" | "push", remote: string): GitOperation {
  return kind === "fetch" ? { kind, remote } : { kind: "push", remote };
}

function GitRemoteAddress({
  remote,
  kind,
  address,
}: Readonly<{
  remote: string;
  kind: "Fetch" | "Push";
  address: string | null;
}>) {
  if (!address) {
    return null;
  }
  const url = remoteWebUrl(address);
  return (
    <div
      className={`git-remote-address flex items-center gap-2 min-w-0 ${gitStyles["git-remote-address"]}`}
    >
      <strong title={remote}>{remote}</strong>
      <code title={address} aria-label={`${kind} URL`}>
        {url ? (
          <a
            href={url}
            className="text-link hover:underline focus-visible:underline"
            aria-label={`Open ${remote} ${kind.toLowerCase()} URL`}
            onClick={(event) => {
              event.preventDefault();
              void openUrl(url).catch(report);
            }}
          >
            {address}
          </a>
        ) : (
          address
        )}
      </code>
    </div>
  );
}

export function GitView() {
  const root = useApp((s) => s.root);
  const git = useApp((s) => s.gitState);
  const infoVersion = useApp((s) => s.gitInfoVersion);
  const selected = useApp((s) => s.gitRepository);
  const tab = useApp((s) => s.gitTab);
  const layout = useApp((s) => s.gitLayout);
  const active = useApp((s) => s.sidebar === "git" && s.view === "editor");
  const repository = selectedRepository();
  const repositoryPath = repository?.path;
  const branch = repository?.branch;
  const detached = repository?.detached;
  const operation = repository?.operation;
  const busy = useApp((s) => (repository ? s.gitBusy[repository.path] : undefined));
  const [details, setDetails] = useState<{
    path: string;
    root: string | null;
    session: typeof git.session;
    branch: typeof branch;
    detached: typeof detached;
    operation: typeof operation;
    info: GitInfo;
  } | null>(null);
  const info =
    details &&
    details.path === repositoryPath &&
    details.root === root &&
    details.session === git.session
      ? details.info
      : null;
  // Metadata invalidation refreshes details silently; it does not make actions unavailable.
  const currentInfo =
    details &&
    details.branch === branch &&
    details.detached === detached &&
    details.operation === operation &&
    !busy
      ? info
      : null;
  const [refreshing, setRefreshing] = useState(false);
  const [syncSuccess, setSyncSuccess] = useState<string | null>(null);
  const [syncPending, setSyncPending] = useState<string | null>(null);
  const syncWorking = useRef(false);
  const syncBusy = busy ?? syncPending;
  const syncGeneration = useRef(0);
  const syncSuccessTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useLayoutEffect(() => {
    setSyncSuccess(null);
    setSyncPending(null);
    syncWorking.current = false;
    return () => {
      syncGeneration.current += 1;
      clearTimeout(syncSuccessTimer.current);
    };
  }, [root, repositoryPath, git.session]);
  const [branchPending, setBranchPending] = useState(false);
  const [switchingBranch, setSwitchingBranch] = useState<string | null>(null);
  const [branchSearch, setBranchSearch] = useState("");
  const branchSearchInputRef = useRef<HTMLInputElement>(null);
  const [branchSearchOpen, setBranchSearchOpen] = useState(false);
  useEffect(() => {
    setBranchSearch("");
    setBranchSearchOpen(false);
  }, [root, repositoryPath, git.session]);
  const branchQuery = branchSearch.trim().toLowerCase();
  const visibleBranches =
    info?.branches.filter((branch) => branch.name.toLowerCase().includes(branchQuery)) ?? [];
  const branchWorking = useRef(false);
  useEffect(() => {
    if (repositoryPath && selected !== repositoryPath) {
      setApp({ gitRepository: repositoryPath });
    }
  }, [repositoryPath, selected]);
  useEffect(() => {
    if (!active || !repositoryPath || busy) {
      return;
    }
    let cancelled = false;
    void readGitInfo(repositoryPath)
      .then((result) => {
        if (!cancelled) {
          setDetails({
            path: repositoryPath,
            root,
            session: git.session,
            branch,
            detached,
            operation,
            info: result,
          });
        }
      })
      .catch((e) => {
        if (!cancelled) {
          report(e);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [active, repositoryPath, root, git.session, infoVersion, branch, detached, operation, busy]);

  async function refresh() {
    setRefreshing(true);
    try {
      await refreshGitPanel();
    } catch (error) {
      report(error);
    } finally {
      setRefreshing(false);
    }
  }
  async function choose(
    title: string,
    items: { id: string; label: string; description?: string }[],
  ): Promise<string | null> {
    if (!items.length) {
      notify("No matching Git targets. Fetch or configure a remote first.");
      return null;
    }
    return new Promise((resolve) => {
      let settled = false;
      const unsubscribe = useApp.subscribe((s) => {
        if (!s.quick && !settled) {
          queueMicrotask(() => {
            if (!settled) {
              settled = true;
              unsubscribe();
              resolve(null);
            }
          });
        }
      });
      setApp({
        quick: {
          title,
          items: items.map((item) => ({
            ...item,
            run: () => {
              settled = true;
              unsubscribe();
              resolve(item.id);
            },
          })),
        },
      });
    });
  }
  async function chooseSyncRequest(
    kind: "fetch" | "pull" | "pullRebase" | "push",
    info: GitInfo,
    valid: () => boolean,
  ): Promise<GitOperation | null> {
    if (kind === "fetch" || (kind === "push" && !info.upstream)) {
      const remote =
        info.remotes.length === 1
          ? info.remotes[0].name
          : await choose(
              "Select Remote",
              info.remotes.map((r) => ({
                id: r.name,
                label: r.name,
                description: r.fetch ?? "",
              })),
            );
      if (!valid()) {
        return null;
      }
      if (!remote) {
        warnIfNoRemotes(info.remotes);
        return null;
      }
      return requestForRemote(kind, remote);
    }
    if (kind === "push") {
      return { kind: "push" };
    }
    const request: GitOperation = { kind: "pull", rebase: kind === "pullRebase" };
    if (info.upstream) {
      return request;
    }
    const target = await choose(
      "Select Branch to Pull",
      info.branches.filter((b) => b.remote).map((b) => ({ id: b.name, label: b.name })),
    );
    if (!valid()) {
      return null;
    }
    const remote = info.remotes.find((r) => target?.startsWith(r.name + "/"));
    if (!target || !remote) {
      return null;
    }
    return {
      ...request,
      remote: remote.name,
      branch: target.slice(remote.name.length + 1),
    };
  }
  function finishSync(completed: boolean, kind: string, generation: number) {
    if (!completed || generation !== syncGeneration.current) {
      return;
    }
    setSyncSuccess(kind);
    syncSuccessTimer.current = setTimeout(() => setSyncSuccess(null), 1500);
  }
  async function sync(kind: "fetch" | "pull" | "pullRebase" | "push") {
    if (!repository || !currentInfo || busy || syncWorking.current) {
      return;
    }
    const context = gitContext(repository.path);
    const generation = ++syncGeneration.current;
    const valid = () => {
      const state = useApp.getState();
      const selected = selectedRepository();
      return (
        generation === syncGeneration.current &&
        state.root === context.expectedRoot &&
        state.gitState.session === context.session &&
        selected?.path === repository.path &&
        selected.branch === repository.branch &&
        selected.detached === repository.detached &&
        selected.operation === repository.operation &&
        (kind === "fetch" || (!selected.detached && !selected.operation)) &&
        !state.gitBusy[repository.path]
      );
    };
    if (!valid()) {
      return;
    }
    syncWorking.current = true;
    setSyncPending(kind);
    clearTimeout(syncSuccessTimer.current);
    setSyncSuccess(null);
    try {
      const info = await readGitInfo(repository.path);
      if (
        !valid() ||
        info.detached !== repository.detached ||
        (!info.detached && info.branch !== repository.branch) ||
        info.operation !== repository.operation
      ) {
        return;
      }
      const request = await chooseSyncRequest(kind, info, valid);
      if (!request || !valid()) {
        return;
      }
      finishSync(await runGitOperation(repository.path, request), kind, generation);
    } catch (error) {
      if (valid()) {
        report(error);
      }
    } finally {
      if (generation === syncGeneration.current) {
        syncWorking.current = false;
        setSyncPending(null);
      }
    }
  }
  async function branchAction(action: () => Promise<unknown>, branch: string | null = null) {
    if (branchWorking.current) {
      return;
    }
    branchWorking.current = true;
    setBranchPending(true);
    setSwitchingBranch(branch);
    try {
      await action();
    } catch (error) {
      report(error);
    } finally {
      branchWorking.current = false;
      setBranchPending(false);
      setSwitchingBranch(null);
    }
  }
  const branchDisabled =
    !!syncBusy || branchPending || !currentInfo || !!info?.operation || !!repository?.operation;
  const chooseBranch = (branches: GitInfo["branches"]) =>
    choose(
      "Select Local Tracking Branch",
      branches.map((b) => ({ id: b.name, label: b.name, description: b.upstream ?? undefined })),
    );
  function closeEmptyBranchSearch() {
    if (!branchQuery) {
      setBranchSearchOpen(false);
    }
  }
  function handleBranchSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setBranchSearch("");
    }
  }
  const branchSearchControl = branchSearchOpen ? (
    <div className="relative w-full max-w-48">
      <input
        ref={branchSearchInputRef}
        autoFocus
        className="w-full h-6 pr-6"
        placeholder="Search branches"
        aria-label="Search branches"
        value={branchSearch}
        onChange={(event) => setBranchSearch(event.target.value)}
        onBlur={(event) => {
          if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) {
            closeEmptyBranchSearch();
          }
        }}
        onKeyDown={handleBranchSearchKeyDown}
      />
      <IconButton
        icon="close"
        label="Clear branch search"
        className="absolute right-0 top-0"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (!branchQuery) {
            setBranchSearchOpen(false);
            return;
          }
          setBranchSearch("");
          branchSearchInputRef.current?.focus();
        }}
        onBlur={closeEmptyBranchSearch}
      />
    </div>
  ) : (
    <IconButton icon="search" label="Search branches" onClick={() => setBranchSearchOpen(true)} />
  );
  function renderGitContent() {
    let content;
    if (!root) {
      content = (
        <div
          className={`git-empty py-[25px] px-[14px] text-center text-muted text-[12px] ${gitStyles["git-empty"]}`}
        >
          <Icon name="source-control" />
          <p>Open a folder to use Source Control.</p>
          <button className={actionButtonClass} onClick={() => void openFolder().catch(report)}>
            Open Folder
          </button>
        </div>
      );
    } else {
      if (!repository) {
        content = (
          <div
            className={`git-empty py-[25px] px-[14px] text-center text-muted text-[12px] ${gitStyles["git-empty"]}`}
          >
            <p>{git.root ? "No Git repository found." : "Discovering repositories…"}</p>
            <button className={actionButtonClass} onClick={() => void refresh()}>
              Refresh
            </button>
          </div>
        );
      } else {
        content = (
          <>
            <div
              className={`git-tabs flex shrink-0 min-h-8 py-0 px-[10px] border-b border-b-panel ${gitStyles["git-tabs"]}`}
              role="tablist"
              aria-label="Source Control tabs"
              onKeyDown={(e) => {
                if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
                  e.preventDefault();
                  let next: "changes" | "info";
                  if (e.key === "Home") {
                    next = "changes";
                  } else if (e.key === "End") {
                    next = "info";
                  } else if (tab === "changes") {
                    next = "info";
                  } else {
                    next = "changes";
                  }
                  setApp({ gitTab: next });
                  document.getElementById(`git-tab-${next}`)?.focus();
                }
              }}
            >
              {(
                [
                  ["changes", "Changes"],
                  ["info", "Repository"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  id={`git-tab-${id}`}
                  role="tab"
                  tabIndex={tab === id ? 0 : -1}
                  aria-selected={tab === id}
                  aria-controls={`git-panel-${id}`}
                  onClick={() => {
                    setApp({ gitTab: id });
                    scheduleBackup();
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div
              className={`git-branch-heading flex items-center gap-[7px] min-w-0 text-[12px] ${gitStyles["git-branch-heading"]}`}
              title={repository.branch ?? repository.path}
            >
              <Icon name="git-branch" />
              <strong>
                {repository.branch ?? "No commits yet"}
                {repository.detached ? " (detached)" : ""}
              </strong>
              <span>{branchDifference(info, repository)}</span>
            </div>
            <div
              className={`git-sync-actions flex flex-wrap gap-[5px] ${gitStyles["git-sync-actions"]}`}
              aria-label="Git remote actions"
            >
              <button
                className={`${actionButtonClass} compact`}
                aria-label="Fetch"
                data-success={syncSuccess === "fetch"}
                aria-busy={syncBusy === "fetch"}
                disabled={!!syncBusy || !currentInfo}
                onClick={() => void sync("fetch").catch(report)}
              >
                <span className="git-sync-label">Fetch</span>
                {syncSuccess === "fetch" && <Icon name="check" className="git-sync-success" />}
                {syncBusy === "fetch" && (
                  <span
                    className={`spinner w-5 h-5 border-[2px] border-button-secondary rounded-full ${workbenchStyles["spinner"]}`}
                    aria-hidden="true"
                  />
                )}
              </button>
              <button
                className={`${actionButtonClass} compact`}
                aria-label="Pull"
                data-success={syncSuccess === "pull"}
                aria-busy={syncBusy === "pull"}
                disabled={
                  !!syncBusy || !currentInfo || repository.detached || !!repository.operation
                }
                onClick={() => void sync("pull").catch(report)}
              >
                <span className="git-sync-label">Pull</span>
                {syncSuccess === "pull" && <Icon name="check" className="git-sync-success" />}
                {syncBusy === "pull" && (
                  <span
                    className={`spinner w-5 h-5 border-[2px] border-button-secondary rounded-full ${workbenchStyles["spinner"]}`}
                    aria-hidden="true"
                  />
                )}
              </button>
              <button
                className={`${actionButtonClass} compact`}
                aria-label="Pull (Rebase)"
                data-success={syncSuccess === "pullRebase"}
                aria-busy={syncBusy === "pullRebase"}
                disabled={
                  !!syncBusy || !currentInfo || repository.detached || !!repository.operation
                }
                onClick={() => void sync("pullRebase").catch(report)}
              >
                <span className="git-sync-label">Pull (Rebase)</span>
                {syncSuccess === "pullRebase" && <Icon name="check" className="git-sync-success" />}
                {syncBusy === "pullRebase" && (
                  <span
                    className={`spinner w-5 h-5 border-[2px] border-button-secondary rounded-full ${workbenchStyles["spinner"]}`}
                    aria-hidden="true"
                  />
                )}
              </button>
              <button
                className={`${actionButtonClass} compact`}
                aria-label="Push"
                data-success={syncSuccess === "push"}
                aria-busy={syncBusy === "push"}
                disabled={
                  !!syncBusy || !currentInfo || repository.detached || !!repository.operation
                }
                onClick={() => void sync("push").catch(report)}
              >
                <span className="git-sync-label">Push</span>
                {syncSuccess === "push" && <Icon name="check" className="git-sync-success" />}
                {syncBusy === "push" && (
                  <span
                    className={`spinner w-5 h-5 border-[2px] border-button-secondary rounded-full ${workbenchStyles["spinner"]}`}
                    aria-hidden="true"
                  />
                )}
              </button>
              <GitCommitDialog
                key={`${root}:${repository.path}`}
                repository={repository}
                workspace={root}
              />
            </div>
            {repository.operation && (
              <div
                className={`git-operation-banner flex gap-2 items-center py-[7px] px-3 flex-wrap text-[12px] bg-warning-background ${gitStyles["git-operation-banner"]}`}
              >
                <span>{repository.operation} in progress</span>
                {repository.operation !== "other" && (
                  <div className="actions flex items-center gap-[2px] shrink-0">
                    <button
                      className={`${actionButtonClass} compact`}
                      disabled={!!busy}
                      onClick={() =>
                        void runGitOperation(repository.path, {
                          kind: "continue",
                        }).catch(report)
                      }
                    >
                      Continue
                    </button>
                    <button
                      className={`${actionButtonClass} compact`}
                      disabled={!!busy}
                      onClick={() =>
                        void runGitOperation(repository.path, {
                          kind: "abort",
                        }).catch(report)
                      }
                    >
                      Abort
                    </button>
                  </div>
                )}
              </div>
            )}
            {tab === "changes" ? (
              <div
                id="git-panel-changes"
                role="tabpanel"
                aria-labelledby="git-tab-changes"
                className="git-panel-content overflow-auto flex-1 min-h-0 pb-[18px]"
              >
                <GitChangePanes
                  key={repository.path}
                  repository={repository}
                  tree={layout === "tree"}
                  busy={!!busy}
                />
              </div>
            ) : (
              <div
                id="git-panel-info"
                role="tabpanel"
                aria-labelledby="git-tab-info"
                className={`git-panel-content overflow-auto flex-1 min-h-0 pb-[18px] git-info text-[12px] ${gitStyles["git-info"]}`}
              >
                <h3>Remotes</h3>
                {info?.remotes.length === 0 && (
                  <p className="muted text-muted">No remotes configured.</p>
                )}
                {info?.remotes.map((r) => (
                  <div
                    key={r.name}
                    className={`git-info-field flex flex-col gap-[3px] ${gitStyles["git-info-field"]}`}
                  >
                    <GitRemoteAddress remote={r.name} kind="Fetch" address={r.fetch} />
                    {r.push !== r.fetch && (
                      <GitRemoteAddress remote={r.name} kind="Push" address={r.push} />
                    )}
                  </div>
                ))}
                <div
                  className={`git-section-heading flex shrink-0 items-center min-h-7 bg-sidebar ${gitStyles["git-section-heading"]}`}
                >
                  <h3>Branches</h3>
                  <div className="flex flex-1 min-w-0 items-center justify-end gap-1 ml-2">
                    {branchSearchControl}
                    <IconButton
                      icon="add"
                      label="Create Branch"
                      disabled={branchDisabled}
                      onClick={() => void branchAction(() => createBranch(repository.path))}
                    />
                  </div>
                </div>
                {!info && (
                  <p className="muted text-muted" role="status">
                    Loading branches…
                  </p>
                )}
                {info && branchQuery && visibleBranches.length === 0 && (
                  <p className="muted text-muted" role="status">
                    No matching branches.
                  </p>
                )}
                {info &&
                  visibleBranches.map((b) => {
                    const branchKey = `${repository.path}:${b.remote}:${b.name}`;
                    const switching = switchingBranch === branchKey;
                    const target = branchSwitchTarget(b, info.branches);
                    const switchDisabled = branchDisabled || target.kind === "blocked";
                    const switchToBranch = () =>
                      branchAction(() => switchBranch(repository.path, b, chooseBranch), branchKey);
                    let branchIcon;
                    if (b.remote) {
                      branchIcon = "cloud";
                    } else {
                      if (b.current) {
                        branchIcon = "check";
                      } else {
                        branchIcon = b.worktree ? "worktree" : "git-branch";
                      }
                    }
                    return (
                      <div
                        key={`${b.remote}:${b.name}`}
                        className={`git-branch-row flex items-center gap-[6px] min-h-[29px] ${gitStyles["git-branch-row"]}`}
                      >
                        <button
                          title={b.name}
                          aria-label={b.name}
                          aria-current={b.current ? "true" : undefined}
                          aria-busy={switching}
                          disabled={switchDisabled}
                          onClick={() => void switchToBranch()}
                        >
                          <Icon name={branchIcon} />
                          <span>{b.name}</span>
                          {b.worktree && <small>worktree</small>}
                        </button>
                        <div
                          className={`git-branch-actions flex items-center shrink-0 gap-[2px] ${gitStyles["git-branch-actions"]}`}
                        >
                          <IconButton
                            icon="add"
                            label={`Create Branch from ${b.name}`}
                            disabled={branchDisabled}
                            onClick={() =>
                              void branchAction(() => createBranch(repository.path, b))
                            }
                          />
                          <IconButton
                            icon="copy"
                            label={`Copy Branch Name ${b.name}`}
                            onClick={() => void copyBranchName(b).catch(report)}
                          />
                          {!b.remote && (
                            <IconButton
                              icon="trash"
                              label={`Delete Branch ${b.name}`}
                              disabled={branchDisabled || b.current || b.worktree}
                              onClick={() =>
                                void branchAction(() =>
                                  runGitOperation(repository.path, {
                                    kind: "deleteBranch",
                                    branch: b.name,
                                  }),
                                )
                              }
                            />
                          )}
                        </div>
                        {switching && (
                          <span role="status" aria-label={`Switching to ${b.name}`}>
                            <span
                              className={`spinner block w-3 h-3 shrink-0 border-[2px] border-button-secondary rounded-full ${workbenchStyles["spinner"]}`}
                              aria-hidden="true"
                            />
                          </span>
                        )}
                      </div>
                    );
                  })}
              </div>
            )}
          </>
        );
      }
    }
    return content;
  }
  const content = renderGitContent();
  return (
    <section
      className={`view flex flex-col h-full min-h-0 overflow-hidden search-view text-[15px] bg-sidebar text-foreground ${searchStyles["search-view"]} git-view min-h-0 overflow-hidden ${gitStyles["git-view"]}`}
      aria-label="Source Control"
    >
      <div
        className={`view-title h-[35px] min-h-[35px] flex items-center justify-between text-[11px] ${workbenchStyles["view-title"]}`}
      >
        <span>Source Control</span>
        <div className="actions flex items-center gap-[2px] shrink-0">
          <IconButton
            icon="refresh"
            label="Refresh Source Control"
            disabled={refreshing || !!busy}
            onClick={() => void refresh()}
          />
          <IconButton
            icon={layout === "list" ? "list-tree" : "list-flat"}
            label={layout === "list" ? "View as Tree" : "View as List"}
            onClick={() => {
              setApp({ gitLayout: layout === "list" ? "tree" : "list" });
              scheduleBackup();
            }}
          />
        </div>
      </div>
      {content}
      <span className="sr-only" role="status" aria-live="polite">
        {syncSuccess &&
          `${syncSuccess === "pullRebase" ? "Pull (Rebase)" : syncSuccess.charAt(0).toUpperCase() + syncSuccess.slice(1)} completed successfully.`}
      </span>
      {git.warnings.length > 0 && (
        <button
          className={`inline-warning py-[5px] px-[18px] leading-[18px] m-0 text-[12px] text-warning ${workbenchStyles["inline-warning"]}`}
          onClick={() => notify(git.warnings.join("\n"))}
        >
          {git.warnings.length} Git warning(s)
        </button>
      )}
    </section>
  );
}

function GitChangePanes({
  repository,
  tree,
  busy,
}: Readonly<{
  repository: GitRepository;
  tree: boolean;
  busy: boolean;
}>) {
  const grouped = useMemo(() => groupChanges(repository.changes), [repository.changes]);
  const host = useRef<HTMLDivElement>(null);
  const layout = useRef<AllotmentHandle>(null);
  const weights = useRef<PaneWeights>({});
  const sizes = useRef<number[]>([]);
  const appliedSizes = useRef<number[]>([]);
  const [height, setHeight] = useState(0);
  const [collapsed, setCollapsed] = useState<Partial<Record<ChangeGroup, boolean>>>({});
  const [actions, setActions] = useState<Partial<Record<ChangeGroup, boolean>>>({});
  const onActionsChange = useCallback((kind: ChangeGroup, visible: boolean) => {
    setActions((previous) =>
      previous[kind] === visible ? previous : { ...previous, [kind]: visible },
    );
  }, []);
  const panes = useMemo(
    () =>
      groups
        .filter(([kind]) => grouped[kind].length > 0)
        .map(([kind, title]) => {
          let minimum;
          if (collapsed[kind]) {
            minimum = 28;
          } else {
            if (tree && actions[kind]) {
              minimum = 82;
            } else {
              minimum = 54;
            }
          }
          return {
            kind,
            title,
            count: grouped[kind].length,
            expanded: !collapsed[kind],
            minimum: minimum,
          };
        }),
    [grouped, collapsed, tree, actions],
  );
  const minimum = panes.reduce((sum, pane) => sum + pane.minimum, 0);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    weights.current = addPaneWeights(panes, weights.current);
    const next = changePaneSizes(panes, weights.current, height);
    if (!layout.current) {
      appliedSizes.current = [];
      return;
    }
    if (
      next.length !== appliedSizes.current.length ||
      next.some((size, index) => size !== appliedSizes.current[index])
    ) {
      appliedSizes.current = next;
      layout.current.resize(next);
    }
  }, [panes, height]);
  return (
    <div
      ref={host}
      className={`git-change-panes flex-1 min-h-0 ${gitStyles["git-change-panes"]}`}
      style={{ "--git-panes-min-height": `${minimum}px` } as CSSProperties}
    >
      {panes.length ? (
        <PaneLayout
          ref={layout}
          vertical
          label="Git change group height"
          defaultSizes={panes.map((pane) => pane.count)}
          onChange={(next) => {
            sizes.current = next;
          }}
          onCommit={() => {
            weights.current = resizedPaneWeights(panes, weights.current, sizes.current);
            appliedSizes.current = changePaneSizes(panes, weights.current, height);
          }}
        >
          {panes.map((pane) => (
            <Allotment.Pane
              key={pane.kind}
              minSize={pane.minimum}
              maxSize={pane.expanded ? Infinity : 28}
            >
              <GitChangeSection
                repository={repository}
                kind={pane.kind}
                title={pane.title}
                changes={grouped[pane.kind]}
                tree={tree}
                busy={busy}
                expanded={pane.expanded}
                onToggle={() =>
                  setCollapsed((previous) => ({ ...previous, [pane.kind]: !previous[pane.kind] }))
                }
                onActionsChange={onActionsChange}
              />
            </Allotment.Pane>
          ))}
        </PaneLayout>
      ) : (
        <div
          className={`git-empty py-[25px] px-[14px] text-center text-muted text-[12px] ${gitStyles["git-empty"]}`}
        >
          <Icon name="check" />
          <p>No changes.</p>
        </div>
      )}
    </div>
  );
}

function GitChangeSection({
  repository,
  kind,
  title,
  changes,
  tree,
  busy,
  expanded,
  onToggle,
  onActionsChange,
}: Readonly<{
  repository: GitRepository;
  kind: ChangeGroup;
  title: string;
  changes: GitChange[];
  tree: boolean;
  busy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onActionsChange: (kind: ChangeGroup, visible: boolean) => void;
}>) {
  const staged = kind === "staged";
  const run = (action: "stage" | "unstage" | "discard", files = changes) =>
    runGitOperation(
      repository.path,
      action === "discard"
        ? {
            kind: action,
            files: files.map(({ path, stamp }) => ({ path, stamp })),
          }
        : { kind: action, paths: changePaths(files) },
    ).catch(report);
  return (
    <section
      className={`git-change-section flex flex-col min-h-7 h-full overflow-hidden ${gitStyles["git-change-section"]}`}
      aria-label={title}
    >
      <div
        className={`git-section-heading flex shrink-0 items-center min-h-7 bg-sidebar ${gitStyles["git-section-heading"]}`}
      >
        <button
          className={`git-section-toggle flex items-center gap-[5px] flex-1 min-w-0 text-left h-7 text-[12px] font-semibold ${gitStyles["git-section-toggle"]}`}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <Icon name={expanded ? "chevron-down" : "chevron-right"} />
          <span>{title}</span>
          <span className="git-count text-[11px] rounded-[10px] bg-badge py-0 px-[6px] min-w-[19px] text-center font-normal">
            {changes.length}
          </span>
        </button>
        <div className="actions flex items-center gap-[2px] shrink-0">
          {kind !== "conflicts" && !staged && (
            <IconButton
              icon="discard"
              label={`Discard All ${title}`}
              disabled={busy}
              onClick={() => void run("discard")}
            />
          )}
          <IconButton
            icon={staged ? "remove" : "add"}
            label={staged ? "Unstage All Changes" : `Stage All ${title}`}
            disabled={busy}
            onClick={() => void run(staged ? "unstage" : "stage")}
          />
        </div>
      </div>
      {expanded &&
        (tree ? (
          <GitChangesTree
            repository={repository.path}
            kind={kind}
            changes={changes}
            busy={busy}
            run={run}
            onActionsChange={onActionsChange}
          />
        ) : (
          <GitChangesList
            repository={repository.path}
            kind={kind}
            changes={changes}
            busy={busy}
            run={run}
          />
        ))}
    </section>
  );
}

type ChangesProps = {
  repository: string;
  kind: ChangeGroup;
  changes: GitChange[];
  busy: boolean;
  run: (action: "stage" | "unstage" | "discard", files?: GitChange[]) => Promise<unknown>;
};
function FileActions({
  repository,
  change,
  kind,
  busy,
  run,
}: Omit<ChangesProps, "changes"> & { change: GitChange }) {
  return (
    <div
      className="actions flex items-center gap-[2px] shrink-0 git-file-actions"
      onClick={(e) => e.stopPropagation()}
    >
      <IconButton
        icon="go-to-file"
        label={`Open Source ${change.path}`}
        disabled={kind !== "staged" && change.worktreeStatus === "deleted"}
        onClick={() => void openGitSource(repository, change.path).catch(report)}
      />
      {kind !== "staged" && kind !== "conflicts" && (
        <IconButton
          icon="discard"
          label={`Discard ${change.path}`}
          disabled={busy}
          onClick={() => void run("discard", [change])}
        />
      )}
      <IconButton
        icon={kind === "staged" ? "remove" : "add"}
        label={`${kind === "staged" ? "Unstage" : "Stage"} ${change.path}`}
        disabled={busy}
        onClick={() => void run(kind === "staged" ? "unstage" : "stage", [change])}
      />
    </div>
  );
}
function GitChangesList(props: Readonly<ChangesProps>) {
  const { changes, repository, kind } = props;
  const host = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(260);
  const [selected, setSelected] = useState(0);
  const range = visibleRange(changes.length, scroll, height);
  useEffect(() => {
    const element = host.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setSelected((index) => Math.min(index, changes.length - 1));
  }, [changes.length]);
  return (
    <div
      ref={host}
      className={`git-changes-list flex-1 relative overflow-auto min-h-[26px] outline-none ${gitStyles["git-changes-list"]}`}
      role="listbox"
      aria-label={`${kind} files`}
      tabIndex={0}
      aria-activedescendant={`git-${kind}-row-${selected}`}
      onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) {
          return;
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const index = Math.max(
            0,
            Math.min(changes.length - 1, selected + (e.key === "ArrowDown" ? 1 : -1)),
          );
          setSelected(index);
          const top = host.current?.scrollTop ?? 0;
          if (index * 26 < top) {
            host.current?.scrollTo({ top: index * 26 });
          } else if ((index + 1) * 26 > top + height) {
            host.current?.scrollTo({ top: (index + 1) * 26 - height });
          }
        }
        if (e.key === "Enter" && changes[selected]) {
          e.preventDefault();
          void openGitDiff(repository, changes[selected], kind === "staged", true).catch(report);
        }
      }}
    >
      <div className="relative" style={{ height: changes.length * 26 }}>
        {changes.slice(range.first, range.end).map((change, offset) => {
          const index = range.first + offset;
          let status;
          if (kind === "conflicts") {
            status = "!";
          } else {
            let statusPart1;
            if (kind === "staged") {
              statusPart1 = change.indexStatus;
            } else {
              statusPart1 = change.worktreeStatus;
            }
            status = statusPart1?.slice(0, 1).toUpperCase();
          }

          const statusClass = gitStatusClass(status);
          return (
            <div
              key={change.path}
              id={`git-${kind}-row-${index}`}
              className={`git-file-row absolute left-0 right-0 flex items-center gap-[6px] h-[26px] cursor-pointer text-[13px] ${gitStyles["git-file-row"]}${selected === index ? " selected" : ""}`}
              role="option"
              aria-selected={selected === index}
              aria-label={change.path}
              title={change.oldPath ? `${change.oldPath} → ${change.path}` : change.path}
              data-git-path={change.path}
              style={{ top: index * 26 }}
              onClick={() => {
                setSelected(index);
                host.current?.focus();
                void openGitDiff(repository, change, kind === "staged").catch(report);
              }}
              onDoubleClick={() =>
                void openGitDiff(repository, change, kind === "staged", true).catch(report)
              }
            >
              <FileIcon path={change.path} />
              <span
                className={`git-file-name min-w-0 max-w-[70%] overflow-hidden text-ellipsis whitespace-nowrap ${gitStyles["git-file-name"]}${status === "D" ? " deleted" : ""}`}
              >
                {basename(change.path)}
              </span>
              <span className="git-file-directory flex-1 text-muted text-[11px] overflow-hidden text-ellipsis whitespace-nowrap">
                {change.path.includes("/")
                  ? change.path.slice(0, change.path.lastIndexOf("/"))
                  : ""}
              </span>
              <FileActions {...props} change={change} />
              <span
                className={`git-status ml-auto shrink-0 w-3 text-[12px] text-center git-status-${status} ${statusClass}`}
              >
                {status}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GitChangesTree(
  props: ChangesProps & { onActionsChange: (kind: ChangeGroup, visible: boolean) => void },
) {
  const { changes, repository, kind, run, busy, onActionsChange } = props;
  const [selected, setSelected] = useState<string>("");
  const changeIndex = useMemo(() => new Map(changes.map((c) => [c.path, c])), [changes]);
  const latestIndex = useRef(changeIndex);
  latestIndex.current = changeIndex;
  const { model } = useFileTree({
    paths: changes.map((c) => c.path),
    initialExpansion: "open",
    flattenEmptyDirectories: false,
    itemHeight: 26,
    overscan: 8,
    search: false,
    icons: treeIcons,
    onSelectionChange: (paths) => setSelected(paths[0] ?? ""),
    renderRowDecoration: ({ row }) => {
      const change = latestIndex.current.get(row.path);
      return change?.conflicted ? { text: "!", title: "Unmerged changes" } : null;
    },
    unsafeCSS: sidebarScrollbarCSS,
  });
  const treePaths = useRef(changes.map((change) => change.path));
  useEffect(() => {
    const paths = changes.map((change) => change.path);
    if (
      paths.length !== treePaths.current.length ||
      paths.some((path, index) => path !== treePaths.current[index])
    ) {
      treePaths.current = paths;
      model.resetPaths(paths);
    }
    model.setGitStatus(
      changes.map((c) => ({
        path: c.path,
        status: (kind === "staged" ? c.indexStatus : c.worktreeStatus) ?? "modified",
      })) as GitStatusEntry[],
    );
  }, [model, changes, kind]);
  const selectedFiles = useMemo(() => filesUnder(changes, selected), [changes, selected]);
  const hasActions = selectedFiles.length > 0;
  useLayoutEffect(() => {
    onActionsChange(kind, hasActions);
    return () => onActionsChange(kind, false);
  }, [kind, hasActions, onActionsChange]);
  function open(event: Event, pinned = false) {
    const row = event
      .composedPath()
      .find((target) => target instanceof HTMLElement && target.hasAttribute("data-item-path")) as
      | HTMLElement
      | undefined;
    const path = row?.dataset.itemPath ?? model.getFocusedPath();
    const change = changes.find((c) => c.path === path);
    if (change) {
      void openGitDiff(repository, change, kind === "staged", pinned).catch(report);
    }
  }
  return (
    <div className="git-tree-group flex-1 flex flex-col min-h-[26px]">
      <FileTree
        model={model}
        className="git-file-tree flex-1 block min-h-[26px]"
        aria-label={`${kind} tree`}
        style={
          {
            ...themeToTreeStyles(treeTheme),
            "--trees-font-family-override": '"Segoe UI", sans-serif',
            "--trees-font-size-override": "13px",
          } as CSSProperties
        }
        onClick={(e) => open(e.nativeEvent)}
        onDoubleClick={(e) => open(e.nativeEvent, true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            open(e.nativeEvent, true);
          }
        }}
      />
      {selectedFiles.length > 0 && (
        <div
          className={`git-tree-selection-actions flex shrink-0 items-center gap-[5px] py-[2px] px-2 text-[11px] text-muted ${gitStyles["git-tree-selection-actions"]}`}
        >
          <span className="truncate" title={selected}>
            {selected}
          </span>
          <div className="actions flex items-center gap-[2px] shrink-0">
            {selectedFiles.length === 1 && !selected.endsWith("/") && (
              <IconButton
                icon="go-to-file"
                label={`Open Source ${selected}`}
                onClick={() => void openGitSource(repository, selected).catch(report)}
              />
            )}
            {kind !== "staged" && kind !== "conflicts" && (
              <IconButton
                icon="discard"
                label={`Discard ${selected}`}
                disabled={busy}
                onClick={() => void run("discard", selectedFiles)}
              />
            )}
            <IconButton
              icon={kind === "staged" ? "remove" : "add"}
              label={`${kind === "staged" ? "Unstage" : "Stage"} ${selected}`}
              disabled={busy}
              onClick={() => void run(kind === "staged" ? "unstage" : "stage", selectedFiles)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
