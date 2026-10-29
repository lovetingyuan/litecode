import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertBuiltTree,
  buildAndPushRelease,
  checkGit,
  currentVersion,
  ensureTagAbsent,
  git,
  normalizeVersion,
  parseNotes,
  pushRelease,
  releaseUrl,
  updateVersions,
} from "./release.mjs";

const temporary = [];
afterEach(async () => {
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "litecode-release-"));
  temporary.push(directory);
  const remote = path.join(directory, "remote.git"),
    cwd = path.join(directory, "local");
  await mkdir(cwd);
  git(directory, ["init", "--bare", remote]);
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "release-test@example.invalid"]);
  git(cwd, ["config", "user.name", "Release Test"]);
  await writeFile(path.join(cwd, "source.txt"), "original\n");
  git(cwd, ["add", "source.txt"]);
  git(cwd, ["commit", "-m", "Initial"]);
  git(cwd, ["remote", "add", "origin", remote]);
  git(cwd, ["push", "-u", "origin", "main"]);
  const base = await checkGit(cwd);
  return { cwd, remote, base };
}
async function commitVersion(cwd) {
  await writeFile(path.join(cwd, "version.txt"), "0.2.0\n");
  git(cwd, ["add", "version.txt"]);
  git(cwd, ["commit", "-m", "chore(release): v0.2.0"]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

describe("release inputs", () => {
  it("accepts only increasing stable versions", () => {
    expect(normalizeVersion(" v0.10.0 ", "0.9.9")).toBe("0.10.0");
    for (const input of ["0.9.9", "0.1.0", "0.10.0-beta.1", "01.2.3", "x.y.z", "1.0.0; echo bad"]) {
      expect(() => normalizeVersion(input, "0.9.9")).toThrow();
    }
  });
  it("splits only consecutive ASCII spaces and preserves punctuation", () => {
    expect(parseNotes("  修复打开文件   支持 Markdown & `code`  improve single spaces  ")).toBe(
      "- 修复打开文件\n- 支持 Markdown & `code`\n- improve single spaces\n",
    );
    expect(() => parseNotes("   ")).toThrow();
    expect(() => parseNotes("one\ntwo")).toThrow();
  });
  it("round-trips Chinese, newlines and shell characters in the Release URL", () => {
    const notes = parseNotes('修复 #123 & %  新增 `code` $() "quote"');
    const url = new URL(releaseUrl("0.2.0", notes));
    expect(url.searchParams.get("body")).toBe(notes);
    expect(url.searchParams.get("tag")).toBe("v0.2.0");
    expect(url.searchParams.get("title")).toBe("LiteCode v0.2.0");
  });
  it("updates only application versions in both locks", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "litecode-versions-"));
    temporary.push(directory);
    await mkdir(path.join(directory, "src-tauri"));
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ version: "0.1.0" }));
    await writeFile(
      path.join(directory, "package-lock.json"),
      JSON.stringify({
        version: "0.1.0",
        packages: { "": { version: "0.1.0" }, "node_modules/example": { version: "9.9.9" } },
      }),
    );
    await writeFile(
      path.join(directory, "src-tauri/tauri.conf.json"),
      JSON.stringify({ version: "0.1.0" }),
    );
    await writeFile(
      path.join(directory, "src-tauri/Cargo.toml"),
      '[package]\nname = "litecode"\nversion = "0.1.0"\n',
    );
    await writeFile(
      path.join(directory, "src-tauri/Cargo.lock"),
      'version = 4\n\n[[package]]\nname = "example"\nversion = "9.9.9"\n\n[[package]]\nname = "litecode"\nversion = "0.1.0"\n',
    );
    await updateVersions(directory, "0.2.0");
    expect(await currentVersion(directory)).toBe("0.2.0");
    const lock = JSON.parse(await readFile(path.join(directory, "package-lock.json"), "utf8"));
    expect(lock.packages[""].version).toBe("0.2.0");
    expect(lock.packages["node_modules/example"].version).toBe("9.9.9");
    expect(await readFile(path.join(directory, "src-tauri/Cargo.lock"), "utf8")).toContain(
      'name = "example"\nversion = "9.9.9"',
    );
    await writeFile(
      path.join(directory, "src-tauri/tauri.conf.json"),
      JSON.stringify({ version: "0.1.0" }),
    );
    await expect(currentVersion(directory)).rejects.toThrow("版本不一致");
  });
});

describe("release Git transactions", { timeout: 30000 }, () => {
  it("rejects dirty trees, other branches and unsynchronized main", async () => {
    const { cwd } = await fixture();
    await writeFile(path.join(cwd, "untracked.txt"), "unexpected");
    await expect(checkGit(cwd)).rejects.toThrow("不干净");
    await rm(path.join(cwd, "untracked.txt"));
    git(cwd, ["checkout", "-b", "feature"]);
    await expect(checkGit(cwd)).rejects.toThrow("main");
    git(cwd, ["checkout", "main"]);
    await commitVersion(cwd);
    await expect(checkGit(cwd)).rejects.toThrow("同步");
  });
  it("pushes precisely main and the annotated release tag to the built commit", async () => {
    const { cwd, remote, base } = await fixture();
    const commit = await commitVersion(cwd);
    git(cwd, ["tag", "unrelated"]);
    await buildAndPushRelease(cwd, "0.2.0", base, async (built) => {
      expect(built).toBe(commit);
    });
    expect(git(remote, ["rev-parse", "refs/heads/main"])).toBe(commit);
    expect(git(remote, ["rev-parse", "refs/tags/v0.2.0^{}"]).trim()).toBe(commit);
    expect(git(remote, ["cat-file", "-t", "refs/tags/v0.2.0"])).toBe("tag");
    expect(git(remote, ["tag", "--list", "unrelated"])).toBe("");
    expect(() => ensureTagAbsent(cwd, "0.2.0")).toThrow("已存在");
    git(cwd, ["tag", "-d", "v0.2.0"]);
    expect(() => ensureTagAbsent(cwd, "0.2.0")).toThrow("已存在");
  });
  it("does not tag or push when build fails or changes tracked files", async () => {
    const { cwd, remote, base } = await fixture();
    const commit = await commitVersion(cwd);
    await expect(
      buildAndPushRelease(cwd, "0.2.0", base, async () => {
        throw new Error("Build failed");
      }),
    ).rejects.toThrow("Build failed");
    expect(git(cwd, ["tag", "--list"])).toBe("");
    await expect(
      buildAndPushRelease(cwd, "0.2.0", base, async () => {
        await writeFile(path.join(cwd, "source.txt"), "generated mutation");
      }),
    ).rejects.toThrow("发生变化");
    expect(git(remote, ["rev-parse", "main"])).toBe(base);
    expect(git(cwd, ["rev-parse", "HEAD"])).toBe(commit);
    expect(() => assertBuiltTree(cwd, commit)).toThrow();
  });
  it("rejects remote races before creating a tag", async () => {
    const { cwd, remote, base } = await fixture();
    const commit = await commitVersion(cwd);
    git(remote, ["update-ref", "refs/heads/main", base, base]);
    expect(() => pushRelease(cwd, "0.2.0", commit, "0".repeat(40))).toThrow("远端 main");
    expect(git(cwd, ["tag", "--list"])).toBe("");
  });
  it("keeps local commits and tags when the remote rejects an atomic push", async () => {
    const { cwd, remote, base } = await fixture();
    const commit = await commitVersion(cwd);
    await writeFile(path.join(remote, "hooks/pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(() => pushRelease(cwd, "0.2.0", commit, base)).toThrow("git push --atomic");
    expect(git(remote, ["rev-parse", "main"])).toBe(base);
    expect(git(remote, ["tag", "--list"])).toBe("");
    expect(git(cwd, ["rev-parse", "v0.2.0^{}"]).trim()).toBe(commit);
  });
});
