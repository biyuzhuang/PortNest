"""Print rules whose selector mentions one of a set of class prefixes.

Usage:
    python design/tools/find_rules.py <css> [--class settings-] [--class templates-]

Shows line number, selector, and which declarations carry `!important`.
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


def rules(text: str, offset: int = 0):
    """Yield (line, selector, declarations) for each rule, recursing into @media."""
    index = 0
    length = len(text)
    while index < length:
        char = text[index]
        if char.isspace():
            index += 1
            continue
        if text.startswith("/*", index):
            end = text.find("*/", index + 2)
            index = (length if end == -1 else end + 2)
            continue
        depth, quote, cursor = 0, "", index
        while cursor < length:
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
        if cursor >= length:
            break
        prelude = text[index:cursor].strip()
        if text[cursor] == ";":
            index = cursor + 1
            continue
        end = cursor
        depth, quote = 0, ""
        while end < length:
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
        body = text[cursor + 1:end]
        if prelude.startswith("@"):
            yield from rules(body, 0)
        else:
            line = text.count("\n", 0, index + offset) + 1
            yield line, prelude, body
        index = end + 1


def main() -> int:
    args = sys.argv[1:]
    prefixes: list[str] = []
    paths: list[str] = []
    index = 0
    while index < len(args):
        if args[index] == "--class" and index + 1 < len(args):
            prefixes.append(args[index + 1])
            index += 2
            continue
        if not args[index].startswith("--"):
            paths.append(args[index])
        index += 1
    if not paths:
        print(__doc__)
        return 2
    pattern = re.compile("|".join(re.escape(p) for p in prefixes)) if prefixes else None
    for name in paths:
        path = pathlib.Path(name)
        text = path.read_text(encoding="utf-8")
        print(f"== {path} ==")
        for line, selector, body in rules(text):
            if pattern and not pattern.search(selector):
                continue
            decls = [d.strip() for d in split_top(body, ";") if d.strip()]
            important = [d.split(":")[0] for d in decls if "!important" in d]
            flag = f"  !! {','.join(important)}" if important else ""
            print(f"{line:5d}: {' '.join(selector.split())}{flag}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
