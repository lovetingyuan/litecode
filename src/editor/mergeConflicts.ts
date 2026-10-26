export type ConflictSpan = { start: number; end: number };
export type ConflictRegion = { header: ConflictSpan; content: ConflictSpan; name: string };
export type InlineMergeConflict = {
  range: ConflictSpan;
  current: ConflictRegion;
  incoming: ConflictRegion;
  ancestors: ConflictRegion[];
};
export type ConflictChoice = "current" | "incoming" | "both";

export function parseMergeConflicts(text: string): InlineMergeConflict[] {
  const conflicts: InlineMergeConflict[] = [];
  let pending: {
    current: ConflictRegion;
    ancestors: ConflictRegion[];
    incomingStart?: number;
  } | undefined;
  let offset = 0;
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    const next = newline < 0 ? text.length : newline + 1;
    const end = newline < 0 ? text.length : newline > offset && text[newline - 1] === "\r" ? newline - 1 : newline;
    const line = text.slice(offset, end);
    const header = { start: offset, end };
    const start = /^<<<<<<<(?: (.*))?$/.exec(line);
    const ancestor = /^\|\|\|\|\|\|\|(?: (.*))?$/.exec(line);
    const footer = /^>>>>>>>(?: (.*))?$/.exec(line);
    if (start) {
      if (pending) { break; }
      pending = { current: { header, content: { start: next, end: next }, name: start[1] ?? "" }, ancestors: [] };
    } else if (pending && ancestor) {
      if (pending.incomingStart !== undefined) { pending = undefined; }
      else {
        const previous = pending.ancestors[pending.ancestors.length - 1] ?? pending.current;
        previous.content.end = offset;
        pending.ancestors.push({ header, content: { start: next, end: next }, name: ancestor[1] ?? "" });
      }
    } else if (pending && line === "=======") {
      if (pending.incomingStart !== undefined) { pending = undefined; }
      else {
        (pending.ancestors[pending.ancestors.length - 1] ?? pending.current).content.end = offset;
        pending.incomingStart = next;
      }
    } else if (pending && footer) {
      if (pending.incomingStart !== undefined) {
        conflicts.push({
          range: { start: pending.current.header.start, end: next },
          current: pending.current,
          ancestors: pending.ancestors,
          incoming: { header, content: { start: pending.incomingStart, end: offset }, name: footer[1] ?? "" },
        });
      }
      pending = undefined;
    }
    offset = next;
  }
  return conflicts;
}

export function conflictReplacement(text: string, conflict: InlineMergeConflict, choice: ConflictChoice): string {
  const current = text.slice(conflict.current.content.start, conflict.current.content.end);
  const incoming = text.slice(conflict.incoming.content.start, conflict.incoming.content.end);
  if (choice === "both") { return current + incoming; }
  const content = choice === "current" ? current : incoming;
  return content === "\n" || content === "\r\n" ? "" : content;
}
