import { call, errorMessage } from "../core/bridge";
import { ask } from "../components/dialog";
import { useApp, notify, searchSession, primarySearchId } from "../store/store";
import { checkpoint, models, normalize, relative, basename, patchDoc, restoreDocument, showDocument } from "../editor/documents";
import { monaco } from "../editor/monaco";
import type { SearchMatch, DiskDocument, Query, Mirror } from "../types/types";
import { isTextDocument } from "../utils/media";

type BufferEdit = { before: Mirror; after: string };
type DiskEdit = { path: string; before: string; after: string; encoding: string; revision: string };
type Report = { succeeded: string[]; failed: string[]; remaining: string[]; complete: boolean };
type Recovery = { transactionId: string; root: string | null; paths: string[]; buffers: BufferEdit[]; targetAfter: boolean };
type Direction = "apply" | "undo" | "redo";
type Transaction = { id: string; root: string | null; buffers: BufferEdit[]; direction: Direction | null; finishing: boolean };
const undoStack: Transaction[] = [];
const redoStack: Transaction[] = [];
let pendingApply: Transaction | null = null;
let operations = Promise.resolve();

function serial<T>(action: () => Promise<T>): Promise<T> {
  const next = operations.catch(() => {}).then(action);
  operations = next.then(() => {}, () => {});
  return next;
}

useApp.subscribe((state, previous) => {
  if (state.root !== previous.root) {
    undoStack.length = 0;
    redoStack.length = 0;
    pendingApply = null;
  }
});

function checkRoot(root: string | null) {
  const current = useApp.getState().root;
  if ((root === null ? null : normalize(root)) !== (current === null ? null : normalize(current))) {
    throw new Error("The workspace changed. Open the original folder before retrying this replacement.");
  }
}
function checkBuffers(buffers: BufferEdit[], after: boolean, retry: boolean) {
  for (const buffer of buffers) {
    const doc = useApp.getState().docs[buffer.before.id];
    const m = models.get(buffer.before.id);
    if (!doc || !m || doc.path !== buffer.before.path || doc.encoding !== buffer.before.encoding ||
        (m.getValue() !== (after ? buffer.before.text : buffer.after) &&
          !(retry && m.getValue() === (after ? buffer.after : buffer.before.text)))) {
      throw new Error((doc?.name ?? buffer.before.name ?? "A replacement editor") +
        " changed. Preserve those edits or restore the expected version before retrying.");
    }
  }
}
function applyBuffers(buffers: BufferEdit[], after: boolean) {
  checkBuffers(buffers, after, true);
  for (const buffer of buffers) {
    const m = models.get(buffer.before.id)!;
    const text = after ? buffer.after : buffer.before.text;
    if (m.getValue() === text) { continue; }
    m.pushStackElement();
    m.pushEditOperations([], [{ range: m.getFullModelRange(), text }], () => null);
    m.pushStackElement();
    patchDoc(buffer.before.id, { encoding: buffer.before.encoding });
  }
}
function failure(report: Report) {
  return [...report.failed, ...(report.remaining.length ? ["Still pending: " + report.remaining.join(", ")] : [])].join("\n");
}
async function finish(transaction: Transaction, after: boolean) {
  transaction.finishing = true;
  checkRoot(transaction.root);
  applyBuffers(transaction.buffers, after);
  await checkpoint();
  checkRoot(transaction.root);
  await call("finish_replacement", { transactionId: transaction.id });
  transaction.direction = null;
  transaction.finishing = false;
}
async function hasRecovery(id: string) {
  const records = await call<Recovery[]>("replacement_recovery");
  return records.some((record) => record.transactionId === id);
}

export function replaceMatches(
  matches: SearchMatch[], replacement: string, preserve = false,
  query = searchSession(primarySearchId)!.query, preview = false,
) {
  return serial(() => replace(matches, replacement, preserve, query, preview));
}
async function replace(matches: SearchMatch[], replacement: string, preserve: boolean, query: Query, preview: boolean) {
  if (!preview && (pendingApply || [...undoStack, ...redoStack].some((t) => t.direction))) {
    notify("A workspace replacement is unfinished. Use Search: Retry Interrupted Replacement or Search: Recover Interrupted Replacements.");
    return ["A replacement is unfinished"];
  }
  const root = useApp.getState().root;
  const byFile = new Map<string, SearchMatch[]>();
  matches.forEach((m) => {
    const key = m.documentId ?? normalize(m.path);
    byFile.set(key, [...(byFile.get(key) ?? []), m]);
  });
  const buffers: BufferEdit[] = [];
  const errors: string[] = [];
  const diskEdits: DiskEdit[] = [];
  for (const list of byFile.values()) {
    let temporary: monaco.editor.ITextModel | undefined;
    try {
      const first = list[0];
      const doc = first.documentId
        ? useApp.getState().docs[first.documentId]
        : Object.values(useApp.getState().docs).find(
            (d) => d.path && normalize(d.path) === normalize(first.path),
          );
      if (doc && !isTextDocument(doc)) {
        throw new Error(`${relative(first.path)} is no longer a text document. Search again.`);
      }
      let disk: DiskDocument | undefined;
      if (!doc) {
        disk = await call<DiskDocument>("read_document", { path: first.path });
        temporary = monaco.editor.createModel(disk.text);
      }
      const m = doc ? models.get(doc.id)! : temporary!;
      if (doc && first.version !== null && first.version !== doc.version) {
        throw new Error(`${relative(first.path)} changed after searching. Search again.`);
      }
      const version = m.getVersionId();
      const planned = await call<
        { line: number; column: number; endLine: number; endColumn: number; text: string }[]
      >("replacement_plan", { text: m.getValue(), query, replacement, preserveCase: preserve });
      if (m.getVersionId() !== version) {
        throw new Error(
          `${doc?.name ?? first.path} changed while preparing replacements. Search again.`,
        );
      }
      const edits = list.map((match) => {
        const range = new monaco.Range(match.line, match.column, match.endLine, match.endColumn);
        if (m.getValueInRange(range) !== match.matched) {
          throw new Error(`${relative(match.path)} changed after searching. Search again.`);
        }
        const plan = planned.find(
          (p) =>
            p.line === match.line &&
            p.column === match.column &&
            p.endLine === match.endLine &&
            p.endColumn === match.endColumn,
        );
        if (!plan) {
          throw new Error("Search and replacement ranges changed. Search again before replacing.");
        }
        return { range, text: plan.text };
      });
      const before = m.getValue();
      let after = before;
      for (const edit of [...edits].sort(
        (a, b) =>
          m.getOffsetAt(b.range.getStartPosition()) - m.getOffsetAt(a.range.getStartPosition()),
      )) {
        const start = m.getOffsetAt(edit.range.getStartPosition());
        const end = m.getOffsetAt(edit.range.getEndPosition());
        after = after.slice(0, start) + edit.text + after.slice(end);
      }
      if (preview) {
        window.dispatchEvent(
          new CustomEvent("show-diff", {
            detail: {
              title: `Replace Preview · ${doc?.name ?? basename(first.path)}`,
              before,
              after,
              language: doc?.language ?? "plaintext",
            },
          }),
        );
        return;
      }
      if (doc) {
        buffers.push({
          before: { ...doc, text: before },
          after: after.replace(/\r\n|\r|\n/g, m.getEOL()),
        });
      } else if (disk) {
        diskEdits.push({
          path: first.path,
          before: disk.text,
          after,
          encoding: disk.encoding,
          revision: disk.revision,
        });
      }
    } catch (e) {
      errors.push(errorMessage(e));
    } finally {
      temporary?.dispose();
    }
  }

  if (preview || errors.length || (!buffers.length && !diskEdits.length)) {
    if (errors.length) { notify(errors.join("\n")); }
    return errors;
  }
  const transaction: Transaction = { id: crypto.randomUUID(), root, buffers, direction: "apply", finishing: false };
  pendingApply = transaction; // Keep the identifier even when IPC loses its response.
  try {
    await checkpoint();
    checkRoot(root);
    checkBuffers(buffers, true, false);
    const report = await call<Report>("replace_disk", {
      transactionId: transaction.id, expectedRoot: root, edits: diskEdits, buffers,
    });
    if (!report.complete) { throw new Error(failure(report)); }
    await finish(transaction, true);
    undoStack.push(transaction);
    redoStack.length = 0;
    pendingApply = null;
    notify(report.succeeded.length + " closed file(s) saved; " + buffers.length + " open editor(s) updated. Open editors retain unsaved edits.");
  } catch (error) {
    errors.push(errorMessage(error));
    // A rejected preflight has no journal and changed no file. An unavailable
    // recovery query leaves the ID intact, because the write outcome is unknown.
    try { if (!transaction.finishing && !(await hasRecovery(transaction.id))) { pendingApply = null; } } catch { /* Retry recovery when the backend is available. */ }
    notify(errors.join("\n") + (pendingApply ? "\nThe backup is retained. Retry or recover the interrupted replacement." : ""));
  }
  return errors;
}

export function undoReplacement(redo = false) {
  return serial(async () => {
    if (pendingApply) { notify("Recover or retry the unfinished replacement first."); return; }
    const from = redo ? redoStack : undoStack;
    const to = redo ? undoStack : redoStack;
    const transaction = from[from.length - 1];
    if (!transaction) { return; }
    const direction = redo ? "redo" : "undo";
    if (transaction.direction && transaction.direction !== direction) {
      notify("An operation in the other direction is unfinished. Retry or recover it first.");
      return;
    }
    const retry = transaction.direction === direction;
    try {
      checkRoot(transaction.root);
      checkBuffers(transaction.buffers, redo, retry);
      await checkpoint();
      transaction.direction = direction;
      if (!transaction.finishing) {
        const report = await call<Report>(retry ? "resume_replacement" : "replay_replacement", {
          transactionId: transaction.id, redo,
        });
        if (!report.complete) { throw new Error(failure(report)); }
      }
      await finish(transaction, redo);
      from.pop();
      to.push(transaction);
    } catch (error) {
      // A whole group stays on its original stack until every file and buffer
      // has reached the target and its durable completion marker is confirmed.
      try { if (!transaction.finishing && !(await hasRecovery(transaction.id))) { transaction.direction = null; } } catch { /* Preserve unknown outcomes. */ }
      notify(errorMessage(error));
    }
  });
}

export function retryReplacement() {
  return serial(async () => {
    const transaction = pendingApply ?? [...undoStack, ...redoStack].find((t) => t.direction);
    if (!transaction) {
      notify("Use Search: Recover Interrupted Replacements to inspect backups from a previous session.");
      return;
    }
    const direction = transaction.direction!;
    try {
      checkRoot(transaction.root);
      const after = direction !== "undo";
      checkBuffers(transaction.buffers, after, true);
      await checkpoint();
      if (!transaction.finishing) {
        const report = await call<Report>("resume_replacement", { transactionId: transaction.id });
        if (!report.complete) { throw new Error(failure(report)); }
      }
      await finish(transaction, after);
      if (direction === "apply") {
        undoStack.push(transaction); redoStack.length = 0; pendingApply = null;
      } else {
        const from = direction === "undo" ? undoStack : redoStack;
        const to = direction === "undo" ? redoStack : undoStack;
        from.splice(from.indexOf(transaction), 1); to.push(transaction);
      }
      notify("Workspace replacement completed.");
    } catch (error) { notify(errorMessage(error)); }
  });
}

export function recoverInterruptedReplacements() {
  return serial(async () => {
    const records = await call<Recovery[]>("replacement_recovery");
    for (const record of records) {
      const choice = await ask(
        "检测到未完成的工作区替换",
        "文件快照和操作记录已保留。恢复操作前状态时，将检查文件是否被外部修改。",
        ["稍后处理", "恢复操作前状态", "保留现状"],
        { items: record.paths, itemsLabel: "Affected files" },
      );
      if (!choice || choice === "稍后处理") { continue; }
      try {
        if (choice !== "保留现状") {
          checkRoot(record.root);
          for (const buffer of record.buffers) {
            if (!models.has(buffer.before.id)) {
              if (buffer.before.path && Object.values(useApp.getState().docs).some((doc) => doc.path && normalize(doc.path) === normalize(buffer.before.path!))) {
                throw new Error("A replacement file is open in a different editor. Its edits were preserved; resolve that editor before recovering.");
              }
              restoreDocument(buffer.before);
              showDocument(buffer.before.id, { pinned: true });
            }
          }
          await checkpoint();
          checkBuffers(record.buffers, true, true);
        }
        const report = await call<Report>("recover_replacement", { transactionId: record.transactionId, keep: choice === "保留现状" });
        if (!report.complete) { throw new Error(failure(report)); }
        if (choice !== "保留现状") {
          const updated = (await call<Recovery[]>("replacement_recovery")).find((r) => r.transactionId === record.transactionId);
          if (!updated) { throw new Error("The recovery record changed. Inspect the retained backup before retrying."); }
          await finish({ id: updated.transactionId, root: updated.root, buffers: updated.buffers, direction: "apply", finishing: false }, updated.targetAfter);
        }
        if (pendingApply?.id === record.transactionId) { pendingApply = null; }
        for (const stack of [undoStack, redoStack]) {
          const index = stack.findIndex((t) => t.id === record.transactionId);
          if (index >= 0) {
            if (choice === "保留现状") { stack.splice(index, 1); } else { stack[index].direction = null; stack[index].finishing = false; }
          }
        }
        notify("恢复记录已处理，备份仍保留。");
      } catch (error) { notify(errorMessage(error) + "\n恢复尚未完成，备份已保留。"); }
    }
  });
}
