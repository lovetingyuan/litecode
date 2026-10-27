import { cp, mkdir, readFile, writeFile, copyFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function packagePortable(options = {}) {
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const binary = await readFile("src-tauri/target/release/litecode.exe");
if (options.writeReport === false) {
  const pe = binary.length >= 64 ? binary.readUInt32LE(0x3c) : -1;
  if (pe < 0 || pe + 6 > binary.length || binary.toString("ascii", 0, 2) !== "MZ" || binary.readUInt32LE(pe) !== 0x4550 || binary.readUInt16LE(pe + 4) !== 0x8664) {
    throw new Error("Release executable is not Windows x64 PE");
  }
}
const build = sha(binary).slice(0, 12);
const name = `LiteCode-${pkg.version}-${build}-win-x64`;
const output = path.resolve(options.directory ?? "artifacts");
const directory = path.join(output, name);
await mkdir(path.join(directory, "data"), { recursive: true });
await writeFile(
  path.join(directory, "data", ".portable"),
  "An adjacent data directory enables portable mode. Keep this directory when upgrading.\n",
);
await writeFile(path.join(directory, "LiteCode.exe"), binary);
await cp("src-tauri/tools", path.join(directory, "tools"), { recursive: true });
await cp("docs", path.join(directory, "docs"), {
  recursive: true,
  filter: (source) =>
    !source.endsWith("PERFORMANCE.md") && !source.endsWith("release-manifest.json"),
});
await copyFile("README.md", path.join(directory, "README.md"));
await copyFile("docs/verification/LIMITATIONS.md", path.join(directory, "LIMITATIONS.md"));
const zip = path.join(output, `${name}-portable.zip`);
try {
  await stat(zip);
  throw new Error(`Archive already exists: ${zip}`);
} catch (error) {
  if (error.code !== "ENOENT") {
    throw error;
  }
}
execFileSync(
  "tar.exe",
  [
    "-a", "-c", "-f", zip,
    "-C", path.dirname(directory), path.basename(directory),
  ],
  { windowsHide: true },
);
const installerName = `LiteCode_${pkg.version}_x64-setup.exe`;
const installer = path.join(output, installerName);
await copyFile(path.join("src-tauri/target/release/bundle/nsis", installerName), installer);
if (options.writeReport === false) {
  await copyFile(path.join("src-tauri/target/release/bundle/nsis", `${installerName}.sig`), `${installer}.sig`);
}
const artifacts = [];
for (const file of [zip, installer]) {
  const bytes = await readFile(file);
  artifacts.push({ name: path.basename(file), bytes: bytes.length, sha256: sha(bytes) });
}
const report = {
  version: pkg.version,
  build,
  generatedAt: new Date().toISOString(),
  platform: "Windows x64",
  executableSha256: sha(binary),
  packageLockSha256: sha(await readFile("package-lock.json")),
  cargoLockSha256: sha(await readFile("src-tauri/Cargo.lock")),
  artifacts,
};
if (options.writeReport !== false) {
  await writeFile(path.join(output, "manifest.json"), JSON.stringify(report, null, 2));
  await writeFile("docs/verification/release-manifest.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--output");
  if (index !== -1 && !process.argv[index + 1]) throw new Error("--output requires a directory");
  await packagePortable({ directory: index === -1 ? undefined : process.argv[index + 1], writeReport: !process.argv.includes("--no-report") });
}
