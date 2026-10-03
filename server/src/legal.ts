import type { FastifyInstance } from "fastify";
import type { Config } from "./config.js";

/** Bump when the wording changes. */
const UPDATED = "3 October 2026";

const LINKS = {
  googlePrivacy: "https://policies.google.com/privacy",
  youtubeTerms: "https://www.youtube.com/t/terms",
  discordPrivacy: "https://discord.com/privacy",
  discordTerms: "https://discord.com/terms",
  license: "https://github.com/czahrien/relayer/blob/main/LICENSE",
};

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** OPERATOR_CONTACT as a link when it is an email address or URL, else as text. */
function contactLine(contact: string | undefined): string {
  if (!contact) return "To reach them, ask whoever shared a room link with you.";
  const safe = escape(contact);
  if (/^[^\s@]+@[^\s@]+$/.test(contact)) return `You can reach them at <a href="mailto:${safe}">${safe}</a>.`;
  if (/^https?:\/\//i.test(contact)) return `You can reach them at <a href="${safe}">${safe}</a>.`;
  return `You can reach them at ${safe}.`;
}

/**
 * Where the pages link. Served by Relayer they sit at /privacy and /terms;
 * standalone (e.g. on GitHub Pages) they are files side by side, with no app to link back to.
 */
interface Site {
  privacy: string;
  terms: string;
  head: string;
  home: string;
  /** Standalone pages say which server they cover, since they aren't on it. */
  covers: string;
}

const SERVED: Site = {
  privacy: "/privacy",
  terms: "/terms",
  head: `<link rel="icon" href="/favicon.svg" type="image/svg+xml">\n`,
  home: ` · <a href="/start">Relayer</a>`,
  covers: "",
};

function standalone(serverUrl: string, config: Config): Site {
  const url = escape(serverUrl);
  const activity = config.discord ? " and its Discord Activity" : "";
  return {
    privacy: "privacy.html",
    terms: "terms.html",
    head: "",
    home: "",
    covers: `<p><strong>This page covers the Relayer server at <a href="${url}">${url}</a>${activity}.</strong> “This server” below means that one.</p>\n`,
  };
}

function page(site: Site, title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
${site.head}<title>${title} · Relayer</title>
<style>
  :root { --bg: #f4f0e8; --ink: #24211c; --ink-2: #5c564c; --line: #d9d1c3; }
  @media (prefers-color-scheme: dark) { :root { --bg: #151412; --ink: #ece6da; --ink-2: #a49d90; --line: #3a362f; } }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.6 system-ui, sans-serif; }
  main { max-width: 680px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 30px; line-height: 1.2; margin: 0 0 4px; }
  h2 { font-size: 19px; margin: 32px 0 8px; }
  p, li { color: var(--ink-2); }
  strong { color: var(--ink); }
  a { color: inherit; text-underline-offset: 3px; }
  .updated { margin-top: 0; font-size: 14px; }
  nav { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--line); font-size: 14px; }
</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p class="updated">Last updated ${UPDATED}</p>
${site.covers}${body}
<nav><a href="${site.privacy}">Privacy policy</a> · <a href="${site.terms}">Terms of service</a>${site.home}</nav>
</main>
</body>
</html>
`;
}

function privacyPolicy(config: Config, site: Site): string {
  const idleMinutes = Math.round(config.roomIdleTtlMs / 60_000);
  const youtubeSearch = config.youtubeApiKey
    ? `<li>When you <strong>search YouTube</strong> or paste a YouTube or playlist link, the server sends the search terms or link to YouTube to look up videos. Recent searches are kept in the server's memory for about 10 minutes so repeats don't have to ask YouTube again.</li>`
    : `<li>When you paste a YouTube link, the server asks YouTube for the video's title.</li>`;
  const discord = config.discord
    ? `
<h2>Using Relayer in Discord</h2>
<p>When you start Relayer as a Discord Activity, Discord asks you to let Relayer know who you are (Discord's <em>identify</em> permission). Relayer then gets your Discord user ID, username, and display name from Discord. It uses your user ID only to check with Discord that you're really in that Activity, and your display name as your name in the room. Relayer doesn't store your user ID or Discord's sign-in token on the server. The token is passed back to the Discord app on your device to finish signing in.</p>
<p>Discord delivers the Activity through its own servers, so Discord's <a href="${LINKS.discordPrivacy}">Privacy Policy</a> also applies. You can remove Relayer's access at any time in Discord, under <strong>User Settings → Authorized Apps</strong>.</p>`
    : "";

  return page(
    site,
    "Privacy policy",
    `
<p>Relayer is a listening room: people who open the same room link hear the same music at the same time. This server is run by its operator, not by the people who write Relayer, and this policy describes what the Relayer software on it does with your information. ${contactLine(config.operatorContact)}</p>
<p>There are no accounts, no advertising, and no analytics. Relayer doesn't sell or share your information except as described below.</p>

<h2>What Relayer handles</h2>
<ul>
<li><strong>Your name</strong> as you enter it${config.discord ? " (or your Discord display name)" : ""}. Everyone in the room sees it in the listener list, next to the tracks you add, and on your chat messages.</li>
<li><strong>Chat messages and room activity</strong>, such as who added, skipped, or removed a track. Everyone in the room sees them.</li>
<li><strong>Files you upload.</strong> They are stored on the server, along with the song details and cover art read from them, so everyone in the room can play them.</li>
<li><strong>What's in the queue</strong>, including tracks from the server's music library and YouTube videos.</li>
<li><strong>Your browser keeps some settings</strong> on your own device: your name, volume, display and notification choices (in local storage), and a random ID that lets the room recognise you when you reconnect (in session storage). Relayer doesn't use cookies.</li>
<li><strong>Server logs.</strong> Like most web servers, this one records each request: its time, the address it came from, and the web address requested. Requested addresses can include room names and YouTube search terms. The operator decides how long logs are kept.</li>
</ul>

<h2>How long it's kept</h2>
<p>Rooms live only in the server's memory. A room and everything in it, including uploaded files, is deleted after nobody has been in it for ${idleMinutes} minutes, and every room is deleted whenever the server restarts. Removing an uploaded track from the queue deletes its file straight away. Server logs are kept as long as the operator chooses.</p>

<h2>YouTube</h2>
<p>Relayer uses YouTube API Services.</p>
<ul>
<li>YouTube videos play in YouTube's own embedded player, which your browser loads straight from YouTube. YouTube may collect information and set cookies as described in the <a href="${LINKS.googlePrivacy}">Google Privacy Policy</a>.</li>
${youtubeSearch}
</ul>
<p>Relayer never signs in to YouTube or reads anything from a YouTube account.</p>
${discord}

<h2>Who can see what</h2>
<p>Rooms are unlisted, not private: anyone with a room's link can join it and see its queue, listeners, and chat, and play its tracks. Share links only with people you'd invite in person.</p>

<h2>Children</h2>
<p>Relayer isn't meant for children under 13.</p>

<h2>Your choices</h2>
<ul>
<li>Use any name you like; it doesn't have to be your real one.</li>
<li>Remove tracks you uploaded from the queue to delete them.</li>
<li>Clear this site's data in your browser to remove the settings it keeps.</li>
<li>For anything in the server's logs, ask the operator.</li>
</ul>

<h2>Changes</h2>
<p>If this policy changes, the date at the top changes too.</p>`,
  );
}

function termsOfService(config: Config, site: Site): string {
  return page(
    site,
    "Terms of service",
    `
<p>These terms cover your use of the Relayer listening room on this server. The server is run by its operator. ${contactLine(config.operatorContact)} By using it, you agree to these terms.</p>

<h2>The service</h2>
<p>Relayer is <a href="${LINKS.license}">free software</a>, and this server is provided as is, without any warranty. It may be slow, unavailable, or changed at any time, and rooms, queues, chat, and uploaded files can disappear without notice (for example, whenever the server restarts). Don't rely on it to keep anything.</p>

<h2>Your content</h2>
<p>Only upload, link, or share music and other content you have the right to share with the people in your room. You keep any rights you have in what you upload. You let the server store it and play it to the people in your room for as long as the room exists.</p>
<p>The operator may remove content, close rooms, or block anyone from the server at any time.</p>

<h2>Acceptable use</h2>
<p>Don't use Relayer to:</p>
<ul>
<li>infringe copyright or anyone else's rights;</li>
<li>harass, threaten, or impersonate people;</li>
<li>share illegal content; or</li>
<li>disrupt, overload, or get around the limits of this server.</li>
</ul>

<h2>Rooms are open to anyone with the link</h2>
<p>Anyone with a room's link can join it and control playback. Share links with care.</p>

<h2>YouTube</h2>
<p>Relayer plays YouTube videos through YouTube API Services. By using Relayer's YouTube features, you agree to be bound by the <a href="${LINKS.youtubeTerms}">YouTube Terms of Service</a>.</p>
${
  config.discord
    ? `
<h2>Discord</h2>
<p>When you use Relayer as a Discord Activity, Discord's <a href="${LINKS.discordTerms}">Terms of Service</a> apply as well.</p>`
    : ""
}

<h2>Liability</h2>
<p>As far as the law allows, the operator and the authors of Relayer aren't liable for any loss or damage that comes from using this server.</p>

<h2>Privacy</h2>
<p>The <a href="${site.privacy}">privacy policy</a> explains what Relayer does with your information.</p>

<h2>Changes</h2>
<p>If these terms change, the date at the top changes too. Using the server after a change means you accept the new terms.</p>`,
  );
}

/** Both pages, written from this server's settings. With `serverUrl`, standalone copies to host elsewhere. */
export function legalPages(config: Config, serverUrl?: string): { privacy: string; terms: string } {
  const site = serverUrl ? standalone(serverUrl, config) : SERVED;
  return { privacy: privacyPolicy(config, site), terms: termsOfService(config, site) };
}

export function registerLegalRoutes(app: FastifyInstance, config: Config): void {
  const { privacy, terms } = legalPages(config);
  app.get("/privacy", async (_request, reply) => reply.type("text/html; charset=utf-8").send(privacy));
  app.get("/terms", async (_request, reply) => reply.type("text/html; charset=utf-8").send(terms));
}
