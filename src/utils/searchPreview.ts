import type { SearchMatch } from "../types/types";

export function searchPreview(match: SearchMatch) {
  const text = match.preview.split(/\r?\n/)[0];
  const start = Math.min(text.length, Math.max(0, match.column - 1));
  const end = match.endLine === match.line ? Math.max(start, match.endColumn - 1) : text.length;
  // Keep the hit visible even when it is far into a minified or deeply indented line.
  let offset = Math.max(0, Math.min(start, text.search(/\S|$/)), start - 24);
  if (offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] ?? "")) {
    offset--;
  }
  return {
    before: text.slice(offset, start),
    matched: text.slice(start, end),
    after: text.slice(end),
    clipped: offset > 0 && text.slice(0, offset).trim().length > 0,
  };
}
