export type ConflictSpan = { start: number; end: number };
export type ConflictRegion = { header: ConflictSpan; content: ConflictSpan; name: string };
export type InlineMergeConflict = {
  range: ConflictSpan;
  current: ConflictRegion;
  incoming: ConflictRegion;
  ancestors: ConflictRegion[];
};
export type ConflictChoice = "current" | "incoming" | "both";
export type PendingConflict = {
  current: ConflictRegion;
  ancestors: ConflictRegion[];
  incomingStart?: number;
};
