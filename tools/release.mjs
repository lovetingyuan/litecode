import { execFileSync } from "node:child_process";
import { access, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const repository = "https://github.com/lovetingyuan/litecode";
const versionFiles = [
  "package.json",
  "package-lock.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
];
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function normalizeVersion(input, current) {
  const version = input.trim().replace(/^v/, "");
  if (!stableVersion.test(version) || !stableVersion.test(current))
    throw new Error("请输入正式版本号 X.Y.Z（不含预发布后缀）。");
  const a = version.split(".").map(BigInt),
    b = current.split(".").map(BigInt);
  const differing = a.findIndex((part, i) => part !== b[i]);
  if (differing < 0 || a[differing] < b[differing]) throw new Error(`新版本必须高于 ${current}。`);
  return version;
}

const cargoVersion = {
  "src-tauri/Cargo.toml": /(\[package\][\s\S]*?\nversion\s*=\s*")([^"]+)(")/,
  "src-tauri/Cargo.lock": /(\[\[package\]\]\r?\nname = "litecode"\r?\nversion = ")([^"]+)(")/,
};

function versionContents(name, contents, version) {
  if (name.endsWith(".json")) {
    const data = JSON.parse(contents);
    data.version = version;
    if (name === "package-lock.json") data.packages[""].version = version;
    return `${JSON.stringify(data, null, 2)}\n`;
  }
  const expression = cargoVersion[name];
  if (!expression.test(contents)) throw new Error(`无法定位 ${name} 的应用版本。`);
  return contents.replace(
    expression,
    (_, prefix, _version, suffix) => `${prefix}${version}${suffix}`,
  );
}

function readVersions(files) {
  const pkg = JSON.parse(files.get("package.json"));
  const lock = JSON.parse(files.get("package-lock.json"));
  const config = JSON.parse(files.get("src-tauri/tauri.conf.json"));
  const versions = [lock.version, lock.packages?.[""]?.version, config.version];
  for (const [name, expression] of Object.entries(cargoVersion)) {
    versions.push(files.get(name).match(expression)?.[2]);
  }
  if (!stableVersion.test(pkg.version) || versions.some((version) => version !== pkg.version)) {
    throw new Error(
      "应用版本不一致，请先同步 package.json、npm lock、Tauri 配置及 Cargo manifest/lock。",
    );
  }
  return pkg.version;
}

async function readVersionFiles(cwd) {
  return new Map(
    await Promise.all(
      versionFiles.map(async (name) => [name, await readFile(path.join(cwd, name), "utf8")]),
    ),
  );
}

export async function currentVersion(cwd) {
  return readVersions(await readVersionFiles(cwd));
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

async function checkReleaseTree(cwd) {
  if (git(cwd, ["branch", "--show-current"]).trim() !== "main") {
    throw new Error("请从 main 分支发布。");
  }
  for (const marker of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
  ]) {
    const location = git(cwd, ["rev-parse", "--git-path", marker]).trim();
    if (
      await access(path.resolve(cwd, location)).then(
        () => true,
        () => false,
      )
    ) {
      throw new Error(`请先完成当前 Git 操作（${marker}）。`);
    }
  }
  if (git(cwd, ["status", "--porcelain", "--untracked-files=all"]).trim()) {
    throw new Error("工作区有未提交的改动，请清理后再发布。");
  }
}

export async function pushRelease(cwd, input) {
  await checkReleaseTree(cwd);
  const base = git(cwd, ["rev-parse", "HEAD"]).trim();
  git(cwd, ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  if (git(cwd, ["rev-parse", "refs/remotes/origin/main"]).trim() !== base) {
    throw new Error("本地 main 与 origin/main 不一致，请先同步后再发布。");
  }
  const committed = new Map(
    versionFiles.map((name) => [name, git(cwd, ["show", `${base}:${name}`])]),
  );
  const current = readVersions(committed);
  const requested = input.trim().replace(/^v/, "");
  const version = requested === current ? current : normalizeVersion(input, current);
  const tag = `v${version}`;
  const ref = `refs/tags/${tag}`;
  const onSameVersion = version === current;
  const localTag = git(cwd, ["tag", "--list", tag]).trim();
  const remoteRefs = git(cwd, ["ls-remote", "--tags", "origin", ref, `${ref}^{}`]);
  const remoteTags = new Map(
    remoteRefs
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.trim().split(/\s+/).reverse()),
  );
  const remoteTarget = remoteTags.get(`${ref}^{}`) ?? remoteTags.get(ref);
  if (remoteTarget) {
    if (onSameVersion && remoteTarget === base) return tag;
    throw new Error(`远端标签 ${tag} 已存在。`);
  }
  if (localTag && (!onSameVersion || git(cwd, ["rev-parse", `${ref}^{commit}`]).trim() !== base)) {
    throw new Error(`本地标签 ${tag} 已指向其他发布。`);
  }

  const working = await readVersionFiles(cwd);
  const normalize = (contents) => contents.replaceAll("\r\n", "\n");
  const expected = new Map();
  for (const [name, before] of committed) {
    const after = onSameVersion ? before : versionContents(name, before, version);
    const actual = normalize(working.get(name));
    if (actual !== normalize(before)) {
      throw new Error(`${name} 含有其他改动，请先提交开发改动。`);
    }
    expected.set(name, after);
  }
  if (git(cwd, ["rev-parse", "HEAD"]).trim() !== base) {
    throw new Error("发布期间 HEAD 已改变，请重新执行发布命令。");
  }
  if (!onSameVersion) {
    for (const [name, contents] of expected) {
      if (normalize(working.get(name)) !== normalize(contents)) {
        await writeFile(path.join(cwd, name), contents);
      }
    }
    git(cwd, ["commit", "--only", "-m", `chore(release): ${tag}`, "--", ...versionFiles]);
  }
  const commit = onSameVersion ? base : git(cwd, ["rev-parse", "HEAD"]).trim();
  if (
    !onSameVersion &&
    (git(cwd, ["rev-parse", `${commit}^`]).trim() !== base ||
      git(cwd, ["diff", "--name-only", base, commit])
        .trim()
        .split("\n")
        .some((name) => !versionFiles.includes(name)) ||
      [...expected].some(
        ([name, contents]) =>
          normalize(git(cwd, ["show", `${commit}:${name}`])) !== normalize(contents),
      ))
  ) {
    throw new Error("发布提交含有意外改动，请检查本地提交后重试。");
  }
  if (!localTag) git(cwd, ["tag", "-a", tag, commit, "-m", `LiteCode ${tag}`]);
  try {
    git(cwd, [
      "push",
      "--atomic",
      `--force-with-lease=refs/heads/main:${base}`,
      "--no-follow-tags",
      "origin",
      `${commit}:refs/heads/main`,
      `${ref}:${ref}`,
    ]);
  } catch (error) {
    throw new Error(
      `推送失败，已保留本地发布提交和标签。解决推送问题并同步 main 后，再运行同一条 npm 命令。\n${error.message}`,
    );
  }
  return tag;
}

async function main(args) {
  if (args.length === 2 && args[0] === "--check-tag") {
    const current = await currentVersion(root);
    if (args[1] !== `v${current}`)
      throw new Error(`Release tag must match the application version v${current}.`);
    return;
  }
  if (args.length !== 1) throw new Error("Usage: npm run release -- X.Y.Z");
  const pushUrl = git(root, ["remote", "get-url", "--push", "--all", "origin"]).trim();
  if (
    !/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)lovetingyuan\/litecode(?:\.git)?$/.test(
      pushUrl,
    )
  ) {
    throw new Error("origin 推送目标必须是 lovetingyuan/litecode。");
  }
  const lockFile = path.join(root, "tmp/release.lock");
  await mkdir(path.dirname(lockFile), { recursive: true });
  const lock = await open(lockFile, "wx").catch((error) => {
    if (error.code !== "EEXIST") throw error;
    throw new Error("另一个发布命令正在运行。若进程已退出，请移除 tmp/release.lock 后重试。");
  });
  try {
    const tag = await pushRelease(root, args[0]);
    console.log(
      `${tag} 已推送。GitHub Actions 构建后会创建 Release 草稿。\n${repository}/actions/workflows/release.yml\n${repository}/releases`,
    );
  } finally {
    await lock.close();
    await unlink(lockFile);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
