import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, copyFile, writeFile, readFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { chromium } from "playwright";
import { verifyGitBranches } from "./verify-git-branches.mjs";
import { verifyGitDiff } from "./verify-git-diff.mjs";
import { verifyGitBlame } from "./verify-git-blame.mjs";

// Real native UI and Git. --repo creates an isolated worktree; its main checkout is read-only.
const source = process.argv.includes("--repo")
  ? path.resolve(process.argv[process.argv.indexOf("--repo") + 1])
  : null;
const branchesOnly = process.argv.includes("--branches-only");
assert.ok(!branchesOnly || !source, "Branch checks require an independent temporary repository");
const run = path.resolve(".verification", `git-${Date.now()}`);
const app = path.join(run, "app"),
  data = path.join(app, "data"),
  root = path.join(run, "worktree");
const branch = `codex/git-acceptance-${Date.now()}`;
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "LiteCode Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "LiteCode Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_COUNT: "3",
  GIT_CONFIG_KEY_0: "commit.gpgsign",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "core.hooksPath",
  GIT_CONFIG_VALUE_1: path.join(run, "hooks"),
  GIT_CONFIG_KEY_2: "core.fsmonitor",
  GIT_CONFIG_VALUE_2: "false",
};
await mkdir(data, { recursive: true });
await mkdir(path.join(run, "hooks"));
function git(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 300_000,
    env: gitEnv,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout.trim();
}
const before = source
  ? {
      main: git(source, "rev-parse", "main"),
      status: git(source, "status", "--porcelain=v1"),
      branch: git(source, "symbolic-ref", "HEAD"),
    }
  : null;
if (source) {
  git(source, "worktree", "add", "-b", branch, root, "main");
} else {
  await mkdir(root);
  git(root, "init", "-b", branch);
}
const file = "litecode-git-acceptance.txt",
  nested = "litecode-git-test/new 文件.txt";
await writeFile(path.join(root, file), "base\n");
git(root, "add", "--", file);
git(root, "commit", "-m", "test: isolated Git UI fixture");
await writeFile(path.join(root, file), "staged\n");
git(root, "add", "--", file);
await writeFile(path.join(root, file), "working\n");
await mkdir(path.dirname(path.join(root, nested)), { recursive: true });
await writeFile(path.join(root, nested), "untracked\n");
if (branchesOnly) {
  git(root, "add", "--all");
  git(root, "commit", "-m", "test: second branch fixture commit");
}
await copyFile(
  "src-tauri/target/debug/litecode.exe",
  path.join(app, "LiteCode.exe"),
);
await writeFile(
  path.join(data, "session-main.json"),
  JSON.stringify({
    root,
    documents: [],
    session: { sidebar: "git", sidebarWidth: 350 },
  }),
);
await writeFile(
  path.join(data, "settings.json"),
  JSON.stringify({ "files.autoSave": "off", "editor.fontSize": 14 }),
);
await writeFile(
  path.join(data, "recent.json"),
  JSON.stringify(source ? [root, source] : [root]),
);
// The UI still exercises its trust flow; only this isolated portable profile is trusted.
await writeFile(
  path.join(data, "trusted-workspaces.json"),
  JSON.stringify(
    [root, ...(source ? [source] : [])].map((directory) =>
      path.toNamespacedPath(directory),
    ),
  ),
);
const server = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const child = spawn(path.join(app, "LiteCode.exe"), [], {
  cwd: app,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...gitEnv,
    WEBVIEW2_USER_DATA_FOLDER: path.join(run, "webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --no-proxy-server`,
  },
});
let log = "",
  browser,
  page,
  passed = false;
child.stdout.on("data", (data) => {
  log += data;
});
child.stderr.on("data", (data) => {
  log += data;
});
const errors = [],
  checks = [];
async function waitPage(predicate, argument, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate, argument)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Native UI condition timed out: ${String(predicate).slice(0, 180)}`,
  );
}
async function verify() {
  const endpoint = `http://127.0.0.1:${port}`,
    deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`App exited: ${child.exitCode}: ${log}`);
    }
    if (
      await fetch(`${endpoint}/json/version`)
        .then((r) => r.ok)
        .catch(() => false)
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  browser = await chromium.connectOverCDP(endpoint);
  page = browser.contexts()[0].pages()[0];
  await page.setViewportSize({ width: 1280, height: 820 });
  await browser
    .contexts()[0]
    .addInitScript(() => performance.setResourceTimingBufferSize(10000));
  page.setDefaultTimeout(25_000);
  page.on("pageerror", (error) => {
    errors.push(error.stack ?? String(error));
    console.error(
      "Native page error after",
      checks.length,
      "checks:",
      error.stack ?? String(error),
    );
  });
  await page.waitForURL("http://localhost:1420/**", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.evaluate(() => performance.setResourceTimingBufferSize(10000));
  await waitPage(
    () => !!document.querySelector('.git-view .git-sync-actions'),
  );
  await page
    .getByRole("button", { name: "Source Control (Ctrl+Shift+G)", exact: true })
    .click();
  if (
    !(await page.getByRole("region", { name: "Source Control", exact: true }).isVisible())
  ) {
    await page
      .getByRole("button", {
        name: "Source Control (Ctrl+Shift+G)",
        exact: true,
      })
      .click();
  }
  const invoke = (command, args = {}) =>
    page.evaluate(
      ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
      { command, args },
    );
  async function snapshot() {
    return invoke("workspace_git_status", {
      expectedRoot: root,
      session: null,
      force: true,
    });
  }
  const initial = await snapshot();
  const repository = initial.repositories.find(
    (r) => r.path.toLowerCase() === root.replace(/\\/g, "/").toLowerCase(),
  );
  assert.ok(repository, JSON.stringify(initial));
  if (process.argv.includes("--blame-only")) {
    checks.push(await verifyGitBlame({ page, root, git, run, waitPage, invoke, repository }));
    return;
  }
  if (!branchesOnly) {
    assert.ok(
      repository.changes.some(
        (c) => c.path === file && c.indexStatus && c.worktreeStatus,
      ),
    );
  }
  const section = (title) =>
    page.getByRole("region", { name: title, exact: true });
  if (branchesOnly) {
    await page.getByRole("tab", { name: "Repository", exact: true }).click();
    await waitPage(() => !document.querySelector('[aria-label="Create Branch"]')?.disabled);
    const resources = await page.evaluate(() => ({
      store: performance.getEntriesByType("resource").find((r) => new URL(r.name).pathname === "/src/store/store.ts")?.name,
    }));
    checks.push(await verifyGitBranches({ page, root, branch, git, run, waitPage, resources, repository, invoke }));
    return;
  }
  await section("Staged Changes")
    .getByRole("option", { name: file, exact: true })
    .click();
  await page.locator(".git-diff-host .monaco-diff-editor").waitFor();
  const staged = await invoke("git_read_diff", {
    expectedRoot: root,
    session: initial.session,
    repository: repository.path,
    path: file,
    staged: true,
    oldPath: null,
    conflicted: false,
  });
  assert.equal(staged.before.replace(/\r/g, ""), "base\n");
  assert.equal(staged.after.replace(/\r/g, ""), "staged\n");
  await section("Changes")
    .getByRole("option", { name: file, exact: true })
    .click();
  await page.locator(".git-diff-host .monaco-diff-editor").waitFor();
  await page
    .getByRole("button", { name: "Use Inline Diff", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Use Side by Side Diff", exact: true })
    .click();
  const resources = await page.evaluate(() =>
    Object.fromEntries(
      performance.getEntriesByType("resource").flatMap((entry) => {
        const match = new URL(entry.name).pathname.match(
          /^\/src\/(?:editor|store|git|core)\/(documents|store|git|commands)\.ts$/,
        );
        return match ? [[match[1], entry.name]] : [];
      }),
    ),
  );
  const action = (module, method, ...args) =>
    page.evaluate(
      async ({ url, method, args }) => {
        try {
          return await (await import(url))[method](...args);
        } catch (error) {
          throw new Error(
            error instanceof Error
              ? (error.stack ?? error.message)
              : JSON.stringify(error),
          );
        }
      },
      { url: resources[module], method, args },
    );
  const inspect = () =>
    page.evaluate(async (url) => {
      const s = (await import(url)).useApp.getState();
      const g = s.groups.find((g) => g.id === s.activeGroup);
      return { docs: s.docs, groups: s.groups, active: g.active };
    }, resources.store);
  await verifyGitDiff({ page, resources, action, inspect, section, file, waitPage, checks, run });
  if (process.argv.includes("--diff-only")) {
    return;
  }
  const toolbar = page.locator(".git-sync-actions");
  const commitTrigger = toolbar.getByRole("button", { name: "Commit", exact: true, includeHidden: true });
  const commitDialog = page.getByRole("dialog", { name: "Commit Changes", exact: true });
  const commitMessage = commitDialog.getByRole("textbox", { name: "Commit Message", exact: true });
  const confirmCommit = commitDialog.getByRole("button", { name: "Commit", exact: true });
  assert.deepEqual(await toolbar.getByRole("button").allTextContents(), [
    "Fetch", "Pull", "Pull (Rebase)", "Push", "Commit",
  ]);
  assert.equal(await commitTrigger.isEnabled(), true);
  assert.equal(await commitTrigger.evaluate((button) => getComputedStyle(button).backgroundColor), "rgb(0, 127, 212)");
  assert.equal(await page.getByRole("textbox", { name: "Commit Message" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Open Remote", exact: true }).count(), 0);
  await page.getByRole("tab", { name: "Repository", exact: true }).click();
  const remoteRows = page.locator(".git-remote-address");
  const longRemote = `https://github.com/litecode-test/${"long-repository-name-".repeat(12)}repo.git`;
  if (!source) {
    await page.getByText("No remotes configured.", { exact: true }).waitFor();
    assert.equal(await remoteRows.count(), 0);
    git(root, "remote", "add", "origin", "git@github.com:litecode-test/browser-check.git");
    git(root, "remote", "add", "upstream", "https://github.com/litecode-test/fetch-check.git");
    git(root, "remote", "set-url", "--push", "upstream", "ssh://git@github.com/litecode-test/push-check.git");
    git(root, "remote", "add", "local", root);
    git(root, "remote", "add", "long", longRemote);
    await page.getByRole("button", { name: "Refresh Source Control", exact: true }).click();
    await page.getByRole("button", { name: "Open long fetch URL", exact: true }).waitFor();
    assert.equal(await remoteRows.count(), 5);
    assert.equal(await page.getByRole("button", { name: "Open origin push URL", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Open local fetch URL", exact: true }).isEnabled(), false);
  }
  // Capture only the browser launch; all Git operations continue through real IPC.
  await page.evaluate(() => {
    const original = window.fetch;
    window.__gitBrowserCheck = { original, urls: [] };
    window.fetch = (input, options) => {
      const url = new URL(typeof input === "string" ? input : input.url, location.href);
      if (url.hostname === "ipc.localhost" && decodeURIComponent(url.pathname) === "/plugin:opener|open_url") {
        window.__gitBrowserCheck.urls.push(JSON.parse(options.body).url);
        return Promise.resolve(new Response("null", {
          headers: { "Content-Type": "application/json", "Tauri-Response": "ok" },
        }));
      }
      return original(input, options);
    };
  });
  const openRemote = source
    ? remoteRows.getByRole("button").filter({ visible: true }).and(page.locator(":enabled")).first()
    : page.getByRole("button", { name: "Open origin fetch URL", exact: true });
  await openRemote.click();
  await waitPage(() => window.__gitBrowserCheck.urls.length === 1);
  await action("store", "setApp", { gitBusy: { [repository.path]: "fetch" } });
  assert.equal(await commitTrigger.isEnabled(), false);
  await openRemote.click();
  await waitPage(() => window.__gitBrowserCheck.urls.length === 2);
  await action("store", "setApp", { gitBusy: {} });
  if (!source) {
    await page.getByRole("button", { name: "Open upstream fetch URL", exact: true }).click();
    await waitPage(() => window.__gitBrowserCheck.urls.length === 3);
    await page.getByRole("button", { name: "Open upstream push URL", exact: true }).click();
    await waitPage(() => window.__gitBrowserCheck.urls.length === 4);
    const longButton = page.getByRole("button", { name: "Open long fetch URL", exact: true });
    await longButton.focus();
    await page.keyboard.press("Enter");
    await waitPage(() => window.__gitBrowserCheck.urls.length === 5);
    const sidebarSeparator = page.getByRole("separator", { name: "Primary side bar width", exact: true });
    await sidebarSeparator.focus();
    for (let step = 0; step < 11; step++) {
      await page.keyboard.press("ArrowLeft");
    }
    await waitPage(() => document.querySelector(".git-view").getBoundingClientRect().width <= 241);
    const layout = await remoteRows.evaluateAll((rows) => rows.map((row) => {
      const code = row.querySelector("code");
      const name = row.querySelector("strong").getBoundingClientRect();
      const address = code.getBoundingClientRect();
      const button = row.querySelector("button").getBoundingClientRect();
      const bounds = row.getBoundingClientRect();
      return {
        truncated: code.scrollWidth > code.clientWidth,
        fullAddress: code.title === code.textContent,
        singleLine: bounds.height <= button.height + 1,
        fits: button.right <= bounds.right + 1 && address.right <= button.left && name.right <= address.left,
      };
    }));
    assert.ok(layout.every((row) => row.fits), "Address buttons must stay visible to the right without overlap");
    assert.ok(layout.every((row) => row.singleLine && row.fullAddress), "Remote names, addresses and buttons must share one line with full address tooltips");
    assert.ok(layout.some((row) => row.truncated), "Long remote addresses must truncate");
    await page.screenshot({ path: path.join(run, "00-remotes-narrow.png") });
    await sidebarSeparator.focus();
    for (let step = 0; step < 11; step++) {
      await page.keyboard.press("ArrowRight");
    }
    await waitPage(() => document.querySelector(".git-view").getBoundingClientRect().width >= 349);
    await page.screenshot({ path: path.join(run, "00-remotes.png") });
  }
  const opened = await page.evaluate(() => {
    const check = window.__gitBrowserCheck;
    window.fetch = check.original;
    delete window.__gitBrowserCheck;
    return check.urls;
  });
  assert.equal(opened.length, source ? 2 : 5);
  assert.equal(opened[0], opened[1]);
  assert.match(opened[0], /^https?:\/\//);
  if (!source) {
    assert.equal(opened[0], "https://github.com/litecode-test/browser-check");
    assert.deepEqual(opened.slice(2), [
      "https://github.com/litecode-test/fetch-check",
      "https://github.com/litecode-test/push-check",
      longRemote.slice(0, -4),
    ]);
    for (const name of ["upstream", "local", "long"]) {
      git(root, "remote", "remove", name);
    }
  }
  checks.push("Toolbar order, per-address browser opener IPC, distinct fetch/push targets, unsupported URLs, keyboard and narrow-sidebar layout");
  if (process.argv.includes("--remotes-only")) {
    return;
  }
  await page.getByRole("tab", { name: "Changes", exact: true }).click();
  let state = await inspect();
  let comparison = state.docs[state.active];
  await waitPage(async (url) => {
    const s = (await import(url)).useApp.getState();
    const d = s.docs[s.groups.find((g) => g.id === s.activeGroup).active];
    return !!d?.gitDiff?.sourceId;
  }, resources.store);
  state = await inspect();
  comparison = state.docs[state.active];
  assert.ok(comparison.gitDiff.sourceId);
  await page.evaluate(
    async ({ url, id }) => {
      const module = await import(url);
      const model = module.models.get(id);
      model.pushEditOperations(
        [],
        [
          {
            range: model.getFullModelRange(),
            text: "edited through shared model\n",
          },
        ],
        () => null,
      );
    },
    { url: resources.documents, id: comparison.gitDiff.sourceId },
  );
  await page.evaluate(
    async (url) => (await import(url)).editor()?.focus(),
    resources.documents,
  );
  await page.keyboard.press("Control+s");
  await waitPage(async (url) => {
    const s = (await import(url)).useApp.getState();
    return !Object.values(s.docs).some((d) => d.dirty);
  }, resources.store);
  assert.match(
    await readFile(path.join(root, file), "utf8"),
    /edited through shared model/,
  );
  checks.push(
    "Staged/worktree versions, editable shared model, Ctrl+S, side-by-side and inline diffs",
  );
  await action("documents", "checkpoint");
  await page.reload();
  await page.locator(".git-diff-host .monaco-diff-editor").waitFor();
  Object.assign(
    resources,
    await page.evaluate(() =>
      Object.fromEntries(
        performance.getEntriesByType("resource").flatMap((entry) => {
          const match = new URL(entry.name).pathname.match(
            /^\/src\/(?:editor|store|git|core)\/(documents|store|git|commands)\.ts$/,
          );
          return match ? [[match[1], entry.name]] : [];
        }),
      ),
    ),
  );
  assert.ok(
    resources.git,
    "The native page must expose its actual Git module URL",
  );
  const restored = await inspect();
  assert.equal(
    restored.docs[restored.active].gitDiff.sourceId,
    comparison.gitDiff.sourceId,
  );
  checks.push(
    "Git diff tabs and their shared source models survive session restoration",
  );
  await action("documents", "splitGroup");
  assert.equal((await inspect()).groups.length, 2);
  await page.screenshot({ path: path.join(run, "01-git-diff.png") });
  await action("documents", "closeGroup", (await inspect()).groups.at(-1).id);
  await page.getByRole("button", { name: "View as Tree", exact: true }).click();
  await section("Untracked Files").locator("file-tree-container").waitFor();
  await page.screenshot({ path: path.join(run, "02-git-tree.png") });
  await page.getByRole("button", { name: "View as List", exact: true }).click();
  await section("Untracked Files")
    .getByRole("option", { name: nested, exact: true })
    .hover();
  await page
    .getByRole("button", { name: `Stage ${nested}`, exact: true })
    .click();
  const trust = page.getByRole("button", {
    name: "Trust Workspace",
    exact: true,
  });
  if (await trust.isVisible().catch(() => false)) {
    await trust.click();
  }
  await waitPage(
    async ({ root, file }) => {
      const s = await window.__TAURI_INTERNALS__.invoke(
        "workspace_git_status",
        { expectedRoot: root, session: null, force: true },
      );
      return s.repositories.some((r) =>
        r.changes.some((c) => c.path === file && c.indexStatus),
      );
    },
    { root, file: nested },
  );
  const headBeforeCommit = git(root, "rev-parse", "HEAD");
  await commitTrigger.click();
  await waitPage(() => document.activeElement?.getAttribute("aria-label") === "Commit Message");
  assert.equal(await confirmCommit.isEnabled(), false);
  await commitMessage.fill("   ");
  await commitMessage.press("Control+Enter");
  assert.equal(git(root, "rev-parse", "HEAD"), headBeforeCommit);
  await commitMessage.fill("test: Git UI commit");
  await commitMessage.press("End");
  await commitMessage.press("Enter");
  await commitMessage.press("Enter");
  await commitMessage.pressSequentially("Only staged changes");
  const draft = "test: Git UI commit\n\nOnly staged changes";
  assert.equal(await commitMessage.inputValue(), draft);
  await commitDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await waitPage(() => document.activeElement?.textContent === "Commit");
  await commitTrigger.click();
  assert.equal(await commitMessage.inputValue(), draft);
  await page.keyboard.press("Escape");
  await commitDialog.waitFor({ state: "hidden" });
  await commitTrigger.click();
  assert.equal(await commitMessage.inputValue(), draft);
  await page.locator(".modal-backdrop").click({ position: { x: 2, y: 2 } });
  await commitDialog.waitFor({ state: "hidden" });
  await commitTrigger.click();
  assert.equal(await commitMessage.inputValue(), draft);
  // Inject only a status snapshot; no conflicted files or index data are written.
  await page.evaluate(async ({ url, repository }) => {
    const { setApp } = await import(url);
    setApp((state) => ({
      gitState: {
        ...state.gitState,
        repositories: state.gitState.repositories.map((entry) => entry.path !== repository ? entry : {
          ...entry,
          changes: [...entry.changes, { ...entry.changes[0], path: "conflicted.txt", conflicted: true }],
        }),
      },
    }));
  }, { url: resources.store, repository: repository.path });
  assert.equal(await confirmCommit.isEnabled(), false);
  assert.equal(await commitTrigger.isEnabled(), false);
  await commitMessage.press("Control+Enter");
  assert.equal(git(root, "rev-parse", "HEAD"), headBeforeCommit);
  await action("git", "refreshGitPanel");
  await waitPage(() => !!document.querySelector(".git-commit-dialog button.primary:not(:disabled)"));
  await page.screenshot({ path: path.join(run, "02-commit-dialog.png") });

  // A failed hook and a slow commit exercise retry, keyboard guards and dismissal.
  await page.evaluate(() => {
    const original = window.fetch;
    window.__gitCommitCheck = { original, calls: 0, failNext: true, release: null };
    window.fetch = (input, options) => {
      const url = new URL(typeof input === "string" ? input : input.url, location.href);
      const check = window.__gitCommitCheck;
      if (url.hostname === "ipc.localhost" && url.pathname === "/git_operate" &&
          JSON.parse(options.body).request.kind === "commit") {
        check.calls++;
        if (check.failNext) {
          check.failNext = false;
          return Promise.resolve(new Response(JSON.stringify("Verification: commit hook rejected"), {
            headers: { "Content-Type": "application/json", "Tauri-Response": "error" },
          }));
        }
        return new Promise((resolve, reject) => {
          check.release = () => original(input, options).then(resolve, reject);
        });
      }
      return original(input, options);
    };
  });
  await confirmCommit.click();
  await waitPage(() => !!document.querySelector(".git-commit-dialog button.primary:not(:disabled)"));
  assert.equal(await commitMessage.inputValue(), draft);
  assert.equal(git(root, "rev-parse", "HEAD"), headBeforeCommit);
  await commitMessage.press("Control+Enter");
  await waitPage(() => !!window.__gitCommitCheck.release);
  await page.keyboard.press("Escape");
  await page.locator(".modal-backdrop").click({ position: { x: 2, y: 2 } });
  assert.equal(await commitDialog.isVisible(), true);
  assert.equal(await commitDialog.getByRole("button", { name: "Cancel", exact: true }).isEnabled(), false);
  assert.equal(await commitMessage.isEnabled(), false);
  await page.keyboard.press("Control+Enter");
  assert.equal(await page.evaluate(() => window.__gitCommitCheck.calls), 2);
  await page.evaluate(() => window.__gitCommitCheck.release());
  await waitPage(
    async (url) =>
      !(await import(url)).useApp.getState().gitBusy[
        Object.values(
          (await import(url)).useApp.getState().gitState.repositories,
        )[0]?.path
      ],
    resources.store,
  );
  await commitDialog.waitFor({ state: "hidden" });
  await page.evaluate(() => {
    window.fetch = window.__gitCommitCheck.original;
    delete window.__gitCommitCheck;
  });
  assert.equal(await page.evaluate(async ({ url, repository }) =>
    (await import(url)).useApp.getState().gitMessages[repository],
    { url: resources.store, repository: repository.path }), "");
  assert.equal(await commitTrigger.isEnabled(), false);
  await toolbar.screenshot({ path: path.join(run, "02-commit-disabled.png") });
  assert.match(git(root, "log", "-1", "--format=%B"), /Git UI commit/);
  assert.equal(git(root, "show", `HEAD:${file}`), "staged");
  assert.match(git(root, "diff", "--", file), /edited through shared model/);
  checks.push(
    "List/tree, staging, commit dialog focus/drafts, empty-message guards, failure/retry, busy guards, multiline index-only commit and no-stage guard",
  );
  await section("Changes")
    .getByRole("option", { name: file, exact: true })
    .hover();
  await page
    .getByRole("button", { name: `Discard ${file}`, exact: true })
    .click();
  await page
    .getByRole("button", { name: "Discard Changes", exact: true })
    .click();
  await waitPage(() =>
    document.querySelector(".git-empty")?.textContent?.includes("No changes."),
  );
  assert.equal(await commitTrigger.isEnabled(), false);
  assert.equal(
    (await readFile(path.join(root, file), "utf8")).replace(/\r/g, ""),
    "staged\n",
  );
  await page.getByRole("tab", { name: "Repository", exact: true }).click();
  await page
    .getByRole("button", { name: "Create Branch", exact: true })
    .click();
  const newBranch = `${branch}-child`;
  await page.getByRole("dialog").locator("input").fill(newBranch);
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await waitPage(
    (branch) =>
      document
        .querySelector(".git-branch-heading")
        ?.textContent.includes(branch),
    newBranch,
  );
  await page.getByRole("button", { name: branch, exact: true }).click();
  await waitPage(
    (branch) =>
      document.querySelector(".git-branch-heading strong")?.textContent ===
      branch,
    branch,
  );
  await page
    .getByRole("button", { name: `Delete Branch ${newBranch}`, exact: true })
    .click();
  await page
    .getByRole("button", { name: "Delete Branch", exact: true })
    .click();
  await waitPage(
    (branch) =>
      !document.querySelector(`[aria-label="Delete Branch ${branch}"]`),
    newBranch,
  );
  await page.screenshot({ path: path.join(run, "03-git-repository.png") });
  checks.push(
    "Discard preserves index, create/switch/safe-delete branch and repository metadata",
  );
  if (!source) {
    checks.push(await verifyGitBranches({ page, root, branch, git, run, waitPage, resources, repository, invoke }));
  }
  await page.getByRole("tab", { name: "Changes", exact: true }).click();
  const recycleFile = "litecode-git-recycle.txt";
  await writeFile(path.join(root, recycleFile), "safe to recycle\n");
  await section("Untracked Files")
    .getByRole("option", { name: recycleFile, exact: true })
    .hover();
  await page
    .getByRole("button", { name: `Discard ${recycleFile}`, exact: true })
    .click();
  await page
    .getByRole("button", { name: "Discard Changes", exact: true })
    .click();
  await waitPage(() =>
    document.querySelector(".git-empty")?.textContent?.includes("No changes."),
  );
  assert.equal(
    await readFile(path.join(root, recycleFile))
      .then(() => true)
      .catch(() => false),
    false,
  );

  const nestedRoot = path.join(root, "litecode-nested-repository");
  await mkdir(nestedRoot);
  git(nestedRoot, "init", "-b", "nested-main");
  await writeFile(path.join(nestedRoot, "nested.txt"), "nested content\n");
  // Expanding the folder also exercises discovery of repositories created after startup.
  await action("commands", "execute", "workbench.view.explorer");
  await page
    .locator(
      'file-tree-container [data-item-path="litecode-nested-repository/"]',
    )
    .click();
  await action("commands", "execute", "workbench.view.scm");
  await waitPage(
    (nested) =>
      [...document.querySelector('[aria-label="Git Repository"]').options].some(
        (o) =>
          o.value.toLowerCase() === nested.replace(/\\/g, "/").toLowerCase(),
      ),
    nestedRoot,
  );
  const nestedValue = nestedRoot.replace(/\\/g, "/");
  await writeFile(path.join(root, "litecode-commit-draft.txt"), "draft fixture\n");
  git(root, "add", "--", "litecode-commit-draft.txt");
  git(nestedRoot, "add", "--", "nested.txt");
  await action("git", "refreshGitPanel");
  await commitTrigger.click();
  await commitMessage.fill("Parent repository draft");
  await action("store", "setApp", { gitRepository: nestedValue });
  await commitDialog.waitFor({ state: "hidden" });
  await commitTrigger.click();
  assert.equal(await commitMessage.inputValue(), "");
  await commitMessage.fill("Nested repository draft");
  await commitDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await section("Staged Changes")
    .getByRole("option", { name: "nested.txt", exact: true })
    .click();
  await page.locator(".git-diff-host .monaco-diff-editor").waitFor();
  await page
    .getByRole("combobox", { name: "Git Repository" })
    .selectOption(repository.path);
  await commitTrigger.click();
  assert.equal(await commitMessage.inputValue(), "Parent repository draft");
  await action(
    "commands",
    "openFolder",
    false,
    path.join(root, "litecode-git-test"),
  );
  await commitDialog.waitFor({ state: "hidden" });
  checks.push("Conflicts block keyboard submission; repository/workspace changes close dialogs and isolate drafts");
  await page.getByRole("tab", { name: "Changes", exact: true }).click();
  const outside = "litecode-outside-workspace.txt";
  await writeFile(path.join(root, outside), "outside the opened subfolder\n");
  await section("Untracked Files")
    .getByRole("option", { name: outside, exact: true })
    .click();
  await page.locator(".git-diff-host .monaco-diff-editor").waitFor();
  await waitPage(
    async ({ url, path }) => {
      const s = (await import(url)).useApp.getState();
      return Object.values(s.docs).some((d) =>
        d.path?.replace(/\\/g, "/").endsWith(path),
      );
    },
    { url: resources.store, path: outside },
  );
  await writeFile(
    path.join(root, outside),
    "outside updated by external tool\n",
  );
  await waitPage(
    async ({ documents, store, path }) => {
      const module = await import(documents);
      const state = (await import(store)).useApp.getState();
      const source = Object.values(state.docs).find((d) =>
        d.path?.replace(/\\/g, "/").endsWith(path),
      );
      return (
        source &&
        module.models
          .get(source.id)
          ?.getValue()
          .includes("updated by external tool")
      );
    },
    { documents: resources.documents, store: resources.store, path: outside },
  );
  checks.push(
    "Recycle untracked files, nested repositories, whole-repository subfolder scope and external changes outside the workspace",
  );

  const loadedBefore = await page.evaluate(
    async (url) => (await import(url)).models.size,
    resources.documents,
  );
  const perfDirectory = path.join(root, "litecode-perf-files");
  await mkdir(perfDirectory);
  for (let offset = 0; offset < 10_000; offset += 200) {
    await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        writeFile(
          path.join(perfDirectory, `${offset + i}.txt`),
          "performance fixture\n",
        ),
      ),
    );
  }
  await waitPage(() =>
    [...document.querySelectorAll(".git-count")].some(
      (el) => Number(el.textContent) >= 10000,
    ),
  );
  const rows = await page.locator(".git-file-row").count();
  assert.ok(rows < 100, `10,000 changes rendered ${rows} rows`);
  const loadedAfter = await page.evaluate(
    async (url) => (await import(url)).models.size,
    resources.documents,
  );
  assert.equal(
    loadedAfter,
    loadedBefore,
    "Listing files must not preload their content",
  );
  const measured = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Get-Process -Id ${child.pid} | Select-Object WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress`,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(measured.status, 0, measured.stderr);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const browserMetrics = (await cdp.send("Performance.getMetrics")).metrics;
  await cdp.detach();
  await writeFile(
    path.join(run, "performance.json"),
    JSON.stringify(
      {
        rows,
        loadedBefore,
        loadedAfter,
        nativeProcess: JSON.parse(measured.stdout),
        browserMetrics,
        note: "Native process memory excludes WebView2; browser JS heap metrics are separate observations.",
      },
      null,
      2,
    ),
  );
  await page.screenshot({ path: path.join(run, "05-large-change-list.png") });
  checks.push(
    `10,000 untracked files use ${rows} rendered rows; source content remains lazy`,
  );
  if (source) {
    await action("commands", "openFolder", false, source);
    await action("commands", "execute", "workbench.view.scm");
    await waitPage(
      (root) =>
        document
          .querySelector('[aria-label="Git Repository"]')
          ?.value.toLowerCase() === root.replace(/\\/g, "/").toLowerCase(),
      source,
    );
    await page.getByRole("tab", { name: "Repository", exact: true }).click();
    await page.screenshot({
      path: path.join(run, "04-hotsou-main-readonly.png"),
    });
    const sourceSnapshot = await invoke("workspace_git_status", {
      expectedRoot: source,
      session: null,
      force: true,
    });
    const sourceRepo = sourceSnapshot.repositories.find(
      (r) => r.path.toLowerCase() === source.replace(/\\/g, "/").toLowerCase(),
    );
    const sourceInfo = await invoke("git_repository_info", {
      expectedRoot: source,
      session: sourceSnapshot.session,
      repository: sourceRepo.path,
    });
    assert.ok(
      sourceInfo.remotes.some((r) => /github\.com/.test(r.fetch ?? "")),
    );
    const fetched = await action("git", "runGitOperation", sourceRepo.path, {
      kind: "fetch",
      remote: "origin",
    });
    assert.equal(fetched, true, "Actual GitHub Fetch must succeed");
    checks.push(
      "hotsou main opened read-only with actual GitHub remote, tracking metadata and successful Fetch",
    );
  }
}
try {
  await verify();
  assert.deepEqual(errors, []);
  passed = true;
  await writeFile(
    path.join(run, "results.json"),
    JSON.stringify({ passed, source, root, checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ passed, run, checks }, null, 2));
} catch (error) {
  await page
    ?.screenshot({ path: path.join(run, "failure.png"), timeout: 10000 })
    .catch(() => {});
  await writeFile(
    path.join(run, "failure.json"),
    JSON.stringify({ error: String(error), checks, errors, log }, null, 2),
  );
  console.error(`Evidence: ${run}`);
  console.error(log);
  console.error(
    await page
      ?.evaluate(() => document.body.innerText.slice(-3500))
      .catch(() => ""),
  );
  throw error;
} finally {
  await page
    ?.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke("plugin:window|destroy", {
        label: "main",
      }),
    )
    .catch(() => {});
  await browser?.close().catch(() => {});
  if (child.exitCode === null) {
    child.kill();
  }
  if (source) {
    const after = {
      main: git(source, "rev-parse", "main"),
      status: git(source, "status", "--porcelain=v1"),
      branch: git(source, "symbolic-ref", "HEAD"),
    };
    assert.deepEqual(
      after,
      before,
      "The user's main checkout must remain unchanged",
    );
    await writeFile(
      path.join(run, "main-preserved.json"),
      JSON.stringify({ before, after }, null, 2),
    );
    if (passed) {
      assert.ok(root.startsWith(run + path.sep));
      git(source, "worktree", "remove", "--force", root);
      git(source, "branch", "-D", branch);
    }
  }
}
