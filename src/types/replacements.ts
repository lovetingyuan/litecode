import type { SearchMatch } from "./types";

export type ReplacementRange = Pick<SearchMatch, "line" | "column" | "endLine" | "endColumn">;
export type ReplacementPlan = ReplacementRange & { text: string };
export type ReplacementEdit = { start: number; end: number; text: string };
