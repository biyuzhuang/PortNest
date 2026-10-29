#!/usr/bin/env python3
"""PortNest design system — contrast verification.

Checks every semantic text/background/border pair the design relies on, for all
four skins in both light and dark mode, and writes a markdown report.

Run:  python design/tools/contrast.py
"""

from __future__ import annotations

from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "contrast-report.md"


def hex_to_rgb(value: str) -> tuple[float, float, float]:
    value = value.strip().lstrip("#")
    if len(value) == 3:
        value = "".join(ch * 2 for ch in value)
    return tuple(int(value[i : i + 2], 16) / 255 for i in (0, 2, 4))  # type: ignore[return-value]


def linearize(channel: float) -> float:
    return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4


def luminance(color: str) -> float:
    r, g, b = (linearize(c) for c in hex_to_rgb(color))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(fg: str, bg: str) -> float:
    a, b = luminance(fg), luminance(bg)
    lo, hi = min(a, b), max(a, b)
    return (hi + 0.05) / (lo + 0.05)


# --------------------------------------------------------------------------
# Semantic tokens, per skin and mode.
# --------------------------------------------------------------------------

LIGHT = {
    "aurora": {
        "shell": "#f3f2fa", "base": "#ffffff", "raised": "#ffffff", "sunken": "#f7f6fc", "selected": "#ece9fd",
        "text": "#16152a", "text2": "#5a5c72", "text3": "#65677a",
        "accent": "#5a4be0", "on_accent": "#ffffff", "accent_soft": "#eeebff",
        "line": "#d8d5e9", "line_strong": "#c7c1e0", "line_control": "#87829d",
        "success": "#0f7a4f", "warning": "#9a5b00", "danger": "#c22f38", "info": "#1a6bb5",
    },
    "mist": {
        "shell": "#eef1f6", "base": "#ffffff", "raised": "#ffffff", "sunken": "#f6f8fb", "selected": "#e6effb",
        "text": "#141c26", "text2": "#4e5c6e", "text3": "#5f6c7d",
        "accent": "#1a63b4", "on_accent": "#ffffff", "accent_soft": "#e8f1fc",
        "line": "#d2dbe8", "line_strong": "#bbc9da", "line_control": "#7c8998",
        "success": "#0b6b46", "warning": "#8a5405", "danger": "#bb2f33", "info": "#15619f",
    },
    "ember": {
        "shell": "#f8f2ea", "base": "#fffdfa", "raised": "#fffdfa", "sunken": "#faf5ee", "selected": "#f8e9df",
        "text": "#221a14", "text2": "#5c4e42", "text3": "#726355",
        "accent": "#a8482a", "on_accent": "#ffffff", "accent_soft": "#fbeadf",
        "line": "#e5d5c5", "line_strong": "#d6c2aa", "line_control": "#928474",
        "success": "#3f6b32", "warning": "#8a5a0c", "danger": "#a93330", "info": "#2a5d8a",
    },
    "midnight": {
        "shell": "#eaf2f1", "base": "#fcffff", "raised": "#fcffff", "sunken": "#f4faf9", "selected": "#dcefec",
        "text": "#0f2226", "text2": "#47605f", "text3": "#586b6a",
        "accent": "#0a6f6f", "on_accent": "#ffffff", "accent_soft": "#e2f4f1",
        "line": "#c5dcd9", "line_strong": "#a8cbc6", "line_control": "#6e8c88",
        "success": "#0b6b4f", "warning": "#8a5a0c", "danger": "#a83232", "info": "#1a5f8a",
    },
}

DARK = {
    "aurora": {
        "shell": "#0a0912", "base": "#12101c", "raised": "#191627", "sunken": "#07060c", "selected": "#241f3d",
        "text": "#edecf7", "text2": "#b3aec8", "text3": "#948fa9",
        "accent": "#a99bff", "on_accent": "#12101c", "accent_soft": "#221d3b",
        "line": "#342d48", "line_strong": "#41385e", "line_control": "#70698b",
        "success": "#4fd6a0", "warning": "#e6b45c", "danger": "#ff8b93", "info": "#79b8ff",
    },
    "mist": {
        "shell": "#0a1017", "base": "#121a24", "raised": "#18212c", "sunken": "#070c12", "selected": "#1e2c3c",
        "text": "#e9eef6", "text2": "#aab6c6", "text3": "#8d9aac",
        "accent": "#7ab3ff", "on_accent": "#0a1017", "accent_soft": "#1b2a3c",
        "line": "#2a3948", "line_strong": "#364658", "line_control": "#677788",
        "success": "#4ed3a4", "warning": "#e8b463", "danger": "#ff8f8f", "info": "#7cbaff",
    },
    "ember": {
        "shell": "#120e0b", "base": "#1a1512", "raised": "#231c17", "sunken": "#0c0908", "selected": "#33241c",
        "text": "#f5ece4", "text2": "#c5b2a3", "text3": "#a6917f",
        "accent": "#ff9d78", "on_accent": "#1a1512", "accent_soft": "#2e2119",
        "line": "#3e332a", "line_strong": "#4d3f33", "line_control": "#7f6e60",
        "success": "#7fd49b", "warning": "#e9b45f", "danger": "#ff9186", "info": "#8ec2ef",
    },
    "midnight": {
        "shell": "#05100f", "base": "#0c1a1b", "raised": "#122425", "sunken": "#040b0a", "selected": "#173433",
        "text": "#e2f6f2", "text2": "#a4c3bf", "text3": "#88a8a4",
        "accent": "#4fe0c8", "on_accent": "#05100f", "accent_soft": "#12302e",
        "line": "#224143", "line_strong": "#2d4d50", "line_control": "#607f80",
        "success": "#5fdfb0", "warning": "#ecc06d", "danger": "#ff9a9a", "info": "#7ec8de",
    },
}

# (label, foreground role, background role, minimum ratio, rationale)
TEXT_CHECKS = [
    ("正文 / 基础表面", "text", "base", 7.0, "AAA 正文，UI 主文本"),
    ("正文 / 抬升表面", "text", "raised", 7.0, "卡片、菜单、弹窗文本"),
    ("正文 / 外壳表面", "text", "shell", 7.0, "导轨、状态栏、树面板文本"),
    ("正文 / 选中行", "text", "selected", 7.0, "选中行的主文本"),
    ("次要文本 / 基础表面", "text2", "base", 4.5, "说明、列头、次级信息"),
    ("次要文本 / 选中行", "text2", "selected", 4.5, "选中行内的次级信息"),
    ("弱化文本 / 基础表面", "text3", "base", 4.5, "时间戳、计数、占位符"),
    ("弱化文本 / 外壳表面", "text3", "shell", 4.5, "状态栏、导轨标签"),
    ("强调色 / 基础表面", "accent", "base", 4.5, "链接、活动标签（AA 文本）"),
    ("强调色 / 选中行", "accent", "selected", 4.5, "选中行内的强调文本"),
    ("按钮文字 / 强调填充", "on_accent", "accent", 4.5, "主按钮（1.4.3）"),
    ("成功 / 基础表面", "success", "base", 4.5, "在线状态、成功提示"),
    ("成功 / 外壳表面", "success", "shell", 4.5, "状态栏在线指示"),
    ("警告 / 基础表面", "warning", "base", 4.5, "警告文本"),
    ("危险 / 基础表面", "danger", "base", 4.5, "错误、破坏性操作"),
    ("信息 / 基础表面", "info", "base", 4.5, "提示、链接态"),
]

BORDER_CHECKS = [
    ("控件边框 / 基础表面", "line_control", "base", 3.0, "表单控件边界（1.4.11）"),
    ("控件边框 / 外壳表面", "line_control", "shell", 3.0, "外壳上的控件边界"),
    ("分隔线 / 基础表面", "line_strong", "base", 1.45, "面板分隔（可感知）"),
    ("分隔线 / 外壳表面", "line_strong", "shell", 1.45, "外壳面板分隔"),
    ("发丝线 / 基础表面", "line", "base", 1.18, "装饰性细线（不承载信息）"),
    ("发丝线 / 外壳表面", "line", "shell", 1.18, "外壳装饰细线"),
]


def evaluate(tokens: dict) -> list[dict]:
    rows = []
    for label, fg, bg, minimum, why in TEXT_CHECKS + BORDER_CHECKS:
        value = ratio(tokens[fg], tokens[bg])
        rows.append(
            {
                "label": label,
                "fg": tokens[fg],
                "bg": tokens[bg],
                "ratio": round(value, 2),
                "min": minimum,
                "why": why,
                "ok": value + 1e-9 >= minimum,
            }
        )
    return rows


def main() -> int:
    lines = [
        "# PortNest 设计系统 — 对比度验证报告",
        "",
        "由 `design/tools/contrast.py` 生成。判定标准：WCAG 2.1。",
        "",
        "| 用途 | 阈值 | 依据 |",
        "| --- | --- | --- |",
        "| 正文 / 主文本 | ≥ 7.0:1 | AAA |",
        "| 次要文本、强调色、状态色 | ≥ 4.5:1 | AA 1.4.3 |",
        "| 表单控件边界 | ≥ 3.0:1 | 1.4.11 非文本对比度 |",
        "| 面板分隔线 | ≥ 1.45:1 | 设计下限，保证明暗两套主题都能看见 |",
        "| 装饰发丝线 | ≥ 1.18:1 | 设计下限，仅需可感知 |",
        "",
    ]

    failures = 0
    summary = []

    for skin in ["aurora", "mist", "ember", "midnight"]:
        for mode, table in (("light", LIGHT), ("dark", DARK)):
            rows = evaluate(table[skin])
            bad = [r for r in rows if not r["ok"]]
            failures += len(bad)
            worst = min(r["ratio"] for r in rows)
            summary.append((skin, mode, len(rows) - len(bad), len(rows), worst))

            lines.append(f"## {skin} · {mode}")
            lines.append("")
            lines.append("| 检查项 | 前景 | 背景 | 实测 | 要求 | 结果 |")
            lines.append("| --- | --- | --- | --- | --- | --- |")
            for r in rows:
                mark = "通过" if r["ok"] else "**未通过**"
                lines.append(f"| {r['label']} | `{r['fg']}` | `{r['bg']}` | {r['ratio']}:1 | ≥ {r['min']}:1 | {mark} |")
            lines.append("")

    lines.append("## 汇总")
    lines.append("")
    lines.append("| 皮肤 | 模式 | 通过 / 总数 | 最低比值 |")
    lines.append("| --- | --- | --- | --- |")
    for skin, mode, ok, total, worst in summary:
        lines.append(f"| {skin} | {mode} | {ok} / {total} | {worst:.2f}:1 |")
    lines.append("")
    lines.append(f"**未通过项合计：{failures}**")
    lines.append("")

    OUT.write_text("\n".join(lines), encoding="utf-8")
    print(f"report: {OUT}")

    if failures:
        print(f"FAIL: {failures} pair(s) below threshold")
        for skin in ["aurora", "mist", "ember", "midnight"]:
            for mode, table in (("light", LIGHT), ("dark", DARK)):
                for r in evaluate(table[skin]):
                    if not r["ok"]:
                        print(f"  {skin}/{mode}: {r['fg']} on {r['bg']} = {r['ratio']} < {r['min']}")
        return 1

    print("OK: every checked pair meets its threshold")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
