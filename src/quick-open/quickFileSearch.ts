import type { FileSearchMessage, FileSearchReply, QuickFile } from "./quickFiles";

type Job = { id: number; version: number; query: string; accept: (files: QuickFile[]) => void };
type WorkerPort = Pick<Worker, "postMessage" | "terminate"> & {
  onmessage: ((event: MessageEvent<FileSearchReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
};

export class QuickFileSearch {
  private version = 0;
  private sequence = 0;
  private wanted: Job | null = null;
  private running: Job | null = null;
  private failed = false;
  constructor(
    private worker: WorkerPort,
    onError: () => void,
  ) {
    worker.onmessage = ({ data }) => {
      if (data.id !== this.running?.id) {
        return;
      }
      this.running = null;
      const job = this.wanted;
      if (job?.id === data.id && data.version === this.version) {
        this.wanted = null;
        job.accept(data.files);
      }
      this.pump();
    };
    worker.onerror = () => {
      this.failed = true;
      this.running = null;
      const job = this.wanted;
      this.wanted = null;
      worker.terminate();
      onError();
      job?.accept([]);
    };
  }
  update(message: Exclude<FileSearchMessage, { kind: "search" }>) {
    ++this.version;
    this.wanted = null;
    if (!this.failed) {
      this.worker.postMessage(message);
    }
  }
  search(query: string, accept: Job["accept"]) {
    if (this.failed) {
      accept([]);
      return;
    }
    this.wanted = { id: ++this.sequence, version: this.version, query, accept };
    this.pump();
  }
  cancel() {
    this.wanted = null;
  }
  dispose() {
    this.cancel();
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
  }
  private pump() {
    if (this.running || !this.wanted) {
      return;
    }
    this.running = this.wanted;
    const { id, version, query } = this.running;
    this.worker.postMessage({ kind: "search", id, version, query } satisfies FileSearchMessage);
  }
}
