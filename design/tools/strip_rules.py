"""Remove selector members that match a pattern from every rule in a file.

A grouped rule keeps the members that do not match; a rule whose members all
match is deleted. This is how a retired component's class family is removed
from the legacy layers without touching the rules it shared with live ones.

Usage:
    python design/tools/strip_rules.py src/App.css --match "\\.asset-context" --list
    python design/tools/strip_rules.py src/App.css --match "\\.asset-context" --apply
"""

from __future__ import annotations

import pathlib
import re
import sys


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


class Node:
    def __init__(self, start: int, end: int, prelude: str, body_start: int, body_end: int) -> None:
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
        if text[index].isspace():
            index += 1
            continue
        if text.startswith("/*", index):
            end = text.find("*/", index + 2)
            index = stop if end == -1 or end > stop else end + 2
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
        nodes.append(Node(index, end + 1, prelude, cursor + 1, end))
        index = end + 1
    return nodes


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    argv = sys.argv[1:]
    apply_changes = "--apply" in argv
    pattern = None
    paths = []
    index = 0
    while index < len(argv):
        if argv[index] == "--match" and index + 1 < len(argv):
            pattern = re.compile(argv[index + 1])
            index += 2
            continue
        if not argv[index].startswith("--"):
            paths.append(argv[index])
        index += 1
    if not paths or pattern is None:
        print(__doc__)
        return 2

    for name in paths:
        path = pathlib.Path(name)
        text = path.read_text(encoding="utf-8")
        edits: list[tuple[int, int, str]] = []
        removed_rules = removed_members = 0
        for node in parse(text):
            if node.prelude.startswith("@"):
                continue
            members = [m.strip() for m in split_top(node.prelude, ",") if m.strip()]
            kept = [m for m in members if not pattern.search(m)]
            if len(kept) == len(members):
                continue
            body = text[node.body_start:node.body_end]
            if not kept:
                removed_rules += 1
                edits.append((node.start, node.end, ""))
                print(f"  - {', '.join(members)}")
            else:
                removed_members += len(members) - len(kept)
                joined = ",\n".join(kept)
                edits.append((node.start, node.end, joined + " {" + body + "}"))
                print(f"  ~ kept {len(kept)}/{len(members)} members")
        print(f"{path}: {removed_rules} rules removed, {removed_members} members removed")
        if apply_changes and edits:
            for start, end, replacement in sorted(edits, key=lambda e: e[0], reverse=True):
                text = text[:start] + replacement + text[end:]
            text = re.sub(r"\n{3,}", "\n\n", text)
            path.write_text(text, encoding="utf-8")
            print(f"  wrote {path} ({len(text.splitlines())} lines)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
