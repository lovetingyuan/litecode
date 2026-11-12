// Exercise the shipped CLI and config loaders without Language Tools or project plugins.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const prettier = path.resolve("src-tauri/tools/formatters/node_modules/prettier/bin/prettier.cjs");
await access(prettier);
await mkdir("tmp/.verification", { recursive: true });
const root = await mkdtemp(path.resolve("tmp", ".verification", "formatting-"));
const nested = path.join(root, "src");
await mkdir(nested);
const manifest = JSON.parse(
  await readFile(path.join(path.dirname(path.dirname(prettier)), "package.json"), "utf8"),
);
const project = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(manifest.version, project.devDependencies.prettier);
await assert.rejects(access(path.resolve("src-tauri/tools/formatters/node_modules/oxfmt")));
await writeFile(path.join(root, "package.json"), '{"private":true}');
await writeFile(
  path.join(root, ".editorconfig"),
  "root = true\n[*]\nindent_style = space\nindent_size = 4\nend_of_line = crlf\n",
);
const emptyConfig = path.join(root, "empty-prettier.json");
await writeFile(emptyConfig, "{}");

function run(filename, text, config, parser) {
  const result = spawnSync(
    process.execPath,
    [
      prettier,
      "--editorconfig",
      "--stdin-filepath",
      path.join(nested, filename),
      "--config",
      config ?? emptyConfig,
      ...(parser ? ["--parser", parser] : []),
    ],
    { cwd: root, input: text, encoding: "utf8", windowsHide: true },
  );
  if (result.error) {
    throw result.error;
  }
  return result;
}

function format(filename, text, config, parser) {
  const result = run(filename, text, config, parser);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

const input =
  '{"value":{"first":1,"second":2,"third":3,"fourth":4,"fifth":5,"sixth":6,"seventh":7}}';
assert.match(format("a.json", input), /\r\n {4}"value": \{/);
await writeFile(path.join(nested, ".editorconfig"), "[*]\nend_of_line = lf\n");
const inherited = format("a.json", input);
assert.match(inherited, /\n {4}"value": \{/);
assert.ok(!inherited.includes("\r"));

const config = path.join(root, ".prettierrc.json");
await writeFile(config, '{"tabWidth":2}');
assert.match(format("a.json", input, config), /\n {2}"value": \{/);
await writeFile(
  config,
  '{"tabWidth":3,"overrides":[{"files":"src/*.json","options":{"tabWidth":6}}]}',
);
assert.match(format("a.json", input, config), /\n {6}"value": \{/);

const packageConfig = path.join(root, "package.json");
await writeFile(packageConfig, '{"prettier":{"tabWidth":3}}');
assert.match(format("a.json", input, packageConfig), /\n {3}"value": \{/);

const jsonc = format(
  "tsconfig.json",
  '{// keep this comment\n"compilerOptions":{"strict":true,},}',
  packageConfig,
  "jsonc",
);
assert.ok(jsonc.includes("// keep this comment"));
assert.match(jsonc, /\n {3}"compilerOptions":/);
assert.equal(format("README.md", "# Title\n\n\n\nParagraph.\n"), "# Title\n\nParagraph.\n");
assert.match(format("a.html", "<div><p>text</p></div>"), /<p>text<\/p>/);

for (const invalid of ["{", '{"plugins":["./missing-plugin.mjs"]}']) {
  await writeFile(config, invalid);
  const failure = run("a.json", input, config);
  assert.notEqual(failure.status, 0);
  assert.equal(failure.stdout, "");
  assert.ok(failure.stderr.length > 0);
}
console.log(
  "Bundled Prettier: EditorConfig inheritance, config precedence, overrides, reloads, package settings, JSONC and failures passed.",
);
