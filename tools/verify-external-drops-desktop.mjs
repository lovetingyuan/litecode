import assert from "node:assert/strict";
import { mkdir, copyFile, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";

// Requires Vite and tauri-driver --port 4449 --native-driver <msedgedriver.exe>.
// CDP supplies disk-backed File objects to the real WebView2 native bridge.
// This checks the bridge and disk operations; physical Explorer drags remain a manual check.
const binary = process.env.LITECODE_TEST_BINARY ?? "src-tauri/target/debug/litecode.exe";
const endpoint = process.env.LITECODE_DRIVER_URL ?? "http://127.0.0.1:4449";
const run = path.resolve(".verification", `external-drops-${Date.now()}`);
const app = path.join(run, "app"),
  root = path.join(run, "workspace"),
  external = path.join(run, "external");
await mkdir(path.join(app, "data"), { recursive: true });
await mkdir(path.join(root, "target"), { recursive: true });
await mkdir(path.join(external, "empty"), { recursive: true });
await mkdir(path.join(external, "nested/deep/empty"), { recursive: true });
await writeFile(path.join(external, "hello 中文.txt"), "native file content\n");
await writeFile(path.join(external, "nested/deep/binary"), new Uint8Array([0, 255, 1, 0]));
await copyFile(binary, path.join(app, "LiteCode.exe"));
await writeFile(
  path.join(app, "data/session-main.json"),
  JSON.stringify({ root, documents: [], session: {} }),
);
let session;
async function request(method, route, body) {
  // oxlint-disable-next-line unicorn/no-invalid-fetch-options -- The caller supplies the HTTP method; GET requests omit the body.
  const response = await fetch(endpoint + route, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (payload.value?.error) {
    throw new Error(JSON.stringify(payload.value));
  }
  return payload.value;
}
const route = (suffix) => `/session/${session}${suffix}`;
const exec = (script, args = []) => request("POST", route("/execute/sync"), { script, args });
async function wait(script, message) {
  const start = Date.now();
  while (Date.now() - start < 20000) {
    if (await exec(script)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${message}: ${await exec("return document.body.innerText.slice(-900)")}`);
}
async function drop(selector, files, shadow = false) {
  const point = await exec(
    `const scope=arguments[1]?document.querySelector('file-tree-container').shadowRoot:document; const e=scope.querySelector(arguments[0]); if(!e)throw new Error('Missing '+arguments[0]);const r=e.getBoundingClientRect();return {x:r.x+Math.min(80,r.width/2),y:r.y+r.height/2}`,
    [selector, shadow],
  );
  for (const type of ["dragEnter", "dragOver", "drop"]) {
    await request("POST", route("/ms/cdp/execute"), {
      cmd: "Input.dispatchDragEvent",
      params: { type, ...point, data: { items: [], files, dragOperationsMask: 1 } },
    });
  }
}
async function choice(label) {
  await exec(
    `const button=[...document.querySelectorAll('.modal-actions button')].find(e=>e.textContent===arguments[0]);if(!button)throw new Error('Missing choice');button.click()`,
    [label],
  );
}
try {
  const created = await request("POST", "/session", {
    capabilities: {
      alwaysMatch: { "tauri:options": { application: path.join(app, "LiteCode.exe") } },
    },
  });
  session = created.sessionId;
  await wait(
    'return !!document.querySelector("file-tree-container")?.shadowRoot?.querySelector("[data-item-path]")',
    "Tree did not mount",
  );
  const selector = '[data-item-path="target/"]';
  await drop(
    selector,
    ["empty", "nested", "hello 中文.txt"].map((name) => path.join(external, name)),
    true,
  );
  await wait(
    `return [...document.querySelector('file-tree-container').shadowRoot.querySelectorAll('[data-item-path]')].some(e=>e.dataset.itemPath==='target/hello 中文.txt')`,
    "Native import did not finish",
  );
  assert.deepEqual(await readdir(path.join(root, "target/empty")), []);
  assert.deepEqual(
    [...(await readFile(path.join(root, "target/nested/deep/binary")))],
    [0, 255, 1, 0],
  );
  assert.equal(
    await readFile(path.join(root, "target/hello 中文.txt"), "utf8"),
    "native file content\n",
  );
  assert.equal(
    await readFile(path.join(external, "hello 中文.txt"), "utf8"),
    "native file content\n",
  );
  console.log(
    "PASS: native File paths, Unicode, multiple files, empty and nested directories, exact bytes, source preservation",
  );

  await drop(".editor-group", [path.join(external, "hello 中文.txt")]);
  await wait(
    'return document.querySelector(".editor-tab.active")?.textContent.includes("hello 中文.txt")',
    "External file did not open",
  );
  await drop(".editor-tabs", [path.join(external, "hello 中文.txt")]);
  await wait(
    'return document.querySelectorAll(".editor-tab").length===1',
    "Repeated drop duplicated document",
  );
  console.log("PASS: external file opens in editor and existing tab is reused");

  await writeFile(path.join(external, "hello 中文.txt"), "replacement");
  await drop(selector, [path.join(external, "hello 中文.txt")], true);
  await wait('return !!document.querySelector(".modal-actions")', "Overwrite confirmation missing");
  await choice("Skip");
  await wait('return !document.querySelector(".modal-actions")', "Skip did not close confirmation");
  assert.equal(
    await readFile(path.join(root, "target/hello 中文.txt"), "utf8"),
    "native file content\n",
  );
  await drop(selector, [path.join(external, "hello 中文.txt")], true);
  await wait(
    'return !!document.querySelector(".modal-actions")',
    "Replacement confirmation missing",
  );
  await choice("Replace");
  await wait(
    'return !document.querySelector(".modal-actions")',
    "Replace did not close confirmation",
  );
  const started = Date.now();
  while ((await readFile(path.join(root, "target/hello 中文.txt"), "utf8")) !== "replacement") {
    if (Date.now() - started > 10000) {
      throw new Error("Replacement did not reach disk");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.log("PASS: collision Skip and Replace through native IPC");
} finally {
  if (session) {
    await request("DELETE", route("")).catch(() => {});
  }
}
