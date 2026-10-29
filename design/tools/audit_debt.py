"""Measure the CSS debt this migration is paying down.

Counts, per stylesheet: lines, `!important` occurrences, hex colour literals
(#rgb / #rrggbb) and functional colour literals (rgb()/rgba()/hsl()).
`styles/tokens.css` is the one file allowed to hold raw values, so it is
measured but excluded from the "component layer" totals.

Usage:
    python design/tools/audit_debt.py            # summary table
    python design/tools/audit_debt.py --detail   # also list every literal
"""

from __future__ import annotations

import collections
import pathlib
import re
import sys

ROOT = pathlib.Path("src")
TOKEN_FILE = "styles/tokens.css"
# Files that own the shell/layout/skin layers rather than reusable components.
NON_COMPONENT = {TOKEN_FILE, "App.css", "visual-refresh.css"}

HEX_RE = re.compile(r"#[0-9a-fA-F]{3,8}\b")
FUNC_RE = re.compile(r"\brgba?\([^)]*\)|\bhsla?\([^)]*\)")


def hardcoded_functions(body: str) -> list[str]:
    """rgb()/hsl() calls whose channels are literals — `rgb(0 0 0 / var(--x))`
    is driven by a token and does not count."""
    return [match for match in FUNC_RE.findall(body) if "var(" not in match]


def strip_comments(text: str) -> str:
    return re.sub(r"/\*.*?\*/", "", text, flags=re.S)


def main() -> int:
    detail = "--detail" in sys.argv
    rows = []
    totals = collections.Counter()
    for path in sorted(ROOT.rglob("*.css")):
        raw = path.read_text(encoding="utf-8", errors="ignore")
        body = strip_comments(raw)
        rel = path.relative_to(ROOT).as_posix()
        hexes = HEX_RE.findall(body)
        funcs = hardcoded_functions(body)
        important = body.count("!important")
        lines = len(raw.splitlines())
        totals.update(
            important=important, hex=len(hexes), func=len(funcs), lines=lines
        )
        rows.append((rel, important, hexes, funcs, lines))

    rows.sort(key=lambda r: (-r[1], -len(r[2]), -len(r[3])))
    print(f"{'file':44s}{'!imp':>6s}{'hex':>6s}{'rgb/hsl':>8s}{'lines':>7s}")
    for rel, important, hexes, funcs, lines in rows:
        print(f"{rel:44s}{important:6d}{len(hexes):6d}{len(funcs):8d}{lines:7d}")
    print(f"{'TOTAL':44s}{totals['important']:6d}{totals['hex']:6d}"
          f"{totals['func']:8d}{totals['lines']:7d}")

    comp = [r for r in rows if r[0] not in NON_COMPONENT]
    print(f"\ncomponent layer ({len(comp)} files, excludes tokens.css/App.css/"
          f"visual-refresh.css):")
    print(f"  !important {sum(r[1] for r in comp):5d}   "
          f"hex {sum(len(r[2]) for r in comp):5d}   "
          f"rgb/hsl {sum(len(r[3]) for r in comp):5d}   "
          f"lines {sum(r[4] for r in comp):6d}")
    print(f"whole tree: !important {totals['important']}, "
          f"hex {totals['hex']}, rgb/hsl {totals['func']}")

    if detail:
        for rel, _, hexes, funcs, _ in rows:
            if not hexes and not funcs:
                continue
            print(f"\n== {rel} ==")
            for value, count in collections.Counter(hexes).most_common():
                print(f"  {count:3d}x {value}")
            for value, count in collections.Counter(funcs).most_common():
                print(f"  {count:3d}x {value}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
