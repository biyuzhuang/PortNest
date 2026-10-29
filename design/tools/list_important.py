"""List rules that contain `!important`, with line numbers and the properties.

Usage: python design/tools/list_important.py src/components/Surfaces.css
"""

from __future__ import annotations

import pathlib
import sys


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    for name in sys.argv[1:]:
        path = pathlib.Path(name)
        text = path.read_text(encoding="utf-8")
        print(f"== {path} ==")
        index = 0
        while True:
            brace = text.find("{", index)
            if brace == -1:
                break
            # find prelude start
            start = max(text.rfind("}", 0, brace), text.rfind(";", 0, brace)) + 1
            prelude = text[start:brace].strip()
            end = text.find("}", brace)
            if end == -1:
                break
            body = text[brace + 1:end]
            if "!important" in body and not prelude.startswith("@"):
                props = [d.split(":")[0].strip() for d in body.split(";") if "!important" in d]
                line = text.count("\n", 0, start) + 1
                selector = " ".join(prelude.split())
                print(f"{line:5d}: {selector[:110]}  [{', '.join(props)}]")
            index = end + 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
