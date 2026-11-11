import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  currentVersion,
  normalizeVersion,
  pushRelease,
  readReleaseInput,
  tagNotes,
} from "./release.mjs";
import { rollbackRelease } from "./release-rollback.mjs";

const notes =
  '## Fixed\n\n- Preserve `code`, $HOME, $(echo test), "quotes" and 中文.\n# Markdown comment';
const output = () =>
  new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });

const temporary = [];
// These integration tests start many real Git processes, which are slower on Windows.
afterEach(async () => {
  for (const directory of temporary.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

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

describe("release inputs", { timeout: 60000 }, () => {
  it("accepts only increasing stable versions", () => {
    expect(normalizeVersion(" v0.10.0 ", "0.9.9")).toBe("0.10.0");
    for (const input of ["0.9.9", "0.1.0", "0.10.0-beta.1", "01.2.3", "x.y.z", "1.0.0; echo bad"]) {
      expect(() => normalizeVersion(input, "0.9.9")).toThrow();
    }
  });

  it("reads a version and multiline Markdown until a single dot", async () => {
    const { cwd } = await fixture();
    const input = Readable.from([`0.2.0\n${notes}\n.\n`]);
    expect(await readReleaseInput(cwd, input, output())).toEqual({ version: "0.2.0", notes });
  });

  it("rejects blank or unfinished notes without creating a release", async () => {
    const { cwd, remote } = await fixture();
    await expect(
      readReleaseInput(cwd, Readable.from(["0.2.0\n\n  \n.\n"]), output()),
    ).rejects.toThrow("must not be empty");
    await expect(
      readReleaseInput(cwd, Readable.from(["0.2.0\nIncomplete\n"]), output()),
    ).rejects.toThrow("cancelled");
    await expect(pushRelease(cwd, "0.2.0", " \n")).rejects.toThrow("must not be empty");
    expect(await currentVersion(cwd)).toBe("0.1.0");
    expect(git(cwd, "tag", "--list")).toBe("");
    expect(git(cwd, "rev-parse", "main")).toBe(git(remote, "rev-parse", "main"));
  });
});

describe("release push", { timeout: 90000 }, () => {
  it("updates a clean main and pushes the release commit and annotated tag", async () => {
    const { cwd, remote, files } = await fixture();
    git(cwd, "config", "push.followTags", "true");
    git(cwd, "tag", "-a", "unrelated", "-m", "Unrelated tag");
    expect(await pushRelease(cwd, "0.2.0", notes)).toBe("v0.2.0");
    expect(await currentVersion(cwd)).toBe("0.2.0");
    expect(git(remote, "rev-parse", "main")).toBe(git(remote, "rev-parse", "v0.2.0^{}"));
    expect(git(remote, "cat-file", "-t", "v0.2.0")).toBe("tag");
    expect(tagNotes(remote, "v0.2.0")).toBe(notes);
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

  it("retries a failed atomic push with the same commit and tag after syncing main", async () => {
    const { cwd, remote } = await fixture();
    const hook = path.join(remote, "hooks/pre-receive");
    await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await expect(pushRelease(cwd, "0.2.0", notes)).rejects.toThrow("推送失败");
    const commit = git(cwd, "rev-parse", "main");
    const tagObject = git(cwd, "rev-parse", "v0.2.0");
    expect(await readReleaseInput(cwd, Readable.from(["0.2.0\n"]), output())).toEqual({
      version: "0.2.0",
      notes,
    });
    expect(git(remote, "tag", "--list")).toBe("");
    expect(git(remote, "rev-parse", "main")).not.toBe(commit);
    await rm(hook);
    await expect(pushRelease(cwd, "0.2.0")).rejects.toThrow("本地 main 与 origin/main 不一致");
    git(cwd, "push", "--no-follow-tags", "origin", "main");
    expect(await pushRelease(cwd, "0.2.0")).toBe("v0.2.0");
    expect(await pushRelease(cwd, "0.2.0")).toBe("v0.2.0");
    expect(git(remote, "rev-parse", "v0.2.0^{}")).toBe(commit);
    expect(git(remote, "rev-parse", "v0.2.0")).toBe(tagObject);
    expect(tagNotes(remote, "v0.2.0")).toBe(notes);
  });
});

describe("release rollback", { timeout: 90000 }, () => {
  it("restores the chosen version and removes both tags after an atomic push succeeds", async () => {
    const { cwd, remote, files } = await fixture();
    await pushRelease(cwd, "0.1.1", notes);
    await pushRelease(cwd, "0.2.0", notes);
    const manifestPath = path.join(cwd, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, private: true }, null, 2)}\n`);
    git(cwd, "commit", "-am", "Preserve this fix");
    git(cwd, "push", "origin", "main");
    const releaseHead = git(remote, "rev-parse", "main");
    const hook = path.join(remote, "hooks/pre-receive");
    await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    await expect(rollbackRelease(cwd, "v0.2.0", "0.1.0")).rejects.toThrow("Rollback push failed");
    const rollback = git(cwd, "rev-parse", "main");
    expect(await currentVersion(cwd)).toBe("0.1.0");
    expect(git(cwd, "status", "--porcelain")).toBe("");
    expect(git(cwd, "tag", "--list", "v0.2.0")).toBe("v0.2.0");
    expect(git(remote, "tag", "--list", "v0.2.0")).toBe("v0.2.0");
    expect(git(remote, "rev-parse", "main")).toBe(releaseHead);

    await rm(hook);
    await rollbackRelease(cwd, "v0.2.0", "0.1.0");
    await rollbackRelease(cwd, "v0.2.0", "0.1.0");
    expect(git(cwd, "rev-parse", "main")).toBe(rollback);
    expect(git(remote, "rev-parse", "main")).toBe(rollback);
    expect(git(remote, "rev-parse", "main^")).toBe(releaseHead);
    expect(git(cwd, "tag", "--list")).toBe("v0.1.1");
    expect(git(remote, "tag", "--list")).toBe("v0.1.1");
    expect(git(cwd, "diff", "--name-only", "HEAD^", "HEAD").split("\n").sort()).toEqual(
      Object.keys(files).sort(),
    );
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual({
      version: "0.1.0",
      private: true,
    });
  });

  it("rolls back a version bump left by a failed release push even if the tag is already gone", async () => {
    const { cwd, remote } = await fixture();
    const hook = path.join(remote, "hooks/pre-receive");
    await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await expect(pushRelease(cwd, "0.2.0", notes)).rejects.toThrow("推送失败");
    git(cwd, "tag", "-d", "v0.2.0");
    await rm(hook);

    await rollbackRelease(cwd, "0.2.0", "v0.1.0");
    expect(await currentVersion(cwd)).toBe("0.1.0");
    expect(git(cwd, "rev-parse", "main")).toBe(git(remote, "rev-parse", "main"));
    expect(git(remote, "tag", "--list")).toBe("");
  });
});
