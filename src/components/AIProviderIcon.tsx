import type { Component, JSX } from "solid-js";
import openaiIcon from "../assets/providers/openai.svg";
import anthropicIcon from "../assets/providers/anthropic.svg";
import deepseekIcon from "../assets/providers/deepseek.svg";
import kimiIcon from "../assets/providers/kimi.svg";
import glmIcon from "../assets/providers/glm.png";
import openrouterIcon from "../assets/providers/openrouter.svg";
import alibabaIcon from "../assets/providers/alibaba.svg";
import volcanoIcon from "../assets/providers/volcano.png";
import hunyuanIcon from "../assets/providers/hunyuan.svg";
import minimaxIcon from "../assets/providers/minimax.svg";
import xiaomiIcon from "../assets/providers/xiaomi.svg";
import ollamaIcon from "../assets/providers/ollama.svg";
import geminiIcon from "../assets/providers/gemini.svg";

type ProviderVisual = {
  color: string;
  background: string;
  /** 官方/品牌彩色图标；除自定义供应商外均使用图片渲染。 */
  icon?: string;
  fallback?: JSX.Element;
};

const PROVIDER_VISUALS: Record<string, ProviderVisual> = {
  openai: { color: "#10a37f", background: "rgba(16, 163, 127, .10)", icon: openaiIcon },
  anthropic: { color: "#d97757", background: "rgba(217, 119, 87, .12)", icon: anthropicIcon },
  deepseek: { color: "#4d6bfe", background: "rgba(77, 107, 254, .10)", icon: deepseekIcon },
  kimi: { color: "#7c5cff", background: "rgba(124, 92, 255, .10)", icon: kimiIcon },
  glm: { color: "#111827", background: "rgba(17, 24, 39, .08)", icon: glmIcon },
  openrouter: { color: "#8b5cf6", background: "rgba(139, 92, 246, .10)", icon: openrouterIcon },
  alibaba: { color: "#ff6a00", background: "rgba(255, 106, 0, .10)", icon: alibabaIcon },
  volcano: { color: "#0066ff", background: "rgba(0, 102, 255, .10)", icon: volcanoIcon },
  tencent: { color: "#0053e0", background: "rgba(0, 83, 224, .09)", icon: hunyuanIcon },
  minimax: { color: "#ff5c35", background: "rgba(255, 92, 53, .10)", icon: minimaxIcon },
  xiaomi_mimo: { color: "#ff6900", background: "rgba(255, 105, 0, .10)", icon: xiaomiIcon },
  ollama: { color: "#9a6b4f", background: "rgba(154, 107, 79, .10)", icon: ollamaIcon },
  gemini: { color: "#4285f4", background: "rgba(66, 133, 244, .10)", icon: geminiIcon },
  custom: {
    color: "#64748b",
    background: "rgba(100, 116, 139, .12)",
    fallback: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="2.2" /><circle cx="15" cy="17" r="2.2" /></>,
  },
};

export const AIProviderIcon: Component<{ provider: string; size?: number; class?: string }> = (props) => {
  const visual = () => PROVIDER_VISUALS[props.provider] || PROVIDER_VISUALS.custom;
  const iconSize = () => Math.max(14, Math.min(21, props.size || 18));
  return (
    <span
      class={`ai-provider-logo ${props.class || ""}`}
      style={{
        "--provider-color": visual().color,
        "--provider-background": visual().background,
        "--provider-icon-size": `${iconSize()}px`,
      }}
      aria-hidden="true"
    >
      {visual().icon ? (
        <img class="ai-provider-logo-image" src={visual().icon} alt="" draggable={false} />
      ) : (
        <svg width={iconSize()} height={iconSize()} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          {visual().fallback}
        </svg>
      )}
    </span>
  );
};
