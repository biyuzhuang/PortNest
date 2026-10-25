import { Component, For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { Icon, type IconName } from "./Icon";
import "./AssetContextMenu.css";

export interface AssetMenuAction {
  label: string;
  icon: IconName;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  separatorBefore?: boolean;
  current?: boolean;
  children?: AssetMenuAction[];
  onSelect?: () => void;
}

export interface AssetMenuHeaderAction {
  label: string;
  icon: IconName;
  disabled?: boolean;
  onSelect?: () => void;
}

interface AssetContextMenuProps {
  x: number;
  y: number;
  title?: string;
  headerActions?: AssetMenuHeaderAction[];
  items: AssetMenuAction[];
  onClose: () => void;
}

export const AssetContextMenu: Component<AssetContextMenuProps> = (props) => {
  const [position, setPosition] = createSignal({ x: props.x, y: props.y });
  const [openSubmenu, setOpenSubmenu] = createSignal<AssetMenuAction | null>(null);
  let menuRef: HTMLDivElement | undefined;

  onMount(() => {
    requestAnimationFrame(() => {
      if (!menuRef) return;
      const rect = menuRef.getBoundingClientRect();
      setPosition({
        x: Math.max(8, Math.min(props.x, window.innerWidth - rect.width - 8)),
        y: Math.max(8, Math.min(props.y, window.innerHeight - rect.height - 8)),
      });
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => document.removeEventListener("keydown", onKeyDown));
  });

  const runAction = (item: AssetMenuAction) => {
    if (item.disabled || item.children?.length) return;
    item.onSelect?.();
    props.onClose();
  };

  const prepareSubmenu = (event: MouseEvent, item: AssetMenuAction) => {
    if (!item.children?.length) return;
    setOpenSubmenu(item);
    const row = event.currentTarget as HTMLElement;
    requestAnimationFrame(() => {
      const submenu = row.querySelector<HTMLElement>(":scope > .hexhub-context-submenu");
      if (!submenu) return;
      const rowRect = row.getBoundingClientRect();
      submenu.classList.toggle("open-left", rowRect.right + submenu.offsetWidth > window.innerWidth - 8);
      submenu.classList.toggle("open-up", rowRect.bottom + submenu.offsetHeight > window.innerHeight - 8);
    });
  };

  const renderItems = (items: AssetMenuAction[], submenu = false) => (
    <For each={items}>{item => (
      <>
        <Show when={item.separatorBefore}><div class="hexhub-context-separator" /></Show>
        <div
          class={`hexhub-context-row ${item.children?.length ? "has-submenu" : ""}`}
          onMouseEnter={event => prepareSubmenu(event, item)}
          onMouseLeave={() => { if (item.children?.length) setOpenSubmenu(null); }}
        >
          <button
            type="button"
            class={`hexhub-context-item ${item.disabled ? "disabled" : ""} ${item.current ? "is-current" : ""} ${item.danger ? "danger" : ""}`}
            disabled={item.disabled}
            aria-disabled={item.disabled || undefined}
            onClick={() => runAction(item)}
          >
            <span class="hexhub-context-icon"><Icon name={item.icon} size={15} /></span>
            <span class="hexhub-context-label">{item.label}</span>
            <Show when={item.shortcut}><span class="hexhub-context-shortcut">{item.shortcut}</span></Show>
            <Show when={item.children?.length}><span class="hexhub-context-arrow"><Icon name="chevronRight" size={13} /></span></Show>
          </button>
          <Show when={item.children?.length}>
            <div class={`hexhub-context-submenu ${submenu ? "nested" : ""} ${openSubmenu() === item ? "open" : ""}`}>
              {renderItems(item.children!, true)}
            </div>
          </Show>
        </div>
      </>
    )}</For>
  );

  return (
    <Portal>
      <div class="hexhub-context-overlay" onClick={props.onClose} onContextMenu={event => { event.preventDefault(); props.onClose(); }} />
      <div
        ref={menuRef}
        class="asset-context-menu hexhub-context-menu"
        style={{ left: `${position().x}px`, top: `${position().y}px` }}
        onClick={event => event.stopPropagation()}
        onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
      >
        <div class="hexhub-context-header">
          <strong>{props.title || "操作"}</strong>
          <Show when={props.headerActions?.length}>
            <div class="hexhub-context-header-actions">
              <For each={props.headerActions}>{action => (
                <button type="button" title={action.label} aria-label={action.label} disabled={action.disabled} onClick={() => { action.onSelect?.(); props.onClose(); }}>
                  <Icon name={action.icon} size={14} />
                </button>
              )}</For>
            </div>
          </Show>
        </div>
        <div class="hexhub-context-items">
          {renderItems(props.items)}
        </div>
      </div>
    </Portal>
  );
};
