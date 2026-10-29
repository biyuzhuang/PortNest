"""Check specific contrast claims about the CURRENT implementation (Themes.css)."""

from contrast import ratio

cases = [
    ("aurora light", "正文次要 --text-secondary #5f6076 / 白", "#5f6076", "#ffffff"),
    ("aurora light", "弱化 --text-muted #9495a8 / 白", "#9495a8", "#ffffff"),
    ("aurora light", "弱化 --text-muted #9495a8 / bg-primary #f6f5ff", "#9495a8", "#f6f5ff"),
    ("aurora light", "主按钮文字 #fff / 渐变起点 #6d5efc", "#ffffff", "#6d5efc"),
    ("aurora dark", "主按钮文字 #fff / 渐变起点 #8f80ff", "#ffffff", "#8f80ff"),
    ("aurora dark", "主按钮文字 #fff / 渐变终点 #7c74ff", "#ffffff", "#7c74ff"),
    ("aurora dark", "弱化 --text-muted #78738f / bg-secondary #151321", "#78738f", "#151321"),
    ("mist dark", "主按钮文字 #fff / 渐变起点 #5aa2ff", "#ffffff", "#5aa2ff"),
    ("midnight dark", "主按钮文字 #fff / 渐变起点 #2dd4bf", "#ffffff", "#2dd4bf"),
    ("ember dark", "主按钮文字 #fff / 渐变起点 #f08a68", "#ffffff", "#f08a68"),
    ("aurora light", "输入框边框 #e8e6f4 / 白", "#e8e6f4", "#ffffff"),
    ("aurora dark", "输入框边框 #2a2640 / #151321", "#2a2640", "#151321"),
]

print(f"{'皮肤':14s}{'场景':46s}{'比值':>8s}")
for skin, label, fg, bg in cases:
    print(f"{skin:14s}{label:46s}{ratio(fg, bg):7.2f}:1")
