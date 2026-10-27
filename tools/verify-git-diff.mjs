import assert from "node:assert/strict";
import path from "node:path";

export async function verifyGitDiff({ page, resources, action, inspect, section, file, waitPage, checks, run }) {
  const monacoUrl = () => page.evaluate(() => performance.getEntriesByType("resource")
    .find((entry) => new URL(entry.name).pathname === "/src/editor/monaco.ts").name);
  const monaco = await monacoUrl();
  const released = (uris) => waitPage(async ({ url, uris }) => {
    const { monaco } = await import(url);
    return uris.every((uri) => !monaco.editor.getModel(monaco.Uri.parse(uri)));
  }, { url: monaco, uris });
  const snapshot = (groupId) => page.evaluate(async ({ documents, store, groupId }) => {
    const { diffEditors } = await import(documents);
    const state = (await import(store)).useApp.getState();
    const group = state.groups.find((g) => g.id === (groupId ?? state.activeGroup));
    const editor = diffEditors.get(group.id)?.editor;
    const pair = editor?.getModel();
    return {
      id: group.active,
      group: group.id,
      before: pair?.original.getValue(),
      after: pair?.modified.getValue(),
      original: pair?.original.uri.toString(),
      modified: pair?.modified.uri.toString(),
      originalReadOnly: editor?.getOriginalEditor().getRawOptions().readOnly,
      modifiedReadOnly: editor?.getModifiedEditor().getRawOptions().readOnly,
    };
  }, { documents: resources.documents, store: resources.store, groupId });
  const ready = async () => {
    await page.locator(".git-diff-host .monaco-diff-editor").waitFor();
    await waitPage(async (url) => {
      const { diffEditors } = await import(url);
      return [...diffEditors.values()].every(({ editor }) => editor.getLineChanges()?.length);
    }, resources.documents);
  };
  const assertContents = (actual, expected, message) => {
    // Git refreshes may replace snapshot models; displayed contents and editability must persist.
    for (const key of ["id", "group", "before", "after", "originalReadOnly", "modifiedReadOnly"]) {
      assert.equal(actual[key], expected[key], `${message}: ${key}`);
    }
  };
  const focusSides = async (expected) => {
    const group = page.locator(`[data-group-id="${expected.group}"]`);
    for (const side of ["original", "modified", "original", "modified", "original"]) {
      await group.locator(`.git-diff-host .editor.${side} .view-lines`).click({ position: { x: 40, y: 8 } });
      await page.keyboard.press("Home");
      await page.keyboard.press("Shift+End");
      // Model-service releases run in microtasks after the focus/selection event.
      assertContents(await snapshot(expected.group), expected, `Clicking ${side} must preserve both diff contents`);
    }
    await page.keyboard.type("must stay read only");
    assertContents(await snapshot(expected.group), expected, "The original remains read-only");
  };

  await ready();
  const working = await snapshot();
  assert.equal(working.before.replace(/\r/g, ""), "staged\n");
  assert.equal(working.after.replace(/\r/g, ""), "working\n");
  assert.equal(working.originalReadOnly, true);
  assert.equal(working.modifiedReadOnly, false);
  await focusSides(working);
  await page.getByRole("button", { name: "Use Inline Diff", exact: true }).click();
  assertContents(await snapshot(), working, "Inline diff preserves contents");
  await page.getByRole("button", { name: "Use Side by Side Diff", exact: true }).click();
  await focusSides(working);
  checks.push("Worktree diff survives real clicks, selections, focus changes and inline/side-by-side toggles");

  await section("Staged Changes").getByRole("option", { name: file, exact: true }).click();
  await ready();
  await released([working.original]);
  const staged = await snapshot();
  assert.equal(staged.before.replace(/\r/g, ""), "base\n");
  assert.equal(staged.after.replace(/\r/g, ""), "staged\n");
  assert.equal(staged.originalReadOnly, true);
  assert.equal(staged.modifiedReadOnly, true);
  await focusSides(staged);
  checks.push("Staged diff retains both private read-only models while either side is focused");

  await section("Changes").getByRole("option", { name: file, exact: true }).click();
  await ready();
  await released([staged.original, staged.modified]);
  const reopened = await snapshot();
  assert.equal(reopened.before, working.before);
  assert.equal(reopened.after, working.after);
  const modified = page.locator(".git-diff-host .editor.modified .view-lines");
  await modified.click({ position: { x: 40, y: 8 } });
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("temporary edit");
  assert.match((await snapshot()).after, /temporary edit/);
  for (let undo = 0; undo < 3 && (await snapshot()).after !== working.after; undo++) {
    await page.keyboard.press("Control+z");
  }
  assert.equal((await snapshot()).after, working.after);
  await page.keyboard.press("Control+s");
  await waitPage(async (url) => !Object.values((await import(url)).useApp.getState().docs).some((d) => d.dirty), resources.store);

  await action("documents", "splitGroup");
  await waitPage(async (url) => (await import(url)).diffEditors.size === 2, resources.documents);
  const split = await snapshot();
  await focusSides(split);
  await action("documents", "closeGroup", split.group);
  await ready();
  await released([split.original]);
  assertContents(await snapshot(reopened.group), reopened, "Closing a split must preserve the other diff and shared source");
  const remaining = await snapshot(reopened.group);
  const state = await inspect();
  await action("documents", "closeDocument", state.active);
  await released([remaining.original, remaining.modified]);
  await section("Changes").getByRole("option", { name: file, exact: true }).click();
  await ready();
  const final = await snapshot();
  assert.equal(final.before, working.before);
  assert.equal(final.after, working.after);
  await focusSides(final);
  checks.push("Shared source supports typing/undo/save; split close and tab reopen preserve diff contents");

  // Pause after retaining a model to exercise actual React effect cancellation.
  await page.evaluate(async () => {
    const url = performance.getEntriesByType("resource")
      .find((entry) => new URL(entry.name).pathname.endsWith("/monaco-vscode-api/services.js")).name;
    const { getService, ITextModelService } = await import(url);
    // The service itself is a lazy proxy; intercept its actual reference collection.
    const collection = (await getService(ITextModelService)).asyncModelCollection;
    const original = collection.acquire;
    window.__gitDiffRestore = () => { collection.acquire = original; };
    collection.acquire = async function (resource) {
      const reference = await original.call(this, resource);
      const gate = window.__gitDiffGate;
      if (gate?.armed && resource.startsWith("inmemory:") && !gate.existing.includes(resource)) {
        gate.armed = false;
        gate.pending = true;
        await gate.wait;
      }
      return reference;
    };
  });
  for (const cancel of ["switch", "close"]) {
    await page.evaluate(async (url) => {
      const { monaco } = await import(url);
      let release;
      const wait = new Promise((resolve) => { release = resolve; });
      window.__gitDiffGate = {
        armed: true, pending: false, release, wait,
        existing: monaco.editor.getModels().map((m) => m.uri.toString()),
      };
    }, monaco);
    await section("Staged Changes").getByRole("option", { name: file, exact: true }).click();
    await waitPage(() => window.__gitDiffGate.pending);
    const pending = await page.evaluate(async (url) => {
      const { monaco } = await import(url);
      return monaco.editor.getModels().filter((m) => m.uri.scheme === "inmemory").map((m) => m.uri.toString());
    }, monaco);
    assert.equal(pending.length, 2, "Both staged models exist while initialization is paused");
    if (cancel === "switch") {
      await section("Changes").getByRole("option", { name: file, exact: true }).click();
      await ready();
    } else {
      await action("documents", "closeDocument", (await inspect()).active);
    }
    await page.evaluate(() => window.__gitDiffGate.release());
    await released(pending);
    if (cancel === "close") {
      assert.equal(await page.locator(".git-diff-host .monaco-diff-editor").count(), 0);
      await section("Changes").getByRole("option", { name: file, exact: true }).click();
      await ready();
    }
    const active = await snapshot();
    assert.equal(active.before, working.before);
    assert.equal(active.after, working.after);
    await focusSides(active);
  }
  await page.evaluate(() => { window.__gitDiffRestore(); delete window.__gitDiffGate; delete window.__gitDiffRestore; });
  await page.screenshot({ path: path.join(run, "diff-focus.png") });
  checks.push("Switching/closing during reference acquisition cancels stale editors and releases all private models");
}
