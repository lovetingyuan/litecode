import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { themeToTreeStyles, type GitStatusEntry } from "@pierre/trees";
import { useApp, setApp, notify } from "../store/store";
import { basename, scheduleBackup } from "../editor/documents";
import { errorMessage } from "../core/bridge";
import { openFolder } from "../core/commands";
import { input } from "./dialog";
import { Icon, IconButton, FileIcon } from "./ui";
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
  const message = useApp((s) =>
    repository ? (s.gitMessages[repository.path] ?? "") : "",
  );
  const [info, setInfo] = useState<GitInfo | null>(null);
  const [infoError, setInfoError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const paths = repository?.changes;
  const grouped = useMemo(() => groupChanges(paths ?? []), [paths]);
  useEffect(() => {
    if (repositoryPath && selected !== repositoryPath) {
      setApp({ gitRepository: repositoryPath });
    }
  }, [repositoryPath, selected]);
  useEffect(() => {
    if (!active || !repositoryPath) {
      return;
    }
    let cancelled = false;
    setInfo(null);
    setInfoError("");
    void readGitInfo(repositoryPath)
      .then((result) => {
        if (!cancelled) {
          setInfo(result);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setInfoError(errorMessage(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [active, repositoryPath, git, busy]);

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
  async function commit() {
    if (!repository || !message.trim() || !grouped.staged.length || busy) {
      return;
    }
    if (await runGitOperation(repository.path, { kind: "commit", message })) {
      setApp((s) => ({
        gitMessages: { ...s.gitMessages, [repository.path]: "" },
      }));
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
    if (!repository || !info || busy) {
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
  async function createBranch(start?: string) {
    if (!repository) {
      return;
    }
    const name = await input(
      "New branch name",
      start?.replace(/^refs\/remotes\/[^/]+\//, "") ?? "",
    );
    if (name) {
      await runGitOperation(repository.path, {
        kind: "createBranch",
        name,
        ...(start ? { start } : {}),
      });
    }
  }
  return (
    <section className="view search-view git-view" aria-label="Source Control">
      <div className="view-title">
        <span>SOURCE CONTROL</span>
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
          <select
            className="git-repository-select"
            aria-label="Git Repository"
            value={repository.path}
            title={repository.path}
            onChange={(e) => {
              setInfo(null);
              setApp({ gitRepository: e.target.value });
              scheduleBackup();
            }}
          >
            {(git.repositories ?? []).map((r) => (
              <option key={r.path} value={r.path}>
                {r.name} — {r.path}
              </option>
            ))}
          </select>
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
          <div className="git-branch-heading" title={repository.path}>
            <Icon name="git-branch" />
            <strong>
              {repository.branch ?? "No commits yet"}
              {repository.detached ? " (detached)" : ""}
            </strong>
            <span>
              {info?.ahead !== null && info?.ahead !== undefined
                ? `↑${info.ahead} ↓${info.behind}`
                : ""}
            </span>
          </div>
          <div className="git-sync-actions" aria-label="Git remote actions">
            <button
              className="btn btn-xs"
              disabled={!!busy || !info}
              onClick={() => void sync("fetch").catch(report)}
            >
              Fetch
            </button>
            <button
              className="btn btn-xs"
              disabled={
                !!busy || !info || repository.detached || !!repository.operation
              }
              onClick={() => void sync("pull").catch(report)}
            >
              Pull
            </button>
            <button
              className="btn btn-xs"
              disabled={
                !!busy || !info || repository.detached || !!repository.operation
              }
              onClick={() => void sync("pullRebase").catch(report)}
            >
              Pull (Rebase)
            </button>
            <button
              className="btn btn-xs"
              disabled={
                !!busy || !info || repository.detached || !!repository.operation
              }
              onClick={() => void sync("push").catch(report)}
            >
              Push
            </button>
          </div>
          {busy && (
            <div className="git-operation-status" role="status">
              <span className="spinner" />
              Git: {busy}…
            </div>
          )}
          {infoError && (
            <p className="inline-error" role="alert">
              {infoError}
            </p>
          )}
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
              <div className="git-commit-form">
                <textarea
                  aria-label="Commit Message"
                  placeholder={`Message (Ctrl+Enter to commit${repository.branch ? ` on ${repository.branch}` : ""})`}
                  value={message}
                  disabled={!!busy}
                  rows={3}
                  onChange={(e) =>
                    setApp((s) => ({
                      gitMessages: {
                        ...s.gitMessages,
                        [repository.path]: e.target.value,
                      },
                    }))
                  }
                  onKeyDown={(e) => {
                    if (e.ctrlKey && e.key === "Enter") {
                      e.preventDefault();
                      void commit().catch(report);
                    }
                  }}
                />
                <button
                  className="btn btn-sm btn-primary"
                  disabled={
                    !!busy ||
                    !message.trim() ||
                    !grouped.staged.length ||
                    !!grouped.conflicts.length
                  }
                  onClick={() => void commit().catch(report)}
                >
                  <Icon name="check" />
                  Commit
                </button>
              </div>
              {groups.map(
                ([kind, title]) =>
                  grouped[kind].length > 0 && (
                    <GitChangeSection
                      key={`${repository.path}:${kind}:${layout}`}
                      repository={repository}
                      kind={kind}
                      title={title}
                      changes={grouped[kind]}
                      tree={layout === "tree"}
                      busy={!!busy}
                    />
                  ),
              )}
              {repository.changes.length === 0 && (
                <div className="git-empty">
                  <Icon name="check" />
                  <p>No changes.</p>
                </div>
              )}
            </div>
          ) : (
            <div
              id="git-panel-info"
              role="tabpanel"
              aria-labelledby="git-tab-info"
              className="git-panel-content git-info"
            >
              <div className="git-info-field">
                <span>Repository</span>
                <code>{repository.path}</code>
              </div>
              <div className="git-info-field">
                <span>Current branch</span>
                <code>
                  {info?.branch ?? repository.branch ?? "Unborn HEAD"}
                </code>
              </div>
              <div className="git-info-field">
                <span>Upstream</span>
                <code>{info?.upstream ?? "Not set"}</code>
              </div>
              <div className="git-info-field">
                <span>Remote difference</span>
                <span>
                  {info?.ahead === null || !info
                    ? "Unavailable without an upstream"
                    : `${info.ahead} ahead · ${info.behind} behind`}
                </span>
              </div>
              <div className="git-info-field">
                <span>Last fetch</span>
                <span>
                  {info?.lastFetch
                    ? new Date(info.lastFetch * 1000).toLocaleString()
                    : "Not fetched"}
                </span>
              </div>
              <h3>Remotes</h3>
              {info?.remotes.length === 0 && (
                <p className="muted">No remotes configured.</p>
              )}
              {info?.remotes.map((r) => (
                <div key={r.name} className="git-info-field">
                  <strong>{r.name}</strong>
                  <code title="Fetch URL">{r.fetch}</code>
                  {r.push !== r.fetch && <code title="Push URL">{r.push}</code>}
                </div>
              ))}
              <div className="git-section-heading">
                <h3>Branches</h3>
                <IconButton
                  icon="add"
                  label="Create Branch"
                  disabled={!!busy || !!repository.operation}
                  onClick={() => void createBranch().catch(report)}
                />
              </div>
              {info?.branches.map((b) => (
                <div key={`${b.remote}:${b.name}`} className="git-branch-row">
                  <button
                    title={b.upstream ?? b.name}
                    disabled={
                      !!busy ||
                      !!repository.operation ||
                      b.current ||
                      b.worktree
                    }
                    onClick={() =>
                      void (
                        b.remote
                          ? createBranch(`refs/remotes/${b.name}`)
                          : runGitOperation(repository.path, {
                              kind: "switch",
                              branch: b.name,
                            })
                      ).catch(report)
                    }
                  >
                    <Icon
                      name={
                        b.remote ? "cloud" : b.current ? "check" : "git-branch"
                      }
                    />
                    <span>{b.name}</span>
                    {b.worktree && <small>worktree</small>}
                  </button>
                  {!b.remote && (
                    <IconButton
                      icon="trash"
                      label={`Delete Branch ${b.name}`}
                      disabled={
                        !!busy ||
                        !!repository.operation ||
                        b.current ||
                        b.worktree
                      }
                      onClick={() =>
                        void runGitOperation(repository.path, {
                          kind: "deleteBranch",
                          branch: b.name,
                        }).catch(report)
                      }
                    />
                  )}
                </div>
              ))}
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

function GitChangeSection({
  repository,
  kind,
  title,
  changes,
  tree,
  busy,
}: {
  repository: GitRepository;
  kind: ChangeGroup;
  title: string;
  changes: GitChange[];
  tree: boolean;
  busy: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
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
          onClick={() => setExpanded(!expanded)}
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
      style={{ height: Math.min(312, changes.length * 26) }}
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

function GitChangesTree(props: ChangesProps) {
  const { changes, repository, kind, run, busy } = props;
  const [selected, setSelected] = useState<string>("");
  const changeIndex = useMemo(
    () => new Map(changes.map((c) => [c.path, c])),
    [changes],
  );
  const latestIndex = useRef(changeIndex);
  latestIndex.current = changeIndex;
  const treeRows = useMemo(() => {
    const directories = new Set<string>();
    for (const change of changes) {
      for (
        let index = change.path.indexOf("/");
        index >= 0;
        index = change.path.indexOf("/", index + 1)
      ) {
        directories.add(change.path.slice(0, index));
      }
    }
    return changes.length + directories.size;
  }, [changes]);
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
            height: Math.min(312, Math.max(26, treeRows * 26)),
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
