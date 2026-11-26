import { createSignal } from "solid-js";

/**
 * 整体缩放（外观 · 基础）。
 *
 * 采用「页面级缩放」而不是放大字号：Tauri 里走 WebView 的 setZoom，浏览器预览
 * 退回根元素 `zoom`。两者都会把文字、图标、终端画布、数据库表格一起等比缩放，
 * 且保持布局尺寸与鼠标坐标一致（单纯改 font-size 无法做到）。
 */

export const ZOOM_MIN = 50;
export const ZOOM_MAX = 200;
export const ZOOM_STEP = 10;
export const ZOOM_DEFAULT = 100;

export const zoomLevels: number[] = Array.from(
  { length: (ZOOM_MAX - ZOOM_MIN) / ZOOM_STEP + 1 },
  (_, index) => ZOOM_MIN + index * ZOOM_STEP,
);

const STORAGE_KEY = "portnest-ui-zoom";

const normalize = (value: number) => {
  if (!Number.isFinite(value)) return ZOOM_DEFAULT;
  const stepped = Math.round(value / ZOOM_STEP) * ZOOM_STEP;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, stepped));
};

const readStoredZoom = (): number => {
  if (typeof localStorage === "undefined") return ZOOM_DEFAULT;
  const stored = Number(localStorage.getItem(STORAGE_KEY));
  return Number.isFinite(stored) && stored > 0 ? normalize(stored) : ZOOM_DEFAULT;
};

const [zoom, setZoomSignal] = createSignal<number>(readStoredZoom());
export { zoom };

const zoomChannel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("portnest-ui-zoom") : null;

const isTauri = () =>
  typeof window !== "undefined" && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);

/** 把百分比落到当前 WebView；失败时退回 CSS zoom，保证设置不会「点了没反应」 */
async function applyZoom(percent: number) {
  if (typeof document === "undefined") return;
  const scale = percent / 100;
  if (isTauri()) {
    try {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      await getCurrentWebview().setZoom(scale);
      document.documentElement.style.removeProperty("zoom");
      return;
    } catch {
      // 权限未授予或 API 不可用时继续走 CSS 方案
    }
  }
  document.documentElement.style.zoom = String(scale);
}

export function setUiZoom(value: number) {
  const next = normalize(value);
  setZoomSignal(next);
  localStorage.setItem(STORAGE_KEY, String(next));
  void applyZoom(next);
  zoomChannel?.postMessage(next);
}

/** Ctrl + 滚轮：每一档 10%，到边界即停 */
export function stepUiZoom(direction: 1 | -1) {
  setUiZoom(zoom() + direction * ZOOM_STEP);
}

export function resetUiZoom() {
  setUiZoom(ZOOM_DEFAULT);
}

zoomChannel?.addEventListener("message", event => {
  const next = normalize(Number(event.data));
  setZoomSignal(next);
  void applyZoom(next);
});

export function initUiZoom() {
  if (typeof window !== "undefined") {
    const sync = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      const next = normalize(Number(event.newValue));
      setZoomSignal(next);
      void applyZoom(next);
    };
    window.addEventListener("storage", sync);

    // Ctrl + 滚轮缩放；不按 Ctrl 时保持页面正常滚动
    window.addEventListener(
      "wheel",
      event => {
        if (!event.ctrlKey) return;
        // 捕获阶段截断：终端、表格等内部滚轮不再收到这次事件，避免「又缩放又滚动」
        event.preventDefault();
        event.stopPropagation();
        stepUiZoom(event.deltaY < 0 ? 1 : -1);
      },
      { passive: false, capture: true },
    );
  }
  void applyZoom(zoom());
}
