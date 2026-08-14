import type { Component, JSX } from "solid-js";

export type IconName = "assets" | "list" | "terminal" | "database" | "table" | "view" | "query" | "play" | "import" | "export" | "trash" | "copy" | "edit" | "chevronRight" | "settings" | "search" | "plus" | "folder" | "refresh" | "more" | "close" | "minimize" | "maximize" | "restore" | "pin" | "key" | "info" | "transfer" | "back";

export const Icon: Component<{ name: IconName; class?: string; size?: number }> = (props) => {
  const paths: Record<IconName, JSX.Element> = {
    assets: <><rect x="3" y="4" width="7" height="7" rx="1.5"/><rect x="14" y="4" width="7" height="7" rx="1.5"/><rect x="3" y="15" width="7" height="5" rx="1.5"/><rect x="14" y="15" width="7" height="5" rx="1.5"/></>,
    list: <><path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1" fill="currentColor" stroke="none"/></>,
    terminal: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/></>,
    database: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7"/></>,
    table: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11M15 9v11M3 14h18"/></>,
    view: <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></>,
    query: <><path d="M5 4h14v12H9l-4 4Z"/><path d="M9 8h6M9 12h4"/></>, play:<path d="m8 5 11 7-11 7Z"/>,
    import:<><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 19h14"/></>, export:<><path d="M12 15V3m0 0 4 4m-4-4L8 7"/><path d="M5 19h14"/></>,
    trash:<><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/></>, copy:<><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></>,
    edit:<><path d="m4 20 4.5-1 10-10-3.5-3.5-10 10Z"/><path d="m13.5 6.5 3.5 3.5"/></>, chevronRight:<path d="m9 6 6 6-6 6"/>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 9 19.37a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.63 15 1.7 1.7 0 0 0 3.08 14H3v-4h.08A1.7 1.7 0 0 0 4.63 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.63 1.7 1.7 0 0 0 10 3.08V3h4v.08A1.7 1.7 0 0 0 15 4.63a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.37 9 1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    plus: <path d="M12 5v14M5 12h14"/>, folder: <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5Z"/>,
    refresh: <><path d="M20 6v5h-5M4 18v-5h5"/><path d="M18.2 9A7 7 0 0 0 6.4 6.4L4 9m16 6-2.4 2.6A7 7 0 0 1 5.8 15"/></>,
    more: <><circle cx="12" cy="5" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="19" r="1" fill="currentColor"/></>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    minimize: <path d="M6 16h12"/>,
    maximize: <rect x="6" y="6" width="12" height="12" rx=".5"/>,
    restore: <><path d="M8 8V6h10v10h-2"/><rect x="5" y="9" width="10" height="10" rx=".5"/></>,
    pin: <path d="m14 4 6 6-3 1-4 4-1 5-2-2-4 4-1-1 4-4-2-2 5-1 4-4Z"/>,
    key: <><circle cx="8" cy="15" r="4"/><path d="m11 12 8-8m-3 3 2 2m-5 1 2 2"/></>, info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></>,
    transfer: <path d="M4 8h15m0 0-4-4m4 4-4 4M20 16H5m0 0 4 4m-4-4 4-4"/>, back: <path d="m15 18-6-6 6-6"/>,
  };
  return <svg class={props.class} width={props.size || 18} height={props.size || 18} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{paths[props.name]}</svg>;
};
