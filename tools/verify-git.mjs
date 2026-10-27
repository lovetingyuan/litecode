import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, copyFile, writeFile, readFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { chromium } from "playwright";

// Real native UI and Git. --repo creates an isolated worktree; its main checkout is read-only.
const source = process.argv.includes("--repo")
  ? path.resolve(process.argv[process.argv.indexOf("--repo") + 1])
  : null;
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
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "commit.gpgsign",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "core.hooksPath",
  GIT_CONFIG_VALUE_1: path.join(run, "hooks"),
};
await mkdir(data, { recursive: true });
await mkdir(path.join(run, "hooks"));
function git(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: gitEnv,
  });
  assert.equal(result.status, 0, result.stderr);
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
async function waitPage(predicate, argument) {
  const deadline = Date.now() + 25000;
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
try {
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
    () => !!document.querySelector('[aria-label="Git Repository"]'),
  );
  await page
    .getByRole("button", { name: "Source Control (Ctrl+Shift+G)", exact: true })
    .click();
  if (
    !(await page.getByRole("textbox", { name: "Commit Message" }).isVisible())
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
  assert.ok(
    repository.changes.some(
      (c) => c.path === file && c.indexStatus && c.worktreeStatus,
    ),
  );
  const section = (title) =>
    page.getByRole("region", { name: title, exact: true });
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
  assert.equal(
    await page.getByRole("button", { name: "Commit", exact: true }).isEnabled(),
    false,
  );
  await page
    .getByRole("textbox", { name: "Commit Message", exact: true })
    .fill("test: Git UI commit\n\nOnly staged changes");
  await page.getByRole("button", { name: "Commit", exact: true }).click();
  await waitPage(
    async (url) =>
      !(await import(url)).useApp.getState().gitBusy[
        Object.values(
          (await import(url)).useApp.getState().gitState.repositories,
        )[0]?.path
      ],
    resources.store,
  );
  await waitPage(
    () => document.querySelector('[aria-label="Commit Message"]').value === "",
  );
  assert.match(git(root, "log", "-1", "--format=%B"), /Git UI commit/);
  assert.equal(git(root, "show", `HEAD:${file}`), "staged");
  assert.match(git(root, "diff", "--", file), /edited through shared model/);
  checks.push(
    "List/tree, file staging, required message, multiline commit and index-only commit",
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
  await page
    .getByRole("combobox", { name: "Git Repository" })
    .selectOption(nestedValue);
  await section("Untracked Files")
    .getByRole("option", { name: "nested.txt", exact: true })
    .click();
  await page.locator(".git-diff-host .monaco-diff-editor").waitFor();
  await page
    .getByRole("combobox", { name: "Git Repository" })
    .selectOption(repository.path);
  await action(
    "commands",
    "openFolder",
    false,
    path.join(root, "litecode-git-test"),
  );
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
