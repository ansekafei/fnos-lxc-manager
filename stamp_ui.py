#!/usr/bin/env python3
"""给 ui 里的 ES Module import 与 vendor 引用打版本戳。

浏览器对这种子资源 URL 会做启发式缓存（aiohttp 只给 Etag/Last-Modified），
升级后 index.html 是 no-store 会刷新，但 src/*.js 还是老缓存 —— 于是新旧模块
拼在一起，一升级就白屏。所以发版时把所有 import 路径也带上 ?v=STAMP。

用法: stamp_ui.py <stamp> <ui目录>
"""
import re
import sys
import pathlib

STAMP = sys.argv[1]
ROOT = pathlib.Path(sys.argv[2])

# from './x.js' / import('./x.js') / from "./x.js"
RE_LOCAL = re.compile(
    r"""((?:from|import)\s*\(?\s*['"])(\.{1,2}/[^'"]+?\.js)(?:\?v=\d+)?(['"])"""
)
# '/app/lxcmanager/vendor/xterm.min.js' 之类绝对引用
RE_ABS = re.compile(
    r"""(['"])(/app/lxcmanager/[^'"]+?\.(?:js|css))(?:\?v=\d+)?(['"])"""
)

changed = 0
for path in list(ROOT.rglob("*.js")):
    src = path.read_text(encoding="utf-8")
    out = RE_LOCAL.sub(lambda m: f"{m.group(1)}{m.group(2)}?v={STAMP}{m.group(3)}", src)
    out = RE_ABS.sub(lambda m: f"{m.group(1)}{m.group(2)}?v={STAMP}{m.group(3)}", out)
    if out != src:
        path.write_text(out, encoding="utf-8")
        changed += 1

print(f"✓ 模块引用已打戳 ?v={STAMP}（{changed} 个文件）")
