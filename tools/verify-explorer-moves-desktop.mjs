import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, copyFile, writeFile, readFile, access } from "node:fs/promises";

// Requires tauri-driver --port 4447 --native-driver <msedgedriver.exe>.
// The fixture is portable and never touches the user's workspace or app data.
const run = path.resolve(".verification", `explorer-moves-desktop-${Date.now()}`);
const app = path.join(run, "app"),
  data = path.join(app, "data"),
  root = path.join(run, "fixture");
await mkdir(data, { recursive: true });
for (const dir of ["source/folder", "target", "secondary/source/folder", "secondary/target"]) {
  await mkdir(path.join(root, dir), { recursive: true });
}
for (const file of [
  "source/a.txt",
  "source/b.txt",
  "source/folder/deep.txt",
  "secondary/source/a.txt",
  "secondary/source/b.txt",
  "secondary/source/folder/deep.txt",
]) {
  await writeFile(path.join(root, file), `disk ${file}`);
}
await copyFile("src-tauri/target/debug/litecode.exe", path.join(app, "LiteCode.exe"));
await writeFile(
  path.join(data, "session-main.json"),
  JSON.stringify({ root, documents: [], session: {} }),
);
await writeFile(path.join(data, "settings.json"), JSON.stringify({ "files.autoSave": "off" }));
const endpoint = process.env.LITECODE_DRIVER_URL ?? "http://127.0.0.1:4447";
let session;
const url = (route) => `/session/${session}${route}`;
async function request(method, route, body) {
  // oxlint-disable-next-line unicorn/no-invalid-fetch-options -- The caller supplies the HTTP method; GET requests omit the body.
  const response = await fetch(endpoint + route, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (result.value?.error) {
    throw new Error(`${result.value.error}: ${result.value.message}`);
  }
  return result.value;
}
async function exec(script, args = []) {
  return request("POST", url("/execute/sync"), { script, args });
}
async function asyncExec(script, args = []) {
  return request("POST", url("/execute/async"), { script, args });
}
async function invoke(command, args = {}) {
  const result = await asyncExec(
    "const done=arguments[arguments.length-1]; window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then(value=>done({value}),error=>done({error}));",
    [command, args],
  );
  if (result.error) {
    throw new Error(JSON.stringify(result.error));
  }
  return result.value;
}
async function wait(script, message, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await exec(script)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}
async function keys(actions) {
  await request("POST", url("/actions"), { actions: [{ type: "key", id: "keyboard", actions }] });
}
async function key(value, ctrl = false) {
  await keys([
    ...(ctrl ? [{ type: "keyDown", value: "\ue009" }] : []),
    { type: "keyDown", value },
    { type: "keyUp", value },
    ...(ctrl ? [{ type: "keyUp", value: "\ue009" }] : []),
  ]);
}
async function pointer(actions) {
  await request("POST", url("/actions"), {
    actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions }],
  });
}
const move = (x, y, duration = 150) => ({
  type: "pointerMove",
  origin: "viewport",
  x: Math.round(x),
  y: Math.round(y),
  duration,
});
async function point(selector, shadow = true) {
  return exec(
    `const scope=arguments[1]?document.querySelector('file-tree-container')?.shadowRoot:document; const el=scope?.querySelector(arguments[0]); if(!el) throw new Error('Missing element '+arguments[0]); const b=el.getBoundingClientRect(); return {x:b.x+Math.min(100,b.width/2),y:b.y+b.height/2};`,
    [selector, shadow],
  );
}
async function click(selector, shadow = true) {
  const p = await point(selector, shadow);
  await pointer([
    move(p.x, p.y),
    { type: "pointerDown", button: 0 },
    { type: "pointerUp", button: 0 },
  ]);
}
const row = (p) => `[data-item-path="${p}"]`;
async function drag(from, target) {
  const a = await point(row(from)),
    b = await point(row(target));
  await pointer([
    move(a.x, a.y),
    { type: "pointerDown", button: 0 },
    move(a.x + 14, a.y + 2),
    move(b.x, b.y, 450),
    move(b.x + 1, b.y),
    { type: "pointerUp", button: 0 },
  ]);
}
async function screenshot(name) {
  await writeFile(
    path.join(run, `${name}.png`),
    Buffer.from(await request("GET", url("/screenshot")), "base64"),
  );
}
async function openAndEdit(file) {
  const result = await asyncExec(
    `const done=arguments[arguments.length-1]; import('/src/editor/documents.ts').then(async d=>{const id=await d.openPath(arguments[0],{pinned:true}); d.models.get(id).setValue('unsaved native edit');done({id});}).catch(e=>done({error:String(e)}));`,
    [file],
  );
  if (result.error) {
    throw new Error(result.error);
  }
  return result.id;
}
async function exercise(base, name) {
  await wait(
    "return !!document.querySelector('file-tree-container')?.shadowRoot?.querySelector('[data-item-path=\"source/\"]');",
    "Workspace tree did not mount",
  );
  await click(row("source/"));
  await wait(
    "return !!document.querySelector('file-tree-container').shadowRoot.querySelector('[data-item-path=\"source/a.txt\"]');",
    "Source did not expand",
  );
  const id = await openAndEdit(path.join(base, "source/a.txt"));
  await click(row("source/a.txt"));
  await keys([{ type: "keyDown", value: "\ue009" }]);
  await click(row("source/b.txt"));
  await keys([{ type: "keyUp", value: "\ue009" }]);
  assert.equal(
    await exec(
      "return document.querySelector('file-tree-container').shadowRoot.querySelectorAll('[aria-selected=\"true\"]').length;",
    ),
    2,
  );
  await drag("source/a.txt", "target/");
  await wait(
    "return !!document.querySelector('.move-confirmation');",
    `${name}: HTML5 drag did not reach confirmation`,
  );
  assert.equal(
    await readFile(path.join(base, "source/a.txt"), "utf8"),
    "disk " + (name === "main" ? "" : "secondary/") + "source/a.txt",
  );
  await assert.rejects(access(path.join(base, "target/a.txt")));
  await screenshot(`${name}-confirmation`);
  await key("\ue00c");
  await wait(
    "return !document.querySelector('[role=dialog]');",
    "Escape did not dismiss confirmation",
  );
  await drag("source/a.txt", "target/");
  await wait("return !!document.querySelector('.move-confirmation');", "Second drag did not start");
  await click(".move-confirmation button.primary", false);
  await wait(
    "return !!document.querySelector('file-tree-container').shadowRoot.querySelector('[data-item-path=\"target/a.txt\"]');",
    "Moved tree rows did not appear",
  );
  assert.equal(
    await readFile(path.join(base, "target/a.txt"), "utf8"),
    "disk " + (name === "main" ? "" : "secondary/") + "source/a.txt",
  );
  await assert.rejects(access(path.join(base, "source/a.txt")));
  assert.ok(
    await exec("return !!document.querySelector('.editor-tab.active .dirty');"),
    "Unsaved buffer remains dirty",
  );
  await key("s", true);
  await wait("return !document.querySelector('.editor-tab.active .dirty');", "Save did not finish");
  assert.equal(await readFile(path.join(base, "target/a.txt"), "utf8"), "unsaved native edit");
  await assert.rejects(access(path.join(base, "source/a.txt")));
  await screenshot(`${name}-moved`);
  console.log(
    `PASS: ${name} Windows WebView2 real mouse multi-drag, confirm/cancel, disk move, dirty buffer and save (${id})`,
  );
  await openAndEdit(path.join(base, "source/folder/deep.txt"));
  await wait(
    "return !!document.querySelector('file-tree-container').shadowRoot.querySelector('[data-item-path=\"source/folder/\"]');",
    "Open nested document was not revealed",
  );
  await click(row("source/folder/"));
  await drag("source/folder/", "target/");
  await wait(
    "return !!document.querySelector('.move-confirmation');",
    "Folder drag did not reach confirmation",
  );
  await click(".move-confirmation button.primary", false);
  await wait(
    "return !!document.querySelector('file-tree-container').shadowRoot.querySelector('[data-item-path=\"target/folder/\"]');",
    "Folder move was not reflected",
  );
  await key("s", true);
  await wait(
    "return !document.querySelector('.editor-tab.active .dirty');",
    "Nested document save did not finish",
  );
  assert.equal(
    await readFile(path.join(base, "target/folder/deep.txt"), "utf8"),
    "unsaved native edit",
  );
  await assert.rejects(access(path.join(base, "source/folder")));
  console.log(
    `PASS: ${name} moving a directory rebinds its open dirty descendants and saves into the new subtree`,
  );
}

try {
  const created = await request("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        "tauri:options": { application: path.join(app, "LiteCode.exe") },
        "ms:edgeOptions": { args: ["--no-proxy-server", "--remote-debugging-port=9226"] },
      },
    },
  });
  session = created.sessionId;
  await request("POST", url("/timeouts"), { script: 30000, implicit: 0 });
  await request("POST", url("/window/rect"), { width: 1280, height: 820, x: 40, y: 40 });
  await exercise(root, "main");
  const before = await request("GET", url("/window/handles"));
  await invoke("open_workspace", { path: path.join(root, "secondary"), newWindow: true });
  let handles;
  for (let i = 0; i < 100; i++) {
    handles = await request("GET", url("/window/handles"));
    if (handles.length > before.length) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const other = handles.find((h) => !before.includes(h));
  assert.ok(other, "New workspace window was created");
  await request("POST", url("/window"), { handle: other });
  await exercise(path.join(root, "secondary"), "new-window");
  await writeFile(
    path.join(run, "results.json"),
    JSON.stringify({ passed: true, windows: ["main", "new-window"], run }, null, 2),
  );
  console.log(`Evidence: ${run}`);
} catch (error) {
  if (session) {
    await screenshot("failure").catch(() => {});
    console.error(
      await exec(
        'return {url:location.href,body:document.body.innerText,html:document.documentElement.outerHTML.slice(0,1500),resources:performance.getEntriesByType("resource").slice(-8).map(e=>({name:e.name,duration:e.duration}))};',
      ).catch(() => null),
    );
  }
  throw error;
} finally {
  if (session) {
    await request("DELETE", url("")).catch(() => {});
  }
}
