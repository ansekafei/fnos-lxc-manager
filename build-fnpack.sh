#!/bin/bash
# ============================================================
#  FnLxc Build Script — 官方 fnpack 版
#  用飞牛官方 fnpack 工具打包，manifest/checksum 由官方工具生成，
#  结构 100% 对齐 developer.fnnas.com 的应用包规范。
#
#  用法：
#      bash build-fnpack.sh                  # 自动找 fnpack
#      FNPACK=/path/to/fnpack bash build-fnpack.sh
#
#  取 fnpack（官方地址，Linux x86_64）：
#      curl -fsSL -o fnpack https://static2.fnnas.com/fnpack/fnpack-1.2.3-linux-amd64
#      chmod +x fnpack && sudo install -m 0755 fnpack /usr/local/bin/fnpack
# ============================================================
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"
DIST="${ROOT}/dist"
WORK="${ROOT}/.build-fnpack"

# ── 找 fnpack ──────────────────────────────────────────────
FNPACK_BIN="${FNPACK:-}"
# 转成绝对路径（后面会 cd 到工作目录再调用）
if [ -n "${FNPACK_BIN}" ] && [ "${FNPACK_BIN#/}" = "${FNPACK_BIN}" ]; then
    FNPACK_BIN="$(cd "$(dirname "${FNPACK_BIN}")" && pwd)/$(basename "${FNPACK_BIN}")"
fi
if [ -z "${FNPACK_BIN}" ]; then
    for c in fnpack /usr/local/bin/fnpack /usr/bin/fnpack "${ROOT}/.tools/fnpack" "${ROOT}/fnpack"; do
        if command -v "$c" >/dev/null 2>&1; then FNPACK_BIN="$(command -v "$c")"; break; fi
        if [ -x "$c" ]; then FNPACK_BIN="$c"; break; fi
    done
fi
if [ -z "${FNPACK_BIN}" ]; then
    echo "错误: 找不到 fnpack。请先安装："
    echo "  curl -fsSL -o fnpack https://static2.fnnas.com/fnpack/fnpack-1.2.3-linux-amd64"
    echo "  chmod +x fnpack && sudo install -m 0755 fnpack /usr/local/bin/fnpack"
    exit 1
fi

# ── 从 manifest 读元数据 ────────────────────────────────────
get_meta() { sed -nE "s/^${1}[[:space:]]*=[[:space:]]*//p" manifest | head -1 | sed -E 's/^"(.*)"$/\1/' | tr -d '\r'; }
APPNAME="$(get_meta appname)"; APPNAME="${APPNAME:-fnlxc}"
VERSION="$(get_meta version)"; VERSION="${VERSION:-0.0.0}"

echo "============================================"
echo "  FnLxc Build (fnpack)  ${APPNAME} ${VERSION}"
echo "  fnpack: ${FNPACK_BIN}"
echo "============================================"

rm -rf "${WORK}" "${DIST}"
mkdir -p "${WORK}/${APPNAME}/app" "${DIST}"

# ── 1. 包根：manifest / 图标 / cmd / config / wizard ───────
SRC="${WORK}/${APPNAME}"
cp manifest ICON.PNG ICON_256.PNG "${SRC}/"
cp -r cmd config "${SRC}/"
[ -d wizard ] && cp -r wizard "${SRC}/" || true
# 权限：目录必须 755（否则安装后变 drw-r--r--，应用中心进不去），
# 文件默认 644，可执行脚本 755。
find "${SRC}" -type d -exec chmod 755 {} \;
find "${SRC}" -type f -exec chmod 644 {} \;
chmod 755 "${SRC}"/cmd/* 2>/dev/null || true
[ -f "${SRC}/wizard/install" ] && chmod 755 "${SRC}/wizard/install" 2>/dev/null || true

# ── 2. app/ 目录（fnpack 会自己打成 app.tgz 并算 checksum）──
# 注：app/ 内部权限在构造完成后统一处理（见本文件末尾）
APP="${SRC}/app"
mkdir -p "${APP}/server" "${APP}/ui/images" "${APP}/mcp" "${APP}/templates"

cp server/fnlxc.py "${APP}/server/"
[ -f server/fnlxc_server ] && cp server/fnlxc_server "${APP}/server/"
for f in app.js config index.html style.css; do
    [ -f "ui/${f}" ] && cp "ui/${f}" "${APP}/ui/"
done
[ -d mcp ] && cp -r mcp/. "${APP}/mcp/"
if [ -d hooks ]; then
    mkdir -p "${APP}/hooks"
    cp hooks/*.sh "${APP}/hooks/" 2>/dev/null || true
    chmod 755 "${APP}/hooks"/*.sh 2>/dev/null || true
fi
[ -f templates/lxc-local ] && cp templates/lxc-local "${APP}/templates/"

# 图标：两套都放——ui/images/ 是官方规范，ui/assets/ 是本项目 ui/config 指向的位置
mkdir -p "${APP}/ui/assets"
if command -v convert >/dev/null 2>&1; then
    convert ICON.PNG -resize 56x56   -background none -gravity center -extent 64x64   PNG32:"${APP}/ui/images/icon_64.png"
    convert ICON_256.PNG -resize 240x240 -background none -gravity center -extent 256x256 PNG32:"${APP}/ui/images/icon_256.png"
    convert ICON.PNG -resize 56x56   -background none -gravity center -extent 64x64   PNG32:"${APP}/ui/assets/ICON-64.PNG"
    convert ICON_256.PNG -resize 240x240 -background none -gravity center -extent 256x256 PNG32:"${APP}/ui/assets/ICON-256.PNG"
else
    cp ICON.PNG "${APP}/ui/images/icon_64.png"
    cp ICON_256.PNG "${APP}/ui/images/icon_256.png"
    cp ICON.PNG "${APP}/ui/assets/ICON-64.PNG"
    cp ICON_256.PNG "${APP}/ui/assets/ICON-256.PNG"
fi

# 清掉不该进包的东西
find "${SRC}" -name "__pycache__" -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "${SRC}" -name "*.pyc" -delete 2>/dev/null || true
find "${SRC}" -name ".DS_Store" -delete 2>/dev/null || true

echo "[1/3] 源目录就绪: ${SRC}"

# ── 3. 调用官方 fnpack ─────────────────────────────────────
# app/ 内权限：目录 755、文件 644、可执行文件 755
find "${APP}" -type d -exec chmod 755 {} \;
find "${APP}" -type f -exec chmod 644 {} \;
[ -f "${APP}/server/fnlxc_server" ] && chmod 755 "${APP}/server/fnlxc_server"

echo "[2/3] 打包（tar 直出，对齐社区成熟项目 conversun/fnos-apps 的做法）..."
# 1) app/ → app.tgz（包内路径不带 ./ 前缀）
echo "${VERSION}" > "${APP}/.version"
( cd "${APP}" && tar -czf "${SRC}/app.tgz" .version * )
[ -f "${SRC}/app.tgz" ] || { echo "错误: app.tgz 生成失败"; exit 1; }

# 2) 写 checksum（app.tgz 的 MD5，32 位小写）
MD5_ACTUAL="$(md5sum "${SRC}/app.tgz" | cut -d' ' -f1)"
if grep -q '^checksum' "${SRC}/manifest"; then
    sed -i "s|^checksum.*|checksum=\"${MD5_ACTUAL}\"|" "${SRC}/manifest"
else
    printf 'checksum="%s"\n' "${MD5_ACTUAL}" >> "${SRC}/manifest"
fi

# 3) 整个源目录 → fpk
FINAL="${DIST}/${APPNAME}-x86-${VERSION}.fpk"
( cd "${SRC}" && tar -czf "${FINAL}" --exclude=app * )
chmod 644 "${FINAL}"

# ── 4. 校验 ────────────────────────────────────────────────
echo "[3/3] 校验..."
TMPC="$(mktemp -d)"
tar -xzf "${FINAL}" -C "${TMPC}"
MD5_ACTUAL="$(md5sum "${TMPC}/app.tgz" | cut -d' ' -f1)"
MD5_DECL="$(grep -E '^checksum' "${TMPC}/manifest" | sed -E 's/^checksum[[:space:]]*=[[:space:]]*//' | tr -d ' \"\r')"
echo "      app.tgz md5 = ${MD5_ACTUAL}"
echo "      manifest    = ${MD5_DECL}"
if [ "${MD5_ACTUAL}" != "${MD5_DECL}" ]; then
    echo "错误: checksum 不匹配"
    rm -rf "${TMPC}"; exit 1
fi
tar -tzf "${TMPC}/app.tgz" > "${TMPC}/.list" 2>/dev/null || true
if ! grep -qx "ui/index.html" "${TMPC}/.list"; then
    echo "警告: app.tgz 里没找到 ui/index.html"
fi
rm -rf "${TMPC}"

echo ""
echo "============================================"
echo "  Build Complete (fnpack)"
echo "============================================"
echo "  Package: ${FINAL}"
echo "  Size:    $(du -h "${FINAL}" | cut -f1)"
echo ""
echo "To install on fnOS:"
echo "  appcenter-cli install-local $(basename "${FINAL}")"
