import { Component, For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { Icon } from "./Icon";
import "./SelectMenu.css";

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

interface SelectMenuProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  class?: string;
}

type MenuPosition = { left: number; top: number; width: number; maxHeight: number; openUp: boolean };

export const SelectMenu: Component<SelectMenuProps> = props => {
  let trigger: HTMLButtonElement | undefined;
  let panel: HTMLDivElement | undefined;
  const [open, setOpen] = createSignal(false);
  const [highlighted, setHighlighted] = createSignal(-1);
  const [position, setPosition] = createSignal<MenuPosition>({ left: 0, top: 0, width: 0, maxHeight: 280, openUp: false });
  const selected = () => props.options.find(option => option.value === props.value);
  const selectedIndex = () => props.options.findIndex(option => option.value === props.value);

  const updatePosition = () => {
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportPadding = 8;
    const spaceBelow = window.innerHeight - rect.bottom - viewportPadding;
    const spaceAbove = rect.top - viewportPadding;
    const openUp = spaceBelow < 190 && spaceAbove > spaceBelow;
    const width = Math.min(Math.max(rect.width, 184), window.innerWidth - viewportPadding * 2);
    const left = Math.max(viewportPadding, Math.min(rect.left, window.innerWidth - width - viewportPadding));
    setPosition({
      left,
      top: openUp ? rect.top - 5 : rect.bottom + 5,
      width,
      maxHeight: Math.max(120, Math.min(288, openUp ? spaceAbove : spaceBelow)),
      openUp,
    });
  };

  const openMenu = () => {
    if (props.disabled) return;
    updatePosition();
    setHighlighted(selectedIndex());
    setOpen(true);
  };

  const closeMenu = () => setOpen(false);

  const choose = (option: SelectOption) => {
    if (option.disabled) return;
    props.onChange(option.value);
    closeMenu();
    trigger?.focus();
  };

  const moveHighlight = (direction: 1 | -1) => {
    const enabledIndexes = props.options
      .map((option, index) => option.disabled ? -1 : index)
      .filter(index => index >= 0);
    if (enabledIndexes.length === 0) return;
    const current = highlighted();
    const currentPosition = enabledIndexes.indexOf(current);
    const nextPosition = currentPosition < 0
      ? (direction === 1 ? 0 : enabledIndexes.length - 1)
      : (currentPosition + direction + enabledIndexes.length) % enabledIndexes.length;
    setHighlighted(enabledIndexes[nextPosition]);
  };

  const handleTriggerKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open()) openMenu();
      moveHighlight(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open()) {
        const option = props.options[highlighted()];
        if (option) choose(option);
      } else {
        openMenu();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
    }
  };

  onMount(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!open()) return;
      const target = event.target as Node | null;
      if (target && (trigger?.contains(target) || panel?.contains(target))) return;
      closeMenu();
    };
    const handleViewportChange = () => {
      if (!open()) return;
      if (!trigger?.isConnected) {
        closeMenu();
        return;
      }
      updatePosition();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("resize", handleViewportChange);
    onCleanup(() => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("scroll", handleViewportChange, true);
      window.removeEventListener("resize", handleViewportChange);
    });
  });

  return (
    <div class={`app-select ${open() ? "open" : ""} ${props.disabled ? "disabled" : ""} ${props.class || ""}`}>
      <button
        ref={trigger}
        type="button"
        class="app-select-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open()}
        aria-label={props.ariaLabel}
        disabled={props.disabled}
        onClick={() => open() ? closeMenu() : openMenu()}
        onKeyDown={handleTriggerKeyDown}
      >
        <span class={`app-select-value ${selected() ? "" : "placeholder"}`}>
          {selected()?.label || props.placeholder || "请选择"}
        </span>
        <Icon name="chevronDown" size={14} class="app-select-chevron" />
      </button>
      <Show when={open()}>
        <Portal>
          <div
            ref={panel}
            class={`app-select-popover ${position().openUp ? "open-up" : ""}`}
            style={{
              left: `${position().left}px`,
              top: `${position().top}px`,
              width: `${position().width}px`,
              "max-height": `${position().maxHeight}px`,
              transform: position().openUp ? "translateY(-100%)" : "none",
            }}
            onMouseDown={event => event.preventDefault()}
          >
            <div class="app-select-list" role="listbox" aria-label={props.ariaLabel}>
              <For each={props.options}>{(option, index) => (
                <button
                  type="button"
                  role="option"
                  class={`app-select-option ${option.value === props.value ? "selected" : ""} ${highlighted() === index() ? "highlighted" : ""}`}
                  aria-selected={option.value === props.value}
                  disabled={option.disabled}
                  onMouseEnter={() => setHighlighted(index())}
                  onClick={() => choose(option)}
                >
                  <span class="app-select-option-copy">
                    <strong>{option.label}</strong>
                    <Show when={option.description}><small>{option.description}</small></Show>
                  </span>
                  <Show when={option.value === props.value}><Icon name="check" size={14} /></Show>
                </button>
              )}</For>
            </div>
          </div>
        </Portal>
      </Show>
    </div>
  );
};
