"""Sanity check the mockup: every referenced icon symbol exists, no orphan ids."""

import re
from pathlib import Path

html = Path("E:/code/PortNest/design/mockup.html").read_text(encoding="utf-8")
used = set(re.findall(r'href="#(i-[a-z0-9-]+)"', html))
defined = set(re.findall(r'id="(i-[a-z0-9-]+)"', html))

missing = sorted(used - defined)
unused = sorted(defined - used)
print(f"referenced: {len(used)}  defined: {len(defined)}")
print("MISSING symbols:", missing or "none")
print("unused symbols :", unused or "none")

# crude balance check on the view containers
for view in ("workspace", "assets", "empty", "form", "tokens"):
    print(f"view {view:9s} present: {f'view-{view}' in html}")
