import { createSignal } from "solid-js";

export type ToastKind = "success" | "error" | "info";

export interface ToastMessage {
  id: number;
  kind: ToastKind;
  message: string;
}

export interface FeedbackDialog {
  kind: "confirm" | "prompt";
  title: string;
  message: string;
  initialValue?: string;
  resolve: (value: boolean | string | null) => void;
}

const [toasts, setToasts] = createSignal<ToastMessage[]>([]);
const [dialog, setDialog] = createSignal<FeedbackDialog | null>(null);
let nextToastId = 1;

const toast = (message: string, kind: ToastKind = "info") => {
  const id = nextToastId++;
  setToasts(previous => [...previous, { id, kind, message }]);
  window.setTimeout(() => setToasts(previous => previous.filter(item => item.id !== id)), kind === "error" ? 6500 : 3500);
};

const dismissToast = (id: number) => setToasts(previous => previous.filter(item => item.id !== id));

const confirmDialog = (message: string, title = "请确认") => new Promise<boolean>(resolve => {
  setDialog({ kind: "confirm", title, message, resolve: value => resolve(value === true) });
});

const promptDialog = (message: string, initialValue = "", title = "请输入") => new Promise<string | null>(resolve => {
  setDialog({ kind: "prompt", title, message, initialValue, resolve: value => resolve(typeof value === "string" ? value : null) });
});

const resolveDialog = (value: boolean | string | null) => {
  const current = dialog();
  setDialog(null);
  current?.resolve(value);
};

export const feedback = {
  toasts,
  dialog,
  success: (message: string) => toast(message, "success"),
  error: (message: string) => toast(message, "error"),
  info: (message: string) => toast(message, "info"),
  dismissToast,
  confirm: confirmDialog,
  prompt: promptDialog,
  resolveDialog,
};
