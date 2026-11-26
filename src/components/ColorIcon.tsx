import type { Component, JSX } from "solid-js";

/**
 * 彩色图标集。
 *
 * 与 `Icon` 的区别：`Icon` 是跟随文字颜色的单色线条，用于「操作类」图标；
 * 这里是有固定配色的「类型/对象」图标（MySQL、表、视图、文件夹……），
 * 在浅色和深色皮肤下都保持品牌色，只靠透明度表达禁用态。
 *
 * 所有图形都画在 24×24 网格上，尺寸通过内联样式给，避免被旧的
 * `svg { width: 12px }` 之类的规则压小。
 */
export type ColorIconName =
  | "mysql"
  | "postgresql"
  | "highgo"
  | "ssh"
  | "local"
  | "docker"
  | "folder"
  | "folderOpen"
  | "database"
  | "table"
  | "view"
  | "query"
  | "er"
  | "fx"
  | "assets"
  | "list"
  | "terminal"
  | "ai"
  | "settings"
  | "power"
  | "alert"
  | "loading";

const shapes: Record<ColorIconName, () => JSX.Element> = {
  mysql: () => (
    <>
      <rect width="24" height="24" rx="5.6" fill="#0E7A93" />
      <ellipse cx="12" cy="7.3" rx="5.3" ry="2.2" fill="#fff" />
      <path d="M6.7 7.3v9.3c0 1.2 2.4 2.2 5.3 2.2s5.3-1 5.3-2.2V7.3z" fill="#fff" />
      <path
        d="M6.7 11c0 1.2 2.4 2.2 5.3 2.2s5.3-1 5.3-2.2M6.7 14.7c0 1.2 2.4 2.2 5.3 2.2s5.3-1 5.3-2.2"
        fill="none"
        stroke="#0E7A93"
        stroke-width="1.5"
      />
    </>
  ),
  postgresql: () => (
    <>
      <rect width="24" height="24" rx="5.6" fill="#336791" />
      <ellipse cx="7.9" cy="10.3" rx="2.9" ry="3.3" fill="#B9CCDF" />
      <ellipse cx="16.1" cy="10.3" rx="2.9" ry="3.3" fill="#B9CCDF" />
      <ellipse cx="12" cy="9.7" rx="2.7" ry="3.4" fill="#fff" />
      <path d="M12 12.3v5.1c0 1.4 1 2.3 2.2 2.3" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" />
      <circle cx="10.9" cy="8.7" r=".72" fill="#336791" />
      <circle cx="13.1" cy="8.7" r=".72" fill="#336791" />
    </>
  ),
  highgo: () => (
    <>
      <rect width="24" height="24" rx="5.6" fill="#14776E" />
      <text
        x="12"
        y="16.2"
        text-anchor="middle"
        font-family="Segoe UI, Arial, sans-serif"
        font-size="9.6"
        font-weight="700"
        letter-spacing="-.3"
        fill="#fff"
      >
        HG
      </text>
    </>
  ),
  ssh: () => (
    <>
      <rect width="24" height="24" rx="5.6" fill="#454F5E" />
      <path d="M7.6 8.4 11 11.8 7.6 15.2" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M13 15.4h4.2" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" />
    </>
  ),
  local: () => (
    <>
      <rect width="24" height="24" rx="5.6" fill="#1E9E68" />
      <rect x="4.5" y="5.6" width="15" height="10.2" rx="1.9" fill="#fff" />
      <path
        d="M7.5 8.7 9.9 10.9 7.5 13.1M11.4 13.2h3.2"
        fill="none"
        stroke="#1E9E68"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path d="M12 15.8v2.4M8.6 18.6h6.8" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" />
    </>
  ),
  docker: () => (
    <>
      <rect width="24" height="24" rx="5.6" fill="#1D8FE1" />
      <rect x="7.4" y="9.4" width="2.7" height="2.7" rx=".4" fill="#fff" />
      <rect x="11" y="9.4" width="2.7" height="2.7" rx=".4" fill="#fff" />
      <rect x="14.6" y="9.4" width="2.7" height="2.7" rx=".4" fill="#fff" />
      <rect x="11" y="6.3" width="2.7" height="2.7" rx=".4" fill="#fff" />
      <path d="M13.2 6.3h3.2c.6 0 1.1.4 1.2 1" fill="none" stroke="#fff" stroke-width="1.1" stroke-linecap="round" />
      <path d="M3.6 13h16.2c.4 2.9-2 5.3-5.4 5.3H9.5c-2.9 0-5.3-2.1-5.9-5.3z" fill="#fff" />
      <path d="M4.4 12.2 2.6 10.7l.5 2.5z" fill="#fff" />
    </>
  ),
  // 文件夹沿用设计稿提供的 SVG（1024 网格，等比缩到 24）
  folder: () => (
    <g transform="scale(.0234375)">
      <path
        d="M918.673 883H104.327C82.578 883 65 867.368 65 848.027V276.973C65 257.632 82.578 242 104.327 242h814.346C940.422 242 958 257.632 958 276.973v571.054C958 867.28 940.323 883 918.673 883z"
        fill="#FFE9B4"
      />
      <path
        d="M512 411H65V210.37C65 188.597 82.598 171 104.371 171h305.92c17.4 0 32.71 11.334 37.681 28.036L512 411z"
        fill="#FFB02C"
      />
      <path
        d="M918.673 883H104.327C82.578 883 65 865.42 65 843.668V335.332C65 313.58 82.578 296 104.327 296h814.346C940.422 296 958 313.58 958 335.332v508.336C958 865.32 940.323 883 918.673 883z"
        fill="#FFCA28"
      />
    </g>
  ),
  // 展开态：前板下移，露出里面浅色的「内页」
  folderOpen: () => (
    <g transform="scale(.0234375)">
      <path
        d="M918.673 883H104.327C82.578 883 65 867.368 65 848.027V276.973C65 257.632 82.578 242 104.327 242h814.346C940.422 242 958 257.632 958 276.973v571.054C958 867.28 940.323 883 918.673 883z"
        fill="#FFE9B4"
      />
      <path
        d="M512 411H65V210.37C65 188.597 82.598 171 104.371 171h305.92c17.4 0 32.71 11.334 37.681 28.036L512 411z"
        fill="#FFB02C"
      />
      <rect x="65" y="470" width="893" height="413" rx="70" fill="#FFCA28" />
    </g>
  ),
  database: () => (
    <>
      <ellipse cx="12" cy="6.4" rx="6.5" ry="2.7" fill="#A6CF6B" />
      <path d="M5.5 6.4v11.2c0 1.5 2.9 2.7 6.5 2.7s6.5-1.2 6.5-2.7V6.4z" fill="#7CB342" />
      <path
        d="M5.5 11.3c0 1.5 2.9 2.7 6.5 2.7s6.5-1.2 6.5-2.7M5.5 15.6c0 1.5 2.9 2.7 6.5 2.7s6.5-1.2 6.5-2.7"
        fill="none"
        stroke="#A6CF6B"
        stroke-width="1.4"
      />
    </>
  ),
  table: () => (
    <>
      <path
        d="M5.4 3.8h13.2a2.2 2.2 0 0 1 2.2 2.2v12a2.2 2.2 0 0 1-2.2 2.2H5.4a2.2 2.2 0 0 1-2.2-2.2V6a2.2 2.2 0 0 1 2.2-2.2z"
        fill="#fff"
        stroke="#A9CFC9"
        stroke-width=".9"
      />
      <path d="M3.2 6.6A2.2 2.2 0 0 1 5.4 4.4h13.2a2.2 2.2 0 0 1 2.2 2.2v2.6H3.2z" fill="#2FB3A3" />
      <path d="M3.2 9.2h17.6M9 9.6v10.6M15.2 9.6v10.6M3.2 14.2h17.6" fill="none" stroke="#7FD1C8" stroke-width="1.05" />
    </>
  ),
  view: () => (
    <>
      <path
        d="M5.4 3.4h13.2a2 2 0 0 1 2 2v10.2a2 2 0 0 1-2 2H5.4a2 2 0 0 1-2-2V5.4a2 2 0 0 1 2-2z"
        fill="#fff"
        stroke="#A9CFC9"
        stroke-width=".9"
      />
      <path d="M3.4 6.2a2 2 0 0 1 2-2h13.2a2 2 0 0 1 2 2v2.3H3.4z" fill="#2FB3A3" />
      <path d="M3.4 8.5h17.2M8.8 8.9v8.7M14.6 8.9v8.7" fill="none" stroke="#7FD1C8" stroke-width="1" />
      <circle cx="18.2" cy="17.6" r="4.1" fill="#3B82F6" stroke="#fff" stroke-width="1.3" />
      <circle cx="18.2" cy="17.6" r="1.5" fill="#fff" />
    </>
  ),
  query: () => (
    <>
      <path
        d="M5 3.2h9.6a2 2 0 0 1 2 2v11.4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5.2a2 2 0 0 1 2-2z"
        fill="#fff"
        stroke="#B7CBEA"
        stroke-width=".9"
      />
      <path d="M6.2 7.4h8.4M6.2 10.8h6.4" fill="none" stroke="#8FB4E8" stroke-width="1.4" stroke-linecap="round" />
      <circle cx="15.6" cy="15.4" r="4" fill="#fff" stroke="#3B82F6" stroke-width="1.9" />
      <path d="m18.6 18.4 2.5 2.5" fill="none" stroke="#3B82F6" stroke-width="2.2" stroke-linecap="round" />
    </>
  ),
  er: () => (
    <>
      <path d="M6.6 7.2 17.4 8.6M6.6 7.2l2.7 9.4M17.4 8.6l-8.1 8" fill="none" stroke="#8FB4E8" stroke-width="1.3" />
      <circle cx="6.4" cy="6.8" r="2.7" fill="#3B82F6" />
      <circle cx="17.8" cy="8.4" r="2.7" fill="#3B82F6" />
      <circle cx="9.5" cy="17" r="2.7" fill="#3B82F6" />
      <circle cx="6.4" cy="6.8" r="1" fill="#fff" />
      <circle cx="17.8" cy="8.4" r="1" fill="#fff" />
      <circle cx="9.5" cy="17" r="1" fill="#fff" />
    </>
  ),
  fx: () => (
    <>
      <rect x="2.4" y="4.2" width="19.2" height="15.6" rx="3.2" fill="#F2A521" />
      <text
        x="12"
        y="15.7"
        text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="10"
        font-style="italic"
        font-weight="700"
        fill="#fff"
      >
        fx
      </text>
    </>
  ),
  assets: () => (
    <>
      <rect x="3.2" y="3.2" width="7.6" height="7.6" rx="2" fill="#4C8DF6" />
      <rect x="13.2" y="3.2" width="7.6" height="7.6" rx="2" fill="#8FB8F9" />
      <rect x="3.2" y="13.2" width="7.6" height="7.6" rx="2" fill="#8FB8F9" />
      <rect x="13.2" y="13.2" width="7.6" height="7.6" rx="2" fill="#4C8DF6" />
    </>
  ),
  list: () => (
    <>
      <g stroke="#7C8DA0" stroke-width="1.9" stroke-linecap="round" fill="none">
        <path d="M9 6.5h11M9 12h11M9 17.5h11" />
      </g>
      <g fill="#7C8DA0">
        <circle cx="4.4" cy="6.5" r="1.4" />
        <circle cx="4.4" cy="12" r="1.4" />
        <circle cx="4.4" cy="17.5" r="1.4" />
      </g>
    </>
  ),
  terminal: () => (
    <>
      <rect width="24" height="24" rx="5.6" fill="#454F5E" />
      <path d="M7.6 8.4 11 11.8 7.6 15.2" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M13 15.4h4.2" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" />
    </>
  ),
  ai: () => (
    <>
      <path d="m11.6 3.2 1.7 4.6 4.6 1.7-4.6 1.7-1.7 4.6-1.7-4.6L5.3 9.5l4.6-1.7z" fill="#8B5CF6" />
      <path d="m18.3 14.2.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9z" fill="#E4529B" />
      <path d="m6.2 15.4.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z" fill="#A78BFA" />
    </>
  ),
  settings: () => (
    <path
      fill="#6B7280"
      fill-rule="evenodd"
      d="M19.26 10.59L19.26 13.41L16.79 13.74L16.62 14.16L18.13 16.14L16.14 18.13L14.16 16.62L13.74 16.79L13.41 19.26L10.59 19.26L10.26 16.79L9.84 16.62L7.86 18.13L5.87 16.14L7.38 14.16L7.21 13.74L4.74 13.41L4.74 10.59L7.21 10.26L7.38 9.84L5.87 7.86L7.86 5.87L9.84 7.38L10.26 7.21L10.59 4.74L13.41 4.74L13.74 7.21L14.16 7.38L16.14 5.87L18.13 7.86L16.62 9.84L16.79 10.26ZM14.85 12.00L14.78 12.63L14.57 13.24L14.23 13.78L13.78 14.23L13.24 14.57L12.63 14.78L12.00 14.85L11.37 14.78L10.76 14.57L10.22 14.23L9.77 13.78L9.43 13.24L9.22 12.63L9.15 12.00L9.22 11.37L9.43 10.76L9.77 10.22L10.22 9.77L10.76 9.43L11.37 9.22L12.00 9.15L12.63 9.22L13.24 9.43L13.78 9.77L14.23 10.22L14.57 10.76L14.78 11.37L14.85 12.00Z"
    />
  ),
  power: () => (
    <>
      <g fill="none" stroke="#22A06B" stroke-width="2" stroke-linecap="round">
        <path d="M12 3.4v8.2" />
        <path d="M6.9 6.6a7.2 7.2 0 1 0 10.2 0" />
      </g>
    </>
  ),
  alert: () => (
    <>
      <path d="M12 3.6 21.2 19.5a.9.9 0 0 1-.8 1.4H3.6a.9.9 0 0 1-.8-1.4z" fill="#EF4E4E" />
      <path d="M12 9.4v4.4" stroke="#fff" stroke-width="2" stroke-linecap="round" />
      <circle cx="12" cy="17.4" r="1.1" fill="#fff" />
    </>
  ),
  loading: () => (
    <>
      <g fill="none" stroke="#E39A1B" stroke-width="2.2" stroke-linecap="round">
        <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      </g>
      <path d="M17.4 3.6v3.2h-3.2" fill="none" stroke="#E39A1B" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
    </>
  ),
};

export const ColorIcon: Component<{ name: ColorIconName; size?: number; class?: string }> = (props) => {
  const size = () => props.size ?? 18;
  return (
    <svg
      class={props.class}
      data-cicon="1"
      viewBox="0 0 24 24"
      width={size()}
      height={size()}
      style={{ width: `${size()}px`, height: `${size()}px`, display: "block", flex: "none" }}
      aria-hidden="true"
    >
      {shapes[props.name]()}
    </svg>
  );
};
