import type { editor } from "monaco-editor";
import type { Doc, DocumentSnapshot } from "../types/types";

type Confirmed = { metadata: DocumentSnapshot; model: editor.ITextModel | undefined };
type Pending = { model: editor.ITextModel | undefined; version: number; due: number };

function metadata(doc: Doc): DocumentSnapshot {
  return {
    id: doc.id, path: doc.path, version: doc.version, revision: doc.revision,
    encoding: doc.encoding, dirty: doc.dirty, language: doc.language, name: doc.name,
    searchQuery: doc.searchQuery, kind: doc.kind, fileInfo: doc.fileInfo,
  };
}

// Confirmation retains metadata and model identity, never a second body string.
export class DocumentBackups {
  private confirmed = new Map<string, Confirmed>();
  private pending = new Map<string, Pending>();
  private epoch = 0;

  reset() {
    this.confirmed.clear();
    this.pending.clear();
    this.epoch++;
  }

  confirmRestored(doc: Doc, model: editor.ITextModel | undefined) {
    this.confirmed.set(doc.id, { metadata: metadata(doc), model });
    this.pending.delete(doc.id);
  }

  noteChanges(docs: Doc[], models: ReadonlyMap<string, editor.ITextModel>, now = Date.now()) {
    const ids = new Set(docs.map(doc => doc.id));
    for (const id of this.pending.keys()) {
      if (!ids.has(id)) { this.pending.delete(id); }
    }
    for (const doc of docs) {
      const model = models.get(doc.id);
      const confirmed = this.confirmed.get(doc.id);
      if (confirmed && confirmed.model === model && confirmed.metadata.version === doc.version) {
        this.pending.delete(doc.id);
        continue;
      }
      const previous = this.pending.get(doc.id);
      if (!previous || previous.model !== model || previous.version !== doc.version) {
        const large = doc.large || (doc.fileInfo?.size ?? 0) > 20 * 1024 * 1024
          || (model?.getValueLength() ?? 0) > 20 * 1024 * 1024;
        this.pending.set(doc.id, { model, version: doc.version, due: now + (large ? 2000 : 400) });
      }
    }
  }

  nextDeadline() {
    return Math.min(...[...this.pending.values()].map(pending => pending.due));
  }

  capture(docs: Doc[], models: ReadonlyMap<string, editor.ITextModel>, automatic: boolean) {
    const epoch = this.epoch;
    const next = new Map<string, Confirmed>();
    const documents: DocumentSnapshot[] = [];
    const now = Date.now();
    for (const doc of docs) {
      const previous = this.confirmed.get(doc.id);
      if (automatic && (this.pending.get(doc.id)?.due ?? 0) > now) {
        // Keep body and metadata at the same confirmed version while a large
        // document waits; new documents join after their first idle period.
        if (previous) {
          documents.push(previous.metadata);
          next.set(doc.id, previous);
        }
        continue;
      }
      const model = models.get(doc.id);
      const meta = metadata(doc);
      const needsText = !previous || previous.model !== model || previous.metadata.version !== doc.version;
      documents.push(needsText ? { ...meta, text: model?.getValue() ?? "" } : meta);
      next.set(doc.id, { metadata: meta, model });
    }
    return {
      documents,
      acknowledge: () => { if (this.epoch === epoch) { this.confirmed = next; } },
    };
  }
}
