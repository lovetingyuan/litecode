import type {
  ConflictSpan,
  ConflictChoice,
  InlineMergeConflict,
  PendingConflict,
} from "../types/mergeConflicts";
export type { ConflictSpan, ConflictChoice, InlineMergeConflict } from "../types/mergeConflicts";

function conflictLineEnd(text: string, offset: number, newline: number) {
  let end;
  if (newline < 0) {
    end = text.length;
  } else if (newline > offset && text[newline - 1] === "\r") {
    end = newline - 1;
  } else {
    end = newline;
  }

  return end;
}

function appendConflictAncestor(
  pending: PendingConflict,
  name: string,
  header: ConflictSpan,
  next: number,
  offset: number,
) {
  if (pending.incomingStart !== undefined) {
    return undefined;
  } else {
    const previous = pending.ancestors[pending.ancestors.length - 1] ?? pending.current;
    previous.content.end = offset;
    pending.ancestors.push({
      header,
      content: { start: next, end: next },
      name,
    });
  }
  return pending;
}

function beginIncomingConflict(pending: PendingConflict, next: number, offset: number) {
  if (pending.incomingStart !== undefined) {
    return undefined;
  } else {
    (pending.ancestors[pending.ancestors.length - 1] ?? pending.current).content.end = offset;
    pending.incomingStart = next;
  }
  return pending;
}

function appendCompletedConflict(
  conflicts: InlineMergeConflict[],
  pending: PendingConflict,
  header: ConflictSpan,
  next: number,
  offset: number,
  footer: RegExpExecArray,
) {
  if (pending.incomingStart !== undefined) {
    conflicts.push({
      range: { start: pending.current.header.start, end: next },
      current: pending.current,
      ancestors: pending.ancestors,
      incoming: {
        header,
        content: { start: pending.incomingStart, end: offset },
        name: footer[1] ?? "",
      },
    });
  }
}

export function parseMergeConflicts(text: string): InlineMergeConflict[] {
  const conflicts: InlineMergeConflict[] = [];
  let pending: PendingConflict | undefined;
  let offset = 0;
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    const next = newline < 0 ? text.length : newline + 1;
    const end = conflictLineEnd(text, offset, newline);
    const line = text.slice(offset, end);
    const header = { start: offset, end };
    const start = /^<<<<<<<(?: (.*))?$/.exec(line);
    const ancestor = /^\|\|\|\|\|\|\|(?: (.*))?$/.exec(line);
    const footer = /^>>>>>>>(?: (.*))?$/.exec(line);
    if (start) {
      if (pending) {
        break;
      }
      pending = {
        current: { header, content: { start: next, end: next }, name: start[1] ?? "" },
        ancestors: [],
      };
    } else if (pending && ancestor) {
      pending = appendConflictAncestor(pending, ancestor[1] ?? "", header, next, offset);
    } else if (pending && line === "=======") {
      pending = beginIncomingConflict(pending, next, offset);
    } else if (pending && footer) {
      appendCompletedConflict(conflicts, pending, header, next, offset, footer);
      pending = undefined;
    }
    offset = next;
  }
  return conflicts;
}

export function conflictReplacement(
  text: string,
  conflict: InlineMergeConflict,
  choice: ConflictChoice,
): string {
  const current = text.slice(conflict.current.content.start, conflict.current.content.end);
  const incoming = text.slice(conflict.incoming.content.start, conflict.incoming.content.end);
  if (choice === "both") {
    return current + incoming;
  }
  const content = choice === "current" ? current : incoming;
  return content === "\n" || content === "\r\n" ? "" : content;
}
