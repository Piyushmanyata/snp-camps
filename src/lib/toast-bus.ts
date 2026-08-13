export type ToastPayload = { tone: "error" | "success"; message: string };

let listener: ((toast: ToastPayload) => void) | null = null;

export function setToastListener(fn: ((toast: ToastPayload) => void) | null) {
  listener = fn;
}

export function showErrorToast(message: string) {
  listener?.({ tone: "error", message });
}

export function showSuccessToast(message: string) {
  listener?.({ tone: "success", message });
}
