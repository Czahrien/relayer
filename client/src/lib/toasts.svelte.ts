export interface Toast {
  id: number;
  message: string;
  tone: "info" | "error";
}

let nextId = 1;

export const toasts = $state<Toast[]>([]);

export function toast(message: string, tone: Toast["tone"] = "info", ms = 5000): void {
  // Collapse repeats of the same message.
  if (toasts.some((t) => t.message === message)) return;
  const id = nextId++;
  toasts.push({ id, message, tone });
  setTimeout(() => dismissToast(id), ms);
}

export function dismissToast(id: number): void {
  const index = toasts.findIndex((t) => t.id === id);
  if (index >= 0) toasts.splice(index, 1);
}
