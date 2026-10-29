"""Replace hard-coded colour literals in two component stylesheets with tokens.

Property-aware: a neutral on `border` becomes a line token, on `background` a
surface token, on `color` a text token. Semantic hues map to state tokens.
Anything not in the table is left alone and reported.
"""

from __future__ import annotations

import pathlib
import re

FILES = [
    "src/components/AssetContextMenu.css",
    "src/components/SshKeyPicker.css",
    "src/components/AIAssistant.css",
    "src/components/ServerOverview.css",
    "src/components/DockerDashboard.css",
    "src/components/MysqlWorkspace.css",
]

# explicit semantic mappings (hex -> token)
SEMANTIC = {
    "#ec3b26": "var(--danger)",
    "#c74343": "var(--danger)",
    "#f29b00": "var(--warning)",
    "#3987ea": "var(--accent)",
    "#1685df": "var(--accent)",
    "#2563b8": "var(--accent)",
    "#1f4c91": "var(--accent)",
    "#d8e5fb": "var(--accent-soft)",
    "#f7e2e2": "color-mix(in srgb, var(--danger) 14%, transparent)",
}

LIQUID = {"#fff", "#ffffff", "#f4f5f6", "#eef0f2", "#f6f7f9", "#fafbfc"}


def luminance(hex_value: str) -> float:
    value = hex_value.lstrip("#")
    if len(value) == 3:
        value = "".join(c * 2 for c in value)
    r, g, b = (int(value[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def pick(prop: str, hex_value: str) -> str | None:
    value = hex_value.lower()
    if value in SEMANTIC:
        return SEMANTIC[value]

    prop = prop.strip().lower()
    if prop.startswith("border"):
        return "var(--line)" if luminance(value) > 0.55 else "var(--line-strong)"

    if prop.startswith("background"):
        if value in ("#fff", "#ffffff"):
            return "var(--surface-raised)"
        if luminance(value) > 0.80:
            return "var(--surface-sunken)"
        return None

    if prop.startswith("color"):
        lum = luminance(value)
        if lum < 0.10:
            return "var(--text-1)"
        if lum < 0.30:
            return "var(--text-2)"
        if lum < 0.60:
            return "var(--text-3)"
        return None

    return None


decl = re.compile(r"(?P<prop>[-a-zA-Z]+)\s*:\s*(?P<value>[^;{}]+);")
hex_re = re.compile(r"#[0-9a-fA-F]{3,8}\b")

for rel in FILES:
    path = pathlib.Path(rel)
    text = path.read_text(encoding="utf-8")
    replacements: list[tuple[str, str, str]] = []

    def fix(match: re.Match) -> str:
        prop, value = match.group("prop"), match.group("value")
        new_value = value
        for literal in hex_re.findall(value):
            token = pick(prop, literal)
            if token:
                new_value = new_value.replace(literal, token)
                replacements.append((prop, literal, token))
        return f"{prop}:{new_value};"

    updated = decl.sub(fix, text)
    path.write_text(updated, encoding="utf-8")
    print(f"{rel}: {len(replacements)} literals replaced")
    for prop, literal, token in replacements[:10]:
        print(f"   {prop}: {literal} -> {token}")
