// Installed beside the pinned trees controller by patch-trees-scroll.mjs.
// A draft has a real virtual row, but is never part of a disk snapshot.
let sequence = 0;
export const creationNames = new Set();

export class InlineEditSession {
  constructor(controller, options, emit, close) {
    this.controller = controller;
    this.options = options;
    this.emit = emit;
    this.close = close;
    this.mode = options.mode ?? "create";
    this.initialValue = options.initialValue ?? "";
    this.value = this.initialValue;
    const dot = this.value.lastIndexOf(".");
    this.selection = [0, options.kind === "newFile" && dot > 0 ? dot : this.value.length];
    this.error = null;
    this.busy = false;
    this.disposed = false;
    this.revision = 0;
    this.name = `.litecode-new-${Date.now().toString(36)}-${++sequence}`;
    const parent = options.parentPath.replace(/\/$/, "");
    this.path =
      this.mode === "rename"
        ? options.path
        : `${parent ? parent + "/" : ""}${this.name}${options.kind === "newFolder" ? "/" : ""}`;
    if (this.mode === "create") creationNames.add(this.name);
  }
  setValue(value) {
    if (this.busy || this.disposed) return;
    this.value = value;
    this.revision++;
    this.validation = null;
    clearTimeout(this.timer);
    this.error = this.options.validateSync?.(value) ?? null;
    this.emit();
    if (value && !this.error)
      this.timer = setTimeout(() => {
        void this.check();
      }, 150);
  }
  check() {
    clearTimeout(this.timer);
    if (this.validation) return this.validation;
    const revision = this.revision;
    const value = this.value;
    const syntax = this.options.validateSync?.(value);
    const validation = Promise.resolve()
      .then(() => syntax || this.options.validate(value))
      .catch((error) => error?.message ?? String(error))
      .then((error) => {
        if (!this.disposed && revision === this.revision) {
          if (this.validation === validation) this.validation = null;
          this.error = error ?? null;
          this.emit();
        }
        return error;
      });
    this.validation = validation;
    return validation;
  }
  async commit(blur = false) {
    if (this.busy || this.disposed) return;
    if (!this.value.trim()) {
      this.cancel();
      return;
    }
    if (this.mode === "rename" && this.value === this.initialValue) {
      this.finish(false);
      return;
    }
    const revision = this.revision;
    const error = await this.check();
    if (this.disposed || revision !== this.revision || this.busy) return;
    if (error) {
      if (blur) this.cancel();
      return;
    }
    this.busy = true;
    this.emit();
    try {
      await this.options.onCommit(this.value);
      if (!this.disposed) this.finish(false);
    } catch (error) {
      if (!this.disposed) {
        this.error = error?.message ?? String(error);
        this.busy = false;
        this.validation = null; // Retry must recheck disk, even for the same text.
        this.emit();
      }
    }
  }
  cancel() {
    if (!this.busy) this.finish(true);
  }
  dispose() {
    this.finish(true);
  }
  finish(canceled) {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    creationNames.delete(this.name);
    this.close();
    this.options.onFinish?.();
    if (canceled) this.options.onCancel?.();
  }
}
