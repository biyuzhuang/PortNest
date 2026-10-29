"""Prune provably dead rules from one stylesheet, or across a load-order chain.

Three conservative deductions:

1. **Overridden declarations (single file)** — a declaration is dead when a
   later rule in the same scope (top level, or the same @media block) has the
   *identical* selector and sets the same property (shorthand families count as
   a match, so `padding-right` is never dropped because of a later `padding`).
   `!important` inverts the cascade, so an `!important` declaration is only
   dead when a later `!important` declaration overrides it.

2. **Overridden declarations (chain)** — same rule, but "later" means later in
   the given file order. This is how the four legacy layers (`App.css` →
   `SettingsModal.css` → `visual-refresh.css` → `Surfaces.css` → `Themes.css`)
   duplicate each other. Only selectors that are entirely settings-scoped are
   considered, so a shared list like `.primary-btn, .settings-footer-primary, …`
   is never touched.

3. **Unused classes** — a rule is removed when every class it requires does not
   appear in any `.tsx` file (dynamic `class={`x-${v}`}` prefixes count as used).

Usage:
    python design/tools/prune_css.py src/components/SettingsModal.css --list
    python design/tools/prune_css.py src/components/SettingsModal.css --apply
    python design/tools/prune_css.py --chain src/App.css src/components/SettingsModal.css \
        src/visual-refresh.css src/components/Surfaces.css src/components/Themes.css --list
"""

from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path("src")

FAMILIES = {
    "padding": {"padding", "padding-top", "padding-right", "padding-bottom", "padding-left"},
    "margin": {"margin", "margin-top", "margin-right", "margin-bottom", "margin-left"},
    "inset": {"inset", "top", "right", "bottom", "left"},
    "overflow": {"overflow", "overflow-x", "overflow-y"},
    "gap": {"gap", "row-gap", "column-gap"},
}
for base in ("background", "border", "font", "flex", "grid", "transition", "animation"):
    FAMILIES[base] = {base}


def family(prop: str) -> str:
    for name, members in FAMILIES.items():
        if prop in members:
            return name
    return prop


def split_top(text: str, sep: str) -> list[str]:
    parts, depth, current = [], 0, []
    for char in text:
        if char in "([":
            depth += 1
        elif char in ")]":
            depth = max(0, depth - 1)
        if char == sep and depth == 0:
            parts.append("".join(current))
            current = []
            continue
        current.append(char)
    parts.append("".join(current))
    return parts


class Rule:
    def __init__(self, start: int, end: int, selector: str, scope: str,
                 span: tuple[int, int]) -> None:
        self.start = start
        self.end = end
        self.selector = " ".join(selector.split())
        self.selector_changed = False
        self.scope = scope
        self.span = span
        self.decls: list[tuple[str, str, bool]] = []
        self.dead = False
        self.dropped = 0

    def parse_decls(self, body: str) -> None:
        for raw in split_top(body, ";"):
            item = raw.strip()
            if not item or ":" not in item:
                continue
            prop, value = item.split(":", 1)
            important = "!important" in value
            value = value.replace("!important", "").strip()
            self.decls.append((prop.strip().lower(), value, important))

    def keep(self) -> list[tuple[str, str, bool]]:
        return [d for d in self.decls if len(d) == 3]


def parse(text: str) -> list[Rule]:
    rules: list[Rule] = []
    i = 0
    length = len(text)

    def walk(segment: str, scope: str, offset: int) -> None:
        index = 0
        size = len(segment)
        while index < size:
            brace = segment.find("{", index)
            if brace == -1:
                return
            prelude = segment[index:brace].strip()
            depth, j = 0, brace
            while j < size:
                if segment[j] == "{":
                    depth += 1
                elif segment[j] == "}":
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            body = segment[brace + 1:j]
            if prelude.startswith("@keyframes") or prelude.startswith("@font-face"):
                index = j + 1
                continue
            if prelude.startswith("@") and prelude:
                walk(body, prelude if not scope else f"{scope} || {prelude}", offset + brace + 1)
            elif prelude:
                rule = Rule(index + offset, j + 1 + offset, prelude, scope,
                            (index + offset, j + 1 + offset))
                rule.parse_decls(body)
                rules.append(rule)
            index = j + 1

    walk(text, "", 0)
    return rules


def scoped(selector: str, prefixes: list[str]) -> bool:
    members = [m.strip() for m in split_top(selector, ",") if m.strip()]
    if not members:
        return False
    for member in members:
        if not any(re.search(rf"\.{re.escape(prefix)}", member) for prefix in prefixes):
            return False
    return True


def settings_scoped(selector: str) -> bool:
    return scoped(selector, ["settings-", "templates-"])


DEFAULT_CHAIN_SCOPE = ["settings-", "templates-"]


def collect_usage():
    tsx = "\n".join(p.read_text(encoding="utf-8", errors="ignore")
                    for p in sorted(ROOT.rglob("*.tsx")))
    class_templates = re.findall(r"class=\{`([^`]*)`\}", tsx)
    prefixes = set()
    for template in class_templates:
        prefixes.update(re.findall(r"([a-zA-Z][\w-]*-)\$\{", template))

    def used(name: str) -> bool:
        # Classes created by third-party libraries at runtime, not by our TSX.
        if name.startswith(("xterm-", "monaco-", "cm-")):
            return True
        if any(name.startswith(prefix) for prefix in prefixes):
            return True
        return bool(re.search(rf"(?<![\w-]){re.escape(name)}(?![\w-])", tsx))

    return used


def apply_edits(path: pathlib.Path, text: str, edits: list[tuple[int, int, str]],
                label: str) -> None:
    edits.sort(key=lambda e: e[0], reverse=True)
    out = text
    for start, end, replacement in edits:
        out = out[:start] + replacement + out[end:]
    path.write_text(out, encoding="utf-8")
    print(f"  wrote {path} ({len(out.splitlines())} lines) {label}")


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    argv = sys.argv[1:]
    chain = "--chain" in argv
    apply_changes = "--apply" in argv
    prune_unused = "--no-unused" not in argv
    any_scope = "--all" in argv
    paths = []
    skip = False
    for index, item in enumerate(argv):
        if skip:
            skip = False
            continue
        if item == "--only":
            skip = True
            continue
        if not item.startswith("--"):
            paths.append(item)
    if not paths:
        print(__doc__)
        return 2

    used = collect_usage()
    any_unused = "--any" in argv
    scope_prefixes = list(DEFAULT_CHAIN_SCOPE)
    for index, item in enumerate(argv):
        if item == "--only" and index + 1 < len(argv):
            scope_prefixes = [part.strip() for part in argv[index + 1].split(",") if part.strip()]

    docs = []
    for order, name in enumerate(paths):
        path = pathlib.Path(name)
        text = path.read_text(encoding="utf-8")
        rules = parse(text)
        docs.append((path, text, rules, order))
        if not prune_unused:
            continue
        for rule in rules:
            selectors = [s.strip() for s in split_top(rule.selector, ",") if s.strip()]
            live = []
            for selector in selectors:
                cleaned = re.sub(r":not\([^)]*\)", "", selector)
                classes = re.findall(r"\.([a-zA-Z][\w-]*)", cleaned)
                if not classes or "${" in selector:
                    live.append(selector)
                    continue
                is_dead = any(not used(c) for c in classes) if any_unused else \
                    all(not used(c) for c in classes)
                if not is_dead:
                    live.append(selector)
            if not live:
                rule.dead = True
            elif len(live) != len(selectors):
                rule.selector = ", ".join(live)
                rule.selector_changed = True

    # Collect surviving declarations per (scope, selector), in cascade order.
    buckets: dict[tuple[str, str], list[tuple[int, Rule]]] = {}
    for path, text, rules, order in docs:
        for rule in rules:
            if rule.dead:
                continue
            if chain and not any_scope and not scoped(rule.selector, scope_prefixes):
                continue
            buckets.setdefault((rule.scope, rule.selector), []).append((order, rule))

    for (scope, selector), entries in buckets.items():
        for position, (order, rule) in enumerate(entries):
            for index, (prop, _value, important) in enumerate(rule.decls):
                later = False
                for later_order, other in entries[position + 1:]:
                    if later_order == order and other.start <= rule.end:
                        continue
                    for oprop, _ovalue, oimportant in other.decls:
                        if family(oprop) == family(prop) and important == oimportant:
                            later = True
                            break
                    if later:
                        break
                if later:
                    rule.decls[index] = (prop, _value, important, "dead")  # type: ignore[assignment]

    total_rules = total_decls = 0
    for path, text, rules, order in docs:
        removed_rules = removed_decls = 0
        edits: list[tuple[int, int, str]] = []
        report: list[str] = []
        for rule in rules:
            if rule.dead:
                removed_rules += 1
                edits.append((rule.span[0], rule.span[1], ""))
                report.append(f"  - {rule.selector}")
                continue
            keep = rule.keep()
            dropped = len(rule.decls) - len(keep)
            removed_decls += dropped
            if dropped and not keep:
                removed_rules += 1
                edits.append((rule.span[0], rule.span[1], ""))
                report.append(f"  - {rule.selector}")
                continue
            if dropped or rule.selector_changed:
                rebuilt = " ".join(f"{p}: {v}{' !important' if i else ''};"
                                   for p, v, i in keep)
                edits.append((rule.span[0], rule.span[1],
                              f"{rule.selector} {{ {rebuilt} }}"))
                report.append(f"  ~ {rule.selector} ({dropped} decl)")
        total_rules += removed_rules
        total_decls += removed_decls
        print(f"{path}: {len(rules)} rules, {removed_rules} removable rules, "
              f"{removed_decls} dead declarations")
        if "--list" in argv:
            for line in report:
                print(line)
        if apply_changes and edits:
            apply_edits(path, text, edits, "")

    if len(docs) > 1:
        print(f"chain: {total_rules} rules / {total_decls} declarations removable")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
