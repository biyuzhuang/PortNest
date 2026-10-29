#!/usr/bin/env python3
"""One-off solver: nudge a seed colour until it clears a contrast target against
the *worst* of several backgrounds. Prints hex values to paste into contrast.py.

Not part of the shipped design system; kept so the token values are reproducible.
"""

from __future__ import annotations

import colorsys

from contrast import DARK, LIGHT, ratio


def to_hex(rgb) -> str:
    return "#" + "".join(f"{max(0, min(255, round(c * 255))):02x}" for c in rgb)


def hex_to_rgb(v: str):
    v = v.lstrip("#")
    return tuple(int(v[i : i + 2], 16) / 255 for i in (0, 2, 4))


def worst(bgs: list[str], fg: str) -> float:
    return min(ratio(fg, bg) for bg in bgs)


def solve(seed: str, bgs: list[str], target: float, mode: str, sat: float | None = None) -> tuple[str, float]:
    r, g, b = hex_to_rgb(seed)
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    if sat is not None:
        s = sat
    step = -0.002 if mode == "light" else 0.002
    best, best_ratio = to_hex(colorsys.hls_to_rgb(h, l, s)), worst(bgs, to_hex(colorsys.hls_to_rgb(h, l, s)))
    for _ in range(1200):
        l += step
        if l <= 0 or l >= 1:
            break
        cand = to_hex(colorsys.hls_to_rgb(h, l, s))
        value = worst(bgs, cand)
        if value >= target:
            return cand, value
        best, best_ratio = cand, value
    return best, best_ratio


REQUESTS = [
    # (skin, mode, token, seed, target, saturation override)
    ("aurora", "light", "line", "#e6e4f1", 1.20, None),
    ("aurora", "light", "line_strong", "#d5d1e8", 1.45, None),
    ("aurora", "light", "line_control", "#cbc7dd", 3.05, 0.12),
    ("aurora", "light", "text3", "#65677b", 4.60, None),
    ("aurora", "dark", "line", "#262135", 1.20, None),
    ("aurora", "dark", "line_strong", "#332c4a", 1.45, None),
    ("aurora", "dark", "line_control", "#3a3352", 3.05, 0.14),
    ("mist", "light", "line", "#e2e8f0", 1.20, None),
    ("mist", "light", "line_strong", "#cfd9e5", 1.45, None),
    ("mist", "light", "line_control", "#c6d2e0", 3.05, 0.12),
    ("mist", "light", "text3", "#5f6c7e", 4.60, None),
    ("mist", "dark", "line", "#24303d", 1.20, None),
    ("mist", "dark", "line_strong", "#2f3d4d", 1.45, None),
    ("mist", "dark", "line_control", "#364759", 3.05, 0.14),
    ("ember", "light", "line", "#ece1d5", 1.20, None),
    ("ember", "light", "line_strong", "#ddcdb9", 1.45, None),
    ("ember", "light", "line_control", "#d5c2ac", 3.05, 0.12),
    ("ember", "dark", "line", "#332a23", 1.20, None),
    ("ember", "dark", "line_strong", "#41352b", 1.45, None),
    ("ember", "dark", "line_control", "#4a3c31", 3.05, 0.14),
    ("midnight", "light", "line", "#dceae8", 1.20, None),
    ("midnight", "light", "line_strong", "#cbe0dd", 1.45, None),
    ("midnight", "light", "line_control", "#bdd8d4", 3.05, 0.12),
    ("midnight", "light", "text3", "#586c6b", 4.60, None),
    ("midnight", "dark", "line", "#1b3335", 1.20, None),
    ("midnight", "dark", "line_strong", "#254042", 1.45, None),
    ("midnight", "dark", "line_control", "#2c4a4b", 3.05, 0.14),
]

for skin, mode, token, seed, target, sat in REQUESTS:
    table = LIGHT if mode == "light" else DARK
    t = table[skin]
    bgs = [t["base"], t["raised"], t["shell"], t["selected"]]
    new, value = solve(seed, bgs, target, mode, sat)
    print(f"{skin:9s} {mode:5s} {token:13s} {seed} -> {new}  ({value:.2f}:1)")
