"""Report class names styled in a stylesheet but never referenced by any .tsx.

Usage: python design/tools/unused_classes.py src/components/SettingsModal.css
"""

from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path("src")


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    tsx = "\n".join(p.read_text(encoding="utf-8", errors="ignore")
                    for p in sorted(ROOT.rglob("*.tsx")))
    for name in sys.argv[1:]:
        css = pathlib.Path(name).read_text(encoding="utf-8", errors="ignore")
        css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
        classes = sorted(set(re.findall(r"\.([a-zA-Z][\w-]*)", css)))
        unused = [c for c in classes if not re.search(rf"(?<![\w-]){re.escape(c)}(?![\w-])", tsx)]
        print(f"== {name}: {len(classes)} classes, {len(unused)} unused ==")
        for c in unused:
            print(f"  {c}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
