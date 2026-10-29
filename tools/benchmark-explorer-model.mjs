import assert from "node:assert/strict";
import { readdirSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { FileTree, prepareFileTreeInput } from "@pierre/trees";

const root = process.env.LITECODE_BENCH_ROOT;
assert.ok(root, "Set LITECODE_BENCH_ROOT to an existing read-only project");
const rootPaths = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.name !== ".git")
  .map((entry) => entry.name + (entry.isDirectory() && !entry.isSymbolicLink() ? "/" : ""));
const paths = [];
function visit(directory, prefix) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (paths.length >= 200000) {
      return;
    }
    if (entry.name === ".git") {
      continue;
    }
    const folder = entry.isDirectory() && !entry.isSymbolicLink();
    const relative = prefix + entry.name + (folder ? "/" : "");
    paths.push(relative);
    if (folder) {
      visit(path.join(directory, entry.name), relative);
    }
  }
}
visit(root, "");
const samples = [];
for (let iteration = 0; iteration < 3; iteration++) {
  let started = performance.now();
  const cloned = structuredClone(paths);
  const cloneMs = performance.now() - started;
  started = performance.now();
  const preparedInput = prepareFileTreeInput(cloned, { flattenEmptyDirectories: false });
  const prepareMs = performance.now() - started;
  started = performance.now();
  const legacy = new FileTree({
    preparedInput,
    initialExpansion: 0,
    flattenEmptyDirectories: false,
  });
  const legacyModelMs = performance.now() - started;
  legacy.cleanUp();
  started = performance.now();
  const lazy = new FileTree({ paths: [], initialExpansion: 0, flattenEmptyDirectories: false });
  lazy.batch(rootPaths.map((path) => ({ type: "add", path })));
  const directoryModelMs = performance.now() - started;
  assert.equal(lazy.getVisibleCount(), rootPaths.length);
  lazy.cleanUp();
  const sample = { iteration, cloneMs, prepareMs, legacyModelMs, directoryModelMs };
  samples.push(sample);
  console.log(JSON.stringify(sample));
}
mkdirSync(".verification/lazy-explorer", { recursive: true });
writeFileSync(
  ".verification/lazy-explorer/model.json",
  JSON.stringify(
    {
      root,
      legacyEntries: paths.length,
      directoryEntries: rootPaths.length,
      samples,
      note: "Node/V8 model preparation, excludes DOM paint and IPC. Target is read-only.",
    },
    null,
    2,
  ),
);
