import { describe, expect, it } from "vitest";
import { isYouTubeLink, parseYouTubePlaylistUrl, parseYouTubeUrl } from "./youtube.js";

const ID = "dQw4w9WgXcQ";

describe("parseYouTubeUrl", () => {
  it.each([
    [`https://www.youtube.com/watch?v=${ID}`, ID],
    [`https://youtube.com/watch?v=${ID}&t=42s`, ID],
    [`https://m.youtube.com/watch?v=${ID}`, ID],
    [`http://www.youtube.com/watch?feature=share&v=${ID}`, ID],
    [`www.youtube.com/watch?v=${ID}`, ID],
    [`https://youtu.be/${ID}`, ID],
    [`https://youtu.be/${ID}?si=abc&t=10`, ID],
    [`https://www.youtube.com/shorts/${ID}`, ID],
    [`https://www.youtube.com/embed/${ID}?autoplay=1`, ID],
    [`https://www.youtube-nocookie.com/embed/${ID}`, ID],
    [`https://music.youtube.com/watch?v=${ID}&list=RDAMVM${ID}`, ID],
    [`https://www.youtube.com/watch?v=${ID}&list=PL1234567890`, ID],
    [`  https://youtu.be/${ID}  `, ID],
    [`https://www.youtube.com/live/${ID}`, ID],
    ["https://www.youtube.com/playlist?list=PL1234567890", null],
    ["https://www.youtube.com/watch?v=short", null],
    ["https://www.youtube.com/", null],
    [`https://vimeo.com/${ID}`, null],
    [`https://notyoutube.com/watch?v=${ID}`, null],
    [`https://youtube.com.evil.example/watch?v=${ID}`, null],
    [`javascript:alert(1)//youtu.be/${ID}`, null],
    ["just some text", null],
    ["", null],
  ])("%s → %s", (url, expected) => {
    expect(parseYouTubeUrl(url)).toBe(expected);
  });
});

describe("parseYouTubePlaylistUrl", () => {
  const LIST = "OLAK5uy_ktIG_lU06uGTq4dwpDuurDU-DcykrLuE4";
  it.each([
    [`https://music.youtube.com/playlist?list=${LIST}&si=dq80ds-Ud5T1AKX6`, LIST],
    [`https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG`, "PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG"],
    [`youtube.com/playlist?list=${LIST}`, LIST],
    // A video within a playlist is the video.
    [`https://music.youtube.com/watch?v=${ID}&list=${LIST}`, null],
    ["https://www.youtube.com/playlist", null],
    ["https://www.youtube.com/playlist?list=a", null],
    [`https://example.com/playlist?list=${LIST}`, null],
  ])("%s → %s", (url, expected) => {
    expect(parseYouTubePlaylistUrl(url)).toBe(expected);
  });

  it("recognizes both kinds of link", () => {
    expect(isYouTubeLink(`https://music.youtube.com/playlist?list=${LIST}`)).toBe(true);
    expect(isYouTubeLink(`https://youtu.be/${ID}`)).toBe(true);
    expect(isYouTubeLink("https://example.com")).toBe(false);
  });
});
