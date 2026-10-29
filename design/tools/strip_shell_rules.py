"""Remove shell rules from the override layers so one authoritative file can own them.

Parses CSS by brace matching (handles @media/@supports nesting), drops top-level
rules whose every selector belongs to the shell, and reports what it removed.
Rules that mix shell and non-shell selectors are kept (safer to under-remove).
"""

import pathlib
import re

SHELL_PREFIXES = (
    ".app-titlebar",
    ".titlebar-",
    ".module-rail",
    ".asset-sidebar",
    ".session-tabs-bar",
    ".session-tabs",
    ".session-list-tab",
    ".session-tab",
    ".session-action-bar",
    ".session-action-",
    ".status-bar",
    ".status-item",
    ".status-dot",
    ".sidebar-footer",
)

# structural rules that must survive even though they mention a shell selector
KEEP_MARKERS = ("app-body > .sidebar", ".sidebar .asset-sidebar")

FILES = [
    "src/visual-refresh.css",
    "src/components/Themes.css",
    "src/components/Surfaces.css",
]


def split_selectors(prelude: str) -> list[str]:
    out, depth, cur = [], 0, ""
    for ch in prelude:
        if ch in "([":
            depth += 1
        elif ch in ")]":
            depth -= 1
        if ch == "," and depth == 0:
            out.append(cur.strip())
            cur = ""
        else:
            cur += ch
    if cur.strip():
        out.append(cur.strip())
    return out


def is_shell(prelude: str) -> bool:
    sels = split_selectors(prelude)
    if not sels:
        return False
    if any(marker in s for s in sels for marker in KEEP_MARKERS):
        return False
    return all(any(s.startswith(p) for p in SHELL_PREFIXES) for s in sels)


def process(text: str, path: str):
    """Return (new_text, removed_list)."""
    out = []
    removed = []
    i = 0
    n = len(text)
    buffer_start = 0

    while i < n:
        ch = text[i]
        if ch == "{":
            prelude = text[buffer_start:i]
            stripped = prelude.strip()
            # find matching close brace
            depth = 1
            j = i + 1
            while j < n and depth:
                if text[j] == "{":
                    depth += 1
                elif text[j] == "}":
                    depth -= 1
                j += 1
            block_start = buffer_start
            body = text[i + 1 : j - 1]

            if stripped.startswith("@media") or stripped.startswith("@supports"):
                inner, inner_removed = process(body, path)
                removed.extend(inner_removed)
                head = text[buffer_start:i + 1]
                if inner.strip():
                    out.append(head + inner + "}")
                else:
                    # whole at-rule became empty; drop it including its prelude
                    pass
                buffer_start = j
                i = j
                continue

            if not stripped.startswith("@") and is_shell(stripped):
                removed.append(re.sub(r"\s+", " ", stripped)[:110])
                buffer_start = j
                i = j
                continue

            out.append(text[buffer_start:j])
            buffer_start = j
            i = j
            continue
        i += 1

    out.append(text[buffer_start:])
    return "".join(out), removed


for rel in FILES:
    p = pathlib.Path(rel)
    original = p.read_text(encoding="utf-8")
    updated, removed = process(original, rel)
    updated = re.sub(r"\n{4,}", "\n\n\n", updated)
    p.write_text(updated, encoding="utf-8")
    print(f"{rel}: {len(original.splitlines())} -> {len(updated.splitlines())} lines, removed {len(removed)} rules")
    for sel in removed:
        print(f"    - {sel}")
