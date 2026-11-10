import { execFileSync } from "node:child_process";
import { access, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const repositoryName = "lovetingyuan/litecode";
const repository = `https://github.com/${repositoryName}`;
const versionFiles = [
  "package.json",
  "package-lock.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
];
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const normalize = (contents) => contents.replaceAll("\r\n", "\n");

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

function committedVersionFiles(cwd, ref) {
  return new Map(versionFiles.map((name) => [name, git(cwd, ["show", `${ref}:${name}`])]));
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

async function synchronizedMain(cwd) {
  await checkReleaseTree(cwd);
  const base = git(cwd, ["rev-parse", "HEAD"]).trim();
  git(cwd, ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  if (git(cwd, ["rev-parse", "refs/remotes/origin/main"]).trim() !== base) {
    throw new Error("本地 main 与 origin/main 不一致，请先同步后再发布。");
  }
  return base;
}

export async function pushRelease(cwd, input) {
  const base = await synchronizedMain(cwd);
  const committed = committedVersionFiles(cwd, base);
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
  if (!localTag) {
    const versionCommit = onSameVersion ? "none" : commit;
    git(cwd, [
      "tag",
      "-a",
      tag,
      commit,
      "-m",
      `LiteCode ${tag}\n\nRelease-Version-Commit: ${versionCommit}`,
    ]);
  }
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

function githubApi(cwd, endpoint, ...args) {
  try {
    const route = endpoint ? `${repositoryName}/${endpoint}` : repositoryName;
    return execFileSync("gh", ["api", "--hostname", "github.com", `repos/${route}`, ...args], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    }).trim();
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error("撤销发布需要 GitHub CLI，请安装 gh 并运行 gh auth login。");
    throw error;
  }
}

function removeReleaseDraft(cwd, tag) {
  if (githubApi(cwd, "", "--jq", ".permissions.push") !== "true") {
    throw new Error("请通过 gh 登录有仓库写权限的 GitHub 账户。");
  }
  const runs = githubApi(
    cwd,
    `actions/workflows/release.yml/runs?branch=${tag}&event=push`,
    "--paginate",
    "--jq",
    '.workflow_runs[] | select(.status != "completed") | .html_url',
  );
  if (runs) throw new Error(`请先取消发布构建或等待其结束。\n${runs}`);
  const releases = githubApi(
    cwd,
    "releases?per_page=100",
    "--paginate",
    "--jq",
    `.[] | select(.tag_name == ${JSON.stringify(tag)}) | {id, draft} | @json`,
  );
  if (!releases) return;
  const matches = releases.split(/\r?\n/).map((line) => JSON.parse(line));
  if (matches.length !== 1 || !matches[0].draft) {
    throw new Error(`${tag} 已公开发布或存在多个 Release，请在 GitHub 上检查。`);
  }
  const endpoint = `releases/${matches[0].id}`;
  const release = JSON.parse(githubApi(cwd, endpoint));
  if (!release.draft || release.tag_name !== tag)
    throw new Error("Release 状态已变化，请重新检查。");
  githubApi(cwd, endpoint, "--method", "DELETE");
}

function rollbackCommit(cwd, base, target, version, versionCommit) {
  const tag = `v${version}`;
  if (versionCommit === "none") return base;
  const subject = git(cwd, ["show", "-s", "--format=%s", target]).trim();
  if (!versionCommit && subject !== `chore(release): ${tag}`) return base;
  const [parent, secondParent] = git(cwd, ["show", "-s", "--format=%P", target]).trim().split(" ");
  if (
    (versionCommit && versionCommit !== target) ||
    !parent ||
    secondParent ||
    subject !== `chore(release): ${tag}`
  ) {
    throw new Error(`无法识别 ${tag} 的版本提交。`);
  }
  const before = committedVersionFiles(cwd, parent);
  const previous = readVersions(before);
  const released = committedVersionFiles(cwd, target);
  const changed = git(cwd, ["diff", "--name-only", parent, target]).trim().split("\n");
  if (
    normalizeVersion(version, previous) !== readVersions(released) ||
    changed.some((name) => !versionFiles.includes(name)) ||
    [...before].some(
      ([name, contents]) =>
        normalize(released.get(name)) !== normalize(versionContents(name, contents, version)),
    )
  ) {
    throw new Error(`${tag} 的版本提交包含意外改动。`);
  }
  if (readVersions(committedVersionFiles(cwd, base)) !== version) {
    throw new Error(`main 的版本已变化，无法自动撤销 ${tag} 的版本提交。`);
  }
  // Build the reverse commit without changing the checkout before the atomic push.
  const tree = git(cwd, [
    "merge-tree",
    "--write-tree",
    "--no-messages",
    `--merge-base=${target}`,
    base,
    parent,
  ]).trim();
  const restored = git(cwd, ["diff", "--name-only", base, tree]).trim().split("\n");
  if (
    readVersions(committedVersionFiles(cwd, tree)) !== previous ||
    restored.some((name) => !versionFiles.includes(name))
  ) {
    throw new Error(`无法安全恢复 ${tag} 发布前的版本。`);
  }
  return git(cwd, ["commit-tree", tree, "-p", base, "-m", `revert(release): ${tag}`]).trim();
}

export async function revertRelease(cwd, input) {
  const version = input.trim().replace(/^v/, "");
  if (!stableVersion.test(version)) throw new Error("请输入正式版本号 X.Y.Z。");
  const base = await synchronizedMain(cwd);
  const tag = `v${version}`;
  const ref = `refs/tags/${tag}`;
  const local = git(cwd, ["for-each-ref", "--format=%(refname) %(objectname)", ref])
    .split("\n")
    .find((line) => line.startsWith(`${ref} `))
    ?.trim()
    .split(" ")[1];
  const remote = git(cwd, ["ls-remote", "--refs", "origin", ref]).trim().split("\t")[0];
  if (!remote && !local) return tag;
  if (local && remote && local !== remote) throw new Error(`本地和远端的 ${tag} 标签不一致。`);
  if (!local) git(cwd, ["fetch", "--no-tags", "origin", ref]);
  const object = remote || local;
  const annotation = git(cwd, ["cat-file", "tag", object]);
  if (annotation.split(/\r?\n\r?\n/, 2)[1]?.split(/\r?\n/, 1)[0] !== `LiteCode ${tag}`) {
    throw new Error(`${tag} 的注释与发布脚本不匹配。`);
  }
  const target = git(cwd, ["rev-parse", `${object}^{commit}`]).trim();
  git(cwd, ["merge-base", "--is-ancestor", target, base]);
  if (readVersions(committedVersionFiles(cwd, target)) !== version)
    throw new Error(`${tag} 与应用版本不一致。`);
  const versionCommit = annotation.match(/^Release-Version-Commit: (\S+)$/m)?.[1];
  const commit = rollbackCommit(cwd, base, target, version, versionCommit);
  removeReleaseDraft(cwd, tag);
  if (remote || commit !== base) {
    git(cwd, [
      "push",
      "--atomic",
      "--no-follow-tags",
      `--force-with-lease=refs/heads/main:${base}`,
      ...(remote ? [`--force-with-lease=${ref}:${remote}`] : []),
      "origin",
      `${commit}:refs/heads/main`,
      ...(remote ? [`:${ref}`] : []),
    ]);
  }
  if (local) git(cwd, ["update-ref", "-d", ref, local]);
  if (commit !== base) git(cwd, ["merge", "--ff-only", commit]);
  return tag;
}

async function main(args) {
  if (args.length === 2 && args[0] === "--check-tag") {
    const current = await currentVersion(root);
    if (args[1] !== `v${current}`)
      throw new Error(`Release tag must match the application version v${current}.`);
    return;
  }
  const revertFlag = args.length === 2 && args[1] === "--revert";
  if (args.length !== 1 && !revertFlag)
    throw new Error("Usage: npm run release -- X.Y.Z [--revert]");
  // Some npm.ps1 versions forward this option as npm config instead of an argument.
  const revert = revertFlag || process.env.npm_config_revert === "true";
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
    if (revert) {
      const tag = await revertRelease(root, args[0]);
      console.log(`${tag} 的发布已撤销。`);
      return;
    }
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
