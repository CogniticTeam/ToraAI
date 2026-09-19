#!/usr/bin/env python3
# 从 logo.PNG 生成：
#   1) 带圆角+透明外角的方形图标（macOS Dock / 网页 favicon 通用风格）
#   2) CoCode.iconset/ 各尺寸 PNG（供 iconutil 打成 .icns）
#   3) favicon PNG（32/16）
# 用法: python gen_icon.py <src.png> <out_dir>
import os
import sys
from PIL import Image, ImageDraw

src = sys.argv[1]
out_dir = sys.argv[2]
os.makedirs(out_dir, exist_ok=True)

img = Image.open(src).convert("RGBA")
# 裁成正方形（logo 已是 2048x2048，保险起见居中裁方）
w, h = img.size
side = min(w, h)
img = img.crop(((w - side) // 2, (h - side) // 2, (w - side) // 2 + side, (h - side) // 2 + side))


def rounded(im: Image.Image, radius_ratio: float = 0.225) -> Image.Image:
    """把方形图裁成圆角矩形，四角透明（macOS 应用图标风格）。"""
    s = im.size[0]
    r = int(s * radius_ratio)
    mask = Image.new("L", (s, s), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=r, fill=255)
    out = im.copy()
    out.putalpha(mask)
    return out


def with_padding(im: Image.Image, ratio: float = 0.80) -> Image.Image:
    """按 Apple HIG 图标网格：可见图形约占画布 80%（1024 画布 → 824 圆角方块），
    四周透明留白。不加这层留白，Dock 里会比其它 app 图标明显大一圈。"""
    s = im.size[0]
    inner = int(s * ratio)
    small = im.resize((inner, inner), Image.LANCZOS)
    canvas = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    off = (s - inner) // 2
    canvas.paste(small, (off, off), small)
    return canvas


# 主图标基准 1024：
#   full   —— 铺满画布（favicon / 应用内 logo / Linux 窗口图标用）
#   padded —— 四周 10% 透明留白（macOS Dock icns 用，符合 HIG 图标网格）
full = rounded(img.resize((1024, 1024), Image.LANCZOS))
base = with_padding(full)

iconset = os.path.join(out_dir, "CoCode.iconset")
os.makedirs(iconset, exist_ok=True)
# macOS 需要的尺寸（文件名 -> 像素边长）
specs = {
    "icon_16x16.png": 16,
    "icon_16x16@2x.png": 32,
    "icon_32x32.png": 32,
    "icon_32x32@2x.png": 64,
    "icon_128x128.png": 128,
    "icon_128x128@2x.png": 256,
    "icon_256x256.png": 256,
    "icon_256x256@2x.png": 512,
    "icon_512x512.png": 512,
    "icon_512x512@2x.png": 1024,
}
for name, px in specs.items():
    base.resize((px, px), Image.LANCZOS).save(os.path.join(iconset, name))

# 通用主图标（macOS Dock / 打包用）——带 HIG 留白
base.save(os.path.join(out_dir, "icon-1024.png"))
base.resize((512, 512), Image.LANCZOS).save(os.path.join(out_dir, "icon-512.png"))
base.resize((256, 256), Image.LANCZOS).save(os.path.join(out_dir, "icon-256.png"))

# 以下均为铺满版（full）：favicon / 应用内 logo / Windows .ico 都显示在
# 小尺寸场景，再加 10% 留白会显得过小、发虚。
full.resize((32, 32), Image.LANCZOS).save(os.path.join(out_dir, "favicon-32.png"))
full.resize((16, 16), Image.LANCZOS).save(os.path.join(out_dir, "favicon-16.png"))
# apple-touch-icon 180
full.resize((180, 180), Image.LANCZOS).save(os.path.join(out_dir, "apple-touch-icon.png"))
# 应用内 <img> 用的 logo（512 足够清晰）
full.resize((512, 512), Image.LANCZOS).save(os.path.join(out_dir, "logo-full.png"))

# Windows .ico（多尺寸内嵌；256 档走 PNG 压缩，Vista+ 支持）
full.save(os.path.join(out_dir, "icon.ico"),
          sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

print("generated into", out_dir)
