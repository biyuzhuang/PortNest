"""Re-indent a stylesheet without changing its meaning.

The formatter only rewrites whitespace: one declaration per line, one selector
per line in a selector list, nested at-rules indented by two spaces, and a blank
line between top-level blocks. Strings (data URIs, font names) are preserved
verbatim.

Usage:
    python design/tools/format_css.py src/components/SettingsModal.css
    python design/tools/format_css.py file.css --check   # report only
"""

from __future__ import annotations

import pathlib
import sys


class Node:
    def __init__(self, kind: str, text: str) -> None:
        self.kind = kind          # "comment" | "rule" | "at" | "statement"
        self.text = text          # prelude / comment text
        self.children: list[Node] = []
        self.decls: list[str] = []


def split_top(text: str, sep: str) -> list[str]:
    parts, depth, quote, current = [], 0, "", []
    index = 0
    while index < len(text):
        char = text[index]
        if quote:
            current.append(char)
            if char == quote and text[index - 1] != "\\":
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
        index += 1
    parts.append("".join(current))
    return parts


def parse(text: str) -> list[Node]:
    nodes: list[Node] = []
    index = 0
    length = len(text)
    while index < length:
        char = text[index]
        if char.isspace():
            index += 1
            continue
        if text.startswith("/*", index):
            end = text.find("*/", index + 2)
            end = length - 2 if end == -1 else end
            nodes.append(Node("comment", text[index + 2:end]))
            index = end + 2
            continue
        # find the next top-level delimiter
        depth, quote, cursor = 0, "", index
        while cursor < length:
            current = text[cursor]
            if quote:
                if current == quote and text[cursor - 1] != "\\":
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
            tail = text[index:].strip()
            if tail:
                nodes.append(Node("statement", tail))
            break
        prelude = text[index:cursor].strip()
        if text[cursor] == ";":
            nodes.append(Node("statement", prelude))
            index = cursor + 1
            continue
        # block
        depth = 0
        end = cursor
        quote = ""
        while end < length:
            current = text[end]
            if quote:
                if current == quote and text[end - 1] != "\\":
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
            node = Node("at", prelude)
            node.children = parse(body)
            nodes.append(node)
        else:
            node = Node("rule", prelude)
            node.decls = [d.strip() for d in split_top(body, ";") if d.strip()]
            nodes.append(node)
        index = end + 1
    return nodes


def emit(nodes: list[Node], indent: int = 0, out: list[str] | None = None) -> list[str]:
    out = [] if out is None else out
    pad = "  " * indent
    for index, node in enumerate(nodes):
        if index and (nodes[index - 1].kind == "comment" or node.kind == "comment"
                      or nodes[index - 1].kind == "at" or node.kind == "at"):
            out.append("")
        if node.kind == "comment":
            out.append(f"{pad}/*{node.text}*/")
        elif node.kind == "statement":
            out.append(f"{pad}{node.text};")
        elif node.kind == "rule":
            selectors = [" ".join(s.split()) for s in split_top(node.text, ",") if s.strip()]
            decls = []
            for decl in node.decls:
                prop, _, value = decl.partition(":")
                decls.append(f"{prop.strip()}: {' '.join(value.split())}")
            header = ",\n".join(f"{pad}{selector}" for selector in selectors[:-1])
            if header:
                header += ","
            last = f"{pad}{selectors[-1]}"
            single = f"{last} {{ {'; '.join(decls)}; }}"
            if len(single) <= 118 and not header:
                out.append(single)
            else:
                if header:
                    out.append(header)
                out.append(f"{last} {{")
                for decl in decls:
                    out.append(f"{pad}  {decl};")
                out.append(f"{pad}}}")
        elif node.kind == "at":
            prelude = " ".join(node.text.split())
            out.append(f"{pad}{prelude} {{")
            emit(node.children, indent + 1, out)
            out.append(f"{pad}}}")
    return out


def signature(text: str) -> str:
    """Whitespace-free, comment-free form — equal signatures mean equal meaning."""
    out: list[str] = []
    index = 0
    length = len(text)
    quote = ""
    while index < length:
        char = text[index]
        if quote:
            out.append(char)
            if char == quote and text[index - 1] != "\\":
                quote = ""
        elif text.startswith("/*", index):
            end = text.find("*/", index + 2)
            index = (length - 2 if end == -1 else end) + 2
            continue
        elif char in "\"'":
            quote = char
            out.append(char)
        elif char.isspace():
            pass
        else:
            out.append(char)
        index += 1
    # A trailing semicolon before `}` is optional; the formatter always writes it.
    return "".join(out).replace(";}", "}")


def main() -> int:
    check = "--check" in sys.argv
    paths = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not paths:
        print(__doc__)
        return 2
    for name in paths:
        path = pathlib.Path(name)
        source = path.read_text(encoding="utf-8")
        formatted = "\n".join(emit(parse(source))) + "\n"
        same = signature(source) == signature(formatted)
        if check:
            print(f"{path}: {'unchanged' if formatted == source else 'would change'}, "
                  f"content preserved: {'yes' if same else 'NO'}")
            continue
        if not same:
            print(f"{path}: refusing to write, formatting would change content")
            return 1
        path.write_text(formatted, encoding="utf-8")
        print(f"{path}: {len(source.splitlines())} -> {len(formatted.splitlines())} lines")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
