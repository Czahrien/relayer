import { describe, expect, it } from "vitest";
import { CommandError } from "./room.js";
import { createYoutubeResolver } from "./youtube.js";

const URL = "https://youtu.be/dQw4w9WgXcQ";

function stub(status: number, body: unknown = {}): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("createYoutubeResolver", () => {
  it("uses oEmbed metadata", async () => {
    let requested = "";
    const fetchImpl = (async (input: string) => {
      requested = input;
      return new Response(
        JSON.stringify({ title: "Song", author_name: "Channel", thumbnail_url: "https://i.ytimg.com/vi/x/hq.jpg" }),
      );
    }) as unknown as typeof fetch;
    const info = await createYoutubeResolver(fetchImpl)(URL);
    expect(info).toEqual({
      youtubeId: "dQw4w9WgXcQ",
      title: "Song",
      artist: "Channel",
      artUrl: "https://i.ytimg.com/vi/x/hq.jpg",
    });
    expect(requested).toContain(encodeURIComponent("https://www.youtube.com/watch?v=dQw4w9WgXcQ"));
  });

  it("rejects non-YouTube links", async () => {
    await expect(createYoutubeResolver(stub(200))("https://vimeo.com/1")).rejects.toThrow(CommandError);
  });

  it("rejects videos that don't exist", async () => {
    await expect(createYoutubeResolver(stub(404))(URL)).rejects.toThrow(/doesn't exist/);
  });

  it("adds embed-disabled videos as errors", async () => {
    const info = await createYoutubeResolver(stub(401))(URL);
    expect(info.error).toMatch(/outside YouTube/);
  });

  it("falls back when YouTube is unreachable", async () => {
    const failing = (async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch;
    const info = await createYoutubeResolver(failing)(URL);
    expect(info).toMatchObject({ youtubeId: "dQw4w9WgXcQ", title: "YouTube video" });
    expect(info.error).toBeUndefined();
  });

  it("ignores non-https thumbnails", async () => {
    const info = await createYoutubeResolver(stub(200, { title: "T", thumbnail_url: "http://evil/x.jpg" }))(URL);
    expect(info.artUrl).toBe("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
  });
});
