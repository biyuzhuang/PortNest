"""One-off audit: measure how many distinct design values the CSS actually uses."""

import collections
import pathlib
import re

root = pathlib.Path("E:/code/PortNest/src")
css = sorted(root.rglob("*.css"))
total_lines = 0
radii = collections.Counter()
fonts = collections.Counter()
heights = collections.Counter()

for f in css:
    text = f.read_text(encoding="utf-8", errors="ignore")
    lines = text.splitlines()
    total_lines += len(lines)
    print(f"  {f.relative_to(root)}  {len(lines)} lines")
    for m in re.finditer(r"border-radius:\s*([0-9.]+)px", text):
        radii[m.group(1)] += 1
    for m in re.finditer(r"font-size:\s*([0-9.]+)px", text):
        fonts[m.group(1)] += 1
    for m in re.finditer(r"^\s*height:\s*([0-9.]+)px", text, re.M):
        heights[m.group(1)] += 1

print(f"\nCSS files: {len(css)}  total lines: {total_lines}")
fmt = lambda c: dict(sorted(c.items(), key=lambda kv: float(kv[0])))
print(f"\ndistinct border-radius: {len(radii)} -> {fmt(radii)}")
print(f"\ndistinct font-size: {len(fonts)} -> {fmt(fonts)}")
print(f"\ndistinct height: {len(heights)} -> {fmt(heights)}")
