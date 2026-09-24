import { describe, expect, it } from "vitest";
import { parseYouTubeUrl } from "./youtube.js";

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
