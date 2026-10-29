"""Move settings-scoped rules out of the legacy layers into one owning file.

A rule is settings-scoped when *every* selector in its list mentions
`.settings-…` or `.templates-…`. Mixed lists (for example
`select, .settings-card select, …`) are left alone, because they also style
non-settings elements. Media queries are preserved: a fully settings-scoped
@media block moves whole, a mixed one moves only its settings rules, each
wrapped in the same condition.

Usage:
    python design/tools/move_rules.py --from src/visual-refresh.css \
        src/components/Surfaces.css src/components/Themes.css \
        --into src/components/SettingsModal.css --dry-run
"""

from __future__ import annotations

import pathlib
import re
import sys

SETTINGS_RE = re.compile(r"\.(settings|templates)-")


def split_top(text: str, sep: str) -> list[str]:
    parts, depth, quote, current = [], 0, "", []
    for char in text:
        if quote:
            current.append(char)
            if char == quote:
                quote = ""
        elif char in "\"'":
            quote = char
            current.append(char)
        elif char in "([":
            depth += 1
            current.append(char)
        elif char in ")]":
            depth = max(0, depth - 1)
            current.append(char)
        elif char == sep and depth == 0:
            parts.append("".join(current))
            current = []
        else:
            current.append(char)
    parts.append("".join(current))
    return parts


def is_settings(selector: str) -> bool:
    members = [m.strip() for m in split_top(selector, ",") if m.strip()]
    return bool(members) and all(SETTINGS_RE.search(m) for m in members)


class Node:
    def __init__(self, kind: str, start: int, end: int, prelude: str,
                 body_start: int = 0, body_end: int = 0) -> None:
        self.kind = kind            # "rule" | "at" | "statement"
        self.start = start
        self.end = end
        self.prelude = prelude
        self.body_start = body_start
        self.body_end = body_end


def parse(text: str, start: int = 0, stop: int | None = None) -> list[Node]:
    stop = len(text) if stop is None else stop
    nodes: list[Node] = []
    index = start
    while index < stop:
        char = text[index]
        if char.isspace():
            index += 1
            continue
        if text.startswith("/*", index):
            end = text.find("*/", index + 2)
            index = (stop if end == -1 or end > stop else end + 2)
            continue
        depth, quote, cursor = 0, "", index
        while cursor < stop:
            current = text[cursor]
            if quote:
                if current == quote:
                    quote = ""
            elif current in "\"'":
                quote = current
            elif current in "([":
                depth += 1
            elif current in ")]":
                depth = max(0, depth - 1)
            elif depth == 0 and current in "{;":
                break
            cursor += 1
        if cursor >= stop:
            break
        prelude = text[index:cursor].strip()
        if text[cursor] == ";":
            nodes.append(Node("statement", index, cursor + 1, prelude))
            index = cursor + 1
            continue
        depth, quote, end = 0, "", cursor
        while end < stop:
            current = text[end]
            if quote:
                if current == quote:
                    quote = ""
            elif current in "\"'":
                quote = current
            elif current == "{":
                depth += 1
            elif current == "}":
                depth -= 1
                if depth == 0:
                    break
            end += 1
        node = Node("at" if prelude.startswith("@") else "rule",
                    index, end + 1, prelude, cursor + 1, end)
        nodes.append(node)
        index = end + 1
    return nodes


def indent(text: str, pad: str) -> str:
    return "\n".join(pad + line if line.strip() else line for line in text.splitlines())


def process(text: str) -> tuple[list[tuple[int, int, str]], str]:
    """Return (edits, moved CSS). Each edit replaces a span with new text."""
    edits: list[tuple[int, int, str]] = []
    moved: list[str] = []

    def emit(selector: str, body: str, media: str) -> None:
        snippet = f"{selector} {{{body}}}"
        if media:
            snippet = f"{media} {{\n{indent(snippet, '  ')}\n}}"
        moved.append(snippet)

    def walk(start: int, stop: int, media: str = "") -> None:
        for node in parse(text, start, stop):
            if node.kind == "rule":
                members = [m.strip() for m in split_top(node.prelude, ",") if m.strip()]
                settings_members = [m for m in members if SETTINGS_RE.search(m)]
                if not settings_members:
                    continue
                body = text[node.body_start:node.body_end]
                if len(settings_members) == len(members):
                    edits.append((node.start, node.end, ""))
                    emit(",\n".join(settings_members), body, media)
                else:
                    kept = [m for m in members if m not in settings_members]
                    edits.append((node.start, node.end,
                                  f"{', '.join(kept)} {{{body}}}"))
                    emit(",\n".join(settings_members), body, media)
            elif node.kind == "at" and node.prelude.startswith("@media"):
                children = [c for c in parse(text, node.body_start, node.body_end)
                            if c.kind in ("rule", "at")]
                has_settings = any(
                    c.kind == "rule" and is_settings(c.prelude) or
                    (c.kind == "rule" and any(SETTINGS_RE.search(m) for m in
                                              split_top(c.prelude, ",")))
                    for c in children
                )
                if not has_settings:
                    continue
                condition = f"{node.prelude}" if not media else f"{media} {{\n  {node.prelude}"
                # rebuild the media block with settings members stripped, then move them
                kept_children: list[str] = []
                for child in children:
                    if child.kind != "rule":
                        kept_children.append(text[child.start:child.end].strip())
                        continue
                    members = [m.strip() for m in split_top(child.prelude, ",") if m.strip()]
                    settings_members = [m for m in members if SETTINGS_RE.search(m)]
                    if not settings_members:
                        kept_children.append(text[child.start:child.end].strip())
                        continue
                    body = text[child.body_start:child.body_end]
                    emit(",\n".join(settings_members), body, condition)
                    kept = [m for m in members if m not in settings_members]
                    if kept:
                        kept_children.append(f"{', '.join(kept)} {{{body}}}")
                if kept_children:
                    body_text = "\n".join(indent(item, "  ") for item in kept_children)
                    edits.append((node.start, node.end,
                                  f"{node.prelude} {{\n{body_text}\n}}"))
                else:
                    edits.append((node.start, node.end, ""))

    walk(0, len(text))
    return edits, "\n\n".join(moved)


def main() -> int:
    argv = sys.argv[1:]
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    dry = "--dry-run" in argv
    into = None
    sources: list[str] = []
    mode = None
    for index, item in enumerate(argv):
        if item == "--from":
            mode = "from"
            continue
        if item == "--into":
            into = argv[index + 1]
            mode = None
            continue
        if item.startswith("--"):
            continue
        if mode == "from" and item != into:
            sources.append(item)
    if not sources or not into:
        print(__doc__)
        return 2

    blocks: list[str] = []
    for name in sources:
        path = pathlib.Path(name)
        text = path.read_text(encoding="utf-8")
        deletions, moved = process(text)
        if not moved:
            print(f"{path}: no settings rules")
            continue
        out = text
        for start, end, replacement in sorted(deletions, key=lambda e: e[0], reverse=True):
            out = out[:start] + replacement + out[end:]
        folded = re.sub(r"\n{3,}", "\n\n", out)
        blocks.append(moved)
        print(f"{path}: rewrote {len(deletions)} blocks, {len(text.splitlines())} -> "
              f"{len(folded.splitlines())} lines")
        if not dry:
            path.write_text(folded, encoding="utf-8")

    banner = (
        "/* ==========================================================================\n"
        "   Settings surface — moved here from the legacy overlay layers so the\n"
        "   settings screen has one owner. Declarations keep their original cascade\n"
        "   order: visual-refresh → Surfaces → Themes.\n"
        "   ========================================================================== */"
    )
    combined = banner + "\n\n" + "\n\n".join(blocks) + "\n"
    target = pathlib.Path(into)
    print(f"{target}: appending {len(combined.splitlines())} lines")
    if not dry:
        with target.open("a", encoding="utf-8") as handle:
            handle.write("\n" + combined)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
