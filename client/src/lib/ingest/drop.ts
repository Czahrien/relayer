// Every way of adding things (drop, paste, pickers) produces an IngestRequest.

import { isAudioName, joinedArtist, titleFromFilename } from "@listening-room/shared";

export { isAudioName, titleFromFilename };

export interface IngestFile {
  file: File;
  /** Relative path including the file name, e.g. "Album/CD1/01 Song.flac". */
  path: string;
}

export interface IngestRequest {
  files: IngestFile[];
  links: string[];
  /** Non-audio files that were quietly left out. */
  skipped: number;
}

export interface PreparedFile extends IngestFile {
  title: string;
  artist?: string;
  album?: string;
  discNo?: number;
  trackNo?: number;
}

function partition(files: IngestFile[]): Pick<IngestRequest, "files" | "skipped"> {
  const audio = files.filter((f) => isAudioName(f.file.name));
  return { files: audio, skipped: files.length - audio.length };
}

/** Pulls http(s) links out of dragged or pasted text. */
export function extractLinks(uriList: string, plain: string): string[] {
  const fromUriList = uriList
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const source = fromUriList.length > 0 ? fromUriList : plain.split(/\s+/);
  const links = source.map((s) => s.trim()).filter((s) => /^(https?:\/\/|www\.|youtu\.?be)/i.test(s));
  return [...new Set(links)];
}

/**
 * Reads a drop. Entries and strings are grabbed synchronously, before any
 * await, because the DataTransfer is emptied once the event handler returns.
 */
export function collectFromDataTransfer(dt: DataTransfer): Promise<IngestRequest> {
  const entries: FileSystemEntry[] = [];
  const looseFiles: File[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
    else {
      const file = item.getAsFile();
      if (file) looseFiles.push(file);
    }
  }
  const links =
    entries.length === 0 && looseFiles.length === 0
      ? extractLinks(dt.getData("text/uri-list"), dt.getData("text/plain"))
      : [];

  return (async () => {
    const collected: IngestFile[] = looseFiles.map((file) => ({ file, path: file.name }));
    for (const entry of entries) await walk(entry, collected);
    return { ...partition(collected), links };
  })();
}

/** Reads files from an <input type=file>, including folder pickers. */
export function collectFromFileList(list: FileList | File[]): IngestRequest {
  const files = Array.from(list).map((file) => ({ file, path: file.webkitRelativePath || file.name }));
  return { ...partition(files), links: [] };
}

async function walk(entry: FileSystemEntry, out: IngestFile[]): Promise<void> {
  if (entry.isFile) {
    try {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      out.push({ file, path: entry.fullPath.replace(/^\//, "") });
    } catch {
      // Unreadable entry (permissions, vanished file): skip it.
    }
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns batches; keep reading until an empty batch or large
    // folders are silently truncated.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject)).catch(
        () => [] as FileSystemEntry[],
      );
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, out);
    }
  }
}

// ---- Tags and ordering ----

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Directory path, then disc, then track, then natural filename order (§7). */
export function compareBatch(a: PreparedFile, b: PreparedFile): number {
  return (
    collator.compare(dirname(a.path), dirname(b.path)) ||
    (a.discNo ?? 1) - (b.discNo ?? 1) ||
    (a.trackNo ?? Number.MAX_SAFE_INTEGER) - (b.trackNo ?? Number.MAX_SAFE_INTEGER) ||
    collator.compare(basename(a.path), basename(b.path))
  );
}

const TAG_CONCURRENCY = 4;

/** Reads tags client-side so the queue shows real titles and order at once. */
export async function prepareFiles(files: IngestFile[]): Promise<PreparedFile[]> {
  const { parseBlob } = await import("music-metadata");
  const prepared: PreparedFile[] = new Array(files.length);
  let next = 0;
  async function worker() {
    while (next < files.length) {
      const index = next++;
      const f = files[index]!;
      const base: PreparedFile = { ...f, title: titleFromFilename(f.file.name) };
      try {
        const { common } = await parseBlob(f.file, { skipCovers: true, duration: false, skipPostHeaders: true });
        prepared[index] = {
          ...base,
          title: common.title?.trim() || base.title,
          artist: (joinedArtist(common) ?? common.albumartist)?.trim() || undefined,
          album: common.album?.trim() || undefined,
          discNo: common.disk.no ?? undefined,
          trackNo: common.track.no ?? undefined,
        };
      } catch {
        prepared[index] = base;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(TAG_CONCURRENCY, files.length) }, worker));
  return prepared.sort(compareBatch);
}
