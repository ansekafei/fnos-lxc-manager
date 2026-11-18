#!/bin/bash
# ─────────────────────────────────────────────
# 标准打包脚本：推进版本号 → 同步所有版本位置 → 构建 fpk
#
# 用法:
#   ./release.sh              # 自动 patch +1（3.2.5 → 3.2.6）
#   ./release.sh 3.3.0        # 指定版本号
#   ./release.sh --dry        # 只推进版本号并展示差异，不打包
#   ./release.sh --prune      # 只清理旧包，不发版
#   KEEP=3 ./release.sh       # 发版后只保留最近 3 个包（默认 5，0 = 全留）
#
# 版本号统一写进 4 处（脚本保证一致）:
#   1. manifest                          version   = x.y.z
#   2. server/fnlxc.py                   APP_VERSION = "x.y.z"
#   3. ui/index.html                     app.js?v=NNN / style.css?v=NNN（缓存戳）
#   4. dist/lxcmanager-x86-x.y.z.fpk     包名
# ─────────────────────────────────────────────
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

MANIFEST="$ROOT/manifest"
SERVER="$ROOT/server/fnlxc.py"
INDEX="$ROOT/ui/index.html"

# ── 清理旧包（可独立调用）──
prune_dist() {
    local keep="${KEEP:-5}"
    [ "$keep" -gt 0 ] || { echo "── KEEP=0，保留全部包"; return 0; }
    local -a all
    mapfile -t all < <(ls -1t "$ROOT"/dist/*.fpk 2>/dev/null || true)
    local total=${#all[@]}
    [ "$total" -gt 0 ] || return 0
    if [ "$total" -le "$keep" ]; then
        echo "── dist/ 共 $total 个包，未超过保留上限 $keep"
        return 0
    fi
    echo "── 清理旧包（保留最近 $keep 个，共 $total 个）"
    local f
    for f in "${all[@]:$keep}"; do
        rm -f -- "$f" && echo "   删除 $(basename "$f")"
    done
    echo "── dist/ 现有 $keep 个包"
}

if [[ "${1:-}" == "--prune" ]]; then
    prune_dist
    exit 0
fi

# ── 读取当前版本 ──
CUR="$(sed -nE 's/^version[[:space:]]*=[[:space:]]*//p' "$MANIFEST" | tr -d ' ')"
[ -n "$CUR" ] || { echo "错误: manifest 里没有 version 行"; exit 1; }

# ── 计算新版本 ──
if [ $# -ge 1 ] && [[ "$1" != --* ]]; then
    NEW="$1"
else
    MAJOR=$(echo "$CUR" | cut -d. -f1)
    MINOR=$(echo "$CUR" | cut -d. -f2)
    PATCH=$(echo "$CUR" | cut -d. -f3)
    NEW="${MAJOR}.${MINOR}.$((PATCH + 1))"
fi
[[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "错误: 版本号格式应为 x.y.z"; exit 1; }

if [ "$NEW" = "$CUR" ]; then
    echo "错误: 新版本与当前版本相同（$CUR），发布必须推进版本号"
    exit 1
fi

# ── 缓存戳：用 x.y.z 数字拼接，保证每次发版都变化 ──
STAMP=$(echo "$NEW" | tr -d '.' | sed 's/^0*//')   # 3.2.6 → 326
STAMP=$((10#$STAMP))                               # 3.3.0 → 330 去前导零

echo "版本: $CUR → $NEW  (缓存戳 ?v=$STAMP)"

if [[ "${1:-}" == "--dry" ]]; then
    echo "(dry-run, 不写入不打包)"
    exit 0
fi

# ── 1. manifest ──
sed -i "s/^version[[:space:]]*=.*/version               = ${NEW}/" "$MANIFEST"

# ── 2. server APP_VERSION ──
sed -i "s/^APP_VERSION = .*/APP_VERSION = \"${NEW}\"/" "$SERVER"

# ── 3. 前端缓存戳（前端重建期间允许缺失）──
if [ -f "$INDEX" ]; then
    sed -i -E "s|(style\.css\?v=)[0-9]+|\1${STAMP}|; s|(app\.js\?v=)[0-9]+|\1${STAMP}|; s|(main\.js\?v=)[0-9]+|\1${STAMP}|" "$INDEX"
else
    echo "注意: ui/index.html 不存在（前端重建中），跳过缓存戳"
fi

# ── 校验一致性 ──
check() { grep -q "$2" "$1" || { echo "错误: $1 未写入 $2"; exit 1; }; }
check "$MANIFEST" "version               = ${NEW}"
check "$SERVER"   "APP_VERSION = \"${NEW}\""
[ -f "$INDEX" ] && check "$INDEX" "?v=${STAMP}"
check "$INDEX"    "app.js?v=${STAMP}"
echo "✓ 版本已同步到 manifest / server / ui 缓存戳"

# ── 4. 构建 ──
bash "$ROOT/build.sh"

# ── 校验产物 ──
OUT="$ROOT/dist/lxcmanager-x86-${NEW}.fpk"
[ -f "$OUT" ] || { echo "错误: 产物不存在 $OUT"; exit 1; }
python3 - "$NEW" "$STAMP" <<'PY'
import sys, tarfile, io
ver, stamp = sys.argv[1], sys.argv[2]
with tarfile.open(f"dist/lxcmanager-x86-{ver}.fpk") as o:
    m = o.extractfile("manifest").read().decode()
    d = o.extractfile("app.tgz").read()
with tarfile.open(fileobj=io.BytesIO(d)) as t:
    names = t.getnames()
    s = t.extractfile(next(n for n in names if n.endswith("server/fnlxc.py"))).read().decode()
    ui = t.extractfile(next(n for n in names if n.endswith("ui/index.html"))).read().decode()
    av = t.extractfile(next(n for n in names if n.endswith(".version"))).read().decode().strip()
assert f"version               = {ver}" in m, "manifest 版本不符"
assert f'APP_VERSION = "{ver}"' in s, "server 版本不符"
assert av == ver, f".version={av} 不符"
assert f"app.js?v={stamp}" in ui and f"style.css?v={stamp}" in ui, "缓存戳不符"
print(f"✓ 包内核对通过: manifest / APP_VERSION / .version / 缓存戳 ?v={stamp}")
PY

echo "── 完成: $OUT"

# ── 5. 清理旧包：默认保留最近 KEEP 个（KEEP=0 表示全部保留）──
prune_dist

