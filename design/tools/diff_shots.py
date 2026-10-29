"""Compare two screenshot sets pixel by pixel.

Usage:
    python design/tools/diff_shots.py design/verify --prefix-a r7-before --prefix-b r7-after

Every pair with the same <page>-<theme> suffix is compared. The report lists the
number of differing pixels, the bounding box of the differences and the largest
per-channel delta, plus the paths of any written diff images (--write-diff).
"""

from __future__ import annotations

import pathlib
import sys


def main() -> int:
    argv = sys.argv[1:]
    directory = pathlib.Path(argv[0] if argv and not argv[0].startswith("--") else "design/verify")
    prefix_a = "r7-before"
    prefix_b = "r7-after"
    write_diff = "--write-diff" in argv
    for index, item in enumerate(argv):
        if item == "--prefix-a":
            prefix_a = argv[index + 1]
        if item == "--prefix-b":
            prefix_b = argv[index + 1]

    from PIL import Image, ImageChops

    files = sorted(directory.glob(f"{prefix_a}-*.png"))
    if not files:
        print(f"no {prefix_a}-*.png in {directory}")
        return 1

    identical = 0
    changed = []
    for before_path in files:
        suffix = before_path.name[len(prefix_a) + 1:]
        after_path = directory / f"{prefix_b}-{suffix}"
        if not after_path.exists():
            print(f"MISSING {after_path.name}")
            continue
        before = Image.open(before_path).convert("RGB")
        after = Image.open(after_path).convert("RGB")
        if before.size != after.size:
            print(f"SIZE    {suffix}: {before.size} != {after.size}")
            continue
        diff = ImageChops.difference(before, after)
        bbox = diff.getbbox()
        if bbox is None:
            identical += 1
            continue
        pixels = sum(1 for pixel in diff.getdata() if pixel != (0, 0, 0))
        extremes = diff.getextrema()
        peak = max(high for _low, high in extremes)
        changed.append((suffix, pixels, bbox, peak))
        if write_diff:
            out = directory / f"{prefix_b}-diff-{suffix}"
            diff.save(out)

    print(f"{identical}/{len(files)} identical")
    for suffix, pixels, bbox, peak in sorted(changed, key=lambda row: -row[1]):
        total = pixels
        print(f"DIFF    {suffix:34s} {total:8d}px  bbox={bbox} peak={peak}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
