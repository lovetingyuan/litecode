import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
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
    await writeFile(
      filename,
      before.replace(expression, (_, prefix, suffix) => `${prefix}${version}${suffix}`),
    );
  }
}

export async function currentVersion(cwd) {
  const pkg = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(path.join(cwd, "package-lock.json"), "utf8"));
  const config = JSON.parse(await readFile(path.join(cwd, "src-tauri/tauri.conf.json"), "utf8"));
  const cargo = (await readFile(path.join(cwd, "src-tauri/Cargo.toml"), "utf8")).match(
    /\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/,
  );
  const cargoLock = (await readFile(path.join(cwd, "src-tauri/Cargo.lock"), "utf8")).match(
    /\[\[package\]\]\r?\nname = "litecode"\r?\nversion = "([^"]+)"/,
  );
  if (
    ![lock.version, lock.packages?.[""]?.version, config.version, cargo?.[1], cargoLock?.[1]].every(
      (version) => version === pkg.version,
    )
  ) {
    throw new Error(
      "应用版本不一致，请先同步 package.json、npm lock、Tauri 配置及 Cargo manifest/lock。",
    );
  }
  return pkg.version;
}

async function main(args) {
  const current = await currentVersion(root);
  if (args.length === 2 && args[0] === "--check-tag") {
    if (!stableVersion.test(current) || args[1] !== `v${current}`)
      throw new Error(`Release tag must match the application version v${current}.`);
    return;
  }
  if (args.length !== 1) throw new Error("Usage: npm run release -- X.Y.Z");
  const version = normalizeVersion(args[0], current);
  await updateVersions(root, version);
  console.log(`Prepared v${version}. Review and commit the version changes, then push the tag.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
