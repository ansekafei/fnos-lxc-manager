#!/bin/bash
# 构建 fnlxc / lxcmanager 的 fpk 安装包
# 打包方式对齐飞牛官方：app/ 打成 app.tgz，根目录文件直接进包
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="${ROOT}/.build"
rm -rf "${SRC}"; mkdir -p "${SRC}"

VERSION="$(sed -nE 's/^version[[:space:]]*=[[:space:]]*//p' "${ROOT}/manifest" | tr -d ' ')"
APPNAME="$(sed -nE 's/^appname[[:space:]]*=[[:space:]]*//p' "${ROOT}/manifest" | tr -d ' ')"

cp -r "${ROOT}/cmd" "${ROOT}/config" "${ROOT}/wizard" "${SRC}/" 2>/dev/null || true
cp "${ROOT}/ICON.PNG" "${ROOT}/ICON_256.PNG" "${ROOT}/manifest" "${SRC}/"

# 组装 app/ 内容
APP="${ROOT}/app"
rm -rf "${APP}"; mkdir -p "${APP}"
for d in ui server mcp templates; do
    [ -d "${ROOT}/${d}" ] && cp -r "${ROOT}/${d}" "${APP}/"
done
rm -rf "${APP}/server/__pycache__" 2>/dev/null || true

echo "${VERSION}" > "${APP}/.version"
( cd "${APP}" && tar -czf "${SRC}/app.tgz" .version * )
MD5="$(md5sum "${SRC}/app.tgz" | cut -d' ' -f1)"
sed -i "s|^checksum.*|checksum              = ${MD5}|" "${SRC}/manifest"

find "${SRC}" -type d -exec chmod 755 {} +
find "${SRC}" -type f -exec chmod 644 {} +
chmod 755 "${SRC}/cmd/"* 2>/dev/null || true

OUT="${ROOT}/dist/${APPNAME}-x86-${VERSION}.fpk"
mkdir -p "${ROOT}/dist"
( cd "${SRC}" && tar -czf "${OUT}" * )
echo "built: ${OUT}  ($(stat -c%s "${OUT}") bytes)  md5(app.tgz)=${MD5}"
