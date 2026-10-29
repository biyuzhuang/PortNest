"""Remove `!important` from declarations of rules whose selector matches a regex.

Usage:
    python design/tools/strip_important.py src/components/Surfaces.css --match "\\.(app-menu|context-menu)"
    python design/tools/strip_important.py a.css b.css --match "..." --apply
"""

from __future__ import annotations

import pathlib
import re
import sys


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
        edits: list[tuple[int, int]] = []
        count = 0
        for match in re.finditer(r"(?m)^([^\n{}@]+)\{([^}]*)\}", text):
            selector = match.group(1)
            if not pattern.search(selector):
                continue
            body = match.group(2)
            if "!important" not in body:
                continue
            count += body.count("!important")
            body_start = match.start(2)
            edits.append((body_start, match.end(2)))
        if apply_changes and edits:
            out = text
            for start, end in sorted(edits, reverse=True):
                segment = out[start:end].replace("!important", "")
                segment = re.sub(r"[ \t]+\n", "\n", segment)
                segment = re.sub(r"[ \t]+;", ";", segment)
                out = out[:start] + segment + out[end:]
            path.write_text(out, encoding="utf-8")
        print(f"{path}: {count} important declarations removed"
              f"{'' if apply_changes else ' (dry run)'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
