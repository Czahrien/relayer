// Browser notifications for song changes and chat (SPEC §8). They're shown
// only while the room tab isn't in view, and need a secure context (HTTPS).

export type NotificationSupport = "supported" | "needs-https" | "unsupported";

export function notificationSupport(): NotificationSupport {
  if (!window.isSecureContext) return "needs-https";
  // iOS Safari has no Notification in normal tabs (only for Home Screen apps).
  return "Notification" in window ? "supported" : "unsupported";
}

export function notificationPermission(): NotificationPermission {
  return notificationSupport() === "supported" ? Notification.permission : "denied";
}

/** Asks for permission; must be called from a click. */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (notificationSupport() !== "supported") return "denied";
  if (Notification.permission !== "default") return Notification.permission;
  const result = await Notification.requestPermission();
  if (result === "granted") void registerWorker();
  return result;
}

let worker: Promise<ServiceWorkerRegistration | null> | null = null;

/**
 * Android Chrome only shows notifications through a service worker. Ours
 * handles notification clicks and nothing else (no caching, no fetches).
 */
function registerWorker(): Promise<ServiceWorkerRegistration | null> {
  worker ??= "serviceWorker" in navigator
    ? navigator.serviceWorker.register("/notifications-sw.js").then(
        () => navigator.serviceWorker.ready,
        () => null,
      )
    : Promise.resolve(null);
  return worker;
}

export interface RoomNotification {
  title: string;
  body: string;
  /** Notifications with the same tag replace each other. */
  tag: string;
  /** An image URL, e.g. album art (made absolute here). */
  icon?: string;
}

/** Whether the room is out of view, which is when notifications are useful. */
export function roomOutOfView(): boolean {
  return document.visibilityState === "hidden" || !document.hasFocus();
}

export async function showNotification(n: RoomNotification): Promise<void> {
  if (notificationPermission() !== "granted") return;
  const options: NotificationOptions = {
    body: n.body,
    tag: n.tag,
    icon: n.icon ? new URL(n.icon, location.href).href : undefined,
    data: { url: location.href },
  };
  const registration = await registerWorker();
  if (registration) {
    await registration.showNotification(n.title, options).catch(() => {});
    return;
  }
  try {
    const notification = new Notification(n.title, options);
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    // Some browsers only allow worker notifications; nothing more to try.
  }
}
