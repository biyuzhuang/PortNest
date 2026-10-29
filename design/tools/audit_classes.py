"""Report JSX class names that no stylesheet mentions.

Extracts static class tokens from .tsx files (class="...", class={`...`} literal
prefixes, classList={{ "key": ... }}) and compares them with every selector
found in .css files. Dynamic interpolations are skipped, so the result lists
classes that exist in markup but are never styled anywhere.
"""

import pathlib
import re

ROOT = pathlib.Path("src")
TSX = sorted(ROOT.rglob("*.tsx"))
CSS = sorted(ROOT.rglob("*.css"))

css_text = "\n".join(p.read_text(encoding="utf-8", errors="ignore") for p in CSS)
css_classes = set(re.findall(r"\.([a-zA-Z][\w-]*)", css_text))

used: dict[str, set[str]] = {}
patterns = [
    re.compile(r'class="([^"{}]+)"'),
    re.compile(r'class=\{`([^`]*)`\}'),
    re.compile(r'class=\{"([^"]+)"\}'),
    re.compile(r'classList=\{\{([^}]*)\}\}'),
]

for path in TSX:
    text = path.read_text(encoding="utf-8", errors="ignore")
    tokens: set[str] = set()
    for pat in patterns[:3]:
        for raw in pat.findall(text):
            raw = re.sub(r"\$\{[^}]*\}", " ", raw)
            tokens.update(raw.split())
    for block in re.findall(r'classList=\{\{([^}]*)\}\}', text):
        tokens.update(re.findall(r'"([\w-]+)"', block))
    for token in tokens:
        token = token.strip()
        if not re.fullmatch(r"[a-zA-Z][\w-]*", token):
            continue
        used.setdefault(token, set()).add(str(path.relative_to(ROOT)))

missing = sorted(t for t in used if t not in css_classes)
print(f"tsx files: {len(TSX)}   css files: {len(CSS)}")
print(f"class tokens used: {len(used)}   styled: {len(used) - len(missing)}   unstyled: {len(missing)}")
if missing:
    print("\nunstyled class names (present in markup, absent from CSS):")
    for token in missing:
        print(f"  {token:34s} {', '.join(sorted(used[token])[:2])}")
