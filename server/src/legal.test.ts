import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { legalPages, registerLegalRoutes } from "./legal.js";

const BASE: Config = {
  port: 0,
  dataDir: "/tmp/unused",
  maxUploadBytes: 1,
  maxRoomBytes: 1,
  roomIdleTtlMs: 90 * 60_000,
  createRoomOnJoin: false,
  libraryRescanMs: 1,
};

async function get(config: Config, url: string): Promise<string> {
  const app = Fastify();
  registerLegalRoutes(app, config);
  const res = await app.inject({ method: "GET", url });
  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toMatch(/^text\/html/);
  return res.body;
}

describe("privacy policy and terms", () => {
  it("describe this server's settings", async () => {
    const plain = await get(BASE, "/privacy");
    expect(plain).toContain("for 90 minutes");
    expect(plain).toContain("ask whoever shared a room link");
    expect(plain).toContain("https://policies.google.com/privacy");
    expect(plain).not.toContain("Discord");
    expect(plain).not.toContain("search YouTube");

    const full = await get(
      { ...BASE, youtubeApiKey: "k", discord: { clientId: "1", clientSecret: "s", botToken: "b", guildIds: new Set(["g"]) } },
      "/privacy",
    );
    expect(full).toContain("Using Relayer in Discord");
    expect(full).toContain("search YouTube");
  });

  it("link the YouTube terms, and Discord's only when the Activity is on", async () => {
    const terms = await get(BASE, "/terms");
    expect(terms).toContain("https://www.youtube.com/t/terms");
    expect(terms).not.toContain("discord.com/terms");
  });

  it("can be written standalone, naming the server they cover", () => {
    const { privacy, terms } = legalPages(BASE, "https://relayer.example.com");
    expect(privacy).toContain('the Relayer server at <a href="https://relayer.example.com">');
    expect(terms).toContain('<a href="privacy.html">privacy policy</a>');
    expect(privacy + terms).not.toMatch(/href="\//);
  });

  it("show the operator's contact safely", async () => {
    expect(await get({ ...BASE, operatorContact: "ops@example.com" }, "/terms")).toContain(
      '<a href="mailto:ops@example.com">ops@example.com</a>',
    );
    const hostile = await get({ ...BASE, operatorContact: '<script>alert("x")</script>' }, "/privacy");
    expect(hostile).not.toContain("<script>");
    expect(hostile).toContain("&#60;script&#62;");
  });
});
