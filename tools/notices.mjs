import { readFile, readdir, writeFile, mkdir, copyFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const sections = [
  "LiteCode third-party notices\nGenerated from the checked-in dependency locks. Development dependencies are included conservatively.\n",
];
const inventory = [];
for (const directory of Object.keys(lock.packages).filter(Boolean).sort()) {
  let pkg;
  try {
    pkg = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  } catch {
    continue;
  }
  const names = (await readdir(directory)).filter((name) =>
    /^(licen[sc]e|copying|notice)(\.|$|-)/i.test(name),
  );
  inventory.push({
    name: pkg.name,
    version: pkg.version,
    license: pkg.license ?? "SEE LICENSE",
    repository: pkg.repository,
  });
  sections.push(
    `\n===== npm: ${pkg.name}@${pkg.version} (${JSON.stringify(pkg.license ?? "SEE LICENSE")}) =====\n`,
  );
  for (const name of names) {
    try {
      sections.push(`\n--- ${name} ---\n${await readFile(path.join(directory, name), "utf8")}\n`);
    } catch {
      /* Some packages use a directory for licenses. */
    }
  }
}
const metadata = JSON.parse(
  execFileSync(
    "cargo",
    ["metadata", "--locked", "--format-version", "1", "--manifest-path", "src-tauri/Cargo.toml"],
    { maxBuffer: 30 * 1024 * 1024, encoding: "utf8", windowsHide: true },
  ),
);
for (const pkg of metadata.packages
  .filter((p) => p.source)
  .sort((a, b) => a.name.localeCompare(b.name))) {
  const directory = path.dirname(pkg.manifest_path);
  inventory.push({
    ecosystem: "cargo",
    name: pkg.name,
    version: pkg.version,
    license: pkg.license,
    repository: pkg.repository,
  });
  sections.push(
    `\n===== crate: ${pkg.name}@${pkg.version} (${pkg.license ?? "SEE LICENSE"}) =====\n`,
  );
  for (const name of (await readdir(directory)).filter((name) =>
    /^(licen[sc]e|copying|notice)(\.|$|-)/i.test(name),
  )) {
    try {
      sections.push(`\n--- ${name} ---\n${await readFile(path.join(directory, name), "utf8")}\n`);
    } catch {
      /* Directory, not a license file. */
    }
  }
}
for (const name of ["COPYING", "LICENSE-MIT", "UNLICENSE"]) {
  const source = path.join("docs/licenses/ripgrep", name);
  sections.push(`\n===== ripgrep 15.1.0: ${name} =====\n${await readFile(source, "utf8")}\n`);
}
await mkdir("docs/licenses", { recursive: true });
await writeFile("docs/licenses/THIRD_PARTY_NOTICES.txt", sections.join(""));
await writeFile("docs/licenses/dependencies.json", JSON.stringify(inventory, null, 2));
await copyFile("docs/licenses/THIRD_PARTY_NOTICES.txt", "src-tauri/tools/THIRD_PARTY_NOTICES.txt");
console.log(`Recorded ${inventory.length} dependency license declarations.`);
