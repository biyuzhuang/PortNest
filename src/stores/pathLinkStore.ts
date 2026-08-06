import { createSignal } from "solid-js";

// 按 sessionKey 记录终端 cwd，供 FileManager 联动跟踪。
const [cwdBySession, setCwdBySession] = createSignal<Record<string, string>>({});
const [unknownBySession, setUnknownBySession] = createSignal<Record<string, boolean>>({});

export const pathLinkStore = {
  getCwd: (sessionKey: string): string | undefined => cwdBySession()[sessionKey],
  cwdForSession: (sessionKey: string): string | undefined => cwdBySession()[sessionKey],
  setCwd: (sessionKey: string, cwd: string) => {
    setCwdBySession(previous => ({ ...previous, [sessionKey]: cwd }));
    if (unknownBySession()[sessionKey]) {
      setUnknownBySession(previous => {
        const next = { ...previous };
        delete next[sessionKey];
        return next;
      });
    }
  },
  isUnknown: (sessionKey: string): boolean => !!unknownBySession()[sessionKey],
  setUnknown: (sessionKey: string) => {
    setUnknownBySession(previous => ({ ...previous, [sessionKey]: true }));
  },
  clear: (sessionKey: string) => {
    setCwdBySession(previous => {
      const next = { ...previous };
      delete next[sessionKey];
      return next;
    });
    setUnknownBySession(previous => {
      const next = { ...previous };
      delete next[sessionKey];
      return next;
    });
  },
};
