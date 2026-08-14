import type { Component } from "solid-js";

interface Props {
  kind: string;
  class?: string;
}

export const ProtocolIcon: Component<Props> = (props) => (
  <svg
    class={props.class}
    viewBox="0 0 24 24"
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    {props.kind === "mysql" || props.kind === "database" ? (
      <>
        <ellipse cx="12" cy="5.5" rx="7" ry="3" />
        <path d="M5 5.5v6c0 1.65 3.13 3 7 3s7-1.35 7-3v-6" />
        <path d="M5 11.5v6c0 1.65 3.13 3 7 3s7-1.35 7-3v-6" />
      </>
    ) : props.kind === "local" ? (
      <>
        <rect x="3" y="3.5" width="18" height="17" rx="2.5" />
        <path d="M3 8h18M7 6h.01M10 6h.01" />
        <path d="m7 12 2.5 2.5L7 17M12 17h5" />
      </>
    ) : props.kind === "ssh" || props.kind === "terminal" ? (
      <>
        <rect x="3" y="4.5" width="18" height="15" rx="1.8" />
        <path d="m7 9 3 3-3 3" />
        <path d="M12.5 15H17" />
        <path d="M16.5 4.5V3M19 4.5V3" />
      </>
    ) : (
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="M9 9h6v6H9z" />
      </>
    )}
  </svg>
);
