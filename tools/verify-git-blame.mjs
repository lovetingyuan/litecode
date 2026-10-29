import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";

// Runs inside verify-git's isolated portable app and repository, using real IPC.
export async function verifyGitBlame({ page, root, git, run, waitPage, invoke, repository }) {
  const file = "line-blame 中文.txt";
  await writeFile(path.join(root, file), "one\ntwo\nthree\n");
  git(root, "add", "--", file);
  git(
    root,
    "commit",
    "--only",
    "--author=Alice <alice@example.invalid>",
    "-m",
    "test: first line attribution",
    "--",
    file,
  );
  const first = git(root, "rev-parse", "HEAD");
  git(root, "branch", "line-blame-base");
  await writeFile(path.join(root, file), "one\nupdated\nthree\n");
  git(root, "add", "--", file);
  git(
    root,
    "commit",
    "--only",
    "--author=Bob <bob@example.invalid>",
    "-m",
    "test: second line attribution",
    "--",
    file,
  );
  const second = git(root, "rev-parse", "HEAD"),
    current = git(root, "branch", "--show-current");
  const resources = await page.evaluate(async () => {
    // The initial resource timing buffer can fill before CDP connects. Read the
    // actual Vite imports so HMR query strings resolve to the existing modules.
    const app = await fetch("/src/components/App.tsx").then((r) => r.text());
    const gitView = await fetch("/src/components/GitView.tsx").then((r) => r.text());
    const imported = (source, path) => {
      const match = source.match(new RegExp(`from ["'](${path}[^"']*)["']`));
      return match && new URL(match[1], location.href).href;
    };
    return {
      store: imported(app, "/src/store/store.ts"),
      documents: imported(app, "/src/editor/documents.ts"),
      git: imported(gitView, "/src/git/git.ts"),
    };
  });
  assert.ok(resources.documents && resources.store && resources.git);
  const refresh = () =>
    page.evaluate(async (url) => (await import(url)).refreshGitPanel(), resources.git);
  await refresh();
  await page.evaluate(
    async ({ url, file }) => (await import(url)).openPath(file, { pinned: true }),
    { url: resources.documents, file: path.join(root, file) },
  );
  const status = page.locator(".git-line-status");
  await status.filter({ hasText: "Alice" }).waitFor();
  const context = {
    expectedRoot: root,
    session: (await invoke("workspace_git_status", { expectedRoot: root, session: null })).session,
    repository: repository.path,
    path: file,
    oldPath: null,
    encoding: "utf8",
  };
  const committed = await invoke("git_blame_file", {
    ...context,
    contents: "one\nupdated\nthree\n",
  });
  assert.equal(committed.head, second);
  assert.equal(committed.ranges[0].commit, first);
  assert.equal(committed.ranges[1].commit, second);

  async function clickLine(line) {
    const point = await page.evaluate(
      async ({ url, line }) => {
        const editor = (await import(url)).editor(),
          box = editor.getDomNode().getBoundingClientRect();
        const position = editor.getScrolledVisiblePosition({ lineNumber: line, column: 1 });
        return { x: box.x + position.left + 2, y: box.y + position.top + position.height / 2 };
      },
      { url: resources.documents, line },
    );
    await page.mouse.click(point.x, point.y);
  }
  await clickLine(2);
  await status.filter({ hasText: "Bob" }).waitFor();
  assert.match(await status.getAttribute("title"), /second line attribution/);
  assert.ok((await status.getAttribute("title")).includes(second.slice(0, 8)));
  await page.keyboard.type("unsaved ");
  await status.filter({ hasText: "尚未提交" }).waitFor();
  await clickLine(3);
  await status.filter({ hasText: "Alice" }).waitFor();
  await clickLine(2);
  for (let i = 0; i < 3; i++) {
    const text = await page.evaluate(
      async (url) => (await import(url)).editor().getValue(),
      resources.documents,
    );
    if (text === "one\nupdated\nthree\n") {
      break;
    }
    await page.keyboard.press("Control+z");
  }
  await status.filter({ hasText: "Bob" }).waitFor();
  await page.keyboard.type("saved ");
  await page.keyboard.press("Control+s");
  await waitPage(async (url) => !(await import(url)).activeDoc()?.dirty, resources.store);
  await status.filter({ hasText: "尚未提交" }).waitFor();
  git(root, "add", "--", file);
  await refresh();
  await status.filter({ hasText: "尚未提交" }).waitFor();
  git(
    root,
    "commit",
    "--only",
    "--author=Carol <carol@example.invalid>",
    "-m",
    "test: commit edited line",
    "--",
    file,
  );
  await status.filter({ hasText: "Carol" }).waitFor();
  await page.screenshot({ path: path.join(run, "line-blame-desktop.png") });
  git(root, "switch", "line-blame-base");
  await waitPage(
    async (url) => (await import(url)).editor()?.getModel()?.getLineContent(2) === "two",
    resources.documents,
  );
  await clickLine(2);
  await status.filter({ hasText: "Alice" }).waitFor();
  git(root, "switch", current);
  await waitPage(
    async (url) => (await import(url)).editor()?.getModel()?.getLineContent(2) === "saved updated",
    resources.documents,
  );
  await clickLine(2);
  await status.filter({ hasText: "Carol" }).waitFor();

  await page.keyboard.press("Control+\\");
  await page.locator(".editor-group").nth(1).waitFor();
  await clickLine(1);
  await status.filter({ hasText: "Alice" }).waitFor();
  await page.locator(".editor-group").first().locator(".editor-tab", { hasText: file }).click();
  await status.filter({ hasText: "Carol" }).waitFor();
  await page.waitForFunction(() =>
    document.querySelector(".status-right")?.textContent.includes("Ln 2, Col"),
  );
  await page.setViewportSize({ width: 800, height: 650 });
  assert.equal(
    await status.evaluate(
      (el) => el.nextElementSibling.getBoundingClientRect().right <= innerWidth,
    ),
    true,
  );
  await page.screenshot({ path: path.join(run, "line-blame-narrow.png") });
  let rejected = false;
  try {
    await invoke("git_blame_file", { ...context, path: "../escape", contents: "escape" });
  } catch {
    rejected = true;
  }
  assert.ok(rejected, "Native IPC rejects traversal");
  rejected = false;
  try {
    await invoke("git_blame_file", { ...context, session: 0, contents: "escape" });
  } catch {
    rejected = true;
  }
  assert.ok(rejected, "Native IPC rejects stale workspace sessions");
  return "Line blame: real IPC, authors, mouse/keyboard, unsaved/saved/staged changes, undo, commit/watch refresh, branch switches, split focus, narrow layout and access guards";
}
