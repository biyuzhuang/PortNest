import type { Component } from "solid-js";
import "./BrandMark.css";

export const BrandMark: Component<{ size?: number; class?: string }> = (props) => (
  <svg
    class={`brand-mark ${props.class || ""}`.trim()}
    width={props.size ?? 22}
    height={props.size ?? 22}
    viewBox="0 0 1024 1024"
    aria-hidden="true"
  >
    <rect class="brand-mark-tile" x="0" y="0" width="1024" height="1024" rx="220" stroke-width="10" />
    <path class="brand-mark-ring" d="M 771.8 362 A 300 300 0 1 1 589.6 222.2" fill="none" stroke-width="96" stroke-linecap="round" />
    <path class="brand-mark-glyph" d="M 390 390 L 520 512 L 390 634" fill="none" stroke-width="92" stroke-linecap="round" stroke-linejoin="round" />
    <rect class="brand-mark-glyph-fill" x="596" y="435" width="118" height="150" rx="22" />
  </svg>
);
