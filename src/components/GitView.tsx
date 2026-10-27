import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Allotment, type AllotmentHandle } from "allotment";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { themeToTreeStyles, type GitStatusEntry } from "@pierre/trees";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useApp, setApp, notify } from "../store/store";
import { basename, scheduleBackup } from "../editor/documents";
import { errorMessage } from "../core/bridge";
import { openFolder } from "../core/commands";
import { Icon, IconButton, FileIcon } from "./ui";
import { GitCommitDialog } from "./GitCommitDialog";
import { PaneLayout } from "./EditorGrid";
import { addPaneWeights, changePaneSizes, resizedPaneWeights, type PaneWeights } from "../git/panes";
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
  openGitDiff,
  openGitSource,
  readGitInfo,
  refreshGitPanel,
  runGitOperation,
  selectedRepository,
} from "../git/git";
import {
  filesUnder,
  groupChanges,
  visibleRange,
  type ChangeGroup,
} from "../git/changes";
import { languageFor } from "../editor/monaco";
import type {
  GitChange,
  GitInfo,
  GitOperation,
  GitRepository,
} from "../types/types";
import sidebarScrollbarCSS from "../styles/sidebar-scrollbar.css?raw";

const groups: [ChangeGroup, string][] = [
  ["conflicts", "Merge Changes"],
  ["staged", "Staged Changes"],
  ["changes", "Changes"],
  ["untracked", "Untracked Files"],
];
const report = (error: unknown) => notify(errorMessage(error));

function GitRemoteAddress({ remote, kind, address }: {
  remote: string;
  kind: "Fetch" | "Push";
  address: string | null;
}) {
  if (!address) {
    return null;
  }
  const url = remoteWebUrl(address);
  return (
    <div className="git-remote-address">
      <strong title={remote}>{remote}</strong>
      <code title={address} aria-label={`${kind} URL`}>{address}</code>
      <button
        type="button"
        className="btn btn-xs"
        aria-label={`Open ${remote} ${kind.toLowerCase()} URL`}
        disabled={!url}
        title={url ?? "No supported web address for this remote URL."}
        onClick={() => {
          if (url) {
            void openUrl(url).catch(report);
          }
        }}
      >
        Open
      </button>
    </div>
  );
}

export function GitView() {
  const root = useApp((s) => s.root);
  const git = useApp((s) => s.gitState);
  const selected = useApp((s) => s.gitRepository);
  const tab = useApp((s) => s.gitTab);
  const layout = useApp((s) => s.gitLayout);
  const active = useApp((s) => s.sidebar === "git" && s.view === "editor");
  const repository = selectedRepository();
  const repositoryPath = repository?.path;
  const busy = useApp((s) =>
    repository ? s.gitBusy[repository.path] : undefined,
  );
  const [details, setDetails] = useState<{
    path: string; root: string | null; snapshot: typeof git; info: GitInfo;
  } | null>(null);
  const info = details && details.path === repositoryPath && details.root === root && details.snapshot.session === git.session
    ? details.info : null;
  const currentInfo = details?.snapshot === git && !busy ? info : null;
  const [refreshing, setRefreshing] = useState(false);
  const [branchPending, setBranchPending] = useState(false);
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
          setDetails({ path: repositoryPath, root, snapshot: git, info: result });
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
  }, [active, repositoryPath, root, git, busy]);

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
  async function sync(kind: "fetch" | "pull" | "pullRebase" | "push") {
    if (!repository || !info || !currentInfo || busy) {
      return;
    }
    let request: GitOperation;
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
      if (!remote) {
        if (!info.remotes.length) {
          notify("This repository has no configured remote.");
        }
        return;
      }
      request = kind === "fetch" ? { kind, remote } : { kind: "push", remote };
    } else if (kind === "pull" || kind === "pullRebase") {
      request = { kind: "pull", rebase: kind === "pullRebase" };
      if (!info.upstream) {
        const target = await choose(
          "Select Branch to Pull",
          info.branches
            .filter((b) => b.remote)
            .map((b) => ({ id: b.name, label: b.name })),
        );
        const remote = info.remotes.find((r) =>
          target?.startsWith(r.name + "/"),
        );
        if (!target || !remote) {
          return;
        }
        request = {
          ...request,
          remote: remote.name,
          branch: target.slice(remote.name.length + 1),
        };
      }
    } else {
      request = { kind: "push" };
    }
    await runGitOperation(repository.path, request);
  }
  async function branchAction(action: () => Promise<unknown>) {
    if (branchWorking.current) {
      return;
    }
    branchWorking.current = true;
    setBranchPending(true);
    try {
      await action();
    } catch (error) {
      report(error);
    } finally {
      branchWorking.current = false;
      setBranchPending(false);
    }
  }
  const branchDisabled = !!busy || branchPending || !currentInfo || !!info?.operation || !!repository?.operation;
  const chooseBranch = (branches: GitInfo["branches"]) => choose(
    "Select Local Tracking Branch",
    branches.map((b) => ({ id: b.name, label: b.name, description: b.upstream ?? undefined })),
  );
  return (
    <section className="view search-view git-view" aria-label="Source Control">
      <div className="view-title">
        <span>Source Control</span>
        <div className="actions">
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
      {!root ? (
        <div className="git-empty">
          <Icon name="source-control" />
          <p>Open a folder to use Source Control.</p>
          <button
            className="btn btn-sm"
            onClick={() => void openFolder().catch(report)}
          >
            Open Folder
          </button>
        </div>
      ) : !repository ? (
        <div className="git-empty">
          <p>
            {git.root
              ? "No Git repository found."
              : "Discovering repositories…"}
          </p>
          <button className="btn btn-sm" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
      ) : (
        <>
          <div
            className="tabs tabs-border git-tabs"
            role="tablist"
            aria-label="Source Control tabs"
            onKeyDown={(e) => {
              if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
                e.preventDefault();
                const next =
                  e.key === "Home"
                    ? "changes"
                    : e.key === "End"
                      ? "info"
                      : tab === "changes"
                        ? "info"
                        : "changes";
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
                className={`tab${tab === id ? " tab-active" : ""}`}
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
          <div className="git-branch-heading" title={repository.branch ?? repository.path}>
            <Icon name="git-branch" />
            <strong>
              {repository.branch ?? "No commits yet"}
              {repository.detached ? " (detached)" : ""}
            </strong>
            <span>{branchDifference(currentInfo, repository)}</span>
          </div>
          <div className="git-sync-actions" aria-label="Git remote actions">
            <button
              className="btn btn-xs"
              aria-label="Fetch"
              aria-busy={busy === "fetch"}
              disabled={!!busy || !currentInfo}
              onClick={() => void sync("fetch").catch(report)}
            >
              <span className="git-sync-label">Fetch</span>
              {busy === "fetch" && <span className="spinner" aria-hidden="true" />}
            </button>
            <button
              className="btn btn-xs"
              aria-label="Pull"
              aria-busy={busy === "pull"}
              disabled={
                !!busy || !currentInfo || repository.detached || !!repository.operation
              }
              onClick={() => void sync("pull").catch(report)}
            >
              <span className="git-sync-label">Pull</span>
              {busy === "pull" && <span className="spinner" aria-hidden="true" />}
            </button>
            <button
              className="btn btn-xs"
              aria-label="Pull (Rebase)"
              aria-busy={busy === "pullRebase"}
              disabled={
                !!busy || !currentInfo || repository.detached || !!repository.operation
              }
              onClick={() => void sync("pullRebase").catch(report)}
            >
              <span className="git-sync-label">Pull (Rebase)</span>
              {busy === "pullRebase" && <span className="spinner" aria-hidden="true" />}
            </button>
            <button
              className="btn btn-xs"
              aria-label="Push"
              aria-busy={busy === "push"}
              disabled={
                !!busy || !currentInfo || repository.detached || !!repository.operation
              }
              onClick={() => void sync("push").catch(report)}
            >
              <span className="git-sync-label">Push</span>
              {busy === "push" && <span className="spinner" aria-hidden="true" />}
            </button>
            <GitCommitDialog
              key={`${root}:${repository.path}`}
              repository={repository}
              workspace={root}
            />
          </div>
          {repository.operation && (
            <div className="git-operation-banner">
              <span>{repository.operation} in progress</span>
              {repository.operation !== "other" && (
                <div className="actions">
                  <button
                    className="btn btn-xs"
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
                    className="btn btn-xs"
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
              className="git-panel-content"
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
              className="git-panel-content git-info"
            >
              <h3>Remotes</h3>
              {info?.remotes.length === 0 && (
                <p className="muted">No remotes configured.</p>
              )}
              {info?.remotes.map((r) => (
                <div key={r.name} className="git-info-field">
                  <GitRemoteAddress remote={r.name} kind="Fetch" address={r.fetch} />
                  {r.push !== r.fetch && (
                    <GitRemoteAddress remote={r.name} kind="Push" address={r.push} />
                  )}
                </div>
              ))}
              <div className="git-section-heading">
                <h3>Branches</h3>
                <IconButton
                  icon="add"
                  label="Create Branch"
                  disabled={branchDisabled}
                  onClick={() => void branchAction(() => createBranch(repository.path))}
                />
              </div>
              {!info && <p className="muted" role="status">Loading branches…</p>}
              {info?.branches.map((b) => {
                const target = branchSwitchTarget(b, info.branches);
                const switchDisabled = branchDisabled || target.kind === "blocked";
                const switchToBranch = () => branchAction(() => switchBranch(repository.path, b, chooseBranch));
                return <div key={`${b.remote}:${b.name}`} className="git-branch-row">
                  <button
                    title={b.name}
                    aria-label={b.name}
                    disabled={switchDisabled}
                    onClick={() => void switchToBranch()}
                  >
                    <Icon
                      name={
                        b.remote ? "cloud" : b.current ? "check" : "git-branch"
                      }
                    />
                    <span>{b.name}</span>
                    {b.worktree && <small>worktree</small>}
                  </button>
                  <div className="git-branch-actions">
                    <IconButton
                      icon="add"
                      label={`Create Branch from ${b.name}`}
                      disabled={branchDisabled}
                      onClick={() => void branchAction(() => createBranch(repository.path, b))}
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
                          void branchAction(() => runGitOperation(repository.path, {
                            kind: "deleteBranch",
                            branch: b.name,
                          }))
                        }
                      />
                    )}
                  </div>
                </div>;
              })}
            </div>
          )}
        </>
      )}
      {git.warnings.length > 0 && (
        <button
          className="inline-warning"
          onClick={() => notify(git.warnings.join("\n"))}
        >
          {git.warnings.length} Git warning(s)
        </button>
      )}
    </section>
  );
}

function GitChangePanes({ repository, tree, busy }: {
  repository: GitRepository;
  tree: boolean;
  busy: boolean;
}) {
  const grouped = useMemo(() => groupChanges(repository.changes), [repository.changes]);
  const host = useRef<HTMLDivElement>(null);
  const layout = useRef<AllotmentHandle>(null);
  const weights = useRef<PaneWeights>({});
  const sizes = useRef<number[]>([]);
  const [height, setHeight] = useState(0);
  const [collapsed, setCollapsed] = useState<Partial<Record<ChangeGroup, boolean>>>({});
  const [actions, setActions] = useState<Partial<Record<ChangeGroup, boolean>>>({});
  const onActionsChange = useCallback((kind: ChangeGroup, visible: boolean) => {
    setActions((previous) => previous[kind] === visible ? previous : { ...previous, [kind]: visible });
  }, []);
  const panes = useMemo(() => groups.filter(([kind]) => grouped[kind].length > 0).map(([kind, title]) => ({
    kind,
    title,
    count: grouped[kind].length,
    expanded: !collapsed[kind],
    minimum: collapsed[kind] ? 28 : tree && actions[kind] ? 82 : 54,
  })), [grouped, collapsed, tree, actions]);
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
    layout.current?.resize(changePaneSizes(panes, weights.current, height));
  }, [panes, height]);
  return (
    <div ref={host} className="git-change-panes" style={{ "--git-panes-min-height": `${minimum}px` } as CSSProperties}>
      {panes.length ? (
        <PaneLayout
          ref={layout}
          vertical
          label="Git change group height"
          defaultSizes={panes.map((pane) => pane.count)}
          onChange={(next) => { sizes.current = next; }}
          onCommit={() => { weights.current = resizedPaneWeights(panes, weights.current, sizes.current); }}
        >
          {panes.map((pane) => (
            <Allotment.Pane key={pane.kind} minSize={pane.minimum} maxSize={pane.expanded ? Infinity : 28}>
              <GitChangeSection
                repository={repository}
                kind={pane.kind}
                title={pane.title}
                changes={grouped[pane.kind]}
                tree={tree}
                busy={busy}
                expanded={pane.expanded}
                onToggle={() => setCollapsed((previous) => ({ ...previous, [pane.kind]: !previous[pane.kind] }))}
                onActionsChange={onActionsChange}
              />
            </Allotment.Pane>
          ))}
        </PaneLayout>
      ) : (
        <div className="git-empty"><Icon name="check" /><p>No changes.</p></div>
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
}: {
  repository: GitRepository;
  kind: ChangeGroup;
  title: string;
  changes: GitChange[];
  tree: boolean;
  busy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onActionsChange: (kind: ChangeGroup, visible: boolean) => void;
}) {
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
    <section className="git-change-section" aria-label={title}>
      <div className="git-section-heading">
        <button
          className="git-section-toggle"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <Icon name={expanded ? "chevron-down" : "chevron-right"} />
          <span>{title}</span>
          <span className="git-count">{changes.length}</span>
        </button>
        <div className="actions">
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
  run: (
    action: "stage" | "unstage" | "discard",
    files?: GitChange[],
  ) => Promise<unknown>;
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
      className="actions git-file-actions"
      onClick={(e) => e.stopPropagation()}
    >
      <IconButton
        icon="go-to-file"
        label={`Open Source ${change.path}`}
        disabled={kind !== "staged" && change.worktreeStatus === "deleted"}
        onClick={() =>
          void openGitSource(repository, change.path).catch(report)
        }
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
        onClick={() =>
          void run(kind === "staged" ? "unstage" : "stage", [change])
        }
      />
    </div>
  );
}
function GitChangesList(props: ChangesProps) {
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
      className="git-changes-list"
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
            Math.min(
              changes.length - 1,
              selected + (e.key === "ArrowDown" ? 1 : -1),
            ),
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
          void openGitDiff(
            repository,
            changes[selected],
            kind === "staged",
            true,
          ).catch(report);
        }
      }}
    >
      <div style={{ position: "relative", height: changes.length * 26 }}>
        {changes.slice(range.first, range.end).map((change, offset) => {
          const index = range.first + offset;
          const status =
            kind === "conflicts"
              ? "!"
              : (kind === "staged" ? change.indexStatus : change.worktreeStatus)
                  ?.slice(0, 1)
                  .toUpperCase();
          return (
            <div
              key={change.path}
              id={`git-${kind}-row-${index}`}
              className={`git-file-row${selected === index ? " selected" : ""}`}
              role="option"
              aria-selected={selected === index}
              aria-label={change.path}
              title={
                change.oldPath
                  ? `${change.oldPath} → ${change.path}`
                  : change.path
              }
              data-git-path={change.path}
              style={{ top: index * 26 }}
              onClick={() => {
                setSelected(index);
                host.current?.focus();
                void openGitDiff(repository, change, kind === "staged").catch(
                  report,
                );
              }}
              onDoubleClick={() =>
                void openGitDiff(
                  repository,
                  change,
                  kind === "staged",
                  true,
                ).catch(report)
              }
            >
              <FileIcon language={languageFor(change.path)} />
              <span
                className={`git-file-name${status === "D" ? " deleted" : ""}`}
              >
                {basename(change.path)}
              </span>
              <span className="git-file-directory">
                {change.path.includes("/")
                  ? change.path.slice(0, change.path.lastIndexOf("/"))
                  : ""}
              </span>
              <FileActions {...props} change={change} />
              <span className={`git-status git-status-${status}`}>
                {status}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GitChangesTree(props: ChangesProps & { onActionsChange: (kind: ChangeGroup, visible: boolean) => void }) {
  const { changes, repository, kind, run, busy, onActionsChange } = props;
  const [selected, setSelected] = useState<string>("");
  const changeIndex = useMemo(
    () => new Map(changes.map((c) => [c.path, c])),
    [changes],
  );
  const latestIndex = useRef(changeIndex);
  latestIndex.current = changeIndex;
  const { model } = useFileTree({
    paths: changes.map((c) => c.path),
    initialExpansion: "open",
    flattenEmptyDirectories: false,
    itemHeight: 26,
    overscan: 8,
    search: false,
    icons: { set: "complete", colored: true },
    onSelectionChange: (paths) => setSelected(paths[0] ?? ""),
    renderRowDecoration: ({ row }) => {
      const change = latestIndex.current.get(row.path);
      return change?.conflicted
        ? { text: "!", title: "Unmerged changes" }
        : null;
    },
    unsafeCSS: sidebarScrollbarCSS,
  });
  useEffect(() => {
    model.resetPaths(changes.map((c) => c.path));
    model.setGitStatus(
      changes.map((c) => ({
        path: c.path,
        status:
          (kind === "staged" ? c.indexStatus : c.worktreeStatus) ?? "modified",
      })) as GitStatusEntry[],
    );
  }, [model, changes, kind]);
  const selectedFiles = useMemo(
    () => filesUnder(changes, selected),
    [changes, selected],
  );
  const hasActions = selectedFiles.length > 0;
  useLayoutEffect(() => {
    onActionsChange(kind, hasActions);
    return () => onActionsChange(kind, false);
  }, [kind, hasActions, onActionsChange]);
  function open(event: Event, pinned = false) {
    const row = event
      .composedPath()
      .find(
        (target) =>
          target instanceof HTMLElement &&
          target.hasAttribute("data-item-path"),
      ) as HTMLElement | undefined;
    const path = row?.dataset.itemPath ?? model.getFocusedPath();
    const change = changes.find((c) => c.path === path);
    if (change) {
      void openGitDiff(repository, change, kind === "staged", pinned).catch(
        report,
      );
    }
  }
  return (
    <div className="git-tree-group">
      <FileTree
        model={model}
        className="git-file-tree"
        aria-label={`${kind} tree`}
        style={
          {
            ...themeToTreeStyles({
              colors: {
                "sideBar.background": "#181818",
                "sideBar.foreground": "#cccccc",
                "list.activeSelectionBackground": "#04395e",
                "list.hoverBackground": "#2a2d2e",
                focusBorder: "#0078d4",
                "gitDecoration.modifiedResourceForeground": "#e2c08d",
                "gitDecoration.untrackedResourceForeground": "#73c991",
                "gitDecoration.addedResourceForeground": "#73c991",
                "gitDecoration.deletedResourceForeground": "#f48771",
                "gitDecoration.renamedResourceForeground": "#73c991",
              },
            }),
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
        <div className="git-tree-selection-actions">
          <span className="truncate" title={selected}>
            {selected}
          </span>
          <div className="actions">
            {selectedFiles.length === 1 && !selected.endsWith("/") && (
              <IconButton
                icon="go-to-file"
                label={`Open Source ${selected}`}
                onClick={() =>
                  void openGitSource(repository, selected).catch(report)
                }
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
              onClick={() =>
                void run(kind === "staged" ? "unstage" : "stage", selectedFiles)
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}
