// Test fixtures: tagged audio files built in memory (no ffmpeg needed).

export interface FixtureTags {
  title?: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  track?: string; // "1" or "1/10"
  disc?: string;
  year?: string;
  cover?: { mime: string; data: Buffer };
}

/** A 1×1 PNG. */
export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function frame(id: string, body: Buffer): Buffer {
  const header = Buffer.alloc(10);
  header.write(id, 0, "latin1");
  header.writeUInt32BE(body.length, 4); // ID3v2.3 frame sizes are plain integers
  return Buffer.concat([header, body]);
}

function textFrame(id: string, text: string): Buffer {
  // Encoding 1: UTF-16 with a byte-order mark, so accents survive.
  return frame(id, Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from(text, "utf16le")]));
}

/** An ID3v2.3 tag. */
export function id3(tags: FixtureTags): Buffer {
  const frames: Buffer[] = [];
  const text: [keyof FixtureTags, string][] = [
    ["title", "TIT2"],
    ["artist", "TPE1"],
    ["albumArtist", "TPE2"],
    ["album", "TALB"],
    ["track", "TRCK"],
    ["disc", "TPOS"],
    ["year", "TYER"],
  ];
  for (const [key, id] of text) {
    const value = tags[key];
    if (typeof value === "string") frames.push(textFrame(id, value));
  }
  if (tags.cover) {
    frames.push(
      frame(
        "APIC",
        Buffer.concat([
          Buffer.from([0]), // Latin-1 description
          Buffer.from(`${tags.cover.mime}\0`, "latin1"),
          Buffer.from([3]), // front cover
          Buffer.from([0]), // empty description
          tags.cover.data,
        ]),
      ),
    );
  }
  const body = Buffer.concat(frames);
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]); // "ID3" v2.3
  // Syncsafe size: 7 bits per byte.
  header[6] = (body.length >> 21) & 0x7f;
  header[7] = (body.length >> 14) & 0x7f;
  header[8] = (body.length >> 7) & 0x7f;
  header[9] = body.length & 0x7f;
  return Buffer.concat([header, body]);
}

/**
 * A mono WAV of silence with an `id3 ` chunk. `formatCode` 1 is PCM (playable
 * everywhere); 2 is ADPCM, which the codec check rejects.
 */
export function taggedWav(tags: FixtureTags, options: { seconds?: number; formatCode?: number } = {}): Buffer {
  const sampleRate = 8000;
  const dataBytes = Math.round((options.seconds ?? 1) * sampleRate) * 2;
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0);
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(options.formatCode ?? 1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * 2, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  const data = Buffer.alloc(8 + dataBytes);
  data.write("data", 0);
  data.writeUInt32LE(dataBytes, 4);

  const tag = id3(tags);
  const pad = tag.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
  const id3Chunk = Buffer.alloc(8);
  id3Chunk.write("id3 ", 0);
  id3Chunk.writeUInt32LE(tag.length, 4);

  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0);
  riff.write("WAVE", 8);
  const body = Buffer.concat([fmt, data, id3Chunk, tag, pad]);
  riff.writeUInt32LE(4 + body.length, 4);
  return Buffer.concat([riff, body]);
}
