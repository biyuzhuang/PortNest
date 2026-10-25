import { Component, For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { api } from "../utils/api";
import { Icon } from "./Icon";
import "./TextContextMenu.css";

type EditableTarget = HTMLInputElement | HTMLTextAreaElement;

interface MenuState {
  x: number;
  y: number;
  target: EditableTarget;
  selectedText: string;
}

export const TextContextMenu: Component = () => {
  const [menu, setMenu] = createSignal<MenuState | null>(null);

  const updateSelection = (target: EditableTarget) => {
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? 0;
    return target.value.slice(start, end);
  };

  const close = () => setMenu(null);

  const copy = async () => {
    const state = menu();
    if (!state?.selectedText) return;
    await api.writeClipboardText(state.selectedText);
    close();
  };

  const cut = async () => {
    const state = menu();
    if (!state?.selectedText) return;
    await api.writeClipboardText(state.selectedText);
    const start = state.target.selectionStart ?? 0;
    const end = state.target.selectionEnd ?? 0;
    state.target.setRangeText("", start, end, "end");
    state.target.dispatchEvent(new Event("input", { bubbles: true }));
    close();
  };

  const paste = async () => {
    const state = menu();
    if (!state) return;
    const text = await api.readClipboardText();
    const start = state.target.selectionStart ?? state.target.value.length;
    const end = state.target.selectionEnd ?? start;
    state.target.setRangeText(text, start, end, "end");
    state.target.dispatchEvent(new Event("input", { bubbles: true }));
    close();
  };

  const selectAll = () => {
    const state = menu();
    if (!state) return;
    state.target.focus();
    state.target.select();
    close();
  };

  const items = () => {
    const state = menu();
    const hasSelection = Boolean(state?.selectedText);
    return [
      { id: "copy", label: "复制", icon: "copy", shortcut: "Ctrl+C", disabled: !hasSelection, action: () => void copy() },
      { id: "cut", label: "剪切", icon: "edit", shortcut: "Ctrl+X", disabled: !hasSelection, action: () => void cut() },
      { id: "paste", label: "粘贴", icon: "import", shortcut: "Ctrl+V", disabled: false, action: () => void paste() },
      { id: "select-all", label: "全选", icon: "check", shortcut: "Ctrl+A", disabled: false, action: selectAll },
    ] as const;
  };

  onMount(() => {
    const handleContextMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const editable = target?.closest("input, textarea") as EditableTarget | null;
      if (!editable || editable.disabled || editable.readOnly) return;
      event.preventDefault();
      event.stopPropagation();
      editable.focus();
      const selectedText = updateSelection(editable);
      setMenu({
        x: Math.max(8, Math.min(event.clientX, window.innerWidth - 196)),
        y: Math.max(8, Math.min(event.clientY, window.innerHeight - 166)),
        target: editable,
        selectedText,
      });
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (!menu()) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest(".text-context-menu")) return;
      close();
    };
    document.addEventListener("contextmenu", handleContextMenu, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("blur", close);
    onCleanup(() => {
      document.removeEventListener("contextmenu", handleContextMenu, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("blur", close);
    });
  });

  return (
    <Show when={menu()}>
      {state => (
        <Portal>
          <div
            class="text-context-menu"
            style={{ left: `${state().x}px`, top: `${state().y}px` }}
            onMouseDown={event => event.preventDefault()}
          >
            <div class="text-context-caption">操作</div>
            <For each={items()}>{item => (
              <button type="button" disabled={item.disabled} onClick={item.action}>
                <span class="text-context-icon"><Icon name={item.icon as "copy" | "edit" | "import" | "check"} size={13} /></span>
                <span>{item.label}</span>
                <kbd>{item.shortcut}</kbd>
              </button>
            )}</For>
          </div>
        </Portal>
      )}
    </Show>
  );
};
