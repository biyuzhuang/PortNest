import { createSignal } from "solid-js";

const DB_NAME = "portnest-appearance";
const STORE_NAME = "terminal-backgrounds";
const [terminalBackgroundImageUrl, setTerminalBackgroundImageUrl] = createSignal<string | null>(null);
let activeUrl: string | null = null;

const openDb = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export async function saveTerminalBackgroundImage(file: File): Promise<string> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("仅支持 PNG、JPEG 或 WebP 图片");
  if (file.size > 15 * 1024 * 1024) throw new Error("图片大小不能超过 15 MB");
  const id = "terminal-background";
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(file, id);
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
  });
  db.close();
  await loadTerminalBackgroundImage(id);
  return id;
}

export async function loadTerminalBackgroundImage(id?: string) {
  if (!id) { clearObjectUrl(); return; }
  try {
    const db = await openDb();
    const blob = await new Promise<Blob | undefined>((resolve, reject) => {
      const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).get(id);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    db.close();
    clearObjectUrl();
    if (blob) { activeUrl = URL.createObjectURL(blob); setTerminalBackgroundImageUrl(activeUrl); }
  } catch { clearObjectUrl(); }
}

export async function clearTerminalBackgroundImage() {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete("terminal-background");
      request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
    });
    db.close();
  } finally { clearObjectUrl(); }
}

function clearObjectUrl() {
  if (activeUrl) URL.revokeObjectURL(activeUrl);
  activeUrl = null;
  setTerminalBackgroundImageUrl(null);
}

export { terminalBackgroundImageUrl };
