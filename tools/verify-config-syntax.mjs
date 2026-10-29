import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

// Real Monaco tokenizers and restored editor buffers; only the native bridge is isolated.
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
const errors = [];
const urls = {};
page.on("pageerror", (error) => errors.push(String(error)));
page.on("request", (request) => {
  const match = new URL(request.url()).pathname.match(/^\/src\/editor\/(monaco|documents)\.ts$/);
  if (match) {
    urls[match[1]] = request.url();
  }
});
const documents = [
  {
    name: ".gitignore",
    text: "# Build output\n/dist/\n*.log\n!important.log\n**/cache/file?.[ch]\n\\#literal\n\\!literal\nfile#name\n",
  },
  {
    name: ".env.production.local",
    text: '# Production config\nexport APP_NAME="LiteCode # app" # note\nURL=${HOST}/api\nLITERAL=\'$HOST # literal\'\nMULTILINE="first\n# still a string ${HOST}\nlast"\nNEXT=value # comment\n',
  },
].map((doc) => ({
  ...doc,
  id: `file:///C:/config-syntax/${doc.name}`,
  path: `C:/config-syntax/${doc.name}`,
  language: "plaintext",
  encoding: "utf8",
  eol: "LF",
  revision: "fixture",
  dirty: true,
  version: 1,
}));
const ids = documents.map((doc) => doc.id);
await page.route("**/src/core/bridge.ts*", (route) =>
  route.fulfill({
    contentType: "application/javascript",
    body: `
export const desktop = false;
export const mediaSource = path => path;
export const errorMessage = e => e?.message ?? String(e);
export const channel = fn => ({onmessage:fn});
export async function bootstrap() { return ${JSON.stringify({
      root: null,
      documents,
      session: {
        groups: [{ id: "one", tabs: ids, active: ids[1], preview: null, views: {} }],
        activeGroup: "one",
      },
      recent: [],
      settings: {},
      keybindings: [],
      warnings: [],
      dataDir: "",
    })}; }
export async function call(command) { throw new Error('Unexpected fixture command: '+command); }
`,
  }),
);
try {
  await page.goto("http://127.0.0.1:1420/");
  await page.locator(".monaco-editor .view-lines").waitFor();
  const result = await page.evaluate(
    async ({ ids, urls }) => {
      const { monaco } = await import(urls.monaco);
      const { models } = await import(urls.documents);
      return ids.map((id) => {
        const model = models.get(id);
        const text = model.getValue();
        const lines = text.split("\n");
        return {
          language: model.getLanguageId(),
          text,
          tokens: monaco.editor.tokenize(text, model.getLanguageId()).map((tokens, line) =>
            tokens.map((token, i) => ({
              text: lines[line].slice(token.offset, tokens[i + 1]?.offset),
              type: token.type,
            })),
          ),
        };
      });
    },
    { ids, urls },
  );
  for (let i = 0; i < result.length; i++) {
    assert.equal(result[i].text, documents[i].text, "Restoring preserves unsaved text");
  }
  const [ignore, env] = result;
  assert.equal(ignore.language, "gitignore");
  assert.equal(env.language, "dotenv");
  const has = (doc, line, text, type) =>
    assert.ok(
      doc.tokens[line].some((token) => token.text.includes(text) && token.type === type),
      `Missing ${type} token ${JSON.stringify(text)} on line ${line + 1}`,
    );
  has(ignore, 0, "# Build output", "comment.gitignore");
  has(ignore, 2, "*", "keyword.gitignore");
  has(ignore, 3, "!", "keyword.gitignore");
  has(ignore, 4, "**", "keyword.gitignore");
  has(ignore, 4, "?", "keyword.gitignore");
  has(ignore, 4, "[ch]", "regexp.gitignore");
  for (const line of [5, 6, 7]) {
    assert.ok(ignore.tokens[line].every((token) => !/comment|keyword/.test(token.type)));
  }
  has(env, 0, "# Production config", "comment.dotenv");
  has(env, 1, "export", "keyword.dotenv");
  has(env, 1, "APP_NAME", "identifier.dotenv");
  has(env, 1, "# app", "string.dotenv");
  has(env, 1, "# note", "comment.dotenv");
  has(env, 2, "${HOST}", "identifier.dotenv");
  has(env, 3, "$HOST # literal", "string.dotenv");
  has(env, 5, "# still a string", "string.dotenv");
  has(env, 5, "${HOST}", "identifier.dotenv");
  has(env, 7, "NEXT", "identifier.dotenv");
  has(env, 7, "# comment", "comment.dotenv");
  await page.waitForFunction(
    () =>
      new Set(
        [...document.querySelectorAll(".monaco-editor .view-line span")]
          .filter((span) => span.textContent.trim())
          .map((span) => getComputedStyle(span).color),
      ).size >= 4,
  );
  const colors = await page
    .locator(".monaco-editor .view-line span")
    .evaluateAll((spans) => [
      ...new Set(
        spans.filter((span) => span.textContent.trim()).map((span) => getComputedStyle(span).color),
      ),
    ]);
  assert.ok(colors.length >= 4, `Expected distinct syntax colors, got ${colors}`);
  await mkdir(".verification/config-syntax", { recursive: true });
  await page.screenshot({ path: ".verification/config-syntax/dotenv.png" });
  await page.getByRole("tab", { name: ".gitignore, unsaved", exact: true }).click();
  await page.screenshot({ path: ".verification/config-syntax/gitignore.png" });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ languages: result.map((doc) => doc.language), colors, errors }));
} finally {
  await browser.close();
}
