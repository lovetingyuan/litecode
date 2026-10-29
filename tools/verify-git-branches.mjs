import assert from "node:assert/strict";
import path from "node:path";
import { mkdir } from "node:fs/promises";

export async function verifyGitBranches({
  page,
  root,
  branch,
  git,
  run,
  waitPage,
  resources,
  repository,
  invoke,
}) {
  const button = (name) => page.getByRole("button", { name, exact: true });
  const refresh = async () => {
    await button("Refresh Source Control").click();
    await waitPage(
      () => !document.querySelector('[aria-label="Refresh Source Control"]')?.disabled,
    );
    await button("Create Branch").waitFor();
    await waitPage(() => !document.querySelector('[aria-label="Create Branch"]')?.disabled);
  };
  const current = async (name) => {
    await waitPage(
      (name) => document.querySelector(".git-branch-heading strong")?.textContent === name,
      name,
    );
    await waitPage(() => !document.querySelector('[aria-label="Create Branch"]')?.disabled);
    assert.equal(git(root, "branch", "--show-current"), name);
  };
  const switchTo = async (name, expected = name) => {
    await button(name).click();
    await current(expected);
  };
  const submitName = async (name) => {
    await page.getByRole("dialog").locator("input").fill(name);
    await button("OK").click();
    await current(name);
  };
  const difference = async (text) =>
    waitPage(
      (text) =>
        document.querySelector(".git-branch-heading > span:last-child")?.textContent === text,
      text,
    );
  const sync = async (label, text) => {
    await button(label).click();
    await waitPage(
      (label) =>
        document.querySelector(`[aria-label="${label}"]`)?.getAttribute("aria-busy") !== "true",
      label,
      310000,
    );
    await difference(text);
  };
  const readInfo = async () =>
    invoke("git_repository_info", {
      expectedRoot: root,
      session: (
        await invoke("workspace_git_status", {
          expectedRoot: root,
          session: null,
          force: true,
        })
      ).session,
      repository: repository.path,
    });

  assert.deepEqual(await page.locator(".git-info-field > span:first-child").allTextContents(), []);
  await difference("");
  const base = "feature/older-base-with-a-long-name-that-must-leave-room-for-all-branch-actions";
  git(root, "branch", base, "HEAD~1");
  await refresh();
  await button(`Create Branch from ${base}`).press("Enter");
  assert.match(await page.getByRole("dialog").innerText(), new RegExp(base));
  await submitName("local-child");
  assert.equal(git(root, "rev-parse", "HEAD"), git(root, "rev-parse", base));
  assert.equal(await button("local-child").isEnabled(), false);
  assert.equal(await button("Delete Branch local-child").isEnabled(), false);
  await switchTo(branch);
  await button("Delete Branch local-child").click();
  await button("Cancel").click();
  assert.equal(git(root, "rev-parse", "local-child"), git(root, "rev-parse", base));
  await button("Delete Branch local-child").click();
  await button("Delete Branch").click();
  await button("Delete Branch local-child").waitFor({ state: "hidden" });
  console.log("Branch checks: local source, keyboard and safe deletion passed");

  const bare = path.join(run, "branch-remote.git");
  await mkdir(bare);
  git(bare, "init", "--bare");
  git(
    root,
    "remote",
    git(root, "remote").split(/\r?\n/).includes("origin") ? "set-url" : "add",
    "origin",
    bare.replaceAll("\\", "/"),
  );
  git(root, "push", "--set-upstream", "origin", branch);
  git(root, "push", "origin", `${base}:refs/heads/feature/demo`, "HEAD:refs/heads/collision");
  await refresh();
  await difference("(↓0 behind · ↑0 ahead)");
  await button("Create Branch from origin/feature/demo").click();
  await submitName("remote-child");
  assert.equal(git(root, "rev-parse", "HEAD"), git(root, "rev-parse", base));
  assert.equal((await readInfo()).upstream, "origin/feature/demo");
  await switchTo(branch);
  await switchTo("origin/feature/demo", "remote-child");
  await switchTo(branch);
  await button("Delete Branch remote-child").click();
  await button("Delete Branch").click();
  await button("Delete Branch remote-child").waitFor({ state: "hidden" });
  await switchTo("origin/feature/demo", "feature/demo");
  assert.equal((await readInfo()).upstream, "origin/feature/demo");
  await switchTo(branch);
  await switchTo("origin/feature/demo", "feature/demo");
  await switchTo(branch);

  git(root, "branch", "collision");
  await refresh();
  await button("origin/collision").click();
  await page.getByRole("dialog").waitFor();
  await button("Cancel").click();
  assert.equal(git(root, "branch", "--show-current"), branch);
  await button("origin/collision").click();
  await submitName("collision-tracking");
  assert.equal((await readInfo()).upstream, "origin/collision");
  await switchTo(branch);

  git(root, "branch", "--track", "second-tracking", "origin/feature/demo");
  await refresh();
  await button("origin/feature/demo").click();
  await page.getByRole("combobox", { name: "Select Local Tracking Branch" }).waitFor();
  await page.keyboard.press("Escape");
  await button("origin/feature/demo").click();
  await page.getByRole("option").filter({ hasText: "second-tracking" }).click();
  await current("second-tracking");
  await switchTo(branch);

  await button("Copy Branch Name origin/feature/demo").click();
  await waitPage(() => document.body.innerText.includes("Copied branch name: origin/feature/demo"));
  assert.equal(await invoke("plugin:clipboard-manager|read_text"), "origin/feature/demo");
  console.log("Branch checks: remote tracking, collision, picker and clipboard passed");

  const occupied = path.join(run, "occupied-worktree");
  git(root, "worktree", "add", occupied, "second-tracking");
  await refresh();
  assert.equal(await button("second-tracking").isEnabled(), false);
  assert.equal(await button("Delete Branch second-tracking").isEnabled(), false);
  assert.equal(await button("Create Branch from second-tracking").isEnabled(), true);

  // Exercise guards in the actual renderer without starting a network operation.
  for (const guard of ["busy", "operation"]) {
    await page.evaluate(
      async ({ url, repository, guard }) => {
        const { setApp } = await import(url);
        setApp((s) =>
          guard === "busy"
            ? { gitBusy: { ...s.gitBusy, [repository]: "fetch" } }
            : {
                gitState: {
                  ...s.gitState,
                  repositories: s.gitState.repositories.map((r) =>
                    r.path === repository ? { ...r, operation: "merge" } : r,
                  ),
                },
              },
        );
      },
      { url: resources.store, repository: repository.path, guard },
    );
    if (guard === "busy") {
      assert.equal(await button(`Create Branch from ${branch}`).isEnabled(), false);
      assert.equal(await button("collision").isEnabled(), false);
      assert.equal(await button("Delete Branch collision").isEnabled(), false);
      assert.equal(await button(`Copy Branch Name ${branch}`).isEnabled(), true);
    } else {
      await waitPage(
        () => document.querySelector('[aria-label="Create Branch"]')?.disabled === true,
      );
      assert.equal(await button("Create Branch").isEnabled(), false);
    }
    await page.evaluate(
      async ({ url, repository }) => {
        const { setApp } = await import(url);
        setApp((s) => ({
          gitBusy: {},
          gitState: {
            ...s.gitState,
            repositories: s.gitState.repositories.map((r) =>
              r.path === repository ? { ...r, operation: null } : r,
            ),
          },
        }));
      },
      { url: resources.store, repository: repository.path },
    );
    await refresh();
  }

  const layout = await button(base).evaluate((el) => {
    const row = el.closest(".git-branch-row");
    const name = el.querySelector("span:nth-child(2)");
    return {
      truncated: name.scrollWidth > name.clientWidth,
      title: el.title,
      actionsFit: [...row.querySelectorAll(".git-branch-actions button")].every(
        (button) => button.getBoundingClientRect().right <= row.getBoundingClientRect().right + 1,
      ),
    };
  });
  assert.equal(layout.title, base);
  assert.equal(layout.truncated, true);
  assert.equal(layout.actionsFit, true);
  await page.screenshot({ path: path.join(run, "03-branch-actions.png") });
  git(root, "worktree", "remove", occupied);
  console.log("Branch checks: worktree, busy guards and layout passed");

  git(root, "commit", "--allow-empty", "-m", "local ahead fixture");
  await refresh();
  await difference("(↓0 behind · ↑1 ahead)");
  const peer = path.join(run, "branch-peer");
  git(run, "clone", "--branch", branch, bare.replaceAll("\\", "/"), peer);
  git(peer, "commit", "--allow-empty", "-m", "remote ahead fixture");
  git(peer, "push", "origin", branch);
  await sync("Fetch", "(↓1 behind · ↑1 ahead)");
  git(root, "branch", "--track", "behind-only", `origin/${branch}`);
  git(peer, "commit", "--allow-empty", "-m", "remote second fixture");
  git(peer, "push", "origin", branch);
  await sync("Fetch", "(↓2 behind · ↑1 ahead)");
  await switchTo("behind-only");
  await difference("(↓1 behind · ↑0 ahead)");
  await sync("Pull", "(↓0 behind · ↑0 ahead)");
  await switchTo("collision");
  await difference("");
  git(root, "switch", "--detach");
  await refresh();
  await difference("");
  await switchTo(branch);

  // Return the fixture to a clean, remote-free baseline for the remaining checks.
  git(root, "remote", "remove", "origin");
  await refresh();
  return "Branch row actions, source OIDs, remote reuse/creation/collision/picker, clipboard, safe deletion, worktree/busy guards, keyboard/overflow and real ahead/behind states";
}
