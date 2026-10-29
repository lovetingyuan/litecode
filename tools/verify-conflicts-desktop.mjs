import assert from "node:assert/strict";
import { mkdir, copyFile, writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";

// Requires Vite on 1420 and tauri-driver on 4447 with a matching Edge driver.
// The portable app and external writes use an isolated fixture and app data.
const run = path.resolve(".verification", `conflicts-desktop-${Date.now()}`);
const app = path.join(run, "app"),
  root = path.join(run, "fixture");
await mkdir(path.join(app, "data"), { recursive: true });
await mkdir(root, { recursive: true });
const file = path.join(root, "并发编辑.txt");
const original = "第一行：原始内容\r\n第二行：共同内容\r\n第三行：原始末尾\r\n";
const local = "第一行：当前编辑内容\r\n第二行：共同内容\r\n第三行：当前末尾\r\n";
const external = "第一行：第三方修改\r\n第二行：共同内容\r\n第三行：磁盘末尾\r\n";
await writeFile(file, original);
await copyFile("src-tauri/target/debug/litecode.exe", path.join(app, "LiteCode.exe"));
await writeFile(
  path.join(app, "data", "session-main.json"),
  JSON.stringify({ root, documents: [], session: {} }),
);
await writeFile(
  path.join(app, "data", "settings.json"),
  JSON.stringify({ "files.autoSave": "off" }),
);
const endpoint = process.env.LITECODE_DRIVER_URL ?? "http://127.0.0.1:4447";
let session;
const checks = [];
async function request(method, route, body) {
  // oxlint-disable-next-line unicorn/no-invalid-fetch-options -- GET requests omit the body.
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
const url = (route = "") => `/session/${session}${route}`;
const exec = (script, args = []) => request("POST", url("/execute/sync"), { script, args });
async function documents(script, args = []) {
  const result = await request("POST", url("/execute/async"), {
    script: `const done=arguments[arguments.length-1]; const args=arguments[0];
      const moduleUrl=performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname==='/src/editor/documents.ts')?.name;
      import(moduleUrl||'/src/editor/documents.ts').then(async d=>{${script}}).then(value=>done({value}),e=>done({error:e.message||String(e)}));`,
    args: [args],
  });
  if (result.error) {
    throw new Error(result.error);
  }
  return result.value;
}
async function wait(script, message, args = []) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await exec(script, args)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}
async function click(label) {
  const element = await request("POST", url("/element"), {
    using: "xpath",
    value: `//button[normalize-space(.)='${label}']`,
  });
  await request(
    "POST",
    url(`/element/${element["element-6066-11e4-a52e-4f735466cecf"]}/click`),
    {},
  );
}
async function screenshot(name) {
  await writeFile(
    path.join(run, `${name}.png`),
    Buffer.from(await request("GET", url("/screenshot")), "base64"),
  );
}
const closed = () =>
  wait("return !document.querySelector('.diff-panel');", "Comparison did not close");
const getBuffer = () => documents("return d.models.get(args[0]).getValue();", [documentId]);
let documentId;
async function edit(text = local) {
  await documents("d.models.get(args[0]).setValue(args[1]);", [documentId, text]);
}
async function conflict() {
  await writeFile(file, original);
  await documents(
    `d.patchDoc(args[0],{conflict:true});
    const diff=await d.readConflictDiff(args[0]);await d.resolveConflict(diff.conflict,'reload');`,
    [documentId],
  );
  await edit();
  await writeFile(file, external);
  await documents("await d.refreshDocuments();");
  await wait("return !!document.querySelector('.conflict-banner');", "Conflict banner missing");
  await documents("await d.compareDisk(args[0]);", [documentId]);
  await wait(
    "return document.querySelectorAll('.diff-panel .view-lines').length===2;",
    "Diff editors did not mount",
  );
}

try {
  const created = await request("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        "tauri:options": { application: path.join(app, "LiteCode.exe") },
        "ms:edgeOptions": { args: ["--no-proxy-server"] },
      },
    },
  });
  session = created.sessionId;
  await request("POST", url("/timeouts"), { script: 30000, implicit: 0 });
  await request("POST", url("/window/rect"), { width: 1280, height: 820, x: 40, y: 40 });
  await wait("return !!document.querySelector('file-tree-container');", "Workspace did not load");
  documentId = await documents("return await d.openPath(args[0], {pinned:true});", [file]);
  // A separate filesystem writer changes a clean file: the watcher refreshes it.
  await writeFile(file, external);
  await wait(
    "return document.querySelector('.editor-group .view-lines')?.textContent.includes('第三方修改');",
    "Watcher did not reload clean file",
  );
  assert.equal(await getBuffer(), external);
  checks.push("Watcher refreshes a clean Unicode/CRLF file after an external write");

  await conflict();
  await wait(
    "return !!document.querySelector('.diff-panel .line-insert, .diff-panel .line-delete, .diff-panel .char-insert, .diff-panel .char-delete');",
    "Diff highlighting missing",
  );
  assert.equal(
    await exec(
      "return document.querySelector('.diff-panel').textContent.includes('磁盘版本') && document.querySelector('.diff-panel').textContent.includes('当前编辑版本');",
    ),
    true,
  );
  await request("POST", url("/element"), {
    using: "css selector",
    value: '.diff-panel button[aria-label="下一个差异"]',
  }).then((element) =>
    request("POST", url(`/element/${element["element-6066-11e4-a52e-4f735466cecf"]}/click`), {}),
  );
  await screenshot("01-conflict-diff");
  await click("取消");
  await closed();
  assert.equal(await getBuffer(), local);
  assert.equal(await readFile(file, "utf8"), external);
  checks.push("Highlighted side-by-side comparison and cancelling preserve both versions");

  // Manual save with a stale disk revision opens the comparison automatically.
  await documents("try {await d.save(args[0]);} catch(e) {if(e.code!=='conflict') throw e;}", [
    documentId,
  ]);
  await wait(
    "return !!document.querySelector('.diff-panel');",
    "Manual conflict did not open comparison",
  );
  await click("使用磁盘版本");
  await closed();
  assert.equal(await getBuffer(), external);
  assert.equal(await readFile(file, "utf8"), external);
  await documents("d.models.get(args[0]).undo();", [documentId]);
  assert.equal(await getBuffer(), local);
  checks.push("Choosing disk performs an undoable edit without changing disk");

  const externalLF = external.replaceAll("\r\n", "\n");
  await writeFile(file, externalLF);
  await documents("await d.refreshDocuments();await d.compareDisk(args[0]);", [documentId]);
  await click("使用磁盘版本");
  await closed();
  assert.equal(await getBuffer(), externalLF);
  await documents("d.models.get(args[0]).undo();", [documentId]);
  assert.equal(await getBuffer(), local);
  checks.push("Choosing disk also adopts its line endings and undo restores CRLF");

  await conflict();
  await click("保留当前版本");
  await closed();
  assert.equal(await getBuffer(), local);
  assert.equal(await readFile(file, "utf8"), local);
  checks.push("Choosing current saves the displayed Unicode/CRLF bytes");

  await conflict();
  const newer = "第一行：第三方再次修改\r\n第二行：新的磁盘版本\r\n";
  await writeFile(file, newer);
  await click("保留当前版本");
  await wait(
    "return document.querySelector('.diff-panel')?.textContent.includes('再次选择');",
    "Changed disk was not rejected",
  );
  assert.equal(await readFile(file, "utf8"), newer);
  assert.equal(await getBuffer(), local);
  await screenshot("02-updated-comparison");
  await click("使用磁盘版本");
  await closed();
  assert.equal(await getBuffer(), newer);
  checks.push("Disk changes during comparison refresh the diff and require a second choice");

  await conflict();
  await edit("对比后又编辑\r\n");
  await click("使用磁盘版本");
  await wait(
    "return document.querySelector('.diff-panel')?.textContent.includes('再次选择');",
    "Changed buffer was not rejected",
  );
  assert.equal(await getBuffer(), "对比后又编辑\r\n");
  await click("取消");
  await closed();
  checks.push("Editor changes during comparison are preserved and require a second choice");

  await conflict();
  await unlink(file);
  await click("保留当前版本");
  await wait(
    "return document.querySelector('.diff-panel')?.textContent.includes('无法读取磁盘版本');",
    "Missing file error was not shown",
  );
  assert.equal(
    await exec(
      "return [...document.querySelectorAll('.diff-panel button')].filter(b=>/使用磁盘版本|保留当前版本/.test(b.textContent)).every(b=>b.disabled);",
    ),
    true,
  );
  assert.equal(
    await exec("return document.querySelectorAll('.diff-panel .monaco-editor').length;"),
    0,
  );
  assert.equal(await getBuffer(), local);
  await screenshot("03-file-unavailable");
  await writeFile(file, external);
  await click("刷新对比");
  await wait(
    "return document.querySelectorAll('.diff-panel .view-lines').length===2;",
    "Retry did not restore comparison",
  );
  // Deliver two clicks in one task to verify the immediate in-flight guard.
  await exec(
    "const b=[...document.querySelectorAll('.diff-panel button')].find(b=>b.textContent==='保留当前版本');b.click();b.click();",
  );
  await closed();
  assert.equal(await readFile(file, "utf8"), local);
  checks.push(
    "Missing files show errors instead of empty diffs; retry and double-click selection work",
  );

  await exec(
    "window.dispatchEvent(new CustomEvent('show-diff',{detail:{title:'Replace Preview',before:'before',after:'after',language:'plaintext'}}));",
  );
  await wait("return !!document.querySelector('.diff-panel');", "Generic preview missing");
  assert.equal(
    await exec(
      "return document.querySelector('.diff-panel').textContent.includes('保留当前版本');",
    ),
    false,
  );
  await screenshot("04-generic-preview");
  checks.push(
    "Ordinary replacement previews retain read-only comparison without resolution actions",
  );
  await writeFile(
    path.join(run, "results.json"),
    JSON.stringify({ passed: true, checks, run }, null, 2),
  );
  for (const check of checks) {
    console.log(`PASS: ${check}`);
  }
  console.log(`Evidence: ${run}`);
} catch (error) {
  if (session) {
    await screenshot("failure").catch(() => {});
    console.error(
      await exec("return {url:location.href,text:document.body.innerText};").catch(() => null),
    );
  }
  throw error;
} finally {
  if (session) {
    await request("DELETE", url()).catch(() => {});
  }
}
