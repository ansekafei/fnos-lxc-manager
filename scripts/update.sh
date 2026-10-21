#!/bin/bash
# fnlxc 更新脚本 — 飞牛应用中心不支持本地第三方包「更新」，用这个脚本替代。
#
# 用法：
#   bash scripts/update.sh /vol3/1000/临时/fnos-lxc/dist/fnlxc-1.3.3.fpk
#
# 做的事：
#   1. 备份当前 app 表记录到 /tmp
#   2. 清理应用中心数据库里 fnlxc 的记录（app / app_service / app_open / app_shortcut）
#   3. 删除程序目录 /var/apps/fnlxc 与 /usr/local/apps/@appcenter/fnlxc
#      （保留 @appconf/@appdata/@apphome/@apptemp/@appmeta，容器与配置不丢）
#   4. 用 trim-cli 安装新包
#   5. 重启应用并打印状态

set -euo pipefail

FPK="${1:-}"
APP="fnlxc"
TRIM_CLI="${TRIM_CLI:-/vol1/@appdata/deepseek.harness/dsh-data/skills/fnos/bin/trim-cli-linux-x64}"
PSQL="psql -h /var/run/postgresql -U postgres -d appcenter"

if [ -z "$FPK" ] || [ ! -f "$FPK" ]; then
    echo "用法: bash $0 <fnlxc-*.fpk>"
    exit 1
fi

echo "==> 1/5 备份数据库记录"
$PSQL -c "SELECT * FROM app WHERE app_name='${APP}';" > "/tmp/${APP}_app_backup_$(date +%s).txt" 2>&1 || true

echo "==> 2/5 清理应用中心记录"
$PSQL -c "
DELETE FROM app_service  WHERE app_id IN (SELECT id FROM app WHERE app_name='${APP}');
DELETE FROM app_open     WHERE app_id IN (SELECT id FROM app WHERE app_name='${APP}');
DELETE FROM app_shortcut WHERE app_id IN (SELECT id FROM app WHERE app_name='${APP}');
DELETE FROM app          WHERE app_name='${APP}';
" >/dev/null

echo "==> 3/5 清理程序目录（保留 @appconf/@appdata 等数据目录）"
rm -rf "/var/apps/${APP}" "/usr/local/apps/@appcenter/${APP}"

echo "==> 4/5 安装 $(basename "$FPK")"
"$TRIM_CLI" app install-fpk --remote-path "$FPK" --volume-id 1 --custom-parameters '[]' --yes

echo "==> 5/5 等待安装完成后重启"
for i in $(seq 1 30); do
    sleep 2
    if $PSQL -t -A -c "SELECT count(*) FROM app WHERE app_name='${APP}' AND status='running';" 2>/dev/null | grep -q '^1$'; then
        break
    fi
done
"$TRIM_CLI" app restart "$APP" --yes 2>&1 | tail -1 || true
sleep 8

echo
echo "==> 结果"
$PSQL -t -A -F'|' -c "SELECT 'db: '||version||' / '||status FROM app WHERE app_name='${APP}';" 2>/dev/null
echo -n "socket: "; ls -l "/usr/local/apps/@appcenter/${APP}/fnlxc.sock" 2>/dev/null | awk '{print $1, $6, $7, $8}' || echo "缺失"
echo -n "版本: "; grep '^version' "/var/apps/${APP}/manifest" 2>/dev/null | awk '{print $3}'
