import type { IExpression } from "@codingame/monaco-vscode-api/vscode/vs/base/common/glob";

export type MatchRange = { start: number; end: number };

export type QuickFile = {
  path: string;
  label: string;
  description: string;
  labelMatches: MatchRange[];
  descriptionMatches: MatchRange[];
};

export type FileSearchMessage =
  | { kind: "workspace"; root: string | null; paths: string[]; excludes?: IExpression }
  | { kind: "open"; root: string | null; paths: string[]; excludes?: IExpression }
  | { kind: "search"; id: number; version: number; query: string };

export type FileSearchReply = { id: number; version: number; files: QuickFile[] };
