import { describe, expect, it } from "vitest";
import { chatSegments } from "./chatText.js";

describe("chatSegments", () => {
  it("leaves plain text alone", () => {
    expect(chatSegments("this one's great")).toEqual([{ text: "this one's great" }]);
  });

  it("links URLs, keeping trailing punctuation as text", () => {
    expect(chatSegments("see https://example.com/a.")).toEqual([
      { text: "see " },
      { url: "https://example.com/a", youtube: false },
      { text: "." },
    ]);
    expect(chatSegments("(https://example.com/x?y=1)")).toEqual([
      { text: "(" },
      { url: "https://example.com/x?y=1", youtube: false },
      { text: ")" },
    ]);
  });

  it("adds https to www links", () => {
    expect(chatSegments("www.example.com")).toEqual([{ url: "https://www.example.com", youtube: false }]);
  });

  it("marks YouTube links", () => {
    expect(chatSegments("try https://youtu.be/dQw4w9WgXcQ and https://example.com")).toEqual([
      { text: "try " },
      { url: "https://youtu.be/dQw4w9WgXcQ", youtube: true },
      { text: " and " },
      { url: "https://example.com", youtube: false },
    ]);
  });

  it("never links other schemes", () => {
    expect(chatSegments("javascript:alert(1)")).toEqual([{ text: "javascript:alert(1)" }]);
    expect(chatSegments("data:text/html,<b>x</b>")).toEqual([{ text: "data:text/html,<b>x</b>" }]);
    expect(chatSegments("ftp://example.com")).toEqual([{ text: "ftp://example.com" }]);
  });
});
