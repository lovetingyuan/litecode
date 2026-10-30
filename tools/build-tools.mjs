import { build } from "esbuild";
import { mkdir, copyFile, cp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
await mkdir("src-tauri/tools", { recursive: true });
await build({
  entryPoints: ["tools/web-language-server.mjs"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  mainFields: ["module", "main"],
  outfile: "src-tauri/tools/web-language-server.cjs",
  minify: false,
  legalComments: "eof",
});
for (const name of ["package.json", "package-lock.json"]) {
  await copyFile(`tools/languages/${name}`, `src-tauri/tools/languages-${name}`);
}

// Preserve sibling node_modules packages so the server can resolve its fallback
// TypeScript while preferring the workspace version. No Node.js runtime is shipped.
// https://github.com/typescript-language-server/typescript-language-server/blob/v6.0.2/src/tsServer/versionProvider.ts
// Keep Vue's dependency layout and data files intact; its plugins use runtime
// module resolution and paths relative to their own packages.
const copied = new Set();
async function copyPackage(
  name,
  from = path.resolve("package.json"),
  destination = "src-tauri/tools/typescript/node_modules",
  optional = false,
) {
  const require = createRequire(from);
  const directory = require.resolve
    .paths(name)
    .map((base) => path.join(base, name))
    .find((candidate) => {
      try {
        return require.resolve(path.join(candidate, "package.json"));
      } catch {
        return false;
      }
    });
  if (!directory) {
    if (optional) return;
    throw new Error(`Cannot package ${name} from ${from}`);
  }
  const key = path.join(destination, path.relative(path.resolve("node_modules"), directory));
  if (copied.has(key)) return;
  copied.add(key);
  const relative = path.relative(path.resolve("node_modules"), directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Language tool is outside node_modules: ${directory}`);
  }
  await cp(directory, path.join(destination, relative), {
    recursive: true,
  });
  const manifest = path.join(directory, "package.json");
  const info = JSON.parse(await readFile(manifest, "utf8"));
  for (const dependency of Object.keys(info.dependencies ?? {})) {
    await copyPackage(dependency, manifest, destination);
  }
}
for (const name of ["typescript-language-server", "typescript", "@vue/language-server"]) {
  await copyPackage(name);
}

// Keep Oxfmt's bundled Prettier modules and platform binding: the standalone
// binary cannot format HTML. Node.js is resolved by the application at runtime.
const formatters = "src-tauri/tools/formatters/node_modules";
const oxfmtManifest = path.resolve("node_modules/oxfmt/package.json");
await copyPackage("oxfmt", undefined, formatters);
const oxfmt = JSON.parse(await readFile(oxfmtManifest, "utf8"));
for (const name of Object.keys(oxfmt.optionalDependencies ?? {})) {
  await copyPackage(name, oxfmtManifest, formatters, true);
}
