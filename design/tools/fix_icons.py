"""Fix the mockup's icon rendering.

The <svg> wrappers around <use href="#i-..."> had width/height but no viewBox,
so the 24x24 symbol was clipped to a 14x14 (or 13x13) viewport. Every icon was
showing only its top-left corner. This adds the missing viewBox and normalises
stroke width so small icons keep the same optical weight as the app (1.8 @ 24).
"""

import re
from pathlib import Path

path = Path("E:/code/PortNest/design/mockup.html")
html = path.read_text(encoding="utf-8")

before_use = len(re.findall(r"<svg[^>]*>\s*<use", html))

# 1. give every <svg> that wraps a <use> the 24x24 coordinate system
def add_viewbox(match: re.Match) -> str:
    tag = match.group(0)
    if "viewBox" in tag:
        return tag
    return tag[:-1] + ' viewBox="0 0 24 24">'

html = re.sub(r"<svg[^>]*>(?=\s*<use)", add_viewbox, html)

# 2. optical weight: 1.5 -> 1.7 (matches Icon.tsx's 1.8 at 24 scaled down)
html = html.replace('stroke-width="1.5"', 'stroke-width="1.7"')
html = html.replace('stroke-width="1.4"', 'stroke-width="1.7"')
html = html.replace('stroke-width="1.6"', 'stroke-width="1.7"')

path.write_text(html, encoding="utf-8")

after = len(re.findall(r"<svg[^>]*viewBox=\"0 0 24 24\"[^>]*>\s*<use", html))
print(f"<svg><use> wrappers: {before_use}")
print(f"with viewBox now   : {after}")
print("stroke widths now  :", sorted(set(re.findall(r'stroke-width="([0-9.]+)"', html))))
left = re.findall(r"<svg(?![^>]*viewBox)[^>]*>\s*<use", html)
print("still missing viewBox:", len(left))
