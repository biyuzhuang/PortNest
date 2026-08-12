import type { Component } from "solid-js";

interface Props {
  kind: "terminal" | "database";
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
    {props.kind === "terminal" ? (
      <>
        <rect x="3" y="4.5" width="18" height="15" rx="1.8" />
        <path d="m7 9 3 3-3 3" />
        <path d="M12.5 15H17" />
      </>
    ) : (
      <>
        <ellipse cx="12" cy="5.5" rx="7" ry="3" />
        <path d="M5 5.5v6c0 1.65 3.13 3 7 3s7-1.35 7-3v-6" />
        <path d="M5 11.5v6c0 1.65 3.13 3 7 3s7-1.35 7-3v-6" />
      </>
    )}
  </svg>
);
