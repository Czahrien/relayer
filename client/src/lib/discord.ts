import type { DiscordSDK } from "@discord/embedded-app-sdk";
import type { DiscordConfig, DiscordSession } from "@relayer/shared";

/** Discord adds frame_id (with instance_id and others) to an Activity's URL (SPEC §15). */
export const inDiscord = new URLSearchParams(location.search).has("frame_id");
// Lets CSS adapt to Discord's frames, e.g. the fixed-size picture-in-picture view.
if (inDiscord) document.documentElement.classList.add("discord");

/** Discord's proxy fails request bodies from 128 MiB up (measured 2026-10-02), before they reach the server. */
export const DISCORD_MAX_UPLOAD_BYTES = 128 * 1024 * 1024;

export interface Activity {
  sdk: DiscordSDK;
  roomId: string;
  /** The user's Discord display name. */
  name: string;
  /** The room's ordinary web address, for "Open in browser". */
  webUrl: string;
}

async function json<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "Relayer didn't respond.");
  return body;
}

/**
 * Handshake, sign-in, and room lookup for an Activity launch. Every launch and
 * reload (pop-out reloads the iframe) lands in the same room for the instance.
 */
export async function startActivity(): Promise<Activity> {
  // Imported here so browsers outside Discord never download the SDK.
  const [{ DiscordSDK }, { clientId }] = await Promise.all([
    import("@discord/embedded-app-sdk"),
    fetch("/api/discord").then((r) => json<DiscordConfig>(r)),
  ]);
  const sdk = new DiscordSDK(clientId);
  await sdk.ready();

  const { code } = await sdk.commands.authorize({
    client_id: clientId,
    response_type: "code",
    state: "",
    prompt: "none",
    scope: ["identify"],
  });
  const session = await json<DiscordSession>(
    await fetch("/api/discord/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, instanceId: sdk.instanceId }),
    }),
  );
  // Needed for SDK commands such as the invite dialog.
  await sdk.commands.authenticate({ access_token: session.accessToken });
  return { sdk, roomId: session.roomId, name: session.name, webUrl: session.webUrl };
}
