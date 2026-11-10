import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { currentVersion, normalizeVersion, pushRelease } from "./release.mjs";

const temporary = [];
afterEach(async () => {
  for (const directory of temporary.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

async function fixture() {
  await mkdir("tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve("tmp/litecode-release-"));
  temporary.push(directory);
  const cwd = path.join(directory, "local");
  const remote = path.join(directory, "origin.git");
  await mkdir(path.join(cwd, "src-tauri"), { recursive: true });
  const files = {
    "package.json": '{\n  "version": "0.1.0"\n}\n',
    "package-lock.json": `${JSON.stringify(
      {
        version: "0.1.0",
        packages: { "": { version: "0.1.0" }, "node_modules/example": { version: "9.9.9" } },
      },
      null,
      2,
    )}\n`,
    "src-tauri/tauri.conf.json": '{\n  "version": "0.1.0"\n}\n',
    "src-tauri/Cargo.toml": '[package]\nname = "litecode"\nversion = "0.1.0"\n',
    "src-tauri/Cargo.lock":
      'version = 4\n\n[[package]]\nname = "example"\nversion = "9.9.9"\n\n[[package]]\nname = "litecode"\nversion = "0.1.0"\n',
  };
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(path.join(cwd, name), contents);
  }
  git(directory, "init", "--bare", remote);
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.name", "Release Test");
  git(cwd, "config", "user.email", "release-test@example.invalid");
  git(cwd, "config", "commit.gpgsign", "false");
  git(cwd, "config", "tag.gpgsign", "false");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "Initial version");
  git(cwd, "remote", "add", "origin", remote);
  git(cwd, "push", "origin", "main");
  return { cwd, remote, files };
}

describe("release inputs", () => {
  it("accepts only increasing stable versions", () => {
    expect(normalizeVersion(" v0.10.0 ", "0.9.9")).toBe("0.10.0");
    for (const input of ["0.9.9", "0.1.0", "0.10.0-beta.1", "01.2.3", "x.y.z", "1.0.0; echo bad"]) {
      expect(() => normalizeVersion(input, "0.9.9")).toThrow();
    }
  });
});

describe("release push", { timeout: 30000 }, () => {
  it("updates a clean main and pushes the release commit and annotated tag", async () => {
    const { cwd, remote, files } = await fixture();
    git(cwd, "config", "push.followTags", "true");
    git(cwd, "tag", "-a", "unrelated", "-m", "Unrelated tag");
    expect(await pushRelease(cwd, "0.2.0")).toBe("v0.2.0");
    expect(await currentVersion(cwd)).toBe("0.2.0");
    expect(git(remote, "rev-parse", "main")).toBe(git(remote, "rev-parse", "v0.2.0^{}"));
    expect(git(remote, "cat-file", "-t", "v0.2.0")).toBe("tag");
    expect(git(remote, "tag", "--list")).toBe("v0.2.0");
    expect(
      git(cwd, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").split("\n").sort(),
    ).toEqual(Object.keys(files).sort());
    const lock = JSON.parse(await readFile(path.join(cwd, "package-lock.json"), "utf8"));
    expect(lock.packages[""].version).toBe("0.2.0");
    expect(lock.packages["node_modules/example"].version).toBe("9.9.9");
    expect(await readFile(path.join(cwd, "src-tauri/Cargo.lock"), "utf8")).toContain(
      'name = "example"\nversion = "9.9.9"',
    );
    await writeFile(
      path.join(cwd, "src-tauri/tauri.conf.json"),
      JSON.stringify({ version: "0.1.0" }),
    );
    await expect(currentVersion(cwd)).rejects.toThrow("版本不一致");
  });

  it("rejects unstaged, staged, and untracked changes before creating a tag", async () => {
    const { cwd, remote } = await fixture();
    await writeFile(path.join(cwd, "package.json"), '{\n  "version": "0.2.0"\n}\n');
    await expect(pushRelease(cwd, "0.2.0")).rejects.toThrow("工作区有未提交的改动");
    git(cwd, "add", "package.json");
    await expect(pushRelease(cwd, "0.2.0")).rejects.toThrow("工作区有未提交的改动");
    git(cwd, "restore", "--source=HEAD", "--staged", "--worktree", "package.json");
    await writeFile(path.join(cwd, "draft.txt"), "Untracked draft");
    await expect(pushRelease(cwd, "0.2.0")).rejects.toThrow("工作区有未提交的改动");
    expect(git(cwd, "tag", "--list")).toBe("");
    expect(git(cwd, "rev-parse", "main")).toBe(git(remote, "rev-parse", "main"));
  });

  it("fetches the real remote main before checking whether it matches", async () => {
    const { cwd, remote } = await fixture();
    const base = git(cwd, "rev-parse", "main");
    git(cwd, "switch", "-c", "remote-change");
    git(cwd, "commit", "--allow-empty", "-m", "Remote update");
    git(cwd, "push", remote, "HEAD:refs/heads/main");
    git(cwd, "switch", "main");
    expect(git(cwd, "rev-parse", "origin/main")).toBe(base);
    await expect(pushRelease(cwd, "0.2.0")).rejects.toThrow("本地 main 与 origin/main 不一致");
    expect(git(cwd, "rev-parse", "HEAD")).toBe(base);
    expect(git(cwd, "tag", "--list")).toBe("");
  });

  it("retries a failed atomic push with the same commit and tag after syncing main", async () => {
    const { cwd, remote } = await fixture();
    const hook = path.join(remote, "hooks/pre-receive");
    await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await expect(pushRelease(cwd, "0.2.0")).rejects.toThrow("推送失败");
    const commit = git(cwd, "rev-parse", "main");
    expect(git(remote, "tag", "--list")).toBe("");
    expect(git(remote, "rev-parse", "main")).not.toBe(commit);
    await rm(hook);
    await expect(pushRelease(cwd, "0.2.0")).rejects.toThrow("本地 main 与 origin/main 不一致");
    git(cwd, "push", "--no-follow-tags", "origin", "main");
    expect(await pushRelease(cwd, "0.2.0")).toBe("v0.2.0");
    expect(await pushRelease(cwd, "0.2.0")).toBe("v0.2.0");
    expect(git(remote, "rev-parse", "v0.2.0^{}")).toBe(commit);
  });
});
