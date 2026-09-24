import { describe, expect, it } from "vitest";
import { EMBED_BLOCKED_MESSAGE } from "@relayer/shared";
import { CommandError } from "./room.js";
import { fakeYouTube, type FakeVideo } from "./fixtures.js";
import { parseIsoDuration, QUOTA_MESSAGE, YouTubeData } from "./youtubeApi.js";

const VIDEOS: Record<string, FakeVideo> = {
  mamboSun000: { title: "Mambo Sun", channel: "T.Rex - Topic", duration: "PT3M40S" },
  cosmic00000: { title: "Cosmic Dancer", channel: "T.Rex - Topic", duration: "PT4M30S" },
  blocked0000: { title: "Official Video", channel: "LabelVEVO", duration: "PT4M", embeddable: false },
  ageLocked00: { title: "Age Restricted", channel: "Someone", duration: "PT3M", ageRestricted: true },
  liveNow0000: { title: "Live Radio", channel: "Station", duration: "P0D", live: true },
};

describe("parseIsoDuration", () => {
  it.each([
    ["PT3M40S", 220_000],
    ["PT1H2M3S", 3_723_000],
    ["PT45S", 45_000],
    ["P1DT1S", 86_401_000],
    ["P0D", undefined],
    ["", undefined],
    [undefined, undefined],
  ])("%s → %s", (value, expected) => {
    expect(parseIsoDuration(value)).toBe(expected);
  });
});

describe("YouTubeData", () => {
  it("searches, keeping only videos that can play, with durations and clean channel names", async () => {
    const yt = fakeYouTube({ videos: VIDEOS, search: ["mamboSun000", "blocked0000", "ageLocked00", "liveNow0000", "cosmic00000"] });
    const results = await new YouTubeData("key", yt.fetchImpl).search("t rex");
    expect(results).toEqual([
      { youtubeId: "mamboSun000", title: "Mambo Sun", channel: "T.Rex", durationMs: 220_000, thumbnail: "https://i.ytimg.com/vi/mamboSun000/mqdefault.jpg" },
      { youtubeId: "cosmic00000", title: "Cosmic Dancer", channel: "T.Rex", durationMs: 270_000, thumbnail: "https://i.ytimg.com/vi/cosmic00000/mqdefault.jpg" },
    ]);
  });

  it("caches searches for ten minutes", async () => {
    const yt = fakeYouTube({ videos: VIDEOS, search: ["mamboSun000"] });
    let now = 0;
    const api = new YouTubeData("key", yt.fetchImpl, () => now);
    await api.search("T Rex");
    await api.search("  t   rex ");
    expect(yt.calls.filter((c) => c === "search")).toHaveLength(1);
    now = 11 * 60_000;
    await api.search("t rex");
    expect(yt.calls.filter((c) => c === "search")).toHaveLength(2);
  });

  it("says why a video can't play", async () => {
    const yt = fakeYouTube({ videos: VIDEOS });
    const api = new YouTubeData("key", yt.fetchImpl);
    expect((await api.video("blocked0000"))?.unplayable).toBe(EMBED_BLOCKED_MESSAGE);
    expect((await api.video("ageLocked00"))?.unplayable).toMatch(/age-restricted/);
    expect((await api.video("liveNow0000"))?.unplayable).toMatch(/Live streams/);
    const playable = await api.video("mamboSun000");
    expect(playable?.durationMs).toBe(220_000);
    expect(playable?.unplayable).toBeUndefined();
    expect(await api.video("gone0000000")).toBeUndefined();
  });

  it("expands a playlist in order across pages, leaving out what can't play", async () => {
    const items: string[] = Array.from({ length: 60 }, (_, i) => (i % 2 ? "cosmic00000" : "mamboSun000"));
    items[3] = "blocked0000";
    items[7] = "deleted0000"; // not returned by videos.list
    const yt = fakeYouTube({ videos: VIDEOS, playlists: { OLAK5uy_album: { title: "Album - Electric Warrior", items } } });
    const playlist = await new YouTubeData("key", yt.fetchImpl).playlist("OLAK5uy_album");
    expect(playlist.title).toBe("Electric Warrior");
    expect(playlist.videos).toHaveLength(58);
    expect(playlist.skipped).toBe(2);
    expect(playlist.videos.slice(0, 3).map((v) => v.title)).toEqual(["Mambo Sun", "Cosmic Dancer", "Mambo Sun"]);
    expect(yt.calls.filter((c) => c === "playlistItems")).toHaveLength(2);
  });

  it("reports missing playlists and used-up quota in plain words", async () => {
    const missing = fakeYouTube({ videos: VIDEOS });
    await expect(new YouTubeData("key", missing.fetchImpl).playlist("PLnothing00")).rejects.toThrow(/doesn't exist/);
    const quota = fakeYouTube({ videos: VIDEOS, failWith: { status: 403, reason: "quotaExceeded" } });
    const error = await new YouTubeData("key", quota.fetchImpl).search("x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandError);
    expect((error as Error).message).toBe(QUOTA_MESSAGE);
  });
});
