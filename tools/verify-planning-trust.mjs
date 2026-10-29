// Requires a Debug desktop build: cargo build --locked (in src-tauri).
// All files, trust decisions and WebView state belong to an isolated fixture.
import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const run = path.resolve(".verification", `planning-trust-${Date.now()}`);
const app = path.join(run, "app");
const root = path.join(run, "fixture");
const data = path.join(app, "data");
const exe = path.join(app, "LiteCode.exe");
await mkdir(data, { recursive: true });
await mkdir(root, { recursive: true });
await copyFile("src-tauri/target/debug/litecode.exe", exe);
await writeFile(path.join(root, "config.json"), '{"value": }\n');
await writeFile(
  path.join(data, "settings.json"),
  JSON.stringify({ "files.autoSave": "off", "litecode.nodePath": process.execPath }),
);
await writeFile(
  path.join(data, "session-main.json"),
  JSON.stringify({ root, documents: [], session: {} }),
);
let vite;
let child;
let socket;
let evaluate;
const checks = [];
const measurements = [];
const consoleErrors = [];
let stderr = "";

async function waitFor(check, description, timeout = 60_000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try {
      const value = await check();
      if (value) {
        return value;
      }
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${description}: ${last ?? "timeout"}`);
}

try {
  if (!(await fetch("http://localhost:1420").catch(() => null))?.ok) {
    vite = spawn(
      process.execPath,
      ["node_modules/vite/bin/vite.js", "--port", "1420", "--strictPort"],
      { windowsHide: true, stdio: "ignore" },
    );
    await waitFor(
      async () => (await fetch("http://localhost:1420").catch(() => null))?.ok,
      "Vite startup",
    );
  }
  // Reuse the exact module URLs from the running app. An existing Vite server
  // may attach HMR timestamps; importing an unversioned store creates a second store.
  const appSource = await fetch("http://localhost:1420/src/components/App.tsx").then((r) =>
    r.text(),
  );
  const imports = [...appSource.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
  const moduleUrl = (filename) => {
    const imported = imports.find((url) => url.split("?")[0] === filename);
    assert.ok(imported, `App must import ${filename}`);
    return new URL(imported, "http://localhost:1420").href;
  };
  const modules = {
    store: moduleUrl("/src/store/store.ts"),
    docs: moduleUrl("/src/editor/documents.ts"),
    replacements: moduleUrl("/src/search/replacements.ts"),
    monaco: moduleUrl("/src/editor/monaco.ts"),
    languages: moduleUrl("/src/editor/languages.ts"),
  };
  console.log(`Isolated artifacts: ${run}`);
  child = spawn(exe, [], {
    cwd: app,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9235",
      WEBVIEW2_USER_DATA_FOLDER: path.join(run, "webview"),
    },
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const target = await waitFor(async () => {
    const targets = await fetch("http://127.0.0.1:9235/json/list").then((r) => r.json());
    return targets.find((target) => target.type === "page" && target.url.includes("1420"));
  }, "Isolated WebView startup");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Runtime.exceptionThrown") {
      consoleErrors.push(message.params.exceptionDetails.text);
    }
    const callback = pending.get(message.id);
    if (callback) {
      pending.delete(message.id);
      clearTimeout(callback.timer);
      if (message.error) {
        callback.reject(message.error);
      } else {
        callback.resolve(message.result);
      }
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => {
        pending.delete(key);
        reject(new Error(`CDP timeout: ${method}`));
      }, 60_000);
      pending.set(key, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: key, method, params }));
    });
  evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      );
    }
    return result.result.value;
  };
  await send("Runtime.enable");
  await waitFor(
    () => evaluate(`document.querySelector('.view-title') !== null`),
    "App rendering",
    120_000,
  );
  await waitFor(
    () =>
      evaluate(
        `(async()=>{const {useApp}=await import(${JSON.stringify(modules.store)});return useApp.getState().ready})()`,
      ),
    "App bootstrap",
    120_000,
  );
  await evaluate(`(async()=>{
    window.audit = { root: ${JSON.stringify(root.replaceAll("\\", "/"))}, attempts: [], events: [], sent: [], acks: 0, errors: [], released: [], searchStarts: 0 };
    audit.store = await import(${JSON.stringify(modules.store)});
    audit.docs = await import(${JSON.stringify(modules.docs)});
    audit.replacements = await import(${JSON.stringify(modules.replacements)});
    audit.monaco = (await import(${JSON.stringify(modules.monaco)})).monaco;
    audit.languages = await import(${JSON.stringify(modules.languages)});
    // Tauri's invoke property is read-only. Observe the actual IPC fetch boundary
    // and wrap its debug callback Map rather than attempting to replace invoke.
    const original = window.fetch;
    window.fetch = async function(input, options) {
      const url = new URL(String(input), location.href);
      const command = url.hostname === 'ipc.localhost' ? decodeURIComponent(url.pathname.slice(1)) : null;
      const args = command ? JSON.parse(options.body) : {};
      if (command === 'lsp_start') {
        const channelId = Number(args.onEvent.split(':')[1]);
        audit.attempts.push(channelId);
        const deliver = window.__TAURI_INTERNALS__.callbacks.get(channelId);
        window.__TAURI_INTERNALS__.callbacks.set(channelId, event => {
          if (event.message) { audit.events.push(event.message); }
          deliver(event);
        });
      }
      if (command === 'lsp_ack') { audit.acks++; }
      if (command === 'lsp_send') { audit.sent.push(args.message); }
      if (command === 'search_start') { audit.searchStarts++; }
      const response = await original.call(this, input, options);
      if (command === 'lsp_start' && response.headers.get('Tauri-Response') !== 'ok') {
        audit.errors.push(await response.clone().json());
      }
      if (command === 'replacement_plan' && audit.holdPlan) {
        audit.planWaiting = true;
        await new Promise(resolve => { audit.releasePlan = resolve; });
      }
      return response;
    };
    audit.invoke = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
    audit.query = {...audit.store.searchSession('search').query, text:'needle', caseSensitive:true};
  })()`);

  // Native compute timing and complete frontend planning timing use identical inputs.
  for (const n of [1000, 4000, 16000]) {
    const text = `needle${"x".repeat(506)}\n`.repeat(n);
    const filename = path.join(root, `scattered-${n}.txt`);
    await writeFile(filename, text);
    const result = await evaluate(`(async()=>{
      const n=${n}, path=audit.root+'/scattered-${n}.txt';
      const text=('needle'+'x'.repeat(506)+'\\n').repeat(n);
      const requestId=crypto.randomUUID();
      await audit.invoke('replacement_plan_begin',{requestId});
      let nativeMs;
      try {
        const begin=performance.now();
        const edits=await audit.invoke('replacement_plan',{requestId,text,query:audit.query,replacement:'new',preserveCase:false});
        nativeMs=performance.now()-begin;
        if(edits.length!==n||edits.at(-1).line!==n) throw Error('Native ranges incorrect');
      } finally {await audit.invoke('replacement_plan_release',{requestId});}
      const matches=Array.from({length:n},(_,i)=>({path,documentId:null,version:null,line:i+1,column:1,endLine:i+1,endColumn:7,matched:'needle',preview:'needle'}));
      let preview;
      const dispatch=window.dispatchEvent;
      window.dispatchEvent=function(event){if(event.type==='show-diff'){preview=event.detail;return true}return dispatch.call(this,event)};
      let ticks=0,maxGap=0,last=performance.now();
      const timer=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now;ticks++},10);
      const begin=performance.now();
      try {await audit.replacements.replaceMatches(matches,'new',false,audit.query,true);}
      finally {clearInterval(timer);window.dispatchEvent=dispatch;}
      return {n,nativeMs,planningMs:performance.now()-begin,ticks,maxGap,correct:preview?.after===text.replaceAll('needle','new')};
    })()`);
    assert.equal(result.correct, true);
    if (n === 16000) {
      assert.ok(result.ticks > 0);
    }
    assert.equal(await readFile(filename, "utf8"), text);
    measurements.push(result);
    console.log(JSON.stringify(result));
  }
  checks.push(
    "Native and frontend planning preserve all ranges and bytes; event-loop timer runs during 16,000-match planning",
  );

  const cancelledNative = await evaluate(`(async()=>{
    const requestId=crypto.randomUUID();
    await audit.invoke('replacement_plan_begin',{requestId});
    try {
      const text=('needle'+'x'.repeat(506)+'\\n').repeat(16000);
      const pending=audit.invoke('replacement_plan',{requestId,text,query:audit.query,replacement:'new',preserveCase:false}).then(()=>({completed:true}),error=>({code:error.code}));
      await new Promise(resolve=>setTimeout(resolve,5));
      await audit.invoke('replacement_plan_cancel',{requestId});
      return await pending;
    } finally {await audit.invoke('replacement_plan_release',{requestId});}
  })()`);
  assert.equal(cancelledNative.code, "cancelled");
  checks.push(
    "Actual background Rust planning responds to cancellation without returning partial edits",
  );

  const cancelledFrontend = await evaluate(`(async()=>{
    const path=audit.root+'/scattered-16000.txt';
    const matches=Array.from({length:16000},(_,i)=>({path,documentId:null,version:null,line:i+1,column:1,endLine:i+1,endColumn:7,matched:'needle',preview:'needle'}));
    audit.store.setApp({sidebar:'search'});
    const pending=audit.replacements.replaceMatches(matches,'new',false,audit.query);
    let interactive=false;
    await new Promise(resolve=>setTimeout(()=>{interactive=true;audit.replacements.cancelReplacementPlan();resolve()},5));
    const result=await pending;
    return {cancelled:result===null,interactive,phase:audit.store.useApp.getState().replacementPhase};
  })()`);
  assert.deepEqual(cancelledFrontend, { cancelled: true, interactive: true, phase: null });
  assert.equal(
    await readFile(path.join(root, "scattered-16000.txt"), "utf8"),
    `needle${"x".repeat(506)}\n`.repeat(16000),
  );
  checks.push("Frontend cancellation leaves source bytes unchanged and returns to idle");

  // Hold only the native response to exercise an actual click and a stale result.
  await waitFor(
    () =>
      evaluate(
        `!!document.querySelector('[aria-label="Toggle Replace"]') && !audit.store.searchSession('search').searching`,
      ),
    "Search panel mounting",
  );
  await evaluate(`(()=>{
    const path=audit.root+'/scattered-16000.txt';
    const matches=Array.from({length:16000},(_,i)=>({path,documentId:null,version:null,line:i+1,column:1,endLine:i+1,endColumn:7,matched:'needle',preview:'needle'}));
    audit.store.patchSearch('search',{query:audit.query,results:matches});
    audit.holdPlan=true;
  })()`);
  await waitFor(
    () => evaluate(`!!document.querySelector('[aria-label="Toggle Replace"]')`),
    "Replace controls",
  );
  await evaluate(`document.querySelector('[aria-label="Toggle Replace"]').click()`);
  await waitFor(
    () => evaluate(`!!document.querySelector('[aria-label="Replace All"]')`),
    "Replace All control",
  );
  await evaluate(`document.querySelector('[aria-label="Replace All"]').click()`);
  await waitFor(
    () =>
      evaluate(
        `!![...document.querySelectorAll('.modal-actions button')].find(button=>button.textContent.trim()==='Replace')`,
      ),
    "Replace confirmation",
  );
  await evaluate(
    `[...document.querySelectorAll('.modal-actions button')].find(button=>button.textContent.trim()==='Replace').click()`,
  );
  await waitFor(
    () =>
      evaluate(
        `audit.planWaiting && !!document.querySelector('[aria-label="Cancel Replacement Planning"]')`,
      ),
    "Cancelable planning UI",
  );
  assert.equal(
    await evaluate(`document.querySelector('[aria-label="Replace All"]').disabled`),
    true,
  );
  const planningScreenshot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(run, "planning.png"), Buffer.from(planningScreenshot.data, "base64"));
  const cancelButton = await evaluate(
    `(()=>{const r=document.querySelector('[aria-label="Cancel Replacement Planning"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  );
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    clickCount: 1,
    ...cancelButton,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    clickCount: 1,
    ...cancelButton,
  });
  const searchesBeforeRelease = await evaluate(`audit.searchStarts`);
  await evaluate(`audit.holdPlan=false;audit.releasePlan()`);
  await waitFor(
    () => evaluate(`audit.store.useApp.getState().replacementPhase===null`),
    "Planning cancellation completion",
  );
  assert.equal(await evaluate(`audit.searchStarts`), searchesBeforeRelease);
  assert.deepEqual(await evaluate(`audit.invoke('replacement_recovery')`), []);
  assert.equal(
    await readFile(path.join(root, "scattered-16000.txt"), "utf8"),
    `needle${"x".repeat(506)}\n`.repeat(16000),
  );
  checks.push(
    "Actual Replace All and Cancel buttons reject a delayed stale plan, disable duplicate replacement, leave no journal and do not rerun search",
  );

  await evaluate(`audit.docs.openPath(audit.root+'/config.json',{pinned:true})`);
  await waitFor(
    () =>
      evaluate(
        `!![...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Trust Workspace')`,
      ),
    "Actual trust dialog",
  );
  await evaluate(
    `[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Trust Workspace').click()`,
  );
  await waitFor(
    () =>
      evaluate(
        `audit.languages.languageReport().services.some(service=>service.id==='json'&&service.running)`,
      ),
    "Real language initialization",
  );
  await waitFor(
    () =>
      evaluate(
        `audit.events.some(event=>event.kind==='message'&&event.message?.method==='textDocument/publishDiagnostics')`,
      ),
    "Real diagnostic delivery",
  );
  const lsp = await evaluate(
    `({attempts:audit.attempts,errors:audit.errors,acks:audit.acks,released:audit.attempts.filter(id=>!window.__TAURI_INTERNALS__.callbacks.has(id)),services:audit.languages.languageReport().services,diagnostics:audit.events.filter(event=>event.message?.method==='textDocument/publishDiagnostics').length})`,
  );
  assert.equal(lsp.attempts.length, 2);
  assert.notEqual(lsp.attempts[0], lsp.attempts[1]);
  assert.equal(lsp.errors[0].code, "workspaceTrust");
  assert.ok(lsp.released.includes(lsp.attempts[0]));
  assert.ok(lsp.acks > 0);
  assert.ok(lsp.diagnostics > 0);
  checks.push(
    "Real trust rejection, explicit fixture approval, new Channel, LSP initialization, diagnostics and acknowledgements succeed",
  );
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(run, "verified.png"), Buffer.from(screenshot.data, "base64"));
  assert.deepEqual(consoleErrors, []);
  await writeFile(
    path.join(run, "results.json"),
    JSON.stringify({ checks, measurements, lsp, consoleErrors, stderr }, null, 2),
  );
  console.log(JSON.stringify({ run, checks, measurements }, null, 2));
  await evaluate(`audit.languages.stopLanguages()`);
} catch (error) {
  const debug = await evaluate?.(
    `({body:document.body.innerText.slice(-2000),attempts:window.audit?.attempts,events:window.audit?.events,sent:window.audit?.sent,report:window.audit?.languages.languageReport()})`,
  ).catch(() => null);
  await writeFile(
    path.join(run, "failure.json"),
    JSON.stringify(
      { error: String(error), checks, measurements, debug, consoleErrors, stderr },
      null,
      2,
    ),
  );
  throw error;
} finally {
  socket?.close();
  child?.kill();
  vite?.kill();
}
