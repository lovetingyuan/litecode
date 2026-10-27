import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, open, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { signingKeyPath } from "./setup-updater.mjs";
import { packagePortable } from "./package-portable.mjs";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const versionFiles = ["package.json", "package-lock.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock"];
export const repository = "https://github.com/lovetingyuan/litecode";

export function normalizeVersion(input, current) {
  const version = input.trim().replace(/^v/, "");
  const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if (!pattern.test(version) || !pattern.test(current)) throw new Error("请输入正式版本号 X.Y.Z（不含预发布后缀）。");
  const a = version.split(".").map(BigInt), b = current.split(".").map(BigInt);
  const differing = a.findIndex((part, i) => part !== b[i]);
  if (differing < 0 || a[differing] < b[differing]) throw new Error(`新版本必须高于 ${current}。`);
  return version;
}

export function parseNotes(line) {
  const items = line.split(/ {2,}/).map((item) => item.trim()).filter(Boolean);
  if (!items.length || /[\r\n\0]/.test(line)) throw new Error("请用一行输入更新日志，连续两个空格分隔更新点。");
  return `${items.map((item) => `- ${item}`).join("\n")}\n`;
}

export function releaseUrl(version, notes) {
  const url = new URL(`${repository}/releases/new`);
  url.search = new URLSearchParams({ tag: `v${version}`, title: `LiteCode v${version}`, body: notes }).toString();
  return url.href;
}

export function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export async function checkGit(cwd) {
  if (git(cwd, ["branch", "--show-current"]) !== "main") throw new Error("只能从 main 分支发布。");
  if (git(cwd, ["status", "--porcelain", "--untracked-files=all"])) throw new Error("工作区不干净：请先提交或移走所有改动和未跟踪文件。");
  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
    const location = path.resolve(cwd, git(cwd, ["rev-parse", "--git-path", marker]));
    if (await access(location).then(() => true, () => false)) throw new Error(`Git 操作尚未完成：${marker}`);
  }
  git(cwd, ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  const head = git(cwd, ["rev-parse", "HEAD"]);
  if (head !== git(cwd, ["rev-parse", "origin/main"])) throw new Error("main 必须与 origin/main 完全同步，请先自行处理未推送或远端新增的提交。");
  return head;
}

export function ensureTagAbsent(cwd, version) {
  const tag = `refs/tags/v${version}`;
  if (git(cwd, ["tag", "--list", `v${version}`]) || git(cwd, ["ls-remote", "--tags", "origin", tag, `${tag}^{}`])) {
    throw new Error(`Tag v${version} 已存在。`);
  }
}

export async function updateVersions(cwd, version) {
  for (const name of versionFiles.slice(0, 3)) {
    const filename = path.join(cwd, name);
    const object = JSON.parse(await readFile(filename, "utf8"));
    object.version = version;
    if (name === "package-lock.json") object.packages[""].version = version;
    await writeFile(filename, `${JSON.stringify(object, null, 2)}\n`);
  }
  for (const [name, expression] of [
    ["src-tauri/Cargo.toml", /(\[package\][\s\S]*?\nversion\s*=\s*")[^"]+("\s*(?:\r?\n|$))/],
    ["src-tauri/Cargo.lock", /(\[\[package\]\]\r?\nname = "litecode"\r?\nversion = ")[^"]+(")/],
  ]) {
    const filename = path.join(cwd, name);
    const before = await readFile(filename, "utf8");
    if (!expression.test(before)) throw new Error(`无法定位 ${name} 的应用版本。`);
    await writeFile(filename, before.replace(expression, (_, prefix, suffix) => `${prefix}${version}${suffix}`));
  }
}

export async function currentVersion(cwd) {
  const pkg = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(path.join(cwd, "package-lock.json"), "utf8"));
  const config = JSON.parse(await readFile(path.join(cwd, "src-tauri/tauri.conf.json"), "utf8"));
  const cargo = (await readFile(path.join(cwd, "src-tauri/Cargo.toml"), "utf8")).match(/\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/);
  const cargoLock = (await readFile(path.join(cwd, "src-tauri/Cargo.lock"), "utf8")).match(/\[\[package\]\]\r?\nname = "litecode"\r?\nversion = "([^"]+)"/);
  if (![lock.version, lock.packages?.[""]?.version, config.version, cargo?.[1], cargoLock?.[1]].every((version) => version === pkg.version)) {
    throw new Error("应用版本不一致，请先同步 package.json、npm lock、Tauri 配置及 Cargo manifest/lock。");
  }
  return pkg.version;
}

export function assertBuiltTree(cwd, commit) {
  if (git(cwd, ["rev-parse", "HEAD"]) !== commit || git(cwd, ["status", "--porcelain", "--untracked-files=all"])) {
    throw new Error("构建期间 HEAD 或工作区发生变化。请检查生成文件并提交后重新发布，不会推送本次版本。");
  }
}

export function pushRelease(cwd, version, commit, base) {
  assertBuiltTree(cwd, commit);
  if (git(cwd, ["ls-remote", "origin", "refs/heads/main"]).split(/\s/)[0] !== base) throw new Error("构建期间远端 main 发生变化，停止发布。");
  ensureTagAbsent(cwd, version);
  git(cwd, ["tag", "-a", `v${version}`, commit, "-m", `LiteCode v${version}`]);
  try {
    git(cwd, ["push", "--atomic", "origin", "refs/heads/main:refs/heads/main", `refs/tags/v${version}:refs/tags/v${version}`]);
  } catch {
    // A lost connection can report failure after the server accepted both refs.
    let remote;
    try { remote = git(cwd, ["ls-remote", "origin", "refs/heads/main", `refs/tags/v${version}^{}`]); } catch { /* Report recovery below. */ }
    const refs = new Map((remote ?? "").split("\n").map((line) => line.split(/\s+/).reverse()));
    if (refs.get("refs/heads/main") !== commit || refs.get(`refs/tags/v${version}^{}`) !== commit) {
      throw new Error(`推送未确认成功；已保留提交、tag 和产物。检查远端后重试：\ngit push --atomic origin refs/heads/main:refs/heads/main refs/tags/v${version}:refs/tags/v${version}`);
    }
  }
}

export async function buildAndPushRelease(cwd, version, base, build) {
  const commit = git(cwd, ["rev-parse", "HEAD"]);
  assertBuiltTree(cwd, commit);
  await build(commit);
  assertBuiltTree(cwd, commit);
  pushRelease(cwd, version, commit, base);
}

function run(command, args, env = process.env) {
  console.log(`\n> ${command === process.execPath ? "node" : command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd: root, env, stdio: "inherit", windowsHide: true });
}
const npm = (args, env) => run(process.execPath, [process.env.npm_execpath ?? path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), ...args], env);
const tauri = path.join(root, "node_modules/@tauri-apps/cli/tauri.js");

export async function signingEnvironment() {
  const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "" };
  if (!env.TAURI_SIGNING_PRIVATE_KEY) {
    env.TAURI_SIGNING_PRIVATE_KEY = await readFile(signingKeyPath, "utf8").catch(() => { throw new Error("缺少更新私钥，请先执行 npm run updater:setup，并提交公钥配置。"); });
  } else {
    env.TAURI_SIGNING_PRIVATE_KEY = await readFile(env.TAURI_SIGNING_PRIVATE_KEY, "utf8").catch(() => env.TAURI_SIGNING_PRIVATE_KEY);
  }
  const config = JSON.parse(await readFile(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
  if (!config.plugins?.updater?.pubkey) throw new Error("缺少更新公钥，请先执行 npm run updater:setup 并提交配置。");
  return env;
}

function verifySignature(installer, version) {
  run("cargo", ["run", "--locked", "--quiet", "--manifest-path", "src-tauri/Cargo.toml", "--example", "verify-update", "--", installer, `${installer}.sig`, "src-tauri/tauri.conf.json", version]);
}

export async function archiveRelease(directory, version, notes, commit) {
  const name = `LiteCode_${version}_x64-setup.exe`;
  const result = await packagePortable({ directory, writeReport: false });
  const installer = path.join(directory, name);
  verifySignature(installer, version);
  const manifest = {
    version, notes, pub_date: new Date().toISOString(),
    platforms: { "windows-x86_64": { url: `${repository}/releases/download/v${version}/${name}`, signature: (await readFile(`${installer}.sig`, "utf8")).trim() } },
  };
  await writeFile(path.join(directory, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(directory, "RELEASE_NOTES.md"), notes);
  const files = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  const hashes = [];
  for (const filename of files) {
    const bytes = await readFile(path.join(directory, filename));
    if (!bytes.length) throw new Error(`产物为空：${filename}`);
    hashes.push({ name: filename, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const report = { ...result, commit, artifacts: hashes };
  await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(report, null, 2)}\n`);
  const reportHash = createHash("sha256").update(await readFile(path.join(directory, "manifest.json"))).digest("hex");
  await writeFile(path.join(directory, "SHA256SUMS.txt"), [...hashes.map((item) => `${item.sha256}  ${item.name}`), `${reportHash}  manifest.json`].join("\n") + "\n");
}

export function openTarget(target) {
  // Values travel through the environment, never through shell source text.
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $env:LITECODE_RELEASE_TARGET -WindowStyle Hidden"], {
    env: { ...process.env, LITECODE_RELEASE_TARGET: target }, stdio: "pipe", windowsHide: true,
  });
  if (result.error || result.status !== 0) console.warn(`无法自动打开，请手动打开：${target}`);
}

export async function main() {
  process.chdir(root);
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("当前 release 脚本仅支持 Windows x64。");
  if (process.env.CARGO_TARGET_DIR || process.env.CARGO_BUILD_TARGET) throw new Error("Release 使用标准 Windows x64 输出目录，请先移除本终端的 CARGO_TARGET_DIR 和 CARGO_BUILD_TARGET 覆盖。");
  await mkdir(path.join(root, "artifacts"), { recursive: true });
  const lockPath = path.join(root, "artifacts/.release.lock");
  const lock = await open(lockPath, "wx").catch(() => { throw new Error("已有 release 正在执行；若上次进程异常退出，请确认没有发布进程后删除 artifacts/.release.lock。"); });
  let terminal;
  let directory;
  let version;
  try {
    await lock.writeFile(String(process.pid));
    const base = await checkGit(root);
    git(root, ["var", "GIT_AUTHOR_IDENT"]);
    git(root, ["var", "GIT_COMMITTER_IDENT"]);
    if (!git(root, ["remote", "get-url", "--push", "origin"]).match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)lovetingyuan\/litecode(?:\.git)?$/)) throw new Error("origin 推送目标必须是 lovetingyuan/litecode。");
    run("git", ["--version"]);
    run("rustc", ["--version"]);
    run("cargo", ["--version"]);
    run("tar.exe", ["--version"]);
    npm(["--version"]);
    await access(tauri);
    await access(path.join(root, "node_modules/.package-lock.json"));
    const env = await signingEnvironment();
    const current = await currentVersion(root);
    terminal = createInterface({ input: process.stdin, output: process.stdout });
    const input = new AbortController();
    terminal.on("SIGINT", () => { input.abort(); terminal.close(); });
    terminal.on("close", () => input.abort());
    const suggested = current.replace(/\d+$/, (patch) => String(BigInt(patch) + 1n));
    for (;;) {
      try {
        version = normalizeVersion((await terminal.question(`当前版本 ${current}，新版本 [${suggested}]：`, { signal: input.signal })) || suggested, current);
        ensureTagAbsent(root, version);
        if (await access(path.join(root, "artifacts/releases", `v${version}`)).then(() => true, () => false)) throw new Error(`产物目录 v${version} 已存在，不会覆盖，请选择新版本。`);
        break;
      } catch (error) { if (input.signal.aborted) throw new Error("已取消发布。"); console.error(error.message); }
    }
    let notes;
    for (;;) {
      try { notes = parseNotes(await terminal.question("更新日志（连续两个空格分隔更新点）：", { signal: input.signal })); break; }
      catch (error) { if (input.signal.aborted) throw new Error("已取消发布。"); console.error(error.message); }
    }
    terminal.close();
    console.log(`\n发布 v${version}\n${notes}`);
    directory = path.join(root, "artifacts/releases", `v${version}`);
    await mkdir(path.dirname(directory), { recursive: true });
    await mkdir(directory);
    await writeFile(path.join(directory, "RELEASE_NOTES.md"), notes);
    await writeFile(path.join(directory, "release-url.txt"), releaseUrl(version, notes));
    const probe = path.join(directory, "signing-check.txt");
    await writeFile(probe, "LiteCode updater signing key check\n");
    // Capture signer output: never print private-key material or environment contents.
    try { execFileSync(process.execPath, [tauri, "signer", "sign", "--app-version", version, probe], { cwd: root, env, stdio: "pipe", windowsHide: true }); }
    catch { throw new Error("更新私钥不可用或密码错误。未改动版本号。 "); }
    verifySignature(probe, version);
    await unlink(probe);
    await unlink(`${probe}.sig`);
    assertBuiltTree(root, base);
    await updateVersions(root, version);
    git(root, ["add", "--", ...versionFiles]);
    git(root, ["commit", "-m", `chore(release): v${version}`]);
    await buildAndPushRelease(root, version, base, async (commit) => {
      npm(["run", "lint"]);
      npm(["test"]);
      run("cargo", ["test", "--locked", "--manifest-path", "src-tauri/Cargo.toml"]);
      npm(["run", "build:release"], env);
      await archiveRelease(directory, version, notes, commit);
    });
    console.log(`\n发布准备完成：${directory}\n上传本目录中的发布附件，然后将 Release 发布为正式最新版。\n${releaseUrl(version, notes)}`);
    openTarget(directory);
    openTarget(releaseUrl(version, notes));
  } catch (error) {
    if (directory) console.error(`产物与日志保留在 ${directory}。未自动撤销本地提交或 tag。`);
    throw error;
  } finally {
    terminal?.close();
    await lock.close();
    await unlink(lockPath);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`\nRelease 停止：${error.message}`); process.exitCode = 1; });
}
