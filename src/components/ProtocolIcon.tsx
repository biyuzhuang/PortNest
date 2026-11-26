import type { Component } from "solid-js";
import { ColorIcon, type ColorIconName } from "./ColorIcon";

interface Props {
  kind: string;
  class?: string;
  /** 不传时按调用处的容器尺寸自适应（默认 17） */
  size?: number;
}

/** 协议 → 彩色图标。未知协议退回终端图标，避免出现空白。 */
function iconFor(kind: string): ColorIconName {
  if (kind === "mysql") return "mysql";
  if (kind === "postgresql") return "postgresql";
  if (kind === "highgo") return "highgo";
  if (kind === "local") return "local";
  if (kind === "docker") return "docker";
  // 只区分「数据库 / 终端」两类的老调用点，统一落到通用数据库圆柱
  if (kind === "database") return "database";
  return "ssh";
}

export const ProtocolIcon: Component<Props> = (props) => (
  <ColorIcon name={iconFor(props.kind)} size={props.size ?? 17} class={props.class} />
);
