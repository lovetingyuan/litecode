import { normalize } from "../editor/documents";
import type { Doc } from "../types/types";
import { isTextDocument } from "../utils/media";

export function isWorkspacePackageDocument(doc: Doc, root: string | null) {
  if (!root || !doc.path || !isTextDocument(doc)) {
    return false;
  }
  const path = normalize(doc.path);
  const base = normalize(root).replace(/\/$/, "");
  return doc.path.replace(/\\/g, "/").endsWith("/package.json") && path.startsWith(`${base}/`);
}
