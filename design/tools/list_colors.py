"""List every hardcoded colour literal in a stylesheet with its line number.

Usage: python design/tools/list_colors.py src/components/SettingsModal.css
"""

from __future__ import annotations

import pathlib
import re
import sys

PATTERN = re.compile(r"#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)")


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    for name in sys.argv[1:]:
        path = pathlib.Path(name)
        print(f"== {path} ==")
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if PATTERN.search(line):
                print(f"{number:5d}: {line.strip()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
