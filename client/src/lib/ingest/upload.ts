const CONCURRENCY = 2;

interface Job {
  itemId: string;
  file: File;
}

export interface UploadCallbacks {
  onProgress(itemId: string, fraction: number): void;
  onDone(itemId: string): void;
  onError(itemId: string, message: string): void;
}

/**
 * Uploads files in queue order, two at a time, so the earliest tracks become
 * playable first. XHR rather than fetch, for upload progress events (§7).
 */
export class UploadQueue {
  private readonly pending: Job[] = [];
  private readonly running = new Map<string, XMLHttpRequest>();

  constructor(
    private readonly roomId: string,
    private readonly callbacks: UploadCallbacks,
  ) {}

  enqueue(jobs: Job[]): void {
    this.pending.push(...jobs);
    for (const job of jobs) this.callbacks.onProgress(job.itemId, 0);
    this.pump();
  }

  has(itemId: string): boolean {
    return this.running.has(itemId) || this.pending.some((job) => job.itemId === itemId);
  }

  ids(): string[] {
    return [...this.running.keys(), ...this.pending.map((job) => job.itemId)];
  }

  /** Stops an upload whose item was removed or cleared (§9). */
  abort(itemId: string): void {
    const index = this.pending.findIndex((job) => job.itemId === itemId);
    if (index >= 0) this.pending.splice(index, 1);
    const xhr = this.running.get(itemId);
    if (xhr) {
      this.running.delete(itemId);
      xhr.abort();
    }
    this.callbacks.onDone(itemId);
    this.pump();
  }

  abortAll(): void {
    for (const id of this.ids()) this.abort(id);
  }

  private pump(): void {
    while (this.running.size < CONCURRENCY && this.pending.length > 0) {
      this.start(this.pending.shift()!);
    }
  }

  private start({ itemId, file }: Job): void {
    const xhr = new XMLHttpRequest();
    this.running.set(itemId, xhr);
    const finish = (error?: string) => {
      if (this.running.get(itemId) !== xhr) return; // aborted
      this.running.delete(itemId);
      if (error) this.callbacks.onError(itemId, error);
      this.callbacks.onDone(itemId);
      this.pump();
    };
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) this.callbacks.onProgress(itemId, event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return finish();
      let message = `Upload failed (${xhr.status}).`;
      try {
        message = (JSON.parse(xhr.responseText) as { error?: string }).error ?? message;
      } catch {
        // Keep the generic message.
      }
      // 404/410: the item was removed meanwhile, nothing to report.
      finish(xhr.status === 404 || xhr.status === 410 ? undefined : message);
    };
    xhr.onerror = () => finish(`Couldn't upload “${file.name}”. Check your connection.`);
    xhr.open("PUT", `/api/rooms/${encodeURIComponent(this.roomId)}/items/${encodeURIComponent(itemId)}/file`);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.send(file);
  }
}
