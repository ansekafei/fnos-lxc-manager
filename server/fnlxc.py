#!/usr/bin/env python3
"""
FnLxc — LXC 容器管理后端（完整版 v2）
对标 Unraid LXC Plugin 全部功能：容器管理、快照、备份、克隆、元数据、终端、设置持久化
监听 fnOS 网关代理的 Unix Socket，提供 REST API
"""
import asyncio
import datetime
import glob
import json
import logging
import logging.handlers  # RotatingFileHandler
import os
import pty
import re
import shlex
import shutil
import signal
import struct
import subprocess
import termios
import time
import fcntl
import threading

try:
    from aiohttp import web
except ImportError:
    from http.server import HTTPServer, BaseHTTPRequestHandler
    from wsgiref.simple_server import make_server, WSGIServer
    from socketserver import ThreadingMixIn
    HAS_AIOHTTP = False
    import socket as _socket
else:
    HAS_AIOHTTP = True

# ── 日志配置（支持轮转，防止无限膨胀）────────────────────
LOG_FILE = "/var/log/apps/fnlxc.log"
LOG_MAX_BYTES = 10 * 1024 * 1024   # 单文件最大 10MB
LOG_BACKUP_COUNT = 5               # 保留 5 个轮转备份

# 不再用 basicConfig，避免 root logger 重复输出
_logger = logging.getLogger("fnlxc")
_logger.setLevel(logging.INFO)
_formatter = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")

# 添加 handler 前先检查，防止重复（模块热重载场景）
if not _logger.handlers:
    # 终端输出（供 main 捕获重定向到 fnlxc.log）
    _ch = logging.StreamHandler()
    _ch.setFormatter(_formatter)
    _logger.addHandler(_ch)

    # 带轮转的日志文件（/var/log/apps/fnlxc.log）
    try:
        _fh = logging.handlers.RotatingFileHandler(
            LOG_FILE, maxBytes=LOG_MAX_BYTES, backupCount=LOG_BACKUP_COUNT
        )
        _fh.setFormatter(_formatter)
        _logger.addHandler(_fh)
    except Exception:
        pass  # 日志目录不存在则跳过，不崩溃

logger = _logger

# Ensure HOME is set (LXC needs it for .local/share)
if "HOME" not in os.environ or not os.environ.get("HOME"):
    os.environ["HOME"] = "/vol1/1000/lxc"
logger.info("HOME=%s", os.environ.get("HOME", "NOT SET"))

APP_VERSION = "3.1.9"
# --- Paths ---
APP_ROOT = os.path.normpath(os.environ.get("TRIM_APPDEST", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")))
UI_DIR = os.path.join(APP_ROOT, "ui")
GATEWAY_PREFIX = os.environ.get("GATEWAY_PREFIX", "/app/lxcmanager")
SOCKET_PATH = os.environ.get("TRIM_SERVICE_SOCKET", "/var/apps/lxcmanager/lxcmanager.sock")
# 配置路径：TRIM_PKGETC 已包含应用目录（如 /usr/local/apps/@appconf/fnlxc）
# 直接在其下找 fnlxc.cfg；若无此环境变量则用 APP_ROOT/config（开发环境兼容）
_CFG_DIR = os.environ.get("TRIM_PKGETC", "")
if _CFG_DIR:
    SETTINGS_FILE = os.path.join(_CFG_DIR, "fnlxc.cfg")
else:
    _cfg_base = os.path.join(APP_ROOT, "config")
    SETTINGS_FILE = os.path.join(_cfg_base, "fnlxc.cfg")
os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
# 默认 LXC 容器路径（会被 settings 文件覆盖）
LXC_PATH = "/vol1/1000/lxc"
# 启动时从配置读取 LXC_PATH 和存储卷名（覆盖默认值）
_CFG_POOL = None
if os.path.isfile(SETTINGS_FILE):
    with open(SETTINGS_FILE) as _f:
        for _line in _f:
            _line = _line.strip()
            if _line.startswith("lxc_path="):
                _val = _line.split("=", 1)[1].strip()
                if _val:
                    LXC_PATH = _val
            elif _line.startswith("zfs_pool="):
                _CFG_POOL = _line.split("=", 1)[1].strip()
logger.info("LXC_PATH=%s", LXC_PATH)
logger.info("配置指定存储卷=%s", _CFG_POOL)

# ── Storage Backend (btrfs subvolume, LXC dir backend) ─────────────────────
# 本版本不依赖 ZFS。容器存储改为「LXC dir 后端 + btrfs 子卷」：
#   容器目录      {LXC_PATH}/{name}/
#   rootfs 子卷   {LXC_PATH}/{name}/rootfs            → lxc.rootfs.path = dir:<path>
#   快照子卷      {LXC_PATH}/{name}/.snapshots/{snap} （只读子卷）
#   备份          btrfs send → xz ；恢复 xz -dc → btrfs receive
# 非 btrfs 卷上容器仍可创建/启动（纯目录），但快照/克隆/备份会返回明确错误。
ZFS_POOL = None            # 兼容字段：存储卷名（如 vol1）；非 btrfs 为空串
ZFS_BASE_DATASET = "lxc"   # 兼容字段：命名空间，固定 lxc
STORAGE_IS_BTRFS = False
BTRFS_BIN = "/bin/btrfs"

SNAP_DIRNAME = ".snapshots"


def btrfs_run(args, timeout=120):
    """执行 btrfs 命令，返回 (rc, stdout, stderr)"""
    try:
        r = subprocess.run([BTRFS_BIN] + args, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout, r.stderr
    except FileNotFoundError:
        return 127, "", "btrfs 命令不存在"
    except subprocess.TimeoutExpired:
        return 124, "", "btrfs 命令超时"
    except Exception as e:
        return 1, "", str(e)


def zfs_run(args, timeout=30, check=True):
    """兼容旧调用：参数按 btrfs 子命令解释"""
    rc, out, err = btrfs_run(args, timeout=timeout)
    return rc, out, err


def fs_type_of(path):
    """返回路径所在文件系统类型（btrfs / ext4 / ...）"""
    try:
        r = subprocess.run(["stat", "-f", "-c", "%T", path], capture_output=True, text=True, timeout=5)
        return r.stdout.strip() if r.returncode == 0 else ""
    except Exception:
        return ""


def _volume_name(path):
    parts = os.path.abspath(path).strip("/").split("/")
    return parts[0] if parts else ""


def subvol_is(path):
    """判断路径是否为 btrfs 子卷"""
    if not os.path.isdir(path):
        return False
    rc, _, _ = btrfs_run(["subvolume", "show", path], timeout=30)
    return rc == 0


def _validate_zfs_pool_name(pool):
    """校验卷名是否合法（保留旧接口名）"""
    return bool(re.match(r'^[a-zA-Z][a-zA-Z0-9._-]*$', pool))


def _container_name_of(dataset):
    """把各种 dataset 写法归一成容器名

    支持：lxc/foo、vol1/lxc/foo、/vol1/lxc/foo/rootfs、foo
    """
    p = str(dataset or "").strip()
    if not p:
        return ""
    if p.startswith("/"):
        p = p.rstrip("/")
        if p.endswith("/rootfs"):
            p = os.path.dirname(p)
        return os.path.basename(p)
    parts = [x for x in p.split("/") if x]
    if "lxc" in parts:
        parts = parts[parts.index("lxc") + 1:]
    return parts[-1] if parts else ""


def ds_rootfs(dataset):
    """dataset → rootfs 子卷绝对路径"""
    return os.path.join(LXC_PATH, _container_name_of(dataset), "rootfs")


def ds_snapdir(dataset):
    """dataset → 快照目录绝对路径"""
    return os.path.join(LXC_PATH, _container_name_of(dataset), SNAP_DIRNAME)


def snap_path(dataset, snap):
    return os.path.join(ds_snapdir(dataset), snap)


def _valid_name(name):
    return bool(name) and bool(re.match(r"^[a-zA-Z0-9][-a-zA-Z0-9_.]*$", name))


def _valid_snap(snap):
    return bool(snap) and bool(re.match(r"^[a-zA-Z0-9_.-]+$", snap)) and ".." not in snap


def detect_zfs_pool(preferred_pool=None):
    """兼容旧调用名：探测存储卷并刷新全局状态。

    - LXC_PATH 落在 btrfs 上 → STORAGE_IS_BTRFS=True，ZFS_POOL=卷名，并把 LXC_PATH 建成子卷
    - 否则 → STORAGE_IS_BTRFS=False，ZFS_POOL=""，容器仍可用（dir 后端，无 CoW 功能）
    """
    global ZFS_POOL, ZFS_BASE_DATASET, STORAGE_IS_BTRFS, LXC_PATH
    ZFS_BASE_DATASET = "lxc"

    # 父目录必须存在才能判断文件系统类型
    _parent = os.path.dirname(os.path.abspath(LXC_PATH)) or "/"
    try:
        os.makedirs(_parent, exist_ok=True)
    except Exception as e:
        logger.warning("创建 LXC_PATH 父目录失败: %s", e)

    fs = fs_type_of(_parent)
    STORAGE_IS_BTRFS = (fs == "btrfs")
    if STORAGE_IS_BTRFS:
        ZFS_POOL = preferred_pool or _volume_name(LXC_PATH)
        if not os.path.exists(LXC_PATH):
            rc, _, err = btrfs_run(["subvolume", "create", LXC_PATH], timeout=60)
            if rc != 0:
                logger.info("LXC_PATH 子卷创建失败（改用普通目录）: %s", err.strip()[:200])
                try:
                    os.makedirs(LXC_PATH, exist_ok=True)
                except Exception as e:
                    logger.warning("创建 LXC_PATH 失败: %s", e)
        elif not subvol_is(LXC_PATH):
            logger.info("LXC_PATH 已存在且非子卷（沿用普通目录）: %s", LXC_PATH)
        logger.info("存储后端: btrfs 子卷（卷=%s，LXC_PATH=%s）", ZFS_POOL, LXC_PATH)
        return ZFS_POOL

    ZFS_POOL = ""
    logger.warning(
        "存储后端: %s（非 btrfs）——容器可创建/运行，但快照/克隆/备份不可用。LXC_PATH=%s",
        fs or "unknown", LXC_PATH)
    return None


# ── 兼容层：旧 zfs_* 接口 → btrfs 子卷实现 ────────────────────────────────

def zfs_dataset_exists(dataset):
    """rootfs 子卷（或目录）是否存在"""
    return os.path.isdir(ds_rootfs(dataset))


def zfs_create_dataset(dataset, pool=None):
    """创建容器 rootfs 子卷；btrfs 上用子卷，其他文件系统退化为普通目录

    Returns: (ok, rootfs_absolute_path)
    """
    name = _container_name_of(dataset)
    rootfs = ds_rootfs(dataset)
    if not _valid_name(name):
        logger.error("zfs_create_dataset 拒绝非法容器名: %s", dataset)
        return False, rootfs
    try:
        os.makedirs(os.path.join(LXC_PATH, name), exist_ok=True)
    except Exception as e:
        logger.warning("创建容器目录失败 %s: %s", name, e)
        return False, rootfs
    if os.path.isdir(rootfs):
        return True, rootfs
    if STORAGE_IS_BTRFS:
        rc, _, err = btrfs_run(["subvolume", "create", rootfs], timeout=120)
        if rc != 0:
            logger.warning("btrfs 子卷创建失败 %s: %s", rootfs, err.strip()[:300])
            return False, rootfs
    else:
        try:
            os.makedirs(rootfs, exist_ok=True)
        except Exception as e:
            logger.warning("创建 rootfs 目录失败 %s: %s", rootfs, e)
            return False, rootfs
    return True, rootfs


def zfs_snapshot_exists(dataset, snap):
    """快照子卷是否存在"""
    if not _valid_snap(snap):
        return False
    return os.path.isdir(snap_path(dataset, snap))


def find_snapshot_dataset(pool, snap_name):
    """按快照名反查所属容器（源容器已删除但快照残留的场景）

    Returns: (rootfs_path, snap_full) or (None, None)
    """
    if not _valid_snap(snap_name):
        return None, None
    try:
        for entry in os.listdir(LXC_PATH):
            sp = os.path.join(LXC_PATH, entry, SNAP_DIRNAME, snap_name)
            if os.path.isdir(sp):
                return ds_rootfs(entry), f"{ds_rootfs(entry)}@{snap_name}"
    except Exception:
        pass
    return None, None


def zfs_create_snapshot(dataset, snap_name, pool=None):
    """创建只读快照子卷

    Returns: (ok, snap_full) —— snap_full 形如 "<rootfs路径>@<snap>"
    """
    if not _valid_snap(snap_name):
        logger.error("zfs_create_snapshot 拒绝非法快照名: %s", snap_name)
        return False, ""
    rootfs = ds_rootfs(dataset)
    snapdir = ds_snapdir(dataset)
    sp = os.path.join(snapdir, snap_name)
    snap_full = f"{rootfs}@{snap_name}"
    if not os.path.isdir(rootfs):
        logger.error("rootfs 不存在，无法快照: %s", rootfs)
        return False, snap_full
    if not STORAGE_IS_BTRFS:
        logger.error("当前存储不是 btrfs，无法创建快照: %s", rootfs)
        return False, snap_full
    if os.path.isdir(sp):
        logger.info("快照已存在: %s", sp)
        return True, snap_full
    os.makedirs(snapdir, exist_ok=True)
    rc, _, err = btrfs_run(["subvolume", "snapshot", "-r", rootfs, sp], timeout=300)
    if rc != 0:
        logger.error("btrfs 快照失败 %s: %s", sp, err.strip()[:300])
        return False, snap_full
    return True, snap_full


def _du_bytes(path):
    try:
        r = subprocess.run(["du", "-sb", path], capture_output=True, text=True, timeout=20)
        if r.returncode == 0 and r.stdout:
            return r.stdout.split()[0]
    except Exception:
        pass
    return "0"


def zfs_list_snapshots(dataset, pool=None):
    """列出容器快照，返回 [{name, dataset, snap_full, used, refer, created_ts}]"""
    snapdir = ds_snapdir(dataset)
    if not os.path.isdir(snapdir):
        return []
    snaps = []
    for entry in sorted(os.listdir(snapdir)):
        sp = os.path.join(snapdir, entry)
        if not os.path.isdir(sp):
            continue
        try:
            ts = str(int(os.stat(sp).st_mtime))
        except Exception:
            ts = "0"
        size = _du_bytes(sp)
        snaps.append({
            "name": entry,
            "dataset": ds_rootfs(dataset),
            "snap_full": f"{ds_rootfs(dataset)}@{entry}",
            "used": size,
            "refer": size,
            "created_ts": ts,
        })
    return snaps


def zfs_delete_snapshot(dataset, snap_name, pool=None):
    """删除快照子卷"""
    if not _valid_snap(snap_name):
        logger.error("zfs_delete_snapshot 拒绝非法快照名: %s", snap_name)
        return False
    sp = snap_path(dataset, snap_name)
    if not os.path.isdir(sp):
        return True
    if subvol_is(sp):
        rc, _, err = btrfs_run(["subvolume", "delete", sp], timeout=300)
        if rc != 0:
            logger.warning("btrfs 删除快照失败 %s: %s", sp, err.strip()[:300])
            return False
        return True
    shutil.rmtree(sp, ignore_errors=True)
    return True


def zfs_rollback(dataset, snap_name, pool=None):
    """把 rootfs 恢复到快照内容（快照本身保留，可重复恢复）

    等价于 zfs rollback：容器须先 stop。
    """
    if not _valid_snap(snap_name):
        logger.error("zfs_rollback 拒绝非法快照名: %s", snap_name)
        return False
    rootfs = ds_rootfs(dataset)
    sp = snap_path(dataset, snap_name)
    if not os.path.isdir(sp):
        logger.error("快照不存在: %s", sp)
        return False
    if not STORAGE_IS_BTRFS:
        logger.error("当前存储不是 btrfs，无法回滚")
        return False
    # 先删除当前 rootfs（子卷或目录），再从快照生成可写子卷
    if subvol_is(rootfs):
        rc, _, err = btrfs_run(["subvolume", "delete", rootfs], timeout=900)
        if rc != 0:
            logger.error("回滚前删除 rootfs 子卷失败 %s: %s", rootfs, err.strip()[:300])
            return False
    elif os.path.isdir(rootfs):
        shutil.rmtree(rootfs, ignore_errors=True)
    rc, _, err = btrfs_run(["subvolume", "snapshot", sp, rootfs], timeout=900)
    if rc != 0:
        logger.error("回滚生成 rootfs 失败 %s: %s", rootfs, err.strip()[:300])
        return False
    return True


def zfs_clone(snap_full, new_dataset, pool=None):
    """从快照克隆出新容器的 rootfs 子卷

    Returns: (ok, new_rootfs_path)
    """
    new_rootfs = ds_rootfs(new_dataset)
    name = _container_name_of(new_dataset)
    if not _valid_name(name):
        logger.error("zfs_clone 拒绝非法容器名: %s", new_dataset)
        return False, new_rootfs
    if "@" not in str(snap_full):
        logger.error("zfs_clone 拒绝非法 snap_full: %s", snap_full)
        return False, new_rootfs
    ds_part, snap = str(snap_full).split("@", 1)
    if not _valid_snap(snap):
        logger.error("zfs_clone 拒绝非法快照名: %s", snap)
        return False, new_rootfs
    sp = snap_path(ds_part, snap)
    if not os.path.isdir(sp):
        logger.error("zfs_clone 源快照不存在: %s", sp)
        return False, new_rootfs
    if not STORAGE_IS_BTRFS:
        logger.error("当前存储不是 btrfs，无法克隆")
        return False, new_rootfs
    try:
        os.makedirs(os.path.dirname(new_rootfs), exist_ok=True)
    except Exception as e:
        logger.warning("创建克隆目标目录失败: %s", e)
        return False, new_rootfs
    if os.path.isdir(new_rootfs):
        return True, new_rootfs
    rc, _, err = btrfs_run(["subvolume", "snapshot", sp, new_rootfs], timeout=900)
    if rc != 0:
        logger.error("btrfs 克隆失败 %s: %s", new_rootfs, err.strip()[:300])
        return False, new_rootfs
    return True, new_rootfs


def zfs_destroy_dataset(dataset, pool=None, recursive=False):
    """销毁容器的全部子卷（快照 → rootfs → 目录）"""
    name = _container_name_of(dataset)
    if not _valid_name(name):
        logger.error("zfs_destroy_dataset 拒绝非法容器名: %s", dataset)
        return False
    cdir = os.path.join(LXC_PATH, name)
    if not os.path.isdir(cdir):
        return True
    snapdir = ds_snapdir(dataset)
    if os.path.isdir(snapdir):
        for entry in list(os.listdir(snapdir)):
            sp = os.path.join(snapdir, entry)
            if subvol_is(sp):
                btrfs_run(["subvolume", "delete", sp], timeout=300)
    rootfs = ds_rootfs(dataset)
    if subvol_is(rootfs):
        rc, _, err = btrfs_run(["subvolume", "delete", rootfs], timeout=900)
        if rc != 0:
            logger.warning("rootfs 子卷删除失败 %s: %s", rootfs, err.strip()[:300])
    shutil.rmtree(cdir, ignore_errors=True)
    return True


def zfs_unmount_dataset(dataset, pool=None, force=True):
    """dir 后端无需卸载，保留空实现"""
    return True


def _stop_containers_under_path(lxc_path, timeout=30):
    """停止指定路径下所有运行中的容器（同步版，供 executor 调用）"""
    if not lxc_path or not os.path.isdir(lxc_path):
        return
    try:
        r = subprocess.run(
            ["/usr/bin/lxc-ls", "--fancy"],
            capture_output=True, text=True, timeout=15
        )
    except Exception as e:
        logger.warning("lxc-ls 列出容器失败: %s", e)
        return
    if r.returncode != 0:
        return
    for line in r.stdout.strip().split("\n")[1:]:
        if not line.strip():
            continue
        parts = line.split(None, 7)
        if len(parts) < 2:
            continue
        name, state = parts[0], parts[1].lower()
        if state == "running":
            logger.info("停止运行中的容器: %s", name)
            subprocess.run(
                ["/usr/bin/lxc-stop", "-n", name, "-t", str(timeout)],
                capture_output=True, timeout=timeout + 5
            )


def cleanup_old_pool_datasets(old_pool, old_lxc_path=None):
    """切换存储卷后的清理：btrfs 模式下不做破坏性删除，仅记录

    旧数据仍留在旧卷上，由用户自行确认后手动删除，避免误删。
    """
    if old_pool:
        logger.info("存储卷已切换（旧卷=%s，旧路径=%s）；本版本不自动删除旧数据",
                    old_pool, old_lxc_path or "?")


def send_snapshot_argv(dataset, snap_name):
    """返回 btrfs send 的 argv（备份用）"""
    return [BTRFS_BIN, "send", snap_path(dataset, snap_name)]


def rootfs_used_bytes(dataset):
    """rootfs 实际占用字节数（备份进度估算用）"""
    try:
        return int(_du_bytes(ds_rootfs(dataset)))
    except Exception:
        return 0


def _human_size(nbytes):
    try:
        v = float(nbytes)
    except Exception:
        return "0"
    for unit in ("B", "K", "M", "G", "T", "P"):
        if v < 1024 or unit == "P":
            return f"{int(v)}B" if unit == "B" else f"{v:.1f}{unit}"
        v /= 1024
    return f"{v:.1f}P"


def list_storage_volumes():
    """列出可用 btrfs 存储卷（name/mountpoint/size/free/health）

    供 /api/zfs/pools 使用；返回结构保持旧 ZFS 版字段，前端无需改动。
    """
    vols = []
    try:
        seen = set()
        with open("/proc/mounts") as f:
            for line in f:
                parts = line.split()
                if len(parts) < 3 or parts[2] != "btrfs":
                    continue
                mp = parts[1].replace("\\040", " ")
                if mp in seen:
                    continue
                seen.add(mp)
                try:
                    st = os.statvfs(mp)
                    total = st.f_blocks * st.f_frsize
                    free = st.f_bavail * st.f_frsize
                except Exception:
                    continue
                name = _volume_name(mp) or mp.strip("/").replace("/", "_") or "btrfs"
                if any(x in name for x in ("boot", "data")):
                    continue
                vols.append({
                    "name": name,
                    "size": _human_size(total),
                    "free": _human_size(free),
                    "health": "btrfs",
                    "mountpoint": mp,
                })
        vols.sort(key=lambda v: v["mountpoint"])
        # 同一卷可能被多次挂载（bind mount / 子挂载），按卷名去重保留最浅挂载点
        _uniq = {}
        for v in vols:
            if v["name"] not in _uniq:
                _uniq[v["name"]] = v
        vols = list(_uniq.values())
    except Exception as e:
        logger.warning("获取存储卷列表异常: %s", e)
    return vols


def zfs_send(dataset, snap_name, output_path, pool=None):
    """btrfs send 快照流到文件"""
    if not os.path.isdir(snap_path(dataset, snap_name)):
        logger.error("zfs_send 快照不存在: %s", snap_path(dataset, snap_name))
        return False
    try:
        with open(output_path, "wb") as out:
            p = subprocess.Popen(send_snapshot_argv(dataset, snap_name),
                                 stdout=out, stderr=subprocess.PIPE)
            _, err_bytes = p.communicate(timeout=1800)
        if p.returncode != 0:
            logger.error("btrfs send 失败: %s", err_bytes.decode(errors="replace")[:300])
            return False
        return True
    except Exception as e:
        logger.error("btrfs send 异常: %s", e)
        return False


def zfs_recv(new_dataset, input_path, pool=None):
    """btrfs receive 从备份流恢复出 rootfs 子卷"""
    name = _container_name_of(new_dataset)
    if not _valid_name(name):
        logger.error("zfs_recv 拒绝非法容器名: %s", new_dataset)
        return False
    if not STORAGE_IS_BTRFS:
        logger.error("当前存储不是 btrfs，无法用 btrfs receive 恢复")
        return False
    rootfs = ds_rootfs(new_dataset)
    parent = os.path.dirname(rootfs)
    staging = os.path.join(parent, ".restore_tmp")
    try:
        os.makedirs(parent, exist_ok=True)
        shutil.rmtree(staging, ignore_errors=True)
        os.makedirs(staging, exist_ok=True)
        with open(input_path, "rb") as fin:
            p = subprocess.run([BTRFS_BIN, "receive", staging], stdin=fin,
                               capture_output=True, text=True, timeout=1800)
        if p.returncode != 0:
            logger.error("btrfs receive 失败: %s", (p.stderr or "")[:300])
            shutil.rmtree(staging, ignore_errors=True)
            return False
        entries = [e for e in os.listdir(staging)]
        if len(entries) != 1:
            logger.error("btrfs receive 产出异常（%d 个条目）", len(entries))
            shutil.rmtree(staging, ignore_errors=True)
            return False
        src = os.path.join(staging, entries[0])
        if os.path.isdir(rootfs):
            if subvol_is(rootfs):
                btrfs_run(["subvolume", "delete", rootfs], timeout=900)
            else:
                shutil.rmtree(rootfs, ignore_errors=True)
        os.rename(src, rootfs)
        shutil.rmtree(staging, ignore_errors=True)
        return True
    except Exception as e:
        logger.error("btrfs receive 异常: %s", e)
        shutil.rmtree(staging, ignore_errors=True)
        return False


def zfs_get_dataset_from_path(rootfs_path):
    """从 lxc.rootfs.path 值里取出路径/数据集（去掉 backend 前缀）"""
    for prefix in ("zfs:", "btrfs:", "dir:"):
        if rootfs_path.startswith(prefix):
            return rootfs_path[len(prefix):]
    return None


def container_is_zfs(name):
    """容器是否使用可快照的存储后端（dir/btrfs/zfs 前缀均视为本应用托管）"""
    config_path = os.path.join(LXC_PATH, name, "config")
    if not os.path.isfile(config_path):
        return False
    try:
        with open(config_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("lxc.rootfs.path"):
                    val = line.split("=", 1)[1].strip() if "=" in line else ""
                    return val.startswith(("dir:", "btrfs:", "zfs:"))
    except Exception:
        pass
    return False


def zfs_container_dataset(name):
    """获取容器 rootfs 路径（绝对路径）"""
    config_path = os.path.join(LXC_PATH, name, "config")
    if not os.path.isfile(config_path):
        return None
    try:
        with open(config_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("lxc.rootfs.path"):
                    if "=" not in line:
                        continue
                    val = line.split("=", 1)[1].strip()
                    for prefix in ("zfs:", "btrfs:", "dir:"):
                        if val.startswith(prefix):
                            return val[len(prefix):]
    except Exception:
        pass
    default = os.path.join(LXC_PATH, name, "rootfs")
    return default if os.path.isdir(default) else None

# 任务进度文件（参考 PVE：进度写入临时 JSON 文件，前端轮询读取）
# 文件路径: DATA_DIR/task_{mode}_{key}.json
# - backup:  mode="backup",  key=container_name
# - restore: mode="restore", key=container_name (新容器名，从备份恢复时)
# - create:  mode="create",  key=container_name (新容器名，从备份创建时)
# 路径：优先 TRIM_PKGVAR（@appdata），fallback 到 /tmp
_DATA_DIR = os.environ.get("TRIM_PKGVAR", "")
if _DATA_DIR:
    _DATA_DIR = os.path.join(_DATA_DIR, "tasks")
else:
    _DATA_DIR = "/tmp/fnlxc_tasks"

def _task_path(mode, key):
    safe = re.sub(r'[^a-zA-Z0-9_.-]', '_', key)
    safe = safe.replace('..', '_')  # 防止 .. 穿越
    return os.path.join(_DATA_DIR, f"task_{mode}_{safe}.json")

def _load_task(mode, key):
    """从文件加载任务状态，找不到返回 None"""
    p = _task_path(mode, key)
    if os.path.isfile(p):
        try:
            with open(p) as f:
                return json.loads(f.read())
        except Exception:
            return None
    return None

def _save_task(mode, key, data):
    """原子写入任务状态到文件（排除不可序列化字段）"""
    try:
        os.makedirs(_DATA_DIR, exist_ok=True)
        path = _task_path(mode, key)
        tmp = path + f".{threading.get_ident()}.tmp"
        # 过滤掉不可序列化的字段（proc、Popen 对象等）
        clean = {k: v for k, v in data.items() if k != "proc" and not callable(v)}
        with open(tmp, "w") as f:
            json.dump(clean, f, ensure_ascii=False)
        os.replace(tmp, path)
    except Exception as e:
        logger.error("任务文件写入失败 [%s/%s]: %s", mode, key, e)

def _delete_task(mode, key):
    """删除任务文件（完成后清理）"""
    try:
        os.unlink(_task_path(mode, key))
    except Exception:
        pass


# ── Backup progress tracking ──
# NOTE: backup_tasks 保留用于内存引用，_run_zfs_backup 同时写文件供轮询
backup_tasks = {}
backup_tasks_lock = threading.Lock()

def start_backup_task(name):
    """在后台线程中执行容器备份（btrfs send | xz）。实时更新进度到 backup_tasks[name]"""
    def _run():
        settings = load_settings()
        backup_dir = os.path.join(settings.get("backup_path", "/vol1/1000/lxc/bak"), name)
        os.makedirs(backup_dir, exist_ok=True)

        with backup_tasks_lock:
            task = backup_tasks.get(name)
        if not task:
            return
        if not container_is_zfs(name):
            with backup_tasks_lock:
                task["status"] = "error"
                task["error"] = "只有 btrfs 子卷容器支持备份（当前容器为 dir 目录）"
            return

        dataset = zfs_container_dataset(name)
        if not dataset:
            with backup_tasks_lock:
                task["status"] = "error"
                task["error"] = f"无法获取容器 {name} 的 rootfs 路径"
            return

        _run_zfs_backup(name, dataset, backup_dir, task)

    with backup_tasks_lock:
        prev = backup_tasks.get(name)
        if prev and prev["status"] in ("done", "error"):
            del backup_tasks[name]
        backup_tasks[name] = {
            "status": "running",
            "current_size": 0,
            "total_size": 0,
            "rootfs_size": 0,
            "elapsed": 0,
            "start_time": time.time(),
            "output_file": "",
            "proc": None,
        }
        # 同时写文件供前端轮询
        _save_task("backup", name, backup_tasks[name])
    t = threading.Thread(target=_run, daemon=True)
    t.start()


def _run_zfs_backup(name, dataset, backup_dir, task):
    """容器备份：打临时只读快照 → btrfs send | xz → 删临时快照"""
    with backup_tasks_lock:
        task["total_size"] = 0
        task["rootfs_size"] = 0

    snap_ts = time.strftime("%H.%M.%S_%Y-%m-%d")
    tmp_snap = f"_bak_{snap_ts}"
    snap_full = f"{dataset}@{tmp_snap}"
    timestamp = time.strftime("%H.%M.%S_%Y-%m-%d")
    output_file = os.path.join(backup_dir, f"{timestamp}_{name}.zfs.xz")
    ncores = os.cpu_count() or 2
    threads = max(1, ncores // 2)

    was_running = False
    try:
        # 1. 估算总大小（rootfs 实际占用）
        try:
            total_sz = rootfs_used_bytes(dataset)
            if total_sz > 0:
                # xz 压缩率约 30%
                with backup_tasks_lock:
                    task["total_size"] = int(total_sz * 0.30)
                _save_task("backup", name, task)
        except Exception:
            pass

        # 2. 检查是否在运行
        try:
            info_r = subprocess.run(
                ["lxc-info", "-n", name, "-s"],
                capture_output=True, text=True, timeout=10
            )
            if "running" in info_r.stdout.lower():
                was_running = True
                logger.info("容器 %s 正在运行，停止中...", name)
                subprocess.run(["lxc-stop", "-n", name, "-t", "15"],
                               capture_output=True, timeout=30)
        except Exception:
            pass

        # 3. 打临时快照
        ok, _ = zfs_create_snapshot(dataset, tmp_snap, ZFS_POOL)
        if not ok:
            raise Exception(f"btrfs 快照创建失败: {dataset}@{tmp_snap}")

        # 4. btrfs send | xz
        try:
            logger.info("btrfs 备份 %s → %s", name, output_file)
            zfs_send_cmd = send_snapshot_argv(dataset, tmp_snap)
            xz_cmd = ["xz", f"-T{threads}", "-6"]

            with open(output_file, "wb") as f:
                send_proc = subprocess.Popen(zfs_send_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                xz_proc = subprocess.Popen(xz_cmd, stdin=send_proc.stdout, stdout=f, stderr=subprocess.PIPE)
                send_proc.stdout.close()

                task["proc"] = xz_proc
                while xz_proc.poll() is None:
                    time.sleep(2)
                    if os.path.isfile(output_file):
                        cur_size = os.path.getsize(output_file)
                        with backup_tasks_lock:
                            task["current_size"] = cur_size
                            task["output_file"] = output_file
                            task["elapsed"] = int(time.time() - task["start_time"])
                        _save_task("backup", name, task)

                xz_proc.wait()
                send_proc.wait()

            with backup_tasks_lock:
                task["elapsed"] = int(time.time() - task["start_time"])
                if xz_proc.returncode == 0 and send_proc.returncode == 0:
                    final_size = os.path.getsize(output_file) if os.path.isfile(output_file) else 0
                    task["current_size"] = final_size
                    task["output_file"] = output_file
                    task["status"] = "done"
                    logger.info("btrfs 备份完成: %s (%d bytes)", output_file, final_size)
                    try:
                        removed = rotate_backups(name)
                        if removed:
                            logger.info("Backup rotation: removed %d old backup(s) for %s", removed, name)
                    except Exception as e:
                        logger.warning("Backup rotation failed for %s: %s", name, e)
                else:
                    err_parts = []
                    if send_proc.returncode:
                        s_err = send_proc.stderr.read().decode(errors="replace").strip() if send_proc.stderr else ""
                        err_parts.append(f"btrfs send exit={send_proc.returncode}: {s_err}")
                    if xz_proc.returncode:
                        x_err = xz_proc.stderr.read().decode(errors="replace").strip() if xz_proc.stderr else ""
                        err_parts.append(f"xz exit={xz_proc.returncode}: {x_err}")
                    task["status"] = "error"
                    task["error"] = "; ".join(err_parts) or "备份失败"
            # 写文件（done/error）并 5 分钟后清理
            _save_task("backup", name, task)
            def _cleanup():
                time.sleep(1800)
                _delete_task("backup", name)
            threading.Thread(target=_cleanup, daemon=True).start()
        finally:
            # 5. 删除临时快照（无论成功失败都清理）
            zfs_delete_snapshot(dataset, tmp_snap, ZFS_POOL)

    except Exception as e:
        with backup_tasks_lock:
            task["status"] = "error"
            task["error"] = str(e)
        _save_task("backup", name, task)
        logger.exception("备份失败: %s", e)
    finally:
        if was_running:
            try:
                subprocess.run(["lxc-start", "-d", "-n", name],
                               capture_output=True, timeout=30)
                logger.info("容器 %s 已重新启动", name)
            except Exception as e:
                logger.warning("重启容器 %s 失败: %s", name, e)


# ── Config file detection ──
_prev_network = {}
_prev_network_lock = threading.Lock()

# ── Default settings ──
DEFAULT_SETTINGS = {
    "default_path": LXC_PATH,
    "zfs_pool": ZFS_POOL or "",
    "default_interface": "",
    "backup_path": "/vol1/1000/lxc/bak",
    "backup_keep": "7",
    "backup_compression": "6",
    "backup_threads": "4",
    "backup_use_snapshot": "false",
    "backup_max_per_container": "5",
    'lxc_path': LXC_PATH,
    "lxc_mirror": "https://mirrors.tuna.tsinghua.edu.cn/lxc-images",
    "stop_timeout": "180",
    "network_type": "lxcbr0",
    "cache_dir": "/vol1/1000/lxc/template",
}

PROXMOX_MIRROR = "https://mirrors.tuna.tsinghua.edu.cn/proxmox/images/system/"
TEMPLATE_CACHE_DIR = "/vol1/1000/lxc/template"

LXC_CMDS = {
    "ls": "/usr/bin/lxc-ls", "info": "/usr/bin/lxc-info",
    "start": "/usr/bin/lxc-start", "stop": "/usr/bin/lxc-stop",
    "freeze": "/usr/bin/lxc-freeze", "unfreeze": "/usr/bin/lxc-unfreeze",
    "restart": "/usr/bin/lxc-stop", "destroy": "/usr/bin/lxc-destroy",
    "snapshot": "/usr/bin/lxc-snapshot", "config": "/usr/bin/lxc-config",
    "copy": "/usr/bin/lxc-copy", "create": "/usr/bin/lxc-create",
    "attach": "/usr/bin/lxc-attach", "execute": "/usr/bin/lxc-execute",
    "download": "/usr/share/lxc/templates/lxc-download",
}

def run_lxc(bin_key, args, timeout=30):
    binary = LXC_CMDS.get(bin_key, bin_key)
    # 不加 -P，让 LXC 用默认路径 /var/lib/lxc（fnOS 系统默认）
    # 容器 rootfs 在 ZFS（/vol2/lxc），config 在 /var/lib/lxc/（符号链接到 /vol2/lxc），
    # 状态文件在 /var/lib/lxc/，LXC 读取 /var/lib/lxc/{name}/config 时会解析符号链接找到 rootfs。
    if os.geteuid() != 0 and bin_key in LXC_CMDS:
        full_cmd = ["sudo", "-n", binary] + [str(a) for a in args]
    else:
        full_cmd = [binary] + [str(a) for a in args]
    try:
        r = subprocess.run(full_cmd, capture_output=True, text=True, timeout=timeout)
        return {"code": r.returncode, "stdout": r.stdout, "stderr": r.stderr}
    except FileNotFoundError:
        # Fallback: try to find binary via PATH or relative to LXC_PATH
        bin_name = os.path.basename(binary)
        if not os.path.exists(binary):
            # Try PATH-resolved version
            path_bin = shutil.which(bin_name)
            if path_bin:
                if os.geteuid() != 0 and bin_key in LXC_CMDS:
                    full_cmd = ["sudo", "-n", path_bin] + [str(a) for a in args]
                else:
                    full_cmd = [path_bin] + [str(a) for a in args]
                try:
                    r = subprocess.run(full_cmd, capture_output=True, text=True, timeout=timeout)
                    return {"code": r.returncode, "stdout": r.stdout, "stderr": r.stderr}
                except FileNotFoundError:
                    pass
            # Try relative to LXC_PATH/../cmd/
            cmd_dir = os.path.join(os.path.dirname(LXC_PATH.rstrip("/")), "cmd")
            fallback = os.path.join(cmd_dir, bin_name)
            if os.path.exists(fallback):
                if os.geteuid() != 0 and bin_key in LXC_CMDS:
                    full_cmd = ["sudo", "-n", fallback] + [str(a) for a in args]
                else:
                    full_cmd = [fallback] + [str(a) for a in args]
                try:
                    r = subprocess.run(full_cmd, capture_output=True, text=True, timeout=timeout)
                    return {"code": r.returncode, "stdout": r.stdout, "stderr": r.stderr}
                except FileNotFoundError:
                    pass
            # Fallback: try relative to this script's cmd/ directory
            script_cmd_dir = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "cmd"))
            script_fallback = os.path.join(script_cmd_dir, bin_name)
            if os.path.exists(script_fallback):
                if os.geteuid() != 0 and bin_key in LXC_CMDS:
                    full_cmd = ["sudo", "-n", script_fallback] + [str(a) for a in args]
                else:
                    full_cmd = [script_fallback] + [str(a) for a in args]
                try:
                    r = subprocess.run(full_cmd, capture_output=True, text=True, timeout=timeout)
                    return {"code": r.returncode, "stdout": r.stdout, "stderr": r.stderr}
                except FileNotFoundError:
                    pass
            # Fallback: try script's grandparent directory /cmd
            # e.g. /var/apps/fnlxc/target/../../cmd → /var/apps/fnlxc/cmd/
            grandparent_cmd = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "cmd")
            grandparent_fallback = os.path.join(grandparent_cmd, bin_name)
            if os.path.exists(grandparent_fallback):
                if os.geteuid() != 0 and bin_key in LXC_CMDS:
                    full_cmd = ["sudo", "-n", grandparent_fallback] + [str(a) for a in args]
                else:
                    full_cmd = [grandparent_fallback] + [str(a) for a in args]
                try:
                    r = subprocess.run(full_cmd, capture_output=True, text=True, timeout=timeout)
                    return {"code": r.returncode, "stdout": r.stdout, "stderr": r.stderr}
                except FileNotFoundError:
                    pass
        return {"code": -2, "stdout": "", "stderr": f"命令未找到: {binary}"}
    except subprocess.TimeoutExpired:
        return {"code": -1, "stdout": "", "stderr": "命令超时"}
    except Exception as e:
        return {"code": -3, "stdout": "", "stderr": str(e)}

async def async_run_lxc(bin_key, args, timeout=30):
    """异步包装：在 executor 线程池执行 run_lxc，不阻塞事件循环"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, run_lxc, bin_key, args, timeout)

async def async_list_containers():
    """异步版 list_containers，内部所有 run_lxc 调用走 async_run_lxc"""
    result = await async_run_lxc("ls", ["--fancy"])
    if result["code"] != 0:
        return []

    containers = []
    lines = result["stdout"].strip().split("\n")
    if len(lines) < 2:
        return []

    data_start = 1
    if len(lines) > 2 and lines[1].strip().startswith("-"):
        data_start = 2

    for line in lines[data_start:]:
        if not line.strip():
            continue
        parts = line.split(None, 7)
        if len(parts) < 2:
            continue
        name = parts[0]
        # 过滤快照容器（命名规则: {容器名}-snap-{自定义名称或时间戳}）
        if '-snap-' in name:
            continue
        state = parts[1].lower() if len(parts) > 1 else "unknown"
        meta, _ = read_metadata(name)
        info, _ = await async_get_container_info(name)
        containers.append({
            "name": name, "state": state,
            "ips": info.get("ip", []),
            "ipv4": info.get("ipv4", []),
            "ipv6": info.get("ipv6", []),
            "pid": info.get("pid", 0),
            "autostart": info.get("autostart", False),
            "os": info.get("os", ""), "release": info.get("release", ""),
            "memory_used": info.get("memory_used", 0),
            "memory_limit": info.get("memory_limit", 0),
            "cpu_usage": info.get("cpu_usage", 0),
            "cpu_cores": info.get("cpu_cores", 0),
            "processes": info.get("processes", 0),
            "uptime": info.get("uptime", ""),
            "created_at": info.get("created_at", ""),
            "snapshots": info.get("snapshots", 0),
            "backups": info.get("backups", 0),
            "network_rx": info.get("network_rx", 0),
            "network_tx": info.get("network_tx", 0),
            "network_rx_rate": info.get("network_rx_rate", 0),
            "network_tx_rate": info.get("network_tx_rate", 0),
            "disk_used": info.get("disk_used", 0),
            "disk_limit": info.get("disk_limit", 0),
            "description": meta.get("description", ""),
            "webui_url": meta.get("webui_url", ""),
            "container_order": meta.get("container_order", 0),
        })

    containers.sort(key=lambda c: (c.get("container_order", 0) or 0, c["name"]))
    return containers

async def async_get_container_info(name):
    """异步版 get_container_info — 委托至同步版"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, get_container_info, name)

def parse_int(text, default=0):
    try: return int(text)
    except: return default

# ── Settings ─────────────────────────────────────

def load_settings():
    s = dict(DEFAULT_SETTINGS)
    if os.path.isfile(SETTINGS_FILE):
        with open(SETTINGS_FILE) as f:
            for line in f:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1)
                    s[k.strip()] = v.strip()
    return s

def save_settings(updates):
    s = load_settings()
    # 防止换行符注入：设置值不能含换行或回车
    for k, v in updates.items():
        if '\n' in v or '\r' in v:
            raise ValueError(f"设置值不能包含换行符: {k}")
    s.update(updates)
    os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
    with open(SETTINGS_FILE, "w") as f:
        for k, v in s.items():
            f.write(f"{k}={v}\n")
    return s

def ensure_storage(pool=None, lxc_path=None, backup_path=None, cache_dir=None):
    """确保存储目录存在，并在 btrfs 上准备好 LXC_PATH 顶层子卷

    Args:
        pool: 存储卷名（如 "vol1"）
        lxc_path: LXC 容器根目录
        backup_path: 备份存储目录
        cache_dir: 模板缓存目录
    """
    import pwd as _pwd
    import grp as _grp

    dirs = []
    if lxc_path:
        dirs.append(lxc_path)
    if backup_path:
        dirs.append(backup_path)
    if cache_dir:
        dirs.append(cache_dir)

    for d in dirs:
        if d == lxc_path and fs_type_of(os.path.dirname(os.path.abspath(d)) or "/") == "btrfs" and not os.path.exists(d):
            rc, _, err = btrfs_run(["subvolume", "create", d], timeout=60)
            if rc != 0:
                logger.info("子卷创建失败，改用目录: %s", err.strip()[:200])
                os.makedirs(d, exist_ok=True)
        else:
            os.makedirs(d, exist_ok=True)
        try:
            uid = _pwd.getpwnam("admin").pw_uid
            gid = _grp.getgrnam("Users").gr_gid
            os.chown(d, uid, gid)
        except Exception:
            pass
        # ACL: g+Users:rwx（改用列表传参避免 shell 注入）
        subprocess.run(["setfacl", "-m", "g:Users:rwx", d], capture_output=True)
        subprocess.run(["setfacl", "-m", "d:g:Users:rwx", d], capture_output=True)

    # btrfs 模式：记录顶层是否为子卷（容器子卷不依赖它，仅提示）
    if lxc_path:
        try:
            if fs_type_of(lxc_path) == "btrfs":
                logger.info("LXC_PATH=%s 是 btrfs（子卷=%s）", lxc_path, subvol_is(lxc_path))
        except Exception as e:
            logger.warning("ensure_storage 子卷检查异常: %s", e)

# ── Config metadata helpers ──────────────────────

CONFIG_META_KEYS = {
    "description": "#container_description",
    "webui_url": "#container_webui",
    "container_order": "#container_order",
    "support_link": "#container_supportlink",
    "donate_link": "#container_donatelink",
}

def read_metadata(name):
    """从容器 config 注释中读取元数据"""
    config_path = os.path.join(LXC_PATH, name, "config")
    meta = {"description": "", "webui_url": "", "container_order": 0,
            "support_link": "", "donate_link": ""}
    if not os.path.isfile(config_path):
        return meta, None
    try:
        with open(config_path) as f:
            for line in f:
                line = line.strip()
                for key, prefix in CONFIG_META_KEYS.items():
                    if line.startswith(prefix + "="):
                        meta[key] = line[len(prefix)+1:]
                        if key == "container_order":
                            meta[key] = parse_int(meta[key])
    except Exception as e:
        return meta, str(e)
    return meta, None

def write_metadata(name, key, value):
    """"写入元数据到容器 config，以 #key=value 注释形式"""
    config_path = os.path.join(LXC_PATH, name, "config")
    prefix = CONFIG_META_KEYS.get(key)
    if not prefix:
        return False, f"未知元数据: {key}"
    if not os.path.isfile(config_path):
        return False, "配置文件未找到"
    try:
        with open(config_path) as f:
            lines = f.readlines()
        found = False
        new_lines = []
        for line in lines:
            stripped = line.strip()
            if stripped.startswith(prefix + "="):
                if value:
                    new_lines.append(f"{prefix}={value}\n")
                found = True
            else:
                new_lines.append(line)
        if not found and value:
            new_lines.append(f"{prefix}={value}\n")
        # Remove empty meta line if clearing
        if not value and found:
            pass  # already handled above
        with open(config_path, "w") as f:
            f.writelines(new_lines)
        return True, None
    except Exception as e:
        return False, str(e)

def delete_metadata(name, key):
    """删除元数据"""
    return write_metadata(name, key, "")

# ── Container parsing (enhanced) ─────────────────

def list_containers():
    """增强版：读取全部容器 + 元数据 + 状态"""
    result = run_lxc("ls", ["--fancy"])
    if result["code"] != 0:
        return []

    containers = []
    lines = result["stdout"].strip().split("\n")
    if len(lines) < 2:
        return []

    data_start = 1
    if len(lines) > 2 and lines[1].strip().startswith("-"):
        data_start = 2

    for line in lines[data_start:]:
        if not line.strip():
            continue
        parts = line.split(None, 7)
        if len(parts) < 2:
            continue
        name = parts[0]
        # 过滤快照容器（命名规则: {容器名}-snap-{自定义名称或时间戳}）
        if '-snap-' in name:
            continue
        state = parts[1].lower() if len(parts) > 1 else "unknown"

        # Read metadata from config
        meta, _ = read_metadata(name)

        # Get detailed info
        info, _ = get_container_info(name)

        containers.append({
            "name": name,
            "state": state,
            "ips": info.get("ip", []),
            "ipv4": info.get("ipv4", []),
            "ipv6": info.get("ipv6", []),
            "pid": info.get("pid", 0),
            "autostart": info.get("autostart", False),
            "os": info.get("os", ""),
            "release": info.get("release", ""),
            "memory_used": info.get("memory_used", 0),
            "memory_limit": info.get("memory_limit", 0),
            "cpu_usage": info.get("cpu_usage", 0),
            "cpu_cores": info.get("cpu_cores", 0),
            "processes": info.get("processes", 0),
            "uptime": info.get("uptime", ""),
            "created_at": info.get("created_at", ""),
            "snapshots": info.get("snapshots", 0),
            "backups": info.get("backups", 0),
            "network_rx": info.get("network_rx", 0),
            "network_tx": info.get("network_tx", 0),
            "network_rx_rate": info.get("network_rx_rate", 0),
            "network_tx_rate": info.get("network_tx_rate", 0),
            "disk_used": info.get("disk_used", 0),
            "disk_limit": info.get("disk_limit", 0),
            "description": meta.get("description", ""),
            "webui_url": meta.get("webui_url", ""),
            "container_order": meta.get("container_order", 0),
        })

    # Sort by container_order then name
    containers.sort(key=lambda c: (c.get("container_order", 0) or 0, c["name"]))
    return containers

# ── Cgroup helpers ──────────────────────────────

# ── CPU/Network rate tracking ──
_prev_cpu = {}
_prev_cpu_lock = threading.Lock()

def read_cgroup_cpu_percent(name):
    """从 cgroup v2 计算 CPU 使用率百分比（两次采样差值 / 时间差 / 核心数）"""
    path = f"/sys/fs/cgroup/lxc.payload.{name}/cpu.stat"
    usage = 0
    try:
        with open(path) as f:
            for line in f:
                if line.startswith("usage_usec"):
                    usage = int(line.split()[1])
    except (FileNotFoundError, OSError, ValueError):
        return 0.0

    now = time.time()
    cpu_cores = read_container_cpu_cores(name)
    if cpu_cores < 1:
        cpu_cores = 1

    with _prev_cpu_lock:
        prev = _prev_cpu.get(name)
        _prev_cpu[name] = (now, usage)
        if prev is not None:
            prev_time, prev_usage = prev
            dt = now - prev_time
            du = usage - prev_usage
            if dt > 0 and du >= 0:
                # usage_usec per second / 1_000_000 / num_cores * 100
                pct = (du / dt) / 1_000_000 / cpu_cores * 100.0
                return min(pct, 100.0)
    return 0.0

def read_cgroup_memory(name):
    """从 cgroup v2 直读内存使用和限制（字节数）"""
    used_path = f"/sys/fs/cgroup/lxc.payload.{name}/memory.current"
    limit_path = f"/sys/fs/cgroup/lxc.payload.{name}/memory.max"
    used, limit = 0, 0
    try:
        with open(used_path) as f:
            used = int(f.read().strip())
    except (FileNotFoundError, OSError, ValueError):
        pass
    try:
        with open(limit_path) as f:
            val = f.read().strip()
            if val.isdigit():
                limit = int(val)
    except (FileNotFoundError, OSError, ValueError):
        pass
    return used, limit

def read_container_cpu_cores(name):
    """从容器配置读取分配的 CPU 核心数"""
    config_path = get_container_config_path(name)
    try:
        with open(config_path) as f:
            for line in f:
                stripped = line.strip()
                # cgroup v2: lxc.cgroup2.cpu.max = quota period
                # quota/period = core count  (e.g. 100000 100000 = 1 core)
                if stripped.startswith("lxc.cgroup2.cpu.max") and "=" in stripped:
                    val = stripped.split("=", 1)[1].strip()
                    parts = val.split()
                    if len(parts) == 2:
                        quota, period = parts[0], parts[1]
                        try:
                            q, p = int(quota), int(period)
                            if p > 0 and q > 0:
                                return max(1, round(q / p))
                        except ValueError:
                            pass
                # cgroup v1 or cpuset: lxc.cgroup.cpuset.cpus = 0,1
                if stripped.startswith("lxc.cgroup.cpuset.cpus") and "=" in stripped:
                    val = stripped.split("=", 1)[1].strip()
                    cores = set()
                    for part in val.split(","):
                        part = part.strip()
                        if not part:
                            continue
                        if "-" in part:
                            try:
                                lo, hi = part.split("-", 1)
                                cores.update(range(int(lo), int(hi) + 1))
                            except ValueError:
                                pass
                        else:
                            try:
                                cores.add(int(part))
                            except ValueError:
                                pass
                    if cores:
                        return len(cores)
    except (FileNotFoundError, OSError):
        pass
    return 0

def get_container_info(name):
    """获取容器详细状态"""
    result = run_lxc("info", ["-n", name])
    if result["code"] != 0:
        return None, result["stderr"]

    info = {"name": name, "state": "unknown", "pid": 0, "ip": [],
            "ipv4": [], "ipv6": [],
            "memory_used": 0, "memory_limit": 0, "cpu_usage": 0,
            "autostart": False, "os": "", "release": "", "uptime": "",
            "created_at": "", "processes": 0, "snapshots": 0,
            "network_rx": 0, "network_tx": 0,
            "network_rx_rate": 0, "network_tx_rate": 0,
            "disk_used": 0, "disk_limit": 0}

    for line in result["stdout"].split("\n"):
        line = line.strip()
        if ":" not in line:
            continue
        key, val = line.split(":", 1)
        key, val = key.strip().lower(), val.strip()
        if key == "name": info["name"] = val
        elif key == "state": info["state"] = val.lower()
        elif key == "pid": info["pid"] = parse_int(val)
        elif key == "ip":
            info["ip"].extend([v.strip() for v in val.split() if v.strip()])
        elif key == "memory use":
            m = re.match(r"([\d.]+)\s*(\w+)", val)
            if m:
                num, unit = float(m.group(1)), m.group(2).lower()
                multipliers = {"kib": 1024, "mib": 1024*1024, "gib": 1024*1024*1024,
                               "kb": 1024, "mb": 1024*1024, "gb": 1024*1024*1024}
                info["memory_used"] = int(num * multipliers.get(unit, 1))
        elif key == "memory limit":
            m = re.match(r"([\d.]+)\s*(\w+)", val)
            if m:
                num, unit = float(m.group(1)), m.group(2).lower()
                multipliers = {"kib": 1024, "mib": 1024*1024, "gib": 1024*1024*1024}
                info["memory_limit"] = int(num * multipliers.get(unit, 1))
        elif key == "cpu use":
            m = re.search(r"[\d.]+", val)
            if m: info["cpu_usage"] = float(m.group())
        elif key == "processes": info["processes"] = parse_int(val)
        elif key == "autostart": info["autostart"] = val.lower() == "yes"
        elif key == "created": info["created_at"] = val
        # 创建时间兜底：用容器目录的 mtime
        if not info["created_at"]:
            try:
                info["created_at"] = str(int(os.stat(os.path.join(LXC_PATH, name)).st_mtime))
            except Exception:
                pass
        elif key == "os": info["os"] = val
        elif key == "release": info["release"] = val
        elif key == "uptime": info["uptime"] = val
        elif key == "snapshots": info["snapshots"] = parse_int(val)
        elif key == "rx bytes":
            m = re.match(r"([\d.]+)\s*(\w+)", val)
            if m:
                num, unit = float(m.group(1)), m.group(2).lower()
                multipliers = {"b": 1, "bytes": 1, "kib": 1024, "kiB": 1024, "kb": 1024,
                              "mib": 1024*1024, "miB": 1024*1024, "mb": 1024*1024,
                              "gib": 1024*1024*1024, "giB": 1024*1024*1024, "gb": 1024*1024*1024}
                info["network_rx"] = int(num * multipliers.get(unit, 1))
        elif key == "tx bytes":
            m = re.match(r"([\d.]+)\s*(\w+)", val)
            if m:
                num, unit = float(m.group(1)), m.group(2).lower()
                multipliers = {"b": 1, "bytes": 1, "kib": 1024, "kiB": 1024, "kb": 1024,
                              "mib": 1024*1024, "miB": 1024*1024, "mb": 1024*1024,
                              "gib": 1024*1024*1024, "giB": 1024*1024*1024, "gb": 1024*1024*1024}
                info["network_tx"] = int(num * multipliers.get(unit, 1))

    # Fallback: read autostart from config file (lxc-info may not output it in LXC 5.0+)
    config_path = os.path.join(LXC_PATH, name, "config")
    try:
        with open(config_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("lxc.start.auto"):
                    val = line.split("=", 1)[-1].strip()
                    info["autostart"] = val in ("1", "yes", "true")
                    break
    except: pass

    # Fallback: get IPs via lxc-attach + ip addr (with timeout to avoid hanging)
    if info["state"] == "running" and not info["ip"]:
        try:
            r = run_lxc("attach", ["-n", name, "--", "ip", "addr", "show"], 5)
            if r["code"] == 0:
                for line in r["stdout"].split("\n"):
                    m = re.search(r"inet\s+(\d+\.\d+\.\d+\.\d+)", line)
                    if m:
                        info["ip"].append(m.group(1))
                    m6 = re.search(r"inet6\s+([0-9a-f:]+)", line)
                    if m6:
                        addr = m6.group(1)
                        if addr not in info["ipv6"]:
                            info["ipv6"].append(addr)
        except Exception:
            pass
        # Also try via dnsmasq leases file (multiple possible paths)
        if not info["ip"]:
            for leases_path in (
                "/var/lib/misc/dnsmasq.lxcbr0.leases",
                "/var/lib/dnsmasq/dnsmasq.leases",
                "/run/dnsmasq/dnsmasq.leases",
                "/var/lib/dhcp/dhclient.leases",
            ):
                try:
                    with open(leases_path) as f:
                        for line in f:
                            parts = line.split()
                            # dnsmasq format: type timestamp IP MAC hostname client-id
                            if len(parts) >= 4 and parts[3] == name:
                                info["ip"].append(parts[2])
                                break
                except Exception:
                    pass

    # Separate IPv4 and IPv6
    for addr in info["ip"]:
        if ":" in addr:
            if addr not in info["ipv6"]:
                info["ipv6"].append(addr)
        elif "." in addr:
            if addr not in info["ipv4"]:
                info["ipv4"].append(addr)

    # ── OS / Release / Arch / Uptime（需要从容器内部读取）────────────
    # 容器运行时：用 lxc-attach；停止时：直接从 rootfs 读 /etc/os-release
    rootfs = get_container_rootfs(name)
    _os, _release, _arch, _uptime = "", "", "", ""

    def _read_os_release(rfs):
        os_info = {}
        path = os.path.join(rfs, "etc", "os-release")
        if os.path.isfile(path):
            try:
                with open(path) as f:
                    for line in f:
                        line = line.strip()
                        if "=" in line:
                            k, v = line.split("=", 1)
                            v = v.strip('"').strip("'")
                            os_info[k] = v
            except Exception:
                pass
        return os_info

    if info["state"] == "running":
        # 运行时：用 lxc-attach（带 5 秒超时避免挂起）
        for cmd, key, selector in [
            (["cat", "/etc/os-release"], "os_release", ["PRETTY_NAME", "NAME"]),
            (["uname", "-m"], "arch", None),
            (["cat", "/proc/uptime"], "uptime", None),
        ]:
            try:
                r = run_lxc("attach", ["-n", name, "--"] + cmd, 5)
                if r["code"] == 0:
                    output = r["stdout"].strip()
                    if key == "os_release":
                        for sel in selector:
                            if sel in output:
                                _os = output.split(sel)[1].split("=")[1].strip('"').strip("'") if "=" in output else output
                                break
                        # 提取 NAME=
                        for line in output.split("\n"):
                            if line.startswith("PRETTY_NAME="):
                                _os = line.split("=", 1)[1].strip('"').strip("'")
                                break
                            elif line.startswith("NAME=") and not _os:
                                _os = line.split("=", 1)[1].strip('"').strip("'")
                    elif key == "arch":
                        _arch = output
                    elif key == "uptime":
                        # uptime = "1234.5 5678.9" → 取第一个数（系统运行秒数）
                        first = output.split()[0] if output else "0"
                        try:
                            secs = float(first)
                            days = int(secs // 86400)
                            hours = int((secs % 86400) // 3600)
                            mins = int((secs % 3600) // 60)
                            _uptime = f"{days}天{hours}时{mins}分" if days > 0 else f"{hours}时{mins}分"
                        except Exception:
                            _uptime = output
            except Exception:
                pass
    else:
        # 停止时：从 rootfs 直接读
        if rootfs and os.path.isdir(rootfs):
            os_info = _read_os_release(rootfs)
            _os = os_info.get("PRETTY_NAME", os_info.get("NAME", ""))
            try:
                uname_path = os.path.join(rootfs, "bin", "uname")
                if os.path.exists(uname_path):
                    r = subprocess.run([uname_path, "-m"], capture_output=True, text=True, timeout=3)
                    if r.returncode == 0:
                        _arch = r.stdout.strip()
            except Exception:
                pass

    if _os:
        info["os"] = _os
    if _arch:
        info["arch"] = _arch
    if _uptime:
        info["uptime"] = _uptime

    # Count snapshots: btrfs 快照优先，否则用目录扫描（lxc-copy -s 创建的 CoW 快照容器）
    snap_count = 0
    if container_is_zfs(name):
        dataset = zfs_container_dataset(name)
        if dataset:
            snaps = zfs_list_snapshots(dataset, ZFS_POOL)
            snap_count = len(snaps)
    else:
        if os.path.isdir(LXC_PATH):
            prefix = f"{name}-snap-"
            for entry in os.listdir(LXC_PATH):
                if entry.startswith(prefix) and os.path.isdir(os.path.join(LXC_PATH, entry)):
                    snap_count += 1
    info["snapshots"] = snap_count

    # MAC：从 config 读真实值，前端元数据页据此回填
    try:
        _cfg = get_container_config_path(name)
        if os.path.isfile(_cfg):
            with open(_cfg) as _f:
                for _line in _f:
                    if _line.strip().startswith("lxc.net.0.hwaddr"):
                        info["mac"] = _line.split("=", 1)[1].strip()
                        break
    except Exception:
        pass

    # 从 config 真实检测存储后端（API 字段名沿用，前端不用改）
    if container_is_zfs(name):
        info["backend_type"] = "btrfs" if STORAGE_IS_BTRFS else "dir"
        info["zfs_dataset"] = zfs_container_dataset(name) or ""
    else:
        info["backend_type"] = "dir"
        info["zfs_dataset"] = ""

    # Count backups
    try:
        info["backups"] = len(list_backups(name))
    except Exception:
        info["backups"] = 0

    # Disk usage: du -sb on rootfs (exclude /proc and /sys)
    rootfs_path = os.path.join(LXC_PATH, name, "rootfs")
    if os.path.isdir(rootfs_path):
        try:
            du_r = subprocess.run(
                ["du", "-sb", "--exclude=/proc", "--exclude=/sys", rootfs_path],
                capture_output=True, text=True, timeout=15
            )
            if du_r.returncode == 0:
                m = re.match(r"(\d+)", du_r.stdout.strip())
                if m:
                    info["disk_used"] = int(m.group(1))
        except Exception:
            pass

    # Network rate: compute delta from previous sample
    now = time.time()
    rx = info.get("network_rx", 0)
    tx = info.get("network_tx", 0)
    with _prev_network_lock:
        prev = _prev_network.get(name)
        if prev is not None:
            prev_time, prev_rx, prev_tx = prev
            dt = now - prev_time
            if dt > 0:
                info["network_rx_rate"] = max(0, int((rx - prev_rx) / dt))
                info["network_tx_rate"] = max(0, int((tx - prev_tx) / dt))
        _prev_network[name] = (now, rx, tx)

    # Cgroup v2 直读 CPU/内存
    info["cpu_usage"] = read_cgroup_cpu_percent(name)
    info["cpu_cores"] = read_container_cpu_cores(name)
    mem_used, mem_limit = read_cgroup_memory(name)
    if mem_used > 0:
        info["memory_used"] = mem_used
    if mem_limit > 0:
        info["memory_limit"] = mem_limit

    return info, None

# ── Network apply ──────────────────────────────

def apply_container_network(name):
    """根据 settings 的 host_interface 自动设置容器网络模式（macvlan/veth）
    如果容器 config 已有 lxc.net.0.type 配置则跳过（如 Proxmox 模板创建时已设）"""
    settings = load_settings()
    config_path = get_container_config_path(name)
    if not os.path.isfile(config_path):
        logger.warning("apply_network: 配置不存在 %s", config_path)
        return
    try:
        with open(config_path) as f:
            lines = f.readlines()
    except Exception as e:
        logger.warning("apply_network: 读取配置失败 %s", e)
        return

    # 如果已有 lxc.net.0.type 配置，不做覆盖
    for line in lines:
        if line.strip().startswith("lxc.net.0.type"):
            logger.info("apply_network: %s 已有网络配置，跳过", name)
            return

    # "auto" 是向导里的占位符，表示"不使用 macvlan"，实际应走 veth/lxcbr0
    host_iface = settings.get("host_interface", "").strip()
    if host_iface in ("", "auto"):
        host_iface = ""

    # 检测 host_interface 类型：OVS 桥 → veth+ovs，物理网卡 → macvlan
    net_extra = ""
    if host_iface:
        is_ovs = False
        try:
            r = subprocess.run(
                ["ovs-vsctl", "br-exists", host_iface],
                capture_output=True, text=True, timeout=5
            )
            is_ovs = (r.returncode == 0)
        except Exception:
            pass
        if is_ovs:
            # OVS 桥：LXC 原生支持（is_ovs_bridge 检测 /sys/class/net/<br>/bridge
            # 不存在即视为 OVS），veth 建好后自动 ovs-vsctl add-port，无需 hook。
            net_type = "veth"
            net_link = host_iface
            logger.info("apply_network: %s 是 OVS 桥 %s，使用原生 veth+OVS", name, host_iface)
        else:
            # 物理网卡（非 OVS）：macvlan
            net_type = "macvlan"
            net_link = host_iface
    else:
        net_type = "veth"
        net_link = "lxcbr0"

    new_lines = []
    net_0_replaced = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("lxc.net.0."):
            # Skip old net.0 lines — we replace the whole block
            continue
        new_lines.append(line)

    # Insert the new network block at the top (after includes/paths/names)
    # Find a good insertion point
    insert_idx = 0
    last_include_idx = -1
    for i, line in enumerate(new_lines):
        stripped = line.strip()
        if stripped.startswith("lxc.net."):
            break
        if stripped.startswith("lxc.include"):
            last_include_idx = i
        if stripped.startswith("lxc.start.") or stripped.startswith("lxc.tty.") or stripped.startswith("lxc.environment"):
            insert_idx = i
            break
        if stripped.startswith("lxc.apparmor") or stripped.startswith("lxc.mount") or stripped.startswith("lxc.cgroup"):
            insert_idx = i
            break
    # 未找到已知区段标签时，插在 lxc.include 之后或文件末尾
    if insert_idx == 0 and last_include_idx >= 0:
        insert_idx = last_include_idx + 1

    net_conf = (
        f"lxc.net.0.type = {net_type}\n"
        f"lxc.net.0.link = {net_link}\n"
        f"{net_extra}"
        f"lxc.net.0.flags = up\n"
    )
    if not host_iface:
        import random
        mac = "00:16:3e:{:02x}:{:02x}:{:02x}".format(
            random.randint(0, 255), random.randint(0, 255), random.randint(0, 255)
        )
        net_conf += f"lxc.net.0.hwaddr = {mac}\n"
    net_conf += "lxc.net.0.name = eth0\n"

    new_lines.insert(insert_idx, net_conf)

    try:
        with open(config_path, "w") as f:
            f.writelines(new_lines)
        logger.info("apply_network: %s → %s (link=%s)", name, net_type, net_link)
    except Exception as e:
        logger.warning("apply_network: 写入失败 %s", e)


def get_primary_interface():
    """自动检测主网络接口（第一个非 lo 的 eth 类型接口）

    注意：如果物理网卡已接入 OVS（master ovs-system），macvlan 需绑在
    OVS port 而非物理口本身，否则报 Device or resource busy。
    """
    try:
        sys_net = "/sys/class/net"
        if os.path.isdir(sys_net):
            for iface in sorted(os.listdir(sys_net)):
                if iface == "lo":
                    continue
                try:
                    with open(os.path.join(sys_net, iface, "type")) as f:
                        iftype = int(f.read().strip())
                    if iftype != 1:  # not ARPHRD_ETHER
                        continue
                    # Skip bridge/veth/docker/lxcbr/ovs* interfaces
                    if any(x in iface for x in ("br-", "docker", "veth", "lxcbr", "ovs")):
                        continue
                    # 检查是否 enslaved to OVS（macvlan 需绑在 OVS port 上）
                    master_path = os.path.join(sys_net, iface, "master")
                    if os.path.exists(master_path):
                        master = os.path.basename(os.readlink(master_path))
                        if master == "ovs-system":
                            # 找对应的 OVS port（通常叫 {iface}-ovs）
                            ovs_port = iface + "-ovs"
                            if os.path.exists(os.path.join(sys_net, ovs_port)):
                                logger.info("get_primary_interface: %s 是 OVS port，返回 %s", iface, ovs_port)
                                return ovs_port
                            # 否则跳过，尝试其他接口
                            logger.info("get_primary_interface: %s 是 OVS enslaved，跳过", iface)
                            continue
                    return iface
                except Exception:
                    continue
    except Exception:
        pass
    return "enp4s0-ovs"  # fallback


def _cleanup_ovs_leftover(name):
    """兜底清理容器残留的 OVS 端口与 veth（hook 未触发时）"""
    h = f"veth-{name}-h"
    try:
        r = subprocess.run(["ovs-vsctl", "port-to-br", h],
                           capture_output=True, text=True, timeout=5)
        br = (r.stdout or "").strip()
        if br:
            subprocess.run(["ovs-vsctl", "--if-exists", "del-port", br, h],
                           capture_output=True, timeout=5)
            logger.info("清理残留 OVS 端口 %s（桥 %s）", h, br)
    except Exception:
        pass
    try:
        subprocess.run(["ip", "link", "del", h], capture_output=True, timeout=5)
    except Exception:
        pass


def is_ovs_bridge(iface):
    """判断某个接口是不是 OVS bridge（macvlan 挂 OVS bridge 流量不通，必须走 veth+ovs）"""
    if not iface:
        return False
    try:
        r = subprocess.run(["ovs-vsctl", "br-exists", iface],
                           capture_output=True, text=True, timeout=5)
        return r.returncode == 0
    except Exception:
        return False


def _net_params_from_body(body):
    """从请求体提取网络参数。默认 bridge（直连宿主网桥/OVS），不再默认 NAT。"""
    def _s(k):
        v = body.get(k)
        return v.strip() if isinstance(v, str) and v.strip() else None
    return {
        "network_type": (body.get("network_type") or "bridge"),
        "ipv4": _s("ipv4_address"),
        "gateway": _s("ipv4_gateway"),
        "ipv6": _s("ipv6_address"),
        "ipv6_gw": _s("ipv6_gateway"),
    }


def set_root_password(rootfs, password):
    """用 openssl passwd -6 生成 SHA-512 crypt，写入 rootfs 的 /etc/shadow。

    不依赖容器启动，也不依赖 python 的 crypt 模块（3.13 起已移除）。
    返回 (ok, msg)。
    """
    import subprocess, secrets, string
    shadow = os.path.join(rootfs, "etc", "shadow")
    if not os.path.isfile(shadow):
        return False, "/etc/shadow 不存在（模板可能不完整）"
    salt = "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(16))
    try:
        r = subprocess.run(["openssl", "passwd", "-6", "-salt", salt, password],
                           capture_output=True, text=True, timeout=10)
        if r.returncode != 0 or not r.stdout.strip():
            return False, f"openssl 生成密码失败: {r.stderr.strip()}"
        hashed = r.stdout.strip()
    except Exception as e:
        return False, f"生成密码异常: {e}"

    try:
        with open(shadow) as f:
            lines = f.readlines()
        out, found = [], False
        for line in lines:
            if line.startswith("root:"):
                parts = line.rstrip("\n").split(":")
                parts[1] = hashed
                out.append(":".join(parts) + "\n")
                found = True
            else:
                out.append(line)
        if not found:
            out.append(f"root:{hashed}:19000:0:99999:7:::\n")
        with open(shadow, "w") as f:
            f.writelines(out)
        os.chmod(shadow, 0o640)
    except Exception as e:
        return False, f"写入 shadow 失败: {e}"
    return True, "ok"


def set_ssh_authorized_keys(rootfs, pubkey):
    """把 SSH 公钥写进 rootfs 的 /root/.ssh/authorized_keys。"""
    try:
        d = os.path.join(rootfs, "root", ".ssh")
        os.makedirs(d, exist_ok=True)
        os.chmod(d, 0o700)
        f = os.path.join(d, "authorized_keys")
        key = pubkey.strip()
        if not key.endswith("\n"):
            key += "\n"
        with open(f, "w") as fh:
            fh.write(key)
        os.chmod(f, 0o600)
        return True, "ok"
    except Exception as e:
        return False, str(e)


def enable_root_ssh(rootfs):
    """如果模板带 sshd_config，允许 root 用密钥登录。"""
    cfg = os.path.join(rootfs, "etc", "ssh", "sshd_config")
    if not os.path.isfile(cfg):
        return False
    try:
        txt = open(cfg).read()
        lines = [l for l in txt.splitlines()
                 if not l.strip().startswith(("PermitRootLogin", "PasswordAuthentication"))]
        lines += ["PermitRootLogin yes", "PasswordAuthentication yes"]
        open(cfg, "w").write("\n".join(lines) + "\n")
        return True
    except Exception:
        return False


def write_container_network_config_by_type(name, network_type, ipv4=None, gateway=None,
                                           ipv6=None, ipv6_gw=None, mac=None,
                                           vlan=None, mtu=None):
    """根据 network_type (bridge/nat) 向容器 LXC config 写入 per-container 网络配置。

    静态地址（可选，PVE 式）：
      ipv4     形如 "192.168.1.100/24"
      gateway  形如 "192.168.1.1"
      ipv6     形如 "2408:8248:7020:6430::100/64"
      ipv6_gw  形如 "fe80::1"
    不传则走 DHCP（容器内自行获取）。
    """
    config_path = os.path.join(LXC_PATH, name, "config")
    if not os.path.isfile(config_path):
        logger.warning("write_network_by_type: 配置不存在 %s", config_path)
        return

    net_extra = ""
    import random
    if not mac:
        mac = "00:16:3e:{:02x}:{:02x}:{:02x}".format(
            random.randint(0, 255), random.randint(0, 255), random.randint(0, 255)
        )
    if network_type == "bridge":
        host_iface = get_primary_interface()
        if is_ovs_bridge(host_iface):
            # OVS 桥：LXC 原生支持 OVS（is_ovs_bridge 判 /sys/class/net/<br>/bridge
            # 是否存在），veth 建好后自动 ovs-vsctl add-port，停止时自动 del-port。
            # 不需要 hook、不需要重编 liblxc。
            net_type = "veth"
            net_link = host_iface
            logger.info("write_network_by_type: %s → OVS(veth, bridge=%s, mac=%s)", name, host_iface, mac)
        else:
            # 普通 Linux bridge：veth 挂上去，由 LXC 自己 attach。
            # 不用 macvlan —— 它无法与宿主直接通信，且不支持挂 OVS。
            net_type = "veth"
            net_link = host_iface
            logger.info("write_network_by_type: %s → bridge (veth, link=%s)", name, host_iface)
    else:
        # NAT (default)
        net_type = "veth"
        net_link = "lxcbr0"
        logger.info("write_network_by_type: %s → nat (veth, link=lxcbr0)", name)

    try:
        with open(config_path) as f:
            lines = f.readlines()
    except Exception as e:
        logger.warning("write_network_by_type: 读取失败 %s", e)
        return

    # Remove existing lxc.net.0.* lines
    new_lines = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("lxc.net.0."):
            continue
        new_lines.append(line)

    # Insert network block at appropriate position
    insert_idx = 0
    last_include_idx = -1
    for i, line in enumerate(new_lines):
        stripped = line.strip()
        if stripped.startswith("lxc.net."):
            break
        if stripped.startswith("lxc.include"):
            last_include_idx = i
        if stripped.startswith("lxc.start.") or stripped.startswith("lxc.tty.") or stripped.startswith("lxc.environment"):
            insert_idx = i
            break
        if stripped.startswith("lxc.apparmor") or stripped.startswith("lxc.mount") or stripped.startswith("lxc.cgroup"):
            insert_idx = i
            break
    if insert_idx == 0 and last_include_idx >= 0:
        insert_idx = last_include_idx + 1

    static_lines = ""
    if ipv4:
        static_lines += f"lxc.net.0.ipv4.address = {ipv4}\n"
    if gateway:
        static_lines += f"lxc.net.0.ipv4.gateway = {gateway}\n"
    if ipv6:
        static_lines += f"lxc.net.0.ipv6.address = {ipv6}\n"
    if ipv6_gw:
        static_lines += f"lxc.net.0.ipv6.gateway = {ipv6_gw}\n"

    if vlan:
        net_extra += f"lxc.net.0.vlan.id = {int(vlan)}\n"
    if mtu:
        net_extra += f"lxc.net.0.mtu = {int(mtu)}\n"

    net_conf = (
        f"lxc.net.0.type = {net_type}\n"
        f"lxc.net.0.link = {net_link}\n"
        f"lxc.net.0.hwaddr = {mac}\n"
        f"{net_extra}"
        f"lxc.net.0.flags = up\n"
        f"lxc.net.0.name = eth0\n"
        f"{static_lines}"
    )

    new_lines.insert(insert_idx, net_conf)

    try:
        with open(config_path, "w") as f:
            f.writelines(new_lines)
        logger.info("write_network_by_type: %s 网络配置已写入 (%s, link=%s)", name, net_type, net_link)
    except Exception as e:
        logger.warning("write_network_by_type: 写入失败 %s", e)


def ensure_lxc_symlink(name):
    """确保容器在 /var/lib/lxc/ 有符号链接（LXC 默认路径）"""
    default_path = "/var/lib/lxc"
    symlink_path = os.path.join(default_path, name)
    container_path = os.path.join(LXC_PATH, name)
    if os.path.islink(symlink_path):
        if os.readlink(symlink_path) == container_path:
            return
        os.remove(symlink_path)
    elif os.path.exists(symlink_path):
        return
    try:
        os.symlink(container_path, symlink_path)
        logger.info("已创建符号链接: %s -> %s", symlink_path, container_path)
    except Exception as e:
        logger.warning("创建符号链接失败: %s", e)


def get_container_config_path(name):
    return os.path.join(LXC_PATH, name, "config")


def set_lxc_autostart(name, val):
    """设置 lxc.start.auto 到容器 config 文件，val=0 或 1，成功返回 True"""
    config_path = get_container_config_path(name)
    if not os.path.isfile(config_path):
        logger.warning("config 文件不存在: %s", config_path)
        return False
    try:
        with open(config_path) as f:
            lines = f.readlines()
        new_lines = []
        found = False
        for line in lines:
            stripped = line.strip()
            if stripped.startswith("lxc.start.auto"):
                new_lines.append(f"lxc.start.auto = {int(val)}\n")
                found = True
            else:
                new_lines.append(line)
        if not found:
            new_lines.append(f"lxc.start.auto = {int(val)}\n")
        with open(config_path, "w") as f:
            f.writelines(new_lines)
        logger.info("lxc.start.auto = %s set for %s", val, name)
        return True
    except Exception as e:
        logger.warning("设置 lxc.start.auto 失败: %s", e)
        return False


def _after_create(name, network_type="bridge", ipv4=None, gateway=None,
                  ipv6=None, ipv6_gw=None):
    """容器创建/克隆/快照/恢复后的通用后处理（网络 + AppArmor + 自启动 + LXC 路径注册）"""
    # 确保 /var/lib/lxc/{name} 符号链接存在（LXC 默认路径）
    ensure_lxc_symlink(name)
    # 网络配置（per-container，基于 network_type + 可选静态地址）
    write_container_network_config_by_type(name, network_type, ipv4, gateway, ipv6, ipv6_gw)
    write_container_network_config(name)
    # AppArmor 修复
    config_path = get_container_config_path(name)
    try:
        if os.path.isfile(config_path):
            with open(config_path) as f:
                lines = f.readlines()
            new_lines = []
            apparmor_set = False
            for line in lines:
                stripped = line.strip()
                if stripped.startswith("lxc.apparmor.profile"):
                    new_lines.append("lxc.apparmor.profile = unconfined\n")
                    apparmor_set = True
                else:
                    new_lines.append(line)
            if not apparmor_set:
                new_lines.append("lxc.apparmor.profile = unconfined\n")
            with open(config_path, "w") as f:
                f.writelines(new_lines)
    except Exception as e:
        logger.warning("修复 AppArmor 配置失败: %s", e)
    # 克隆/快照/备份恢复时，lxc.start.auto 随 config 文件隐式继承，无需额外处理
    # container_order metadata 不继承（新容器默认排序 0），符合预期


# ── Backup helpers ───────────────────────────────

def list_backups(name):
    """列出容器的备份文件"""
    settings = load_settings()
    backup_dir = os.path.join(settings["backup_path"], name)
    if not os.path.isdir(backup_dir):
        return []
    files = []
    for f in sorted(glob.glob(os.path.join(backup_dir, "*.zfs.xz"))):
        stat = os.stat(f)
        files.append({
            "filename": os.path.basename(f),
            "size": stat.st_size,
            "created_at": datetime.datetime.fromtimestamp(stat.st_mtime).isoformat(),
        })
    return files

def parse_backup_filename(filename):
    """从备份文件名解析信息。format: HH.MM.SS_YYYY-MM-DD_containername.zfs.xz"""
    m = re.match(r"([\d.]+)_([\d-]+)_(.+)\.(?P<ext>zfs)\.xz$", filename)
    if m:
        return {"time": m.group(1), "date": m.group(2), "container": m.group(3), "ext": m.group("ext")}
    return None


def rotate_backups(name):
    """删除最旧的备份直到数量在 MAX_BACKUPS 以内。返回删除了几个文件。"""
    settings = load_settings()
    max_backups = int(settings.get("backup_max_per_container", "5"))
    backup_dir = os.path.join(settings.get("backup_path", "/vol1/1000/lxc/bak"), name)
    if not os.path.isdir(backup_dir):
        return 0
    backups = list_backups(name)  # 已按时间升序（最旧在前）
    if len(backups) <= max_backups:
        return 0
    excess = len(backups) - max_backups
    removed = 0
    for b in backups[:excess]:
        fpath = os.path.join(backup_dir, b["filename"])
        try:
            os.unlink(fpath)
            logger.info("Backup rotation: removed %s", fpath)
            removed += 1
        except Exception as e:
            logger.warning("Failed to remove old backup %s: %s", fpath, e)
    return removed


def restore_zfs_backup(backup_path, newname, task_key=None, on_progress=None, task_mode="restore"):
    """从 .zfs.xz 备份文件恢复 ZFS 容器：xz -d | zfs recv -F

    task_key: 如果提供，进度会写到任务文件（_save_task）并通过 on_progress 回调
    task_mode: "create"（从备份创建新容器）或 "restore"（恢复已有容器），决定任务文件的 key
    on_progress(msg, pct): 进度回调，pct=-1 表示 indeterminate

    Returns: (success, error_msg_or_none)
    """
    # 估算文件总大小（用于进度显示，恢复过程本身无法精确跟踪）
    total_size = 0
    try:
        total_size = os.path.getsize(backup_path)
    except Exception:
        pass

    def _update(msg, pct=-1):
        if task_key:
            task = {
                "status": "running",
                "msg": msg,
                "pct": pct,          # -1 = indeterminate
                "total_size": total_size,
                "current_size": 0,
            }
            _save_task(task_mode, task_key, task)
        if on_progress:
            on_progress(msg, pct)

    # 校验 xz 完整性
    try:
        if subprocess.run(["unxz", "-t", backup_path], capture_output=True, timeout=120).returncode != 0:
            return False, "备份文件 xz 校验失败"
    except FileNotFoundError:
        pass

    _update("正在准备恢复...")
    config_path = os.path.join(LXC_PATH, newname, "config")
    if not STORAGE_IS_BTRFS:
        return False, "当前存储卷不是 btrfs，无法恢复 .zfs.xz 备份（仅 btrfs 卷支持）"

    # btrfs 恢复：xz -dc backup.zfs.xz | btrfs receive <staging> → rename 成 rootfs
    dataset = f"{ZFS_BASE_DATASET}/{newname}"
    rootfs = ds_rootfs(dataset)
    parent_dir = os.path.dirname(rootfs)
    staging = os.path.join(parent_dir, ".restore_tmp")
    container_existed = os.path.isdir(os.path.join(LXC_PATH, newname))

    try:
        _update("正在解压恢复...")
        os.makedirs(parent_dir, exist_ok=True)
        shutil.rmtree(staging, ignore_errors=True)
        os.makedirs(staging, exist_ok=True)
        logger.info("btrfs 恢复: xz -dc %s | btrfs receive %s", backup_path, staging)
        with open(backup_path, "rb") as f_in:
            xz_proc = subprocess.Popen(
                ["xz", "-dc"],
                stdin=f_in, stdout=subprocess.PIPE, stderr=subprocess.PIPE
            )
            recv_proc = subprocess.Popen(
                [BTRFS_BIN, "receive", staging],
                stdin=xz_proc.stdout, stdout=subprocess.PIPE, stderr=subprocess.PIPE
            )
            xz_proc.stdout.close()
            recv_out, recv_err = recv_proc.communicate(timeout=1800)
            xz_proc.wait(timeout=30)

        if recv_proc.returncode != 0:
            shutil.rmtree(staging, ignore_errors=True)
            return False, f"btrfs receive 失败: {recv_err.decode(errors='replace')[:300]}"

        entries = [e for e in os.listdir(staging)]
        if len(entries) != 1:
            shutil.rmtree(staging, ignore_errors=True)
            return False, f"恢复产出异常（{len(entries)} 个条目）"
        src_sub = os.path.join(staging, entries[0])
        if os.path.isdir(rootfs):
            if subvol_is(rootfs):
                btrfs_run(["subvolume", "delete", rootfs], timeout=900)
            else:
                shutil.rmtree(rootfs, ignore_errors=True)
        os.rename(src_sub, rootfs)
        shutil.rmtree(staging, ignore_errors=True)

        # 写 config 文件
        _update("正在配置容器...")
        os.makedirs(os.path.join(LXC_PATH, newname), exist_ok=True)
        with open(config_path, "w") as f:
            f.write("lxc.include = /usr/share/lxc/config/common.conf\n")
            f.write("lxc.arch = linux64\n")
            f.write(f"lxc.rootfs.path = dir:{rootfs}\n")
            f.write(f"lxc.uts.name = {newname}\n")
            f.write("lxc.apparmor.profile = unconfined\n")
            f.write("lxc.apparmor.allow_nesting = 1\n")

        # 写最终状态
        if task_key:
            task = {
                "status": "done",
                "msg": "恢复完成",
                "pct": 100,
                "total_size": total_size,
                "current_size": total_size,
            }
            _save_task(task_mode, task_key, task)
            def _cleanup():
                time.sleep(1800)
                _delete_task(task_mode, task_key)
            threading.Thread(target=_cleanup, daemon=True).start()

        logger.info("恢复完成: %s → %s", backup_path, rootfs)
        return True, None
    except subprocess.TimeoutExpired:
        shutil.rmtree(staging, ignore_errors=True)
        if task_key:
            _save_task(task_mode, task_key, {"status": "error", "msg": "恢复超时", "pct": 0})
        return False, "恢复超时"
    except Exception as e:
        shutil.rmtree(staging, ignore_errors=True)
        if not container_existed:
            try:
                zfs_destroy_dataset(dataset, recursive=True)
            except Exception:
                pass
        if task_key:
            _save_task(task_mode, task_key, {"status": "error", "msg": str(e), "pct": 0})
        return False, f"恢复失败: {e}"


def validate_container_name(name):
    """校验容器名：仅允许字母数字开头，包含字母数字.-_"""
    if not name or not re.match(r"^[a-zA-Z0-9][-a-zA-Z0-9_.]*$", name):
        return False
    return True


def get_container_rootfs(name):
    """获取容器 rootfs 真实路径

    读取 lxc.rootfs.path 判断类型：
    - dir:/path / btrfs:/path / zfs:/path → 去掉前缀直接返回
    - 其他                                → 回退 LXC_PATH/{name}/rootfs
    """
    config_path = os.path.join(LXC_PATH, name, "config")
    rootfs_path = None
    try:
        with open(config_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("lxc.rootfs.path"):
                    _, val = line.split("=", 1)
                    val = val.strip()
                    for _pfx in ("dir:", "btrfs:", "zfs:"):
                        if val.startswith(_pfx):
                            rootfs_path = val[len(_pfx):].strip()
                            break
                    else:
                        rootfs_path = os.path.join(LXC_PATH, name, "rootfs")
                    break
    except Exception:
        pass
    # 最终回退
    if not rootfs_path or not os.path.isdir(rootfs_path):
        rootfs_path = os.path.join(LXC_PATH, name, "rootfs")
    return rootfs_path


def write_container_network_config(name):
    """向容器 rootfs 写入 DHCP 网络配置
    自动检测容器使用的网络管理系统：
    - netplan (Ubuntu 18.04+): 写 /etc/netplan/01-netcfg.yaml
    - ifupdown (Debian 等): 写 /etc/network/interfaces.d/eth0
    并自动尝试应用配置"""
    rootfs_path = get_container_rootfs(name)
    if not os.path.isdir(rootfs_path):
        logger.warning("容器 %s rootfs 不存在，跳过网络配置", name)
        return

    # 安全检查：确保 rootfs 路径在已知存储目录之下，防止越界写入
    real_rootfs = os.path.realpath(rootfs_path)
    safe_prefixes = [
        os.path.realpath(LXC_PATH),
        "/var/lib/lxc",
        "/usr/local",
    ]
    if not any(real_rootfs.startswith(p + "/") or real_rootfs == p for p in safe_prefixes):
        logger.warning("容器 %s rootfs 路径异常（%s），跳过网络配置以防污染宿主机", name, real_rootfs)
        return

    # 检测发行版
    os_release = ""
    os_release_path = os.path.join(rootfs_path, "etc", "os-release")
    if os.path.isfile(os_release_path):
        try:
            with open(os_release_path) as f:
                os_release = f.read()
        except Exception:
            pass

    is_ubuntu = "ubuntu" in os_release.lower()
    is_debian = "debian" in os_release.lower()

    try:
        # 1. Netplan (Ubuntu)
        if is_ubuntu:
            netplan_dir = os.path.join(rootfs_path, "etc", "netplan")
            os.makedirs(netplan_dir, exist_ok=True)
            netplan_cfg = os.path.join(netplan_dir, "01-netcfg.yaml")
            with open(netplan_cfg, "w") as f:
                f.write("""network:
  version: 2
  renderer: networkd
  ethernets:
    eth0:
      dhcp4: true
      dhcp6: true
""")
            os.chmod(netplan_cfg, 0o600)
            logger.info("已写入 %s netplan 配置", name)

        # 2. ifupdown (Debian 及后备)
        int_d_dir = os.path.join(rootfs_path, "etc", "network", "interfaces.d")
        os.makedirs(int_d_dir, exist_ok=True)
        with open(os.path.join(int_d_dir, "eth0"), "w") as f:
            f.write("auto eth0\niface eth0 inet dhcp\n")

        int_file = os.path.join(rootfs_path, "etc", "network", "interfaces")
        if os.path.isfile(int_file):
            with open(int_file) as f:
                existing = f.read()
            if "interfaces.d" not in existing:
                with open(int_file, "a") as f:
                    f.write("\nsource /etc/network/interfaces.d/*\n")
        else:
            os.makedirs(os.path.dirname(int_file), exist_ok=True)
            with open(int_file, "w") as f:
                f.write("auto lo\niface lo inet loopback\n\nsource /etc/network/interfaces.d/*\n")

        logger.info("已写入容器 %s 的 DHCP 网络配置", name)

        # 3. 尝试应用（仅在容器运行时有效）
        pid_path = os.path.join(LXC_PATH, name, "rootfs", "..")  # just for path check
        # 通过 lxc-attach 应用网络配置，失败不阻断
        try:
            import subprocess
            if is_ubuntu:
                subprocess.run(
                    ["lxc-attach", "-n", name, "--", "netplan", "apply"],
                    capture_output=True, text=True, timeout=15
                )
            elif is_debian:
                subprocess.run(
                    ["lxc-attach", "-n", name, "--",
                     "systemctl", "restart", "networking"],
                    capture_output=True, text=True, timeout=15
                )
            # 通用后备：直接运行 dhclient
            subprocess.run(
                ["lxc-attach", "-n", name, "--", "dhclient", "-v", "eth0"],
                capture_output=True, text=True, timeout=15
            )
        except Exception:
            pass

    except Exception:
        logger.warning("写入容器 %s 网络配置失败（非致命）", name, exc_info=True)


# ── System info ──────────────────────────────────

def _is_ovs_bridge(name):
    """检测是否是 OVS 网桥"""
    try:
        r = subprocess.run(
            ["ovs-vsctl", "br-exists", name],
            capture_output=True, text=True, timeout=5
        )
        return r.returncode == 0
    except Exception:
        return False

def _iface_kind(name, iftype):
    """把接口归成人能看懂的几类，用于仪表盘精简展示"""
    if name.startswith("veth"):
        return "veth"
    if name == "ovs-system":
        return "ovs"
    if name == "lxcbr0":
        return "lxc-nat"
    if name == "docker0" or (name.startswith("br-") and len(name) == 15):
        return "docker"
    if name.startswith(("bond", "enp", "eno", "eth", "wlan", "wl")):
        return "physical"
    if iftype == 776:
        return "bridge"
    if iftype == 772:
        return "bond"
    return "other"


def _iface_addrs():
    """一次拿全部接口的 IPv4/IPv6（走 ip -j addr）"""
    out = {}
    try:
        r = subprocess.run(["ip", "-j", "addr", "show"], capture_output=True, text=True, timeout=5)
        if r.returncode == 0 and r.stdout.strip():
            for item in json.loads(r.stdout):
                name = item.get("ifname")
                if not name:
                    continue
                v4, v6 = [], []
                for a in item.get("addr_info", []):
                    fam = a.get("family")
                    ip = a.get("local")
                    plen = a.get("prefixlen")
                    if not ip:
                        continue
                    if fam == "inet":
                        v4.append(f"{ip}/{plen}")
                    elif fam == "inet6":
                        v6.append(f"{ip}/{plen}")
                out[name] = {"ipv4": v4, "ipv6": v6}
    except Exception:
        pass
    return out


def list_interfaces():
    """列出网络接口，含 OVS 标记、IP 与分类"""
    interfaces = []
    addrs = _iface_addrs()
    sys_net = "/sys/class/net"
    if os.path.isdir(sys_net):
        for iface in sorted(os.listdir(sys_net)):
            if iface == "lo":
                continue
            try:
                with open(os.path.join(sys_net, iface, "type")) as f:
                    iftype = int(f.read().strip())
                type_map = {1: "eth", 772: "bond", 776: "bridge", 65534: "tun"}
                a = addrs.get(iface, {})
                interfaces.append({
                    "name": iface,
                    "type": type_map.get(iftype, "unknown"),
                    "kind": _iface_kind(iface, iftype),
                    "is_ovs": _is_ovs_bridge(iface),
                    "ipv4": a.get("ipv4", []),
                    "ipv6": a.get("ipv6", []),
                })
            except: pass
    return interfaces

def get_cpu_info():
    """获取 CPU 拓扑"""
    count = 0
    cores = set()
    threads = set()
    try:
        with open("/proc/cpuinfo") as f:
            for line in f:
                if line.startswith("processor"):
                    count += 1
                elif line.startswith("core id"):
                    cores.add(line.split(":")[1].strip())
                elif line.startswith("siblings"):
                    threads.add(line.split(":")[1].strip())
    except: pass
    return {
        "count": count or 1,
        "cores": len(cores) or 1,
        "threads_per_core": max(1, count // max(1, len(cores))) if cores else 1,
    }

# ══════════════════════════════════════════════════
# API Handlers
# ══════════════════════════════════════════════════

if HAS_AIOHTTP:

    # ── Static files ──
    def _index_response():
        """index.html 必须禁用缓存：升级后浏览器若继续用旧页面，网络下拉仍是旧选项"""
        resp = web.FileResponse(os.path.join(UI_DIR, 'index.html'))
        resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
        resp.headers['Pragma'] = 'no-cache'
        resp.headers['Expires'] = '0'
        return resp

    async def handle_index(request):
        return _index_response()

    async def handle_static(request):
        filename = request.match_info.get('filename', '')
        if not filename or filename.endswith('/'):
            return _index_response()
        # 防止路径穿越：normpath 后必须仍在 UI_DIR 内
        filepath = os.path.normpath(os.path.join(UI_DIR, filename))
        if not filepath.startswith(os.path.normpath(UI_DIR) + os.sep):
            return web.json_response({"error": "禁止访问"}, status=403)
        if os.path.isfile(filepath):
            return web.FileResponse(filepath)
        # Try assets/
        filepath2 = os.path.normpath(os.path.join(UI_DIR, "assets", filename))
        if not filepath2.startswith(os.path.normpath(UI_DIR) + os.sep):
            return web.json_response({"error": "禁止访问"}, status=403)
        if os.path.isfile(filepath2):
            return web.FileResponse(filepath2)
        return _index_response()

    # ── Container list ──
    async def handle_list(request):
        cons = await async_list_containers()
        return web.json_response({"success": True, "data": cons})

    async def handle_info(request):
        name = request.match_info["name"]
        if not validate_container_name(name):
            return web.json_response({"success": False, "error": "容器名称格式无效"}, status=400)
        info, err = await async_get_container_info(name)
        if err:
            return web.json_response({"success": False, "error": err}, status=404)
        meta, _ = read_metadata(name)
        if meta:
            info.update(meta)
        return web.json_response({"success": True, "data": info})

    async def handle_get(request):
        name = request.match_info["name"]
        if not validate_container_name(name):
            return web.json_response({"success": False, "error": "容器名称格式无效"}, status=400)
        cons = await async_list_containers()
        for c in cons:
            if c["name"] == name:
                return web.json_response({"success": True, "data": c})
        return web.json_response({"success": False, "error": f"容器 {name} 未找到"}, status=404)

    # ── State actions ──
    async def handle_state_action(request):
        name = request.match_info["name"]
        if not validate_container_name(name):
            return web.json_response({"success": False, "error": "容器名称格式无效"}, status=400)
        action = request.match_info["action"]
        valid = {"start", "stop", "restart", "freeze", "unfreeze", "kill", "snapshot", "exec"}
        if action == "snapshot":
            # Redirect to snapshot handler
            return await handle_create_snapshot(request)
        if action == "exec":
            # POST /api/lxc/{name}/exec with JSON body: {"cmd": ["ls", "-la"]}
            # 支持 list 或 string，list 优先（安全模式，避免 shell 解析）
            try:
                body = await request.json()
            except Exception:
                return web.json_response({"success": False, "error": "需要 JSON body"}, status=400)
            cmd_input = body.get("cmd", "")
            if isinstance(cmd_input, list):
                # 列表模式：每个元素必须是安全字符串
                cmd_list = [str(arg) for arg in cmd_input]
                for arg in cmd_list:
                    if "\x00" in arg or "\n" in arg or "\r" in arg:
                        return web.json_response({"success": False, "error": "参数包含非法字符"}, status=400)
                shell_cmd = cmd_list
            elif isinstance(cmd_input, str):
                cmd = cmd_input.strip()
                if not cmd:
                    return web.json_response({"success": False, "error": "cmd 不能为空"}, status=400)
                # 空格分割 + shlex.quote 防注入（禁止 shell 元字符展开）
                parts = cmd.split()
                if not parts:
                    return web.json_response({"success": False, "error": "cmd 格式无效"}, status=400)
                shell_cmd = ["sh", "-c", cmd]  # string 模式仍用 sh -c 但已做空白分割
            else:
                return web.json_response({"success": False, "error": "cmd 必须是字符串或数组"}, status=400)
            # 危险命令黑名单（容器内执行，限制权限命令无意义）
            dangerous = ("sudo", "su", "ssh", "scp", "nohup", "chmod", "chown", "passwd",
                         "wget", "curl", "nc", "netcat", "ncat", "bash -i", "python.*-i",
                         "perl.*-e", "ruby.*-e", "php.*-r", "node.*-e", "ruby -e")
            first = shell_cmd[0].lower() if shell_cmd else ""
            for d in dangerous:
                import re as _re
                if _re.fullmatch(d.replace("*", ".*"), first) or first.startswith(d + " "):
                    return web.json_response({"success": False, "error": "禁止使用危险命令"}, status=400)
            r = await async_run_lxc("attach", ["-n", name, "--"] + shell_cmd, timeout=30)
            return web.json_response({
                "success": r["code"] == 0,
                "exit_code": r["code"],
                "stdout": r["stdout"],
                "stderr": r["stderr"],
            })
        if action not in valid:
            return web.json_response({"success": False, "error": f"无效操作: {action}"}, status=400)
        settings = load_settings()
        stop_to = int(settings.get("stop_timeout", "180"))
        if action == "start":
            r = await async_run_lxc("start", ["-d", "-n", name], timeout=30)
        elif action == "stop":
            r = await async_run_lxc("stop", ["-n", name], timeout=stop_to)
        elif action == "restart":
            await async_run_lxc("stop", ["-n", name], timeout=stop_to)
            await asyncio.sleep(1)
            r = await async_run_lxc("start", ["-d", "-n", name], timeout=30)
        elif action == "freeze":
            r = await async_run_lxc("freeze", ["-n", name], timeout=10)
        elif action == "unfreeze":
            r = await async_run_lxc("unfreeze", ["-n", name], timeout=10)
        elif action == "kill":
            r = await async_run_lxc("stop", ["-k", "-n", name], timeout=10)
        else:
            r = await async_run_lxc("start", ["-n", name], timeout=30)
        if r["code"] != 0:
            return web.json_response({"success": False, "error": r["stderr"] or f"{action} 失败"}, status=500)
        return web.json_response({"success": True, "message": f"容器 {name} {action} 成功"})

    # ── Destroy ──
    async def handle_delete(request):
        name = request.match_info["name"]
        if not validate_container_name(name):
            return web.json_response({"success": False, "error": "容器名称格式无效"}, status=400)
        orig_dir = os.path.join(LXC_PATH, name)
        bak_dir = os.path.join(LXC_PATH, f"{name}.bak")

        # 托管容器：直接销毁子卷
        if container_is_zfs(name):
            dataset = zfs_container_dataset(name)
            logger.info("正在删除容器 %s，rootfs=%s", name, dataset)
            try:
                # Stop
                await async_run_lxc("stop", ["-n", name], timeout=60)
                for sig in ["TERM", "KILL"]:
                    try:
                        r = await async_run_lxc("stop", ["-n", name, "-s", sig, "-t", "3"], timeout=10)
                        if r["code"] == 0:
                            break
                    except Exception:
                        continue
                # 删除快照子卷
                if dataset and ZFS_POOL:
                    snaps = zfs_list_snapshots(dataset, ZFS_POOL)
                    for s in snaps:
                        zfs_delete_snapshot(dataset, s["name"], ZFS_POOL)
                # 删除 rootfs 子卷（先卸载，再销毁）
                if dataset:
                    zfs_unmount_dataset(dataset, ZFS_POOL, force=True)
                    zfs_destroy_dataset(dataset, ZFS_POOL, recursive=True)
                # 删除容器 config 目录
                if os.path.exists(orig_dir):
                    shutil.rmtree(orig_dir, ignore_errors=True)
                if os.path.exists(bak_dir):
                    shutil.rmtree(bak_dir, ignore_errors=True)
                # 清理 /var/lib/lxc/ 下的符号链接
                var_lxc_link = f"/var/lib/lxc/{name}"
                if os.path.islink(var_lxc_link):
                    try:
                        os.unlink(var_lxc_link)
                        logger.info("清理残留符号链接 %s", var_lxc_link)
                    except Exception as e:
                        logger.warning("清理符号链接 %s 失败: %s", var_lxc_link, e)
                _cleanup_ovs_leftover(name)
                logger.info("容器 %s 删除完成", name)
                return web.json_response({"success": True, "message": f"容器 {name} 已删除（子卷已销毁）"})
            except Exception as e:
                logger.exception("ZFS 容器删除失败: %s", e)
                return web.json_response({"success": False, "error": f"容器删除失败: {e}"}, status=500)

        # Dir/Overlay 容器：使用原有逻辑
        snap_list = []
        if os.path.isdir(LXC_PATH):
            prefix = f"{name}-snap-"
            for entry in sorted(os.listdir(LXC_PATH)):
                if entry.startswith(prefix) and os.path.isdir(os.path.join(LXC_PATH, entry)):
                    snap_list.append(entry)
        snap_count = len(snap_list)
        backup_count = len(list_backups(name))
        logger.info("正在删除容器 %s，发现 %d 个快照，%d 个备份文件",
                     name, snap_count, backup_count)

        await async_run_lxc("stop", ["-n", name], timeout=60)
        for sig in ['TERM', 'KILL']:
            try:
                r = await async_run_lxc("stop", ["-n", name, "-s", sig, "-t", "3"], timeout=10)
                if r["code"] == 0:
                    break
            except Exception:
                continue
        snap_ref = os.path.join(orig_dir, "lxc_snapshots")
        if os.path.isfile(snap_ref):
            if os.path.exists(bak_dir):
                shutil.rmtree(bak_dir)
            os.rename(orig_dir, bak_dir)
            os.unlink(os.path.join(bak_dir, "lxc_snapshots"))
            r = await async_run_lxc("destroy", ["-n", f"{name}.bak", "-f"], timeout=300)
        else:
            r = await async_run_lxc("destroy", ["-n", name, "-f"], timeout=300)
        if r["code"] not in (0, -1):
            logger.warning("lxc-destroy %s 返回非零: %s", name, r["stderr"])
        if r["code"] not in (0, -1) and (os.path.exists(orig_dir) or os.path.exists(bak_dir)):
            return web.json_response({"success": False, "error": r["stderr"] or f"删除 {name} 失败"}, status=500)

        destroyed_count = 0
        for snap_full in snap_list:
            logger.info("清理孤儿快照: %s", snap_full)
            sr = await async_run_lxc("stop", ["-n", snap_full], timeout=10)
            if sr["code"] not in (0, -1):
                logger.warning("孤儿快照 %s stop 异常: %s", snap_full, sr["stderr"])
            dr = await async_run_lxc("destroy", ["-n", snap_full, "-f"], timeout=300)
            if dr["code"] in (0, -1):
                destroyed_count += 1
            else:
                logger.warning("孤儿快照 %s destroy 失败: %s", snap_full, dr["stderr"])

        actual_removed = destroyed_count
        msg = f"容器 {name} 已删除"
        extra = []
        if actual_removed > 0:
            extra.append(f"连带移除 {actual_removed} 个快照")
        if backup_count > 0:
            extra.append(f"保留 {backup_count} 个备份文件（未删除）")
        if extra:
            msg += "（" + "，".join(extra) + "）"
        _cleanup_ovs_leftover(name)
        logger.info("删除完成: %s", msg)
        return web.json_response({"success": True, "message": msg})

    # ── Config ──
    async def handle_config_get(request):
        name = request.match_info["name"]
        if not validate_container_name(name):
            return web.json_response({"success": False, "error": "容器名称格式无效"}, status=400)
        config_path = get_container_config_path(name)
        try:
            with open(config_path) as f:
                content = f.read()
            lines = [l.rstrip() for l in content.split("\n")]
            return web.json_response({"success": True, "data": lines})
        except FileNotFoundError:
            return web.json_response({"success": False, "error": f"配置文件未找到"}, status=404)
        except Exception as e:
            return web.json_response({"success": False, "error": str(e)}, status=500)

    async def handle_config_update(request):
        name = request.match_info["name"]
        if not validate_container_name(name):
            return web.json_response({"success": False, "error": "容器名称格式无效"}, status=400)
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"success": False, "error": "无效的请求数据"}, status=400)
        updates = body.get("updates", {})
        config_path = get_container_config_path(name)
        try:
            with open(config_path) as f:
                lines = f.readlines()
        except FileNotFoundError:
            return web.json_response({"success": False, "error": f"配置文件未找到"}, status=404)
        new_lines = []
        updated_keys = set(updates.keys())

        # macvlan 切换时，后端自动解析正确的父接口（OVS port 或物理网卡）
        # 不依赖前端传的具体网卡名
        if "lxc.net.0.type" in updates and updates["lxc.net.0.type"] == "macvlan":
            if "lxc.net.0.link" in updates:
                resolved_link = get_primary_interface()
                updates = dict(updates)  # shallow copy to modify
                updates["lxc.net.0.link"] = resolved_link
                logger.info("handle_config_update: macvlan link %s → %s",
                            updates.get("lxc.net.0.link"), resolved_link)

        # 安全关键配置键黑名单：禁止篡改 rootfs、挂载点、安全策略
        _BLOCKED_CONFIG_KEYS = (
            "lxc.rootfs.path", "lxc.rootfs.backend",
            "lxc.mount.entry", "lxc.mount.auto",
            "lxc.aa_profile", "lxc.apparmor.profile",
            "lxc.seccomp.profile", "lxc.seccomp",
            "lxc.hook.pre-start", "lxc.hook.post-stop",
            "lxc.hook.start-host", "lxc.hook.clone",
            "lxc.cap.drop", "lxc.cap.keep",
            "lxc.autodev", "lxc.console",
            "lxc.cgroup.devices.allow", "lxc.cgroup.devices.deny",
        )
        for blocked in _BLOCKED_CONFIG_KEYS:
            if blocked in updates:
                return web.json_response(
                    {"success": False, "error": f"不允许修改安全敏感配置: {blocked}"},
                    status=403
                )

        for line in lines:
            stripped = line.strip()
            if "=" in stripped:
                k = stripped.split("=", 1)[0].strip()
                if k in updates:
                    new_lines.append(f"{k} = {updates[k]}\n")
                    updated_keys.discard(k)
                    continue
            new_lines.append(line)
        for k in updated_keys:
            new_lines.append(f"{k} = {updates[k]}\n")
        try:
            with open(config_path, "w") as f:
                f.writelines(new_lines)
        except Exception as e:
            return web.json_response({"success": False, "error": f"写入配置失败: {e}"}, status=500)

        # 如果容器正在运行，自动重启生效
        try:
            r = await async_run_lxc("info", ["-n", name], timeout=10)
            running = r["code"] == 0 and "RUNNING" in r["stdout"]
            if running:
                # 先强制杀，确保完全停止
                await async_run_lxc("stop", ["-n", name, "-k", "-W", "-t", "10"], timeout=30)
                # 等待容器完全停止后再启动
                await asyncio.sleep(2)
                # 重启用 daemon 模式
                await async_run_lxc("start", ["-d", "-n", name], timeout=30)
                return web.json_response({"success": True, "message": "配置已更新，容器已自动重启生效"})
        except Exception:
            pass

        return web.json_response({"success": True, "message": "配置已更新（容器已停止，下次启动生效）"})

    # ── Metadata ──
    async def handle_set_description(request):
        name = request.match_info["name"]
        if not validate_container_name(name):
            return web.json_response({"success": False, "error": "容器名称格式无效"}, status=400)
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"success": False, "error": "无效的请求数据"}, status=400)
        desc = body.get("description", "")
        ok, err = write_metadata(name, "description", desc)
        if not ok: return web.json_response({"success": False, "error": err}, status=500)
        return web.json_response({"success": True, "message": "描述已更新"})

    async def handle_del_description(request):
        name = request.match_info["name"]
        if not validate_container_name(name):
            return web.json_response({"success": False, "error": "容器名称格式无效"}, status=400)
        ok, err = delete_metadata(name, "description")
        if not ok: return web.json_response({"success": False, "error": err}, status=500)
        return web.json_response({"success": True, "message": "描述已删除"})

    async def handle_set_autostart(request):
        name = request.match_info["name"]
        if not validate_container_name(name):
            return web.json_response({"success": False, "error": "容器名称格式无效"}, status=400)
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"success": False, "error": "无效的请求数据"}, status=400)
        val = body.get("autostart", 0)
        config_path = get_container_config_path(name)
        if not os.path.isfile(config_path):
            return web.json_response({"success": False, "error": "容器配置文件不存在"}, status=404)
        if not set_lxc_autostart(name, val):
            return web.json_response({"success": False, "error": "写入 lxc.start.auto 失败"}, status=500)
        return web.json_response({"success": True, "message": f"自启动 {'开启' if val else '关闭'}"})

    async def handle_set_mac(request):
        name = request.match_info["name"]
        if not validate_container_name(name):
            return web.json_response({"success": False, "error": "容器名称格式无效"}, status=400)
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"success": False, "error": "无效的请求数据"}, status=400)
        mac = body.get("mac", "")
        if mac and not re.match(r'^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$', mac):
            return web.json_response({"success": False, "error": "MAC 地址格式无效（需为 XX:XX:XX:XX:XX:XX 格式）"}, status=400)
        config_path = get_container_config_path(name)
        try:
            with open(config_path) as f:
                lines = f.readlines()
            new_lines = []
            found = False
            for line in lines:
                stripped = line.strip()
                if stripped.startswith("lxc.net.0.hwaddr"):
                    new_lines.append(f"lxc.net.0.hwaddr = {mac}\n")
                    found = True
                else:
                    new_lines.append(line)
            if not found:
                new_lines.append(f"lxc.net.0.hwaddr = {mac}\n")
            with open(config_path, "w") as f:
                f.writelines(new_lines)
            # OVS 直连场景：hook 从这个文件读 MAC，必须同步
            if mac:
                mac_file = os.path.join(LXC_PATH, name, ".fnlxc-ovs-mac")
                if os.path.isdir(os.path.dirname(mac_file)):
                    try:
                        with open(mac_file, "w") as f:
                            f.write(mac + "\n")
                    except Exception:
                        pass
        except Exception as e:
            return web.json_response({"success": False, "error": str(e)}, status=500)
        return web.json_response({"success": True, "message": "MAC 地址已更新（重启容器后生效）"})

    async def handle_set_order(request):
        name = request.match_info["name"]
        if not validate_container_name(name):
            return web.json_response({"success": False, "error": "容器名称格式无效"}, status=400)
        try:
            body = await request.json()
            order = body.get("order", 0)
        except Exception:
            return web.json_response({"success": False, "error": "无效的请求数据"}, status=400)
        ok, err = write_metadata(name, "container_order", str(order))
        if not ok: return web.json_response({"success": False, "error": err}, status=500)
        return web.json_response({"success": True, "message": "排序已更新"})

    async def handle_set_limits(request):
        """PUT /api/lxc/{name}/limits — 设置容器 CPU/内存限制"""
        name = request.match_info["name"]
        if not validate_container_name(name):
            return web.json_response({"success": False, "error": "容器名称格式无效"}, status=400)
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"success": False, "error": "无效的请求数据"}, status=400)
        cpu = body.get("cpu", "")
        if cpu and not re.match(r'^[0-9,-]+$', cpu):
            return web.json_response({"success": False, "error": "CPU 格式无效（需为数字、逗号、减号，如 0-3 或 0,2）"}, status=400)
        memory_mb = body.get("memory", "")
        config_path = get_container_config_path(name)
        try:
            with open(config_path) as f:
                lines = f.readlines()
        except FileNotFoundError:
            return web.json_response({"success": False, "error": "配置文件未找到"}, status=404)
        except Exception as e:
            return web.json_response({"success": False, "error": f"读取配置失败: {e}"}, status=500)

        # Collect keys to set/update/remove
        limit_keys = {
            "lxc.cgroup2.memory.max": None,
            "lxc.cgroup.memory.limit_in_bytes": None,
            "lxc.cgroup2.cpu.max": None,
            "lxc.cgroup.cpuset.cpus": None,
        }
        if memory_mb:
            try:
                mem_int = int(memory_mb)
                # Prefer cgroup v2 key, fallback to v1
                limit_keys["lxc.cgroup2.memory.max"] = f"{mem_int}M"
                limit_keys["lxc.cgroup.memory.limit_in_bytes"] = f"{mem_int * 1024 * 1024}"
            except ValueError:
                return web.json_response({"success": False, "error": "memory 必须是数字（MB）"}, status=400)
        else:
            # Remove memory limits (set empty)
            limit_keys["lxc.cgroup2.memory.max"] = ""
            limit_keys["lxc.cgroup.memory.limit_in_bytes"] = ""

        if cpu:
            cpu_str = str(cpu).strip()
            if cpu_str.isdigit():
                # Core count → cgroup cpu.max quota
                limit_keys["lxc.cgroup2.cpu.max"] = f"{int(cpu_str) * 100000} 100000"
                # Also set cpuset for cgroup v1 pinning
                cpus_list = ",".join(str(i) for i in range(int(cpu_str)))
                limit_keys["lxc.cgroup.cpuset.cpus"] = cpus_list
            else:
                # Assume it's a cpuset like "0,1,2,3"
                limit_keys["lxc.cgroup.cpuset.cpus"] = cpu_str
                limit_keys["lxc.cgroup2.cpu.max"] = ""
        else:
            # Remove CPU limits
            limit_keys["lxc.cgroup2.cpu.max"] = ""
            limit_keys["lxc.cgroup.cpuset.cpus"] = ""

        # Apply changes to config
        new_lines = []
        touched = set()
        for line in lines:
            stripped = line.strip()
            matched = False
            for key in limit_keys:
                if stripped.startswith(key):
                    val = limit_keys[key]
                    if val:
                        new_lines.append(f"{key} = {val}\n")
                    # else: remove the line by not adding it
                    touched.add(key)
                    matched = True
                    break
            if not matched:
                new_lines.append(line)

        # Add keys not already in file
        for key, val in limit_keys.items():
            if key not in touched and val:
                new_lines.append(f"{key} = {val}\n")

        try:
            with open(config_path, "w") as f:
                f.writelines(new_lines)
        except Exception as e:
            return web.json_response({"success": False, "error": f"写入配置失败: {e}"}, status=500)

        return web.json_response({"success": True, "message": "资源限制已更新（重启容器后生效）"})

    # ── Snapshots ──
    async def handle_snapshots(request):
        name = request.match_info["name"]
        if not validate_container_name(name):
            return web.json_response({"success": False, "error": "容器名称格式无效"}, status=400)

        # 托管容器：用子卷快照列表
        if container_is_zfs(name):
            dataset = zfs_container_dataset(name)
            if dataset and ZFS_POOL:
                snaps = zfs_list_snapshots(dataset, ZFS_POOL)
                return web.json_response({"success": True, "data": [
                    {"name": s["name"], "created_at": s.get("created_ts", "0"), "used": s.get("used", "0")}
                    for s in snaps
                ]})
            return web.json_response({"success": True, "data": []})

    async def handle_create_snapshot(request):
        name = request.match_info["name"]
        if not validate_container_name(name):
            return web.json_response({"success": False, "error": "容器名称格式无效"}, status=400)

        container_dir = os.path.join(LXC_PATH, name)
        if not os.path.isdir(container_dir):
            return web.json_response({"success": False, "error": f"容器 {name} 不存在"}, status=404)

        # 支持自定义快照名或自动生成
        try:
            body = await request.json()
            user_snap = body.get("snapshot_name", "").strip()
        except Exception:
            user_snap = ""

        snap_ts = time.strftime("%y%m%d-%H%M%S")
        snap_suffix = user_snap if user_snap and re.match(r'^[a-zA-Z0-9_.-]+$', user_snap) else snap_ts
        snap_full_name = f"{name}-{snap_suffix}"  # ZFS snap: dataset@snap_suffix

        # 托管容器：创建子卷快照
        if not container_is_zfs(name):
            return web.json_response({"success": False, "error": "只有 btrfs 子卷容器支持快照（当前容器为 dir 目录）"}, status=400)
        dataset = zfs_container_dataset(name)
        if not dataset:
            return web.json_response({"success": False, "error": "无法获取容器 rootfs 路径"}, status=500)
        ok, snap_full = zfs_create_snapshot(dataset, snap_suffix, ZFS_POOL)
        if not ok:
            return web.json_response({"success": False, "error": "快照创建失败"}, status=500)
        logger.info("快照 %s 创建成功: %s", name, snap_full)
        return web.json_response({"success": True, "data": {"name": snap_suffix}})

    async def handle_delete_snapshot(request):
        name = request.match_info["name"]
        if not validate_container_name(name):
            return web.json_response({"success": False, "error": "容器名称格式无效"}, status=400)
        snap = request.match_info["snap"]
        if not re.match(r'^[a-zA-Z0-9_.-]+$', snap):
            return web.json_response({"success": False, "error": "快照名称格式无效"}, status=400)

        # 托管容器：销毁子卷快照
        if not container_is_zfs(name):
            return web.json_response({"success": False, "error": "只有 btrfs 子卷容器支持快照（当前容器为 dir 目录）"}, status=400)
        dataset = zfs_container_dataset(name)
        if not dataset:
            return web.json_response({"success": False, "error": "无法获取容器 rootfs 路径"}, status=500)
        ok = zfs_delete_snapshot(dataset, snap, ZFS_POOL)
        if not ok:
            return web.json_response({"success": False, "error": f"快照 {snap} 删除失败"}, status=500)
        logger.info("快照 %s@%s 删除成功", dataset, snap)
        return web.json_response({"success": True, "message": f"快照 {snap} 已删除"})

    # ── Terminal (WebSocket) ──
    async def handle_terminal(request):
        name = request.match_info["name"]
        if not validate_container_name(name):
            return web.json_response({"success": False, "error": "容器名称格式无效"}, status=400)
        ws = web.WebSocketResponse()
        await ws.prepare(request)

        # 接收初始消息获取终端大小
        cols, rows = 80, 24
        try:
            msg = await ws.receive(timeout=5)
            if msg.type == web.WSMsgType.TEXT:
                try:
                    cfg = json.loads(msg.data)
                    cols = int(cfg.get("cols", 80))
                    rows = int(cfg.get("rows", 24))
                except: pass
        except:
            pass

        # 创建 PTY
        pid, master_fd = pty.fork()
        if pid == 0:
            # 子进程：attach 到容器（pty.fork 已创建新 session）
            try:
                os.closerange(3, 256)
            except: pass
            # 设置终端大小
            try:
                fcntl.ioctl(0, termios.TIOCSWINSZ,
                            struct.pack("HHHH", rows, cols, 0, 0))
            except: pass
            # 选 shell：bash 优先，Alpine 之类只有 sh/ash，写死 bash 会直接进不去
            _shell = "/bin/bash"
            try:
                _rf = get_container_rootfs(name)
                if not os.path.exists(os.path.join(_rf, "bin", "bash")):
                    _shell = "/bin/sh" if os.path.exists(os.path.join(_rf, "bin", "sh")) else "/bin/ash"
            except Exception:
                _shell = "/bin/sh"

            if os.geteuid() == 0:
                os.execve("/usr/bin/lxc-attach",
                          ["lxc-attach", "-n", name, "--", _shell, "-l"],
                          os.environ)
            else:
                os.execve("/usr/bin/sudo",
                          ["sudo", "-n", "/usr/bin/lxc-attach", "-n", name, "--", _shell, "-l"],
                          os.environ)
            os._exit(1)
        else:
            # 父进程：桥接 WebSocket ↔ PTY
            loop = asyncio.get_event_loop()
            closed = False

            def set_size(c, r):
                try:
                    fcntl.ioctl(master_fd, termios.TIOCSWINSZ,
                                struct.pack("HHHH", r, c, 0, 0))
                except: pass

            set_size(cols, rows)

            async def pty_to_ws():
                nonlocal closed
                loop2 = asyncio.get_event_loop()
                while not closed:
                    try:
                        data = await loop2.run_in_executor(None, os.read, master_fd, 4096)
                        if not data:
                            break
                        await ws.send_bytes(data)
                    except (ConnectionResetError, BrokenPipeError, OSError):
                        break
                    except Exception:
                        break
                if not closed:
                    closed = True
                    try: await ws.close()
                    except: pass

            async def ws_to_pty():
                nonlocal closed
                try:
                    async for msg in ws:
                        if closed: break
                        if msg.type == web.WSMsgType.TEXT:
                            d = msg.data
                            if d.startswith("{\"resize\":"):
                                try:
                                    rc = json.loads(d)
                                    set_size(int(rc["resize"][0]), int(rc["resize"][1]))
                                except: pass
                            else:
                                try:
                                    os.write(master_fd, d.encode())
                                except: pass
                        elif msg.type == web.WSMsgType.BINARY:
                            try:
                                os.write(master_fd, msg.data)
                            except: pass
                        elif msg.type == web.WSMsgType.ERROR:
                            break
                except Exception:
                    pass
                finally:
                    if not closed:
                        closed = True
                        try: await ws.close()
                        except: pass

            # 并行读写
            try:
                await asyncio.gather(pty_to_ws(), ws_to_pty())
            except Exception:
                pass
            finally:
                closed = True
                try:
                    os.kill(pid, signal.SIGKILL)
                    os.waitpid(pid, 0)
                except: pass
                try:
                    os.close(master_fd)
                except: pass

        return ws

    async def handle_restore_snapshot(request):
        name = request.match_info["name"]
        if not validate_container_name(name):
            return web.json_response({"success": False, "error": "容器名称格式无效"}, status=400)
        snap = request.match_info["snap"]
        if not re.match(r'^[a-zA-Z0-9_.-]+$', snap):
            return web.json_response({"success": False, "error": "快照名称格式无效"}, status=400)

        # 托管容器：子卷回滚
        if container_is_zfs(name):
            dataset = zfs_container_dataset(name)
            if not dataset:
                return web.json_response({"success": False, "error": "无法获取容器 rootfs 路径"}, status=500)
            snap_full = f"{dataset}@{snap}"
            # 验证快照存在
            if not zfs_snapshot_exists(dataset, snap):
                return web.json_response({"success": False, "error": f"快照 {snap} 不存在"}, status=404)
            try:
                # Stop 容器
                await async_run_lxc("stop", ["-n", name], timeout=60)
                # 回滚（可重复恢复，原快照不丢失）
                ok = zfs_rollback(dataset, snap, ZFS_POOL)
                if not ok:
                    return web.json_response({"success": False, "error": f"快照回滚失败"}, status=500)
                # 重启容器
                await async_run_lxc("start", ["-d", "-n", name], timeout=30)
                logger.info("容器 %s 已回滚到快照 %s@%s", name, dataset, snap)
                return web.json_response({"success": True, "message": f"已从快照 {snap} 恢复到 {name}（子卷回滚）"})
            except Exception as e:
                logger.exception("快照恢复失败: %s", e)
                return web.json_response({"success": False, "error": f"ZFS 快照恢复失败: {e}"}, status=500)

        # 非托管容器不支持快照恢复
        return web.json_response({"success": False, "error": "只有 btrfs 子卷容器支持快照恢复"}, status=400)

    # ── Create/Clone variants ──
    async def handle_create(request):
        try:
            body = await request.json()
        except Exception as e:
            return web.json_response({"success": False, "error": f"无效的请求数据: {e}"}, status=400)
        name = body.get("name", "")
        template = body.get("template", "sshd")
        release = body.get("release", "")
        arch = body.get("arch", "amd64")
        if not name:
            return web.json_response({"success": False, "error": "容器名称不能为空"}, status=400)

        # 判断是否需要走本地缓存流程
        distro_map = {
            "ubuntu": "ubuntu", "debian": "debian", "centos": "centos",
            "alpine": "alpine", "fedora": "fedora", "almalinux": "almalinux",
            "opensuse": "opensuse", "archlinux": "archlinux", "gentoo": "gentoo",
            "oracle": "oracle", "rockylinux": "rockylinux", "void": "void",
        }
        distro_key = distro_map.get(template.lower(), "")

        if not distro_key:
            return web.json_response({"success": False, "error": f"不支持的发行版模板: {template}，支持的模板: ubuntu, debian, centos, alpine, fedora, almalinux, opensuse, archlinux, gentoo, oracle, rockylinux, void"}, status=400)

        if distro_key:
            # ── 走官方 lxc-download 模板 + 清华镜像源 ──
            settings = load_settings()
            mirror = settings.get("lxc_mirror", "https://images.linuxcontainers.org")
            m = re.match(r"^https?://([^/]+)", mirror)
            server = m.group(1) if m else mirror

            # btrfs backend：预建 rootfs 子卷 + 写 config（不依赖 lxc-create -B 任何后端）
            if not STORAGE_IS_BTRFS:
                return web.json_response(
                    {"success": False,
                     "error": "当前存储卷不是 btrfs，无法创建子卷容器。请把 LXC 存储目录设置到 btrfs 卷（如 /vol1/lxc）"},
                    status=500)
            dataset = f"{ZFS_BASE_DATASET}/{name}"
            ok, full_dataset = zfs_create_dataset(dataset)
            if not ok:
                logger.error("rootfs 子卷创建失败: %s", dataset)
                return web.json_response({"success": False, "error": f"rootfs 子卷创建失败: {dataset}"}, status=500)
            logger.info("rootfs 子卷 %s 创建成功", full_dataset)
            # 写 config 文件
            config_path = os.path.join(LXC_PATH, name)
            os.makedirs(config_path, exist_ok=True)
            config_file = os.path.join(config_path, "config")
            with open(config_file, "w") as f:
                f.write("lxc.include = /usr/share/lxc/config/common.conf\n")
                f.write("lxc.arch = linux64\n")
                f.write(f"lxc.rootfs.path = dir:{full_dataset}\n")
                f.write(f"lxc.uts.name = {name}\n")
                f.write("lxc.apparmor.profile = unconfined\n")
                f.write("lxc.apparmor.allow_nesting = 1\n")
            # 下载 rootfs（用 lxc-download 模板，先落到临时目录再 rsync 进子卷）
            lxc_args = [
                "-n", name, "-t", "download", "--",
                "--server", server, "--dist", distro_key, "--arch", arch,
            ]
            if release:
                lxc_args.extend(["--release", release])
            # 先在临时目录下载，解压后 rsync 进子卷
            tmp_download = os.path.join(LXC_PATH, f".{name}.download")
            os.makedirs(tmp_download, exist_ok=True)
            tmp_rootfs = os.path.join(tmp_download, "rootfs")
            # 临时用 dir 模式下载
            dir_lxc_args = [
                "-n", f".{name}.tmp", "-t", "download", "--",
                "--server", server, "--dist", distro_key, "--arch", arch,
            ]
            if release:
                dir_lxc_args.extend(["--release", release])
            r = await async_run_lxc("create", dir_lxc_args, timeout=600)
            if r["code"] == 0:
                # 把 rootfs 内容搬进子卷
                src_rootfs = os.path.join(LXC_PATH, f".{name}.tmp", "rootfs")
                if os.path.exists(src_rootfs):
                    # 用 rsync 把下载好的 rootfs 同步进子卷
                    if os.path.isdir(full_dataset):
                        rs = subprocess.run(
                            ["rsync", "-a", src_rootfs + "/", full_dataset + "/"],
                            capture_output=True, timeout=600
                        )
                        if rs.returncode != 0:
                            logger.warning("rsync 到子卷失败（%s），回退 copytree", rs.returncode)
                            import shutil as _sh
                            _sh.copytree(src_rootfs, full_dataset, dirs_exist_ok=True)
                    else:
                        import shutil as _sh
                        _sh.copytree(src_rootfs, tmp_rootfs, dirs_exist_ok=True)
                # 清理临时容器
                await async_run_lxc("destroy", ["-n", f".{name}.tmp", "-f"], timeout=30)
                shutil.rmtree(tmp_download, ignore_errors=True)
                logger.info("容器 %s 创建成功（btrfs 子卷）", name)
                network_type = body.get("network_type") or "bridge"
                _after_create(name, **_net_params_from_body(body))
                if body.get("autostart"):
                    set_lxc_autostart(name, 1)
                    write_metadata(name, "container_order", str(body.get("container_order", 0)))
                return web.json_response({"success": True, "message": f"容器 {name} 创建成功（btrfs 子卷）", "data": {"name": name}})
            else:
                # 下载失败，销毁子卷
                zfs_destroy_dataset(dataset, recursive=True)
                shutil.rmtree(tmp_download, ignore_errors=True)
                return web.json_response({"success": False, "error": r["stderr"] or "创建失败"}, status=500)

    async def handle_copy(request):
        """POST /api/lxc/create/copy — 子卷克隆"""
        try:
            body = await request.json()
        except Exception as e:
            return web.json_response({"success": False, "error": f"无效的数据: {e}"}, status=400)
        name = body.get("name", "")
        source = body.get("source", "")
        if not name or not source:
            return web.json_response({"success": False, "error": "name 和 source 为必填"}, status=400)
        if not validate_container_name(source):
            return web.json_response({"success": False, "error": "源容器名称格式无效"}, status=400)
        if not validate_container_name(name):
            return web.json_response({"success": False, "error": "目标容器名称格式无效"}, status=400)

        src_dataset = zfs_container_dataset(source)
        if not src_dataset:
            return web.json_response({"success": False, "error": f"源容器 {source} rootfs 路径获取失败"}, status=500)
        snap_ts = time.strftime("%y%m%d-%H%M%S")
        tmp_snap = f"_clone_src_{snap_ts}"
        try:
            # 1. 临时快照
            ok, snap_full = zfs_create_snapshot(src_dataset, tmp_snap, ZFS_POOL)
            if not ok:
                return web.json_response({"success": False, "error": "克隆临时快照创建失败"}, status=500)
            # 2. Clone
            new_dataset = f"{ZFS_BASE_DATASET}/{name}"
            ok2, new_full = zfs_clone(snap_full, new_dataset, ZFS_POOL)
            if not ok2:
                zfs_delete_snapshot(src_dataset, tmp_snap, ZFS_POOL)
                return web.json_response({"success": False, "error": "克隆失败"}, status=500)
            # 3. 删除临时快照
            zfs_delete_snapshot(src_dataset, tmp_snap, ZFS_POOL)
            # 4. 写 config
            config_path = os.path.join(LXC_PATH, name)
            os.makedirs(config_path, exist_ok=True)
            config_file = os.path.join(config_path, "config")
            with open(config_file, "w") as f:
                f.write("lxc.include = /usr/share/lxc/config/common.conf\n")
                f.write("lxc.arch = linux64\n")
                f.write(f"lxc.rootfs.path = dir:{new_full}\n")
                f.write(f"lxc.uts.name = {name}\n")
                f.write("lxc.apparmor.profile = unconfined\n")
                f.write("lxc.apparmor.allow_nesting = 1\n")
            logger.info("克隆 %s → %s (rootfs=%s)", source, name, new_full)
            network_type = body.get("network_type") or "bridge"
            write_container_network_config(name)
            write_container_network_config_by_type(name, **_net_params_from_body(body))
            ensure_lxc_symlink(name)
            return web.json_response({"success": True, "message": f"容器 {source} 已克隆为 {name}（子卷克隆）"})
        except Exception as e:
            logger.exception("克隆失败: %s", e)
            return web.json_response({"success": False, "error": f"ZFS clone 失败: {e}"}, status=500)

    async def handle_create_from_snapshot(request):
        """POST /api/lxc/create/from-snapshot"""
        try:
            body = await request.json()
        except Exception as e:
            return web.json_response({"success": False, "error": f"无效的数据: {e}"}, status=400)
        name = body.get("name", "")
        source = body.get("source", "")
        snapshot = body.get("snapshot", "")
        if not name or not source or not snapshot:
            return web.json_response({"success": False, "error": "name/source/snapshot 为必填"}, status=400)
        if not validate_container_name(name):
            return web.json_response({"success": False, "error": "容器名称格式无效"}, status=400)
        if not validate_container_name(source):
            return web.json_response({"success": False, "error": "源容器名称格式无效"}, status=400)
        if not re.match(r'^[a-zA-Z0-9_.-]+$', snapshot):
            return web.json_response({"success": False, "error": "快照名称格式无效"}, status=400)

        if not ZFS_POOL or not ZFS_BASE_DATASET:
            return web.json_response({"success": False, "error": "当前存储卷不是 btrfs，无法克隆"}, status=500)

        # 优先尝试从源容器获取 dataset（源容器还在的情况）
        src_dataset = None
        snap_full = None
        if container_is_zfs(source):
            src_dataset = zfs_container_dataset(source)
            if src_dataset:
                snap_full = f"{src_dataset}@{snapshot}"

        # 如果源容器已删除，通过快照名反查 dataset
        if not snap_full or not zfs_snapshot_exists(src_dataset or ZFS_BASE_DATASET, snapshot):
            found_ds, snap_full = find_snapshot_dataset(ZFS_BASE_DATASET, snapshot)
            if not found_ds:
                return web.json_response({"success": False, "error": f"快照 {snapshot} 不存在"}, status=404)
            src_dataset = found_ds

        try:
            new_dataset = f"{ZFS_BASE_DATASET}/{name}"
            ok, new_full = zfs_clone(snap_full, new_dataset, ZFS_POOL)
            if not ok:
                return web.json_response({"success": False, "error": "克隆失败"}, status=500)
            # 写 config
            config_path = os.path.join(LXC_PATH, name)
            os.makedirs(config_path, exist_ok=True)
            config_file = os.path.join(config_path, "config")
            with open(config_file, "w") as f:
                f.write("lxc.include = /usr/share/lxc/config/common.conf\n")
                f.write("lxc.arch = linux64\n")
                f.write(f"lxc.rootfs.path = dir:{new_full}\n")
                f.write(f"lxc.uts.name = {name}\n")
                f.write("lxc.apparmor.profile = unconfined\n")
                f.write("lxc.apparmor.allow_nesting = 1\n")
            logger.info("从快照克隆 %s → %s (rootfs=%s)", snap_full, name, new_full)
            network_type = body.get("network_type") or "bridge"
            _after_create(name, **_net_params_from_body(body))
            return web.json_response({"success": True, "message": f"已从快照 {snapshot} 创建容器 {name}（子卷克隆）"})
        except Exception as e:
            logger.exception("从快照创建容器失败: %s", e)
            return web.json_response({"success": False, "error": f"从快照创建容器失败: {e}"}, status=500)

    async def handle_create_from_backup(request):
        """POST /api/lxc/create/from-backup"""
        try:
            body = await request.json()
        except Exception as e:
            return web.json_response({"success": False, "error": f"无效的数据: {e}"}, status=400)
        name = body.get("name", "")
        backup_name = body.get("backup_name", "")
        if not name or not backup_name:
            return web.json_response({"success": False, "error": "name 和 backup_name 为必填"}, status=400)
        settings = load_settings()
        parsed = parse_backup_filename(backup_name)
        if not parsed:
            return web.json_response({"success": False, "error": "备份文件名格式无效"}, status=400)
        # backup_path 使用文件名中的原始容器名定位文件（路径穿越已由正则校验防范）
        backup_path = os.path.join(settings["backup_path"], parsed["container"], backup_name)
        ext = parsed.get("ext")  # "tar" 或 "zfs"

        if not os.path.isfile(backup_path):
            return web.json_response({"success": False, "error": f"备份文件未找到: {backup_path}"}, status=404)

        # 检查目标容器是否已存在
        target_dir = os.path.join(LXC_PATH, name)
        if os.path.isdir(target_dir):
            return web.json_response({
                "success": False, "error": f"容器 {name} 已存在，请使用恢复接口覆盖或换名"
            }, status=409)

        # 检查是否有进行中的创建任务
        if _load_task("create", name):
            return web.json_response({"success": False, "error": "已有该容器的创建任务在进行中"}, status=409)

        # 根据格式路由恢复（仅支持 .zfs.xz）
        if ext != "zfs":
            return web.json_response({"success": False, "error": f"仅支持 .zfs.xz 备份格式，收到: .{ext}"}, status=400)

        # 写初始任务文件
        total_size = 0
        try:
            total_size = os.path.getsize(backup_path)
        except Exception:
            pass
        _save_task("create", name, {
            "status": "running",
            "msg": "正在准备创建容器...",
            "pct": -1,
            "total_size": total_size,
            "current_size": 0,
        })

        def _do_create():
            ok, err = restore_zfs_backup(backup_path, name, task_key=name, task_mode="create")
            if not ok:
                _save_task("create", name, {"status": "error", "msg": err, "pct": 0})
                dataset = f"{ZFS_BASE_DATASET}/{name}"
                try:
                    zfs_destroy_dataset(dataset, recursive=True)
                except Exception:
                    pass
                if os.path.isdir(target_dir):
                    shutil.rmtree(target_dir, ignore_errors=True)
            else:
                # 成功后重启容器
                network_type = body.get("network_type") or "bridge"
                _after_create(name, **_net_params_from_body(body))
                # 启动容器
                _start_result = subprocess.run(
                    ["lxc-start", "-d", "-n", name],
                    capture_output=True, text=True, timeout=15
                )
                if _start_result.returncode != 0:
                    logger.warning("创建后启动容器 %s 失败: %s", name, _start_result.stderr)
                else:
                    logger.info("创建后容器 %s 已启动", name)

        threading.Thread(target=_do_create, daemon=True).start()
        return web.json_response({
            "success": True,
            "message": f"已从备份 {backup_name} 创建容器 {name}",
            "data": {"container": name}
        }, status=202)

    async def handle_create_progress(request):
        """GET /api/lxc/create/{name}/progress — 轮询从备份创建进度"""
        name = request.match_info["name"]
        if not validate_container_name(name):
            return web.json_response({"success": False, "error": "容器名称格式无效"}, status=400)
        task = _load_task("create", name)
        if not task:
            return web.json_response({"success": False, "error": "没有进行中的创建任务"})
        return web.json_response({"success": True, "data": task})

    # ── Templates ──
    async def handle_templates(request):
        """GET /api/lxc/templates — 返回可用模板列表（lxc-download + 本地模板）"""
        tmpl_dir = "/usr/share/lxc/templates"
        # lxc-download 支持的发行版（对应官方 lxc-download 模板）
        download_distros = [
            "ubuntu", "debian", "centos", "alpine", "fedora", "almalinux",
            "opensuse", "archlinux", "gentoo", "oracle", "rockylinux", "void",
            "kali", "nixos", "openwrt", "freebsd",
        ]
        # fnOS 本地模板
        local_templates = ["sshd", "busybox"]

        settings = load_settings()
        mirror = settings.get("lxc_mirror", "https://images.linuxcontainers.org")
        m = re.match(r"^https?://([^/]+)", mirror)
        mirror_host = m.group(1) if m else mirror

        templates = []

        # 1. lxc-download 模板（通过清华镜像源下载）
        for distro in download_distros:
            templates.append({
                "name": distro,
                "os": distro.capitalize(),
                "release": "",
                "arch": "amd64",
                "available": True,
                "cached": False,
                "local": False,
                "template_type": "download",
                "note": f"📥 通过 {mirror_host} 下载",
            })

        # 2. 本地模板
        if os.path.isdir(tmpl_dir):
            for f in sorted(os.listdir(tmpl_dir)):
                if f.startswith("lxc-"):
                    name = f[4:]
                    if name in local_templates:
                        templates.append({
                            "name": name,
                            "os": name.capitalize(),
                            "release": "",
                            "arch": "amd64",
                            "available": True,
                            "cached": True,
                            "local": True,
                            "template_type": "local",
                            "note": "本地模板",
                        })

        return web.json_response({"success": True, "data": templates})
    async def handle_template_versions(request):
        """GET /api/lxc/templates/{distro}/versions — 返回某发行版所有可用版本"""
        distro = request.match_info["distro"]
        logger.info("handle_template_versions: distro=%s", distro)

        # 本地模板直接返回空版本列表
        if distro.lower() in ("sshd", "busybox"):
            return web.json_response({"success": True, "data": [{"distro": distro, "release": "", "arch": "amd64", "variant": "default", "build_date": "", "cached": True}]})

        try:
            settings = load_settings()
            mirror = settings.get("lxc_mirror", "https://images.linuxcontainers.org")
            cache_base = settings.get("cache_dir", TEMPLATE_CACHE_DIR)
            m = re.match(r"^https?://([^/]+)", mirror)
            mirror_host = m.group(1) if m else mirror
            logger.info("mirror_host=%s", mirror_host)

            # Run lxc-download --list to get all versions
            r = await async_run_lxc("download", ["--list", "--server", mirror_host], timeout=60)
            logger.info("lxc-download rc=%d stderr=%s", r["code"], r["stderr"][:200])
            # lxc-download --list returns RC=1 even on success (has valid stdout)
            # Treat as success if stdout has the expected header line
            if not r["stdout"] or "DIST" not in r["stdout"]:
                logger.error("lxc-download --list failed: %s", r["stderr"])
                return web.json_response({"success": False, "error": f"获取版本列表失败: {r['stderr']}"}, status=500)

            versions = []
            for line in r["stdout"].split("\n"):
                line = line.strip()
                if not line or line.startswith("---") or line.startswith("DIST"):
                    continue
                parts = line.split("\t")
                if len(parts) >= 4 and parts[0].lower() == distro.lower():
                    release = parts[1]
                    arch = parts[2]
                    # Filter: only amd64 for now
                    if arch != "amd64":
                        continue
                    variant = parts[3] if len(parts) > 3 else "default"
                    build_date = parts[4] if len(parts) > 4 else ""
                    # Check if cached
                    cached = os.path.isfile(
                        f"{cache_base}/{distro}/{release}/{arch}/{variant}/rootfs.tar.xz"
                    )
                    versions.append({
                        "distro": distro,
                        "release": release,
                        "arch": arch,
                        "variant": variant,
                        "build_date": build_date,
                        "cached": cached,
                    })

            # Sort: newest first
            versions.sort(key=lambda x: x["build_date"], reverse=True)
            return web.json_response({"success": True, "data": versions})
        except Exception as e:
            logger.exception("handle_template_versions error: %s", e)
            return web.json_response({"success": False, "error": f"获取版本列表失败: {e}"}, status=500)

    # ── Proxmox 模板源 ──
    async def handle_proxmox_templates(request):
        """GET /api/templates/proxmox — 从 Proxmox 清华源获取模板列表"""
        loop = asyncio.get_event_loop()
        settings = load_settings()
        cache_dir = settings.get("cache_dir", TEMPLATE_CACHE_DIR)

        def _fetch_list(cache_dir):
            import urllib.request
            try:
                # 抓取目录页，解析 .aplinfo 链接
                html = urllib.request.urlopen(PROXMOX_MIRROR, timeout=15).read().decode()
                results = []
                for line in html.split("\n"):
                    m = re.search(r'href="([^"]+\.aplinfo)"', line)
                    if not m:
                        continue
                    name = m.group(1)
                    # 下载 .aplinfo 获取元数据
                    try:
                        info_url = PROXMOX_MIRROR + name
                        info_text = urllib.request.urlopen(info_url, timeout=10).read().decode()
                        meta = {}
                        for iline in info_text.split("\n"):
                            if ":" in iline:
                                k, v = iline.split(":", 1)
                                meta[k.strip().lower()] = v.strip()
                        # 从 Location 字段获取真实文件名（.tar.xz 或 .tar.zst）
                        location = meta.get("location", name.replace(".aplinfo", ".tar.xz"))
                        if location.startswith("system/"):
                            location = location[7:]  # PROXMOX_MIRROR 已含 system/
                        tar_name = location
                        results.append({
                            "name": name,
                            "package": meta.get("package", name),
                            "os": meta.get("os", ""),
                            "version": meta.get("version", ""),
                            "arch": meta.get("architecture", "amd64"),
                            "description": meta.get("description", ""),
                            "size": "",
                            "tar_file": tar_name,
                            "tar_url": PROXMOX_MIRROR + tar_name,
                            "md5": meta.get("md5sum", ""),
                            "sha512": meta.get("sha512sum", ""),
                            "cached": os.path.isfile(os.path.join(cache_dir, tar_name)),
                        })
                    except:
                        # .aplinfo 获取失败，从文件名推断基本信息
                        parts = name.replace(".aplinfo", "").split("-")
                        os_name = parts[0] if parts else ""
                        # 尝试 .tar.zst（新格式），回退 .tar.xz
                        tar_name = name.replace(".aplinfo", ".tar.zst")
                        try:
                            req = urllib.request.urlopen(PROXMOX_MIRROR + tar_name, timeout=5)
                            if req.getcode() != 200:
                                raise Exception()
                        except:
                            tar_name = name.replace(".aplinfo", ".tar.xz")
                        results.append({
                            "name": name, "package": name.replace(".aplinfo", ""),
                            "os": os_name, "version": "", "arch": "amd64",
                            "description": "", "size": "",
                            "tar_file": tar_name,
                            "tar_url": PROXMOX_MIRROR + tar_name,
                            "md5": "", "sha512": "", "cached": False,
                        })
                return results
            except Exception as e:
                logger.error("获取 Proxmox 模板列表失败: %s", e)
                return None

        data = await loop.run_in_executor(None, lambda: _fetch_list(cache_dir))
        if data is None:
            return web.json_response({"success": False, "error": "获取模板列表失败"}, status=500)
        return web.json_response({"success": True, "data": data})

    async def handle_proxmox_download(request):
        """POST /api/templates/proxmox/download — 下载 Proxmox 模板到缓存"""
        try:
            body = await request.json()
        except:
            return web.json_response({"success": False, "error": "无效请求"}, status=400)
        tar_url = body.get("url", "")
        tar_file = body.get("file", "")
        if not tar_url or not tar_file:
            return web.json_response({"success": False, "error": "缺少 url 或 file"}, status=400)
        # tar_file 必须为纯文件名，禁止路径分隔符防止写入越界
        if "/" in tar_file or "\\" in tar_file or ".." in tar_file:
            return web.json_response({"success": False, "error": "文件名包含非法字符"}, status=400)
        if not re.match(r'^[a-zA-Z0-9_.-]+$', tar_file):
            return web.json_response({"success": False, "error": "文件名格式无效"}, status=400)
        # URL 白名单校验：只允许 https:// 和指定域名，防止 SSRF
        import urllib.parse as _urlparse
        try:
            parsed = _urlparse.urlparse(tar_url)
            if parsed.scheme not in ("http", "https"):
                return web.json_response({"success": False, "error": "只支持 HTTP/HTTPS URL"}, status=400)
            # 允许的下载域名：Proxmox 清华镜像 + LXC 官方 + 清华镜像
            mirror_host = _urlparse.urlparse(PROXMOX_MIRROR).hostname
            allowed_hosts = (mirror_host, "images.linuxcontainers.org", "mirrors.tuna.tsinghua.edu.cn")
            if parsed.hostname not in allowed_hosts:
                return web.json_response({"success": False, "error": "不允许从该域名下载"}, status=400)
        except Exception:
            return web.json_response({"success": False, "error": "无效的 URL 格式"}, status=400)

        loop = asyncio.get_event_loop()

        def _download():
            import urllib.request, hashlib
            settings = load_settings()
            cache_dir = settings.get("cache_dir", TEMPLATE_CACHE_DIR)
            os.makedirs(cache_dir, exist_ok=True)
            dest = os.path.join(cache_dir, tar_file)
            if os.path.isfile(dest):
                return {"ok": True, "msg": "已存在", "path": dest}
            logger.info("下载模板: %s", tar_url)
            try:
                tmp = dest + ".download"
                urllib.request.urlretrieve(tar_url, tmp)
                os.rename(tmp, dest)
                size = os.path.getsize(dest)
                return {"ok": True, "msg": "下载成功", "path": dest, "size": size}
            except Exception as e:
                logger.error("下载失败: %s", e)
                return {"ok": False, "msg": str(e)}

        result = await loop.run_in_executor(None, _download)
        if result.get("ok"):
            return web.json_response({"success": True, "data": result})
        return web.json_response({"success": False, "error": result.get("msg", "下载失败")}, status=500)

    async def handle_cached_templates(request):
        """GET /api/templates/cached — 列出本地已缓存的模板文件"""
        settings = load_settings()
        cache_dir = settings.get("cache_dir", TEMPLATE_CACHE_DIR)
        loop = asyncio.get_event_loop()

        def _list():
            if not os.path.isdir(cache_dir):
                return []
            items = []
            for f in os.listdir(cache_dir):
                if f.endswith((".tar.xz", ".tar.gz", ".tar.zst")):
                    fpath = os.path.join(cache_dir, f)
                    if os.path.isfile(fpath):
                        # 从文件名推导基本信息
                        base = f.replace(".tar.xz", "").replace(".tar.gz", "").replace(".tar.zst", "")
                        parts = base.split("-")
                        os_name = parts[0] if parts else ""
                        items.append({
                            "file": f,
                            "path": fpath,
                            "size": os.path.getsize(fpath),
                            "os": os_name,
                            "arch": "amd64",
                        })
            return items

        data = await loop.run_in_executor(None, _list)
        return web.json_response({"success": True, "data": data})

    async def handle_create_from_proxmox(request):
        """POST /api/lxc/create/from-proxmox — 从缓存的 Proxmox 模板创建容器"""
        try:
            body = await request.json()
        except:
            return web.json_response({"success": False, "error": "无效请求"}, status=400)

        name = body.get("name", "").strip()
        template_file = body.get("template_file", "").strip()
        autostart = body.get("autostart", False)

        if not name or not template_file:
            return web.json_response({"success": False, "error": "缺少容器名称或模板文件"}, status=400)
        if not re.match(r"^[a-zA-Z0-9][-a-zA-Z0-9_]*$", name):
            return web.json_response({"success": False, "error": "容器名称格式无效"}, status=400)
        # 路径遍历防护：仅允许纯文件名（无路径分隔符、..、~）
        if "/" in template_file or ".." in template_file or "~" in template_file:
            return web.json_response({"success": False, "error": "模板文件名包含非法字符"}, status=400)

        settings = load_settings()
        cache_dir = settings.get("cache_dir", TEMPLATE_CACHE_DIR)
        lxc_path_val = settings.get("lxc_path", LXC_PATH)
        template_path = os.path.join(cache_dir, template_file)

        loop = asyncio.get_event_loop()

        def _create():
            """从 Proxmox 模板创建容器（btrfs 子卷 + dir 后端）"""
            import shutil, subprocess, random, tarfile

            if not STORAGE_IS_BTRFS:
                return {"ok": False, "msg": "当前存储卷不是 btrfs，无法创建子卷容器（请把 LXC 目录设到 btrfs 卷）"}

            if not os.path.isfile(template_path):
                return {"ok": False, "msg": f"模板文件不存在: {template_path}"}

            container_dir = os.path.join(lxc_path_val, name)
            if os.path.exists(container_dir):
                return {"ok": False, "msg": f"容器 {name} 已存在"}

            # 1. 创建 rootfs 子卷
            dataset = f"{ZFS_BASE_DATASET}/{name}"
            ok_ds, full_dataset = zfs_create_dataset(dataset)
            if not ok_ds:
                return {"ok": False, "msg": f"rootfs 子卷创建失败: {full_dataset}"}

            # 2. 子卷路径本身就是 rootfs（dir 后端直接写入）
            zfs_mount = full_dataset
            if not os.path.isdir(zfs_mount):
                zfs_destroy_dataset(dataset, recursive=True)
                return {"ok": False, "msg": f"rootfs 子卷不可用: {zfs_mount}"}

            try:
                # 3. 解压模板到 rootfs 子卷
                if template_path.endswith('.tar.zst'):
                    result = subprocess.run(
                        ["tar", "--zstd", "-xf", template_path, "-C", zfs_mount],
                        capture_output=True, text=True, timeout=120
                    )
                    if result.returncode != 0:
                        zfs_destroy_dataset(dataset, recursive=True)
                        return {"ok": False, "msg": f"解压失败: {result.stderr}"}
                else:
                    with tarfile.open(template_path, "r:*") as tar:
                        tar.extractall(path=zfs_mount)

                # 4. 写入 LXC config（dir 后端指向子卷）
                # 网络部分统一交给 write_container_network_config_by_type 处理，
                # 避免这里再拼一份 macvlan/veth 逻辑（早期两处不一致导致桥接不通）。
                net_type_setting = body.get("network_type") or "bridge"
                hostname_val = (body.get("hostname") or "").strip() or name

                # 环境变量（每行一个 KEY=VALUE，对应 lxc.environment）
                _env_lines = ""
                for _line in (body.get("environment") or "").splitlines():
                    _line = _line.strip()
                    if _line and "=" in _line:
                        _env_lines += f"lxc.environment = {_line}\n"

                res_lines = ""
                def _posint(key):
                    v = body.get(key)
                    try:
                        v = int(v)
                    except (TypeError, ValueError):
                        return None
                    return v if v > 0 else None

                _mem = _posint("memory")
                if _mem:
                    res_lines += f"lxc.cgroup2.memory.max = {_mem}M\n"
                _swap = body.get("swap")
                if _swap not in (None, ""):
                    try:
                        _swap_i = int(_swap)
                        res_lines += f"lxc.cgroup2.memory.swap.max = {_swap_i}M\n"
                    except (TypeError, ValueError):
                        pass
                _cores = _posint("cores")
                if _cores:
                    res_lines += f"lxc.cgroup2.cpuset.cpus = 0-{_cores - 1}\n"
                _cpulim = _posint("cpu_limit")
                if _cpulim:
                    _quota = max(1000, int(_cpulim * 1000))
                    res_lines += f"lxc.cgroup2.cpu.max = {_quota} 100000\n"

                os.makedirs(container_dir, exist_ok=True)
                config = (
                    "# FnLxc - 从 Proxmox 模板创建 (btrfs 子卷)\n"
                    f"lxc.rootfs.path = dir:{full_dataset}\n"
                    f"lxc.uts.name = {hostname_val}\n"
                    "lxc.include = /usr/share/lxc/config/common.conf\n"
                    "lxc.arch = linux64\n"
                    f"lxc.start.auto = {'1' if autostart else '0'}\n"
                    "lxc.start.delay = 2\n"
                    "lxc.tty.max = 1\n"
                    "lxc.apparmor.profile = unconfined\n"
                    "lxc.apparmor.allow_nesting = 1\n"
                    "lxc.mount.auto = proc:mixed sys:mixed cgroup:mixed\n"
                    "lxc.cgroup.devices.allow = a\n"
                    "lxc.environment = PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n"
                    f"{_env_lines}"
                    f"{res_lines}"
                )
                with open(os.path.join(container_dir, "config"), "w") as f:
                    f.write(config)

                # 4b. 网络配置（bridge → OVS/普通桥 veth；nat → lxcbr0 veth）
                _np = _net_params_from_body(body)
                _vlan = body.get("vlan")
                _mtu = body.get("mtu")
                try:
                    _vlan = int(_vlan) if _vlan not in (None, "") else None
                except (TypeError, ValueError):
                    _vlan = None
                try:
                    _mtu = int(_mtu) if _mtu not in (None, "") else None
                except (TypeError, ValueError):
                    _mtu = None
                write_container_network_config_by_type(
                    name, net_type_setting,
                    ipv4=_np.get("ipv4"), gateway=_np.get("gateway"),
                    ipv6=_np.get("ipv6"), ipv6_gw=_np.get("ipv6_gw"),
                    mac=(body.get("mac") or "").strip() or None,
                    vlan=_vlan, mtu=_mtu)

                # 4c. DNS：写容器内 resolv.conf（模板自带的会被覆盖，留空则不动）
                _dns = (body.get("dns_servers") or "").strip()
                _dns_domain = (body.get("dns_domain") or "").strip()
                if _dns or _dns_domain:
                    try:
                        _srv = [x.strip() for x in _dns.replace(";", ",").split(",") if x.strip()]
                        _rc = os.path.join(zfs_mount, "etc", "resolv.conf")
                        os.makedirs(os.path.dirname(_rc), exist_ok=True)
                        with open(_rc, "w") as fh:
                            if _dns_domain:
                                fh.write(f"search {_dns_domain}\n")
                            for _s in _srv:
                                fh.write(f"nameserver {_s}\n")
                    except Exception as _e:
                        logger.warning("写入容器 DNS 失败: %s", _e)

                # 4d. 静态地址落盘到容器内 ifupdown 配置
                # lxc.net.0.ipv4.address 只在启动瞬间生效，模板自带的 DHCP 客户端
                # （Alpine 的 interfaces.d/eth0、Debian 的 interfaces）会把它冲掉，
                # 所以这里把静态配置写进容器内，保证重启后仍是固定地址。
                _v4_static = (body.get("ipv4_address") or "").strip()
                if _v4_static:
                    try:
                        _addr, _, _plen = _v4_static.partition("/")
                        _plen = int(_plen) if _plen else 24
                        _mask = str(__import__("ipaddress").IPv4Network(f"0.0.0.0/{_plen}").netmask)
                        _gw = (body.get("ipv4_gateway") or "").strip()
                        _blk = f"auto eth0\niface eth0 inet static\n    address {_addr}\n    netmask {_mask}\n"
                        if _gw:
                            _blk += f"    gateway {_gw}\n"
                        _d = os.path.join(zfs_mount, "etc", "network", "interfaces.d")
                        if os.path.isdir(_d):
                            with open(os.path.join(_d, "eth0"), "w") as fh:
                                fh.write(_blk)
                        else:
                            _if = os.path.join(zfs_mount, "etc", "network", "interfaces")
                            if os.path.isdir(os.path.dirname(_if)):
                                _old = ""
                                if os.path.isfile(_if):
                                    _old = open(_if).read()
                                _old = "\n".join(
                                    l for l in _old.splitlines()
                                    if not l.strip().startswith(("auto eth0", "iface eth0", "    address", "    netmask", "    gateway"))
                                )
                                with open(_if, "w") as fh:
                                    fh.write(_old.rstrip() + "\n\n" + _blk)
                    except Exception as _e:
                        logger.warning("写入容器静态网络配置失败: %s", _e)

                # 4e. Root 密码 / SSH 公钥（标准 CT 模板需要能登录进去）
                _pwd = (body.get("root_password") or "").strip()
                _key = (body.get("ssh_public_key") or "").strip()
                if _pwd:
                    _ok, _msg = set_root_password(zfs_mount, _pwd)
                    if _ok:
                        logger.info("已设置容器 %s 的 root 密码", name)
                    else:
                        logger.warning("设置容器 %s 的 root 密码失败: %s", name, _msg)
                if _key:
                    _ok, _msg = set_ssh_authorized_keys(zfs_mount, _key)
                    if _ok:
                        logger.info("已写入容器 %s 的 SSH 公钥", name)
                    else:
                        logger.warning("写入容器 %s 的 SSH 公钥失败: %s", name, _msg)
                if _pwd or _key:
                    enable_root_ssh(zfs_mount)

                # 5. 设置容器内 hostname
                try:
                    hostname_path = os.path.join(zfs_mount, "etc", "hostname")
                    with open(hostname_path, "w") as fh:
                        fh.write(hostname_val + "\n")
                except:
                    pass
                try:
                    hosts_path = os.path.join(zfs_mount, "etc", "hosts")
                    if os.path.isfile(hosts_path):
                        with open(hosts_path, "a") as fh:
                            fh.write(f"127.0.1.1    {name}\n")
                except:
                    pass

                # 6. symlink（网络配置已在 4b/4d 完成，这里不要再跑 DHCP 落盘，
                #    否则会把静态地址覆盖回 dhcp）
                if not (body.get("ipv4_address") or "").strip():
                    write_container_network_config(name)
                ensure_lxc_symlink(name)

                # 7. 启动容器
                lxc_start = subprocess.run(
                    ["lxc-start", "-d", "-n", name],
                    capture_output=True, text=True, timeout=30
                )
                if lxc_start.returncode != 0:
                    logger.warning("容器 %s 启动失败: %s", name, lxc_start.stderr)
                else:
                    logger.info("容器 %s 已自动启动", name)

                logger.info("容器 %s 已从模板 %s 创建成功 (btrfs)", name, template_file)
                return {"ok": True, "msg": f"容器 {name} 创建成功（btrfs 子卷）", "container_dir": container_dir}
            except Exception as e:
                logger.exception("创建容器失败: %s", e)
                zfs_destroy_dataset(dataset, recursive=True)
                if os.path.exists(container_dir):
                    shutil.rmtree(container_dir, ignore_errors=True)
                return {"ok": False, "msg": str(e)}

        result = await asyncio.wait_for(
            loop.run_in_executor(None, _create), timeout=600)
        if result.get("ok"):
            # 同步写 metadata（container_order 用于 UI 排序）
            if autostart:
                write_metadata(name, "container_order", str(body.get("container_order", 0)))
            return web.json_response({"success": True, "data": result})
        return web.json_response({"success": False, "error": result.get("msg", "创建失败")}, status=500)


    # ── Backups ──
    async def handle_list_backups(request):
        name = request.match_info["name"]
        if not validate_container_name(name):
            return web.json_response({"success": False, "error": "容器名称格式无效"}, status=400)
        return web.json_response({"success": True, "data": list_backups(name)})

    async def handle_create_backup(request):
        name = request.match_info["name"]
        if not validate_container_name(name):
            return web.json_response({"success": False, "error": "容器名称格式无效"}, status=400)

        # 检查是否已有备份任务在运行（且进程存活）
        with backup_tasks_lock:
            existing = backup_tasks.get(name)
            if existing and existing["status"] == "running":
                # proc 字段记录了 xz/tar 子进程，检查是否还活着
                proc = existing.get("proc")
                if proc and proc.poll() is not None:
                    # 进程已退出但状态未更新，清理 zombie task
                    del backup_tasks[name]
                    existing = None
                elif existing:
                    return web.json_response({"success": False, "error": f"容器 {name} 已有备份任务在进行中"}, status=409)

        # 在后台线程执行备份
        start_backup_task(name)
        return web.json_response({
            "success": True,
            "message": f"容器 {name} 备份已开始",
            "data": {"task_id": name}
        })

    async def handle_backup_progress(request):
        name = request.match_info["name"]
        if not validate_container_name(name):
            return web.json_response({"success": False, "error": "容器名称格式无效"}, status=400)
        # 优先从文件读（文件方案），fallback 到内存 dict（兼容）
        task = _load_task("backup", name)
        if task is None:
            with backup_tasks_lock:
                task = backup_tasks.get(name)
        if not task:
            return web.json_response({"success": False, "error": "没有进行中的备份任务"}, status=404)
        resp = {
            "status": task.get("status", "unknown"),
            "current_size": task.get("current_size", 0),
            "total_size": task.get("total_size", 0),
            "rootfs_size": task.get("rootfs_size", 0),
            "elapsed": task.get("elapsed", 0),
        }
        if task["status"] == "done":
            resp["output_file"] = task.get("output_file", "")
            resp["size"] = task.get("current_size", 0)
        elif task["status"] == "error":
            resp["error"] = task.get("error", "未知错误")
        return web.json_response({"success": True, "data": resp})

    async def handle_delete_backup(request):
        name = request.match_info["name"]
        if not validate_container_name(name):
            return web.json_response({"success": False, "error": "容器名称格式无效"}, status=400)
        backup_file = request.match_info["file"]
        # 校验备份文件名格式，防止路径遍历
        parsed = parse_backup_filename(backup_file)
        if not parsed:
            return web.json_response({"success": False, "error": "备份文件名格式无效"}, status=400)
        # 备份文件名中的容器名必须与 URL 中的 name 一致，防止删除其他容器的备份
        if parsed.get("container") and parsed["container"] != name:
            return web.json_response({"success": False, "error": "备份文件与容器不匹配"}, status=403)
        settings = load_settings()
        backup_dir = os.path.join(settings["backup_path"], name)
        filepath = os.path.join(backup_dir, backup_file)
        if os.path.isfile(filepath):
            try:
                os.unlink(filepath)
            except Exception as e:
                return web.json_response({"success": False, "error": f"删除备份失败: {e}"}, status=500)
            return web.json_response({"success": True, "message": f"备份 {backup_file} 已删除"})
        return web.json_response({"success": False, "error": "备份文件未找到"}, status=404)

    async def handle_restore_backup(request):
        """POST /api/lxc/{name}/backup/{file}/restore — 从备份恢复（后台异步，返回 202 后开始轮询）"""
        name = request.match_info["name"]
        if not validate_container_name(name):
            return web.json_response({"success": False, "error": "容器名称格式无效"}, status=400)
        backup_file = request.match_info["file"]
        try:
            body = await request.json() if request.can_read_body else {}
        except Exception:
            body = {}
        newname = body.get("newname", name)
        if not validate_container_name(newname):
            return web.json_response({"success": False, "error": "新容器名称格式无效"}, status=400)
        settings = load_settings()
        parsed = parse_backup_filename(backup_file)
        if not parsed:
            return web.json_response({"success": False, "error": "备份文件名格式无效"}, status=400)
        # 备份文件名中的容器名必须与 URL 中的 name 一致，防止跨容器恢复
        if parsed.get("container") and parsed["container"] != name:
            return web.json_response({"success": False, "error": "备份文件与容器不匹配"}, status=403)
        ext = parsed.get("ext")  # "tar" 或 "zfs"
        if ext != "zfs":
            return web.json_response({"success": False, "error": f"仅支持 .zfs.xz 备份格式，收到: .{ext}"}, status=400)

        backup_path = os.path.join(settings["backup_path"], name, backup_file)
        if not os.path.isfile(backup_path):
            return web.json_response({"success": False, "error": f"备份文件未找到: {backup_path}"}, status=404)

        target_dir = os.path.join(LXC_PATH, newname)
        if os.path.isdir(target_dir):
            await async_run_lxc("stop", ["-n", newname], timeout=15)
            bak_dir = f"{target_dir}.bak"
            try:
                os.rename(target_dir, bak_dir)
                snap_ref = os.path.join(bak_dir, "lxc_snapshots")
                if os.path.isfile(snap_ref):
                    os.unlink(snap_ref)
                await async_run_lxc("destroy", ["-n", f"{newname}.bak", "-f"], timeout=30)
            except Exception as e:
                if os.path.isdir(bak_dir) and not os.path.isdir(target_dir):
                    os.rename(bak_dir, target_dir)
                return web.json_response({"success": False, "error": f"无法移除原有容器: {e}"}, status=500)

        # 检查是否有进行中的恢复任务
        if _load_task("restore", newname):
            return web.json_response({"success": False, "error": "已有该容器的恢复任务在进行中"}, status=409)

        # 写初始任务文件
        total_size = 0
        try:
            total_size = os.path.getsize(backup_path)
        except Exception:
            pass
        _save_task("restore", newname, {
            "status": "running",
            "msg": "正在准备恢复...",
            "pct": -1,
            "total_size": total_size,
            "current_size": 0,
        })

        def _do_restore():
            ok, err = restore_zfs_backup(backup_path, newname, task_key=newname)
            if not ok:
                _save_task("restore", newname, {"status": "error", "msg": err, "pct": 0})
                # 同步清理残留
                dataset = f"{ZFS_BASE_DATASET}/{newname}"
                try:
                    zfs_destroy_dataset(dataset, recursive=True)
                except Exception:
                    pass
                if os.path.isdir(target_dir):
                    shutil.rmtree(target_dir, ignore_errors=True)
            else:
                # restore_zfs_backup 内部已写 done 状态，这里补充启动容器
                network_type = body.get("network_type") or "bridge"
                _after_create(newname, network_type)
                # 启动容器
                _start_result = subprocess.run(
                    ["lxc-start", "-d", "-n", newname],
                    capture_output=True, text=True, timeout=15
                )
                if _start_result.returncode != 0:
                    logger.warning("恢复后启动容器 %s 失败: %s", newname, _start_result.stderr)
                else:
                    logger.info("恢复后容器 %s 已启动", newname)

        threading.Thread(target=_do_restore, daemon=True).start()
        return web.json_response({
            "success": True,
            "message": f"恢复已开始",
            "data": {"container": newname}
        }, status=202)

    async def handle_restore_progress(request):
        """GET /api/lxc/{name}/restore/{file}/progress — 轮询恢复进度（从任务文件读）"""
        name = request.match_info["name"]
        # 从 URL 提取 newname 不够直接，恢复任务的 key 是 newname（不是 backup_file）
        # 前端传 newname 作为 URL 中的 file 参数
        newname = request.match_info["file"]
        if not newname or not validate_container_name(newname):
            return web.json_response({"success": False, "error": "参数无效"}, status=400)
        task = _load_task("restore", newname)
        if not task:
            return web.json_response({"success": False, "error": "没有进行中的恢复任务"})
        return web.json_response({"success": True, "data": task})

    # ── Container Migration ──
    async def handle_migrate(request):
        """POST /api/lxc/{name}/migrate — 迁移（已禁用，请使用备份+恢复）"""
        return web.json_response({
            "success": False,
            "error": "迁移功能已禁用。如需迁移存储，请使用备份+恢复功能：将容器备份为 .zfs.xz，删除后从备份恢复至新存储位置。",
            "status": 410
        })

    # ── First-run detection ──
    async def handle_first_run(request):
        """检查是否首次运行：配置文件不存在即视为首次运行（卸载时已删除配置）"""
        is_first = not os.path.isfile(SETTINGS_FILE)
        return web.json_response({"success": True, "data": {"first_run": is_first}})

    # ── Settings ──
    async def handle_version(request):
        """返回 FnLxc 版本号"""
        return web.json_response({"success": True, "version": APP_VERSION, "data": APP_VERSION})

    async def handle_health(request):
        """健康检查接口 — fnOS 框架 class=check 阶段调用"""
        return web.json_response({"success": True, "status": "healthy", "version": APP_VERSION})

    async def handle_list_all_backups(request):
        """GET /api/backups — 扫描备份目录，返回所有容器的所有备份文件（不依赖源容器）"""
        settings = load_settings()
        backup_base = settings.get("backup_path", "/vol1/1000/lxc/bak")
        if not os.path.isdir(backup_base):
            return web.json_response({"success": True, "data": []})
        result = []
        try:
            for container in os.listdir(backup_base):
                container_dir = os.path.join(backup_base, container)
                if not os.path.isdir(container_dir):
                    continue
                for f in glob.glob(os.path.join(container_dir, "*.zfs.xz")):
                    st = os.stat(f)
                    result.append({
                        "filename": os.path.basename(f),
                        "container": container,
                        "size": st.st_size,
                        "created_at": datetime.datetime.fromtimestamp(st.st_mtime).isoformat(),
                    })
        except Exception as e:
            logger.warning("扫描备份目录失败: %s", e)
        # 按时间降序（最新的在前面）
        result.sort(key=lambda x: x["created_at"], reverse=True)
        return web.json_response({"success": True, "data": result})

    async def handle_get_settings(request):
        return web.json_response({"success": True, "data": load_settings()})

    async def handle_zfs_pools(request):
        """返回所有 btrfs 存储卷（含挂载点与容量）

        接口路径沿用 /api/zfs/pools，前端无需改动。
        """
        return web.json_response({"success": True, "data": list_storage_volumes()})

    async def handle_delete_settings(request):
        """恢复出厂设置：停容器 → 删除配置文件，下次启动将进入首次运行向导"""
        try:
            # 先停止所有运行中的容器
            settings = load_settings()
            lxc_path = settings.get("lxc_path", LXC_PATH)
            if lxc_path and os.path.isdir(lxc_path):
                loop = asyncio.get_event_loop()
                await loop.run_in_executor(None, _stop_containers_under_path, lxc_path)
                logger.info("恢复出厂设置：所有容器已停止")

            if os.path.isfile(SETTINGS_FILE):
                os.remove(SETTINGS_FILE)
                logger.info("配置文件已删除: %s", SETTINGS_FILE)
            return web.json_response({"success": True, "message": "设置已重置，重新加载后进入首次运行向导"})
        except Exception as e:
            logger.error("删除配置文件失败: %s", e)
            return web.json_response({"success": False, "error": f"删除配置文件失败: {e}"}, status=500)

    async def handle_put_settings(request):
        global LXC_PATH, STORAGE_IS_BTRFS, ZFS_POOL
        try:
            body = await request.json()
        except Exception as e:
            return web.json_response({"success": False, "error": f"无效的数据: {e}"}, status=400)

        s = load_settings()
        old_pool = s.get("zfs_pool", "")
        new_pool = body.get("zfs_pool", "")

        # 移除不再使用的 host_interface 字段（兼容旧客户端）
        body.pop("host_interface", None)

        # 如果存储卷为空，按 lxc_path 自动识别（btrfs 卷则启用快照能力）
        if not new_pool:
            lxc_path_hint = body.get("lxc_path") or s.get("lxc_path") or ""
            if lxc_path_hint:
                fs = fs_type_of(os.path.dirname(lxc_path_hint) or "/")
                if fs == "btrfs":
                    body["zfs_pool"] = _volume_name(lxc_path_hint)
                    new_pool = body["zfs_pool"]
                    logger.info("按 lxc_path 识别存储卷=%s（btrfs）", body["zfs_pool"])
                else:
                    body["zfs_pool"] = ""
                    logger.warning("lxc_path=%s 不在 btrfs 上（%s），快照/备份不可用", lxc_path_hint, fs or "unknown")
            else:
                return web.json_response({
                    "success": False,
                    "error": "未指定 LXC 存储目录，请先设置 lxc_path"
                }, status=400)

        # 如果存储卷变化，更新全局状态
        if new_pool and new_pool != old_pool and new_pool != ZFS_POOL:
            if not _validate_zfs_pool_name(new_pool):
                return web.json_response({"success": False, "error": "存储卷名不合法"}, status=400)
            old_lxc_path = s.get("lxc_path", "")
            detect_zfs_pool(new_pool)
            logger.info("存储卷已切换: %s → %s", old_pool or "(空)", new_pool)
            cleanup_old_pool_datasets(old_pool, old_lxc_path)

        # 保存设置
        s = save_settings(body)

        # 同步全局路径变量（确保当前请求用到新路径）
        LXC_PATH = s.get("lxc_path", LXC_PATH)
        # 确保存储目录与顶层子卷存在
        ensure_storage(
            pool=s.get("zfs_pool"),
            lxc_path=s.get("lxc_path"),
            backup_path=s.get("backup_path"),
            cache_dir=s.get("cache_dir"),
        )

        # 按最终 LXC_PATH 重新判定存储后端（只改 lxc_path 时也要让全局标志跟上）
        _fs = fs_type_of(LXC_PATH)
        STORAGE_IS_BTRFS = (_fs == "btrfs")
        ZFS_POOL = (s.get("zfs_pool") or _volume_name(LXC_PATH)) if STORAGE_IS_BTRFS else (s.get("zfs_pool") or "")
        logger.info("存储后端判定: LXC_PATH=%s fs=%s btrfs=%s pool=%s",
                    LXC_PATH, _fs or "unknown", STORAGE_IS_BTRFS, ZFS_POOL or "(空)")

        return web.json_response({"success": True, "data": s, "message": "设置已保存"})

    # ── System info ──
    async def handle_interfaces(request):
        return web.json_response({"success": True, "data": list_interfaces()})

    async def handle_cpus(request):
        return web.json_response({"success": True, "data": get_cpu_info()})

    async def handle_stats(request):
        """系统统计：容器总数、运行数、快照数、备份数"""
        cons = await async_list_containers()
        total = len(cons)
        running = sum(1 for c in cons if c["state"] == "running")
        frozen = sum(1 for c in cons if c["state"] == "frozen")
        stopped = total - running - frozen
        # 遍历容器累加快照数
        total_snapshots = sum(c.get("snapshots", 0) for c in cons)
        # 扫描备份目录统计备份数
        total_backups = 0
        settings = load_settings()
        backup_path = settings.get("backup_path", "/vol1/1000/lxc/bak")
        if os.path.isdir(backup_path):
            for entry in os.listdir(backup_path):
                entry_path = os.path.join(backup_path, entry)
                if os.path.isdir(entry_path):
                    try:
                        total_backups += len(glob.glob(os.path.join(entry_path, "*.zfs.xz")))
                    except Exception:
                        pass
        # LXC version
        lxc_ver = ""
        ver_r = await async_run_lxc("ls", ["--version"], timeout=5)
        if ver_r["code"] == 0:
            lxc_ver = ver_r["stdout"].strip()
        return web.json_response({
            "success": True,
            "data": {
                "total": total, "running": running, "stopped": stopped, "frozen": frozen,
                "snapshots": total_snapshots, "backups": total_backups,
                "lxc_version": lxc_ver,
                "lxc_path": LXC_PATH,
            }
        })

    # ── Logs handler ──
    async def handle_logs(request):
        """返回日志文件内容（支持轮转的日志）"""
        # 优先读主日志文件，不存在则尝试最新的轮转备份
        candidates = [LOG_FILE]
        for i in range(1, LOG_BACKUP_COUNT + 1):
            candidates.append(f"{LOG_FILE}.{i}")
        candidates.reverse()  # 最新的备份放前面

        for candidate in candidates:
            # 安全校验：normpath 后必须在允许的日志目录下，防止路径穿越
            real_candidate = os.path.normpath(candidate)
            real_log_dir = os.path.normpath(os.path.dirname(LOG_FILE))
            if not real_candidate.startswith(real_log_dir + os.sep) and real_candidate != real_log_dir:
                continue
            if os.path.exists(candidate):
                try:
                    with open(candidate) as f:
                        lines = f.readlines()
                    return web.json_response({'success': True, 'data': lines[-500:], 'total': len(lines)})
                except Exception:
                    pass
        return web.json_response({'success': True, 'data': [], 'msg': '日志文件不存在'})

    # ── Routes ──
    GW = GATEWAY_PREFIX

    def setup_routes(app):
        api_routes = [
            # Specific routes FIRST (before generic {action})
            ("GET", "/api/lxc/list", handle_list),
            ("GET", "/api/lxc/templates", handle_templates),
            ("GET", "/api/lxc/templates/{distro}/versions", handle_template_versions),
            # Proxmox 模板源
            ("GET",  "/api/templates/proxmox",  handle_proxmox_templates),
            ("POST", "/api/templates/proxmox/download", handle_proxmox_download),
            ("GET",  "/api/templates/cached",    handle_cached_templates),
            ("POST", "/api/lxc/create/from-proxmox", handle_create_from_proxmox),
            ("POST", "/api/lxc/create", handle_create),
            ("POST", "/api/lxc/create/copy", handle_copy),
            ("POST", "/api/lxc/create/from-snapshot", handle_create_from_snapshot),
            ("POST", "/api/lxc/create/from-backup", handle_create_from_backup),
            ("GET", "/api/lxc/{name}/info", handle_info),
            ("GET", "/api/lxc/{name}/config", handle_config_get),
            ("PUT", "/api/lxc/{name}/config", handle_config_update),
            ("GET", "/api/lxc/{name}/snapshots", handle_snapshots),
            ("POST", "/api/lxc/{name}/snapshot", handle_create_snapshot),
            ("DELETE", "/api/lxc/{name}/snapshot/{snap}", handle_delete_snapshot),
            ("POST", "/api/lxc/{name}/snapshot/{snap}/restore", handle_restore_snapshot),
            ("GET", "/api/lxc/{name}/backups", handle_list_backups),
            ("POST", "/api/lxc/{name}/backup", handle_create_backup),
            ("GET", "/api/lxc/{name}/backup/progress", handle_backup_progress),
            ("DELETE", "/api/lxc/{name}/backup/{file}", handle_delete_backup),
            ("POST", "/api/lxc/{name}/backup/{file}/restore", handle_restore_backup),
            ("GET", "/api/lxc/{name}/restore/{file}/progress", handle_restore_progress),
            ("POST", "/api/lxc/create/from-backup", handle_create_from_backup),
            ("GET", "/api/lxc/create/{name}/progress", handle_create_progress),
            ("POST", "/api/lxc/{name}/migrate", handle_migrate),
            ("PUT", "/api/lxc/{name}/description", handle_set_description),
            ("DELETE", "/api/lxc/{name}/description", handle_del_description),
            ("PUT", "/api/lxc/{name}/autostart", handle_set_autostart),
            ("PUT", "/api/lxc/{name}/mac", handle_set_mac),
            ("PUT", "/api/lxc/{name}/order", handle_set_order),
            ("PUT", "/api/lxc/{name}/limits", handle_set_limits),
            ("GET", "/api/lxc/{name}", handle_get),
            ("DELETE", "/api/lxc/{name}", handle_delete),
            # Generic state action LAST — keep specific routes above this line
            ("POST", "/api/lxc/{name}/{action}", handle_state_action),
            # Terminal WebSocket (must come before generic {action} for GET)
            ("GET", "/api/lxc/{name}/terminal", handle_terminal),
            # System routes
            ("GET", "/api/version", handle_version),
            ("GET", "/api/health", handle_health),
            ("GET", "/api/backups", handle_list_all_backups),
            ("GET", "/api/first-run", handle_first_run),
            ("GET", "/api/settings", handle_get_settings),
            ("PUT", "/api/settings", handle_put_settings),
            ("DELETE", "/api/settings", handle_delete_settings),
            ("GET", "/api/zfs/pools", handle_zfs_pools),
            ("GET", "/api/interfaces", handle_interfaces),
            ("GET", "/api/cpus", handle_cpus),
            ("GET", "/api/stats", handle_stats),
            ("GET", "/api/logs", handle_logs),
        ]
        for method, path, handler in api_routes:
            app.router.add_route(method, path, handler)
            app.router.add_route(method, GW + path, handler)

        # Static files
        app.router.add_get(GW, handle_index)
        app.router.add_get(GW + "/", handle_index)
        app.router.add_get(GW + "/{filename:.*}", handle_static)

# ══════════════════════════════════════════════════
# Entry point
# ══════════════════════════════════════════════════

def main():
    logger.info("FnLxc v2 后端启动中...")
    logger.info("Socket: %s", SOCKET_PATH)
    logger.info("UI Dir: %s", UI_DIR)
    # 初始化存储后端状态（btrfs 子卷 / 普通目录）
    try:
        detect_zfs_pool(_CFG_POOL)
    except Exception as e:
        logger.warning("存储后端探测失败: %s", e)

    if HAS_AIOHTTP:
        server_app = web.Application()
        setup_routes(server_app)

        if os.path.exists(SOCKET_PATH):
            os.unlink(SOCKET_PATH)
        os.makedirs(os.path.dirname(SOCKET_PATH), exist_ok=True)

        runner = web.AppRunner(server_app)
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(runner.setup())

        site = web.UnixSite(runner, SOCKET_PATH)
        loop.run_until_complete(site.start())
        os.chmod(SOCKET_PATH, 0o660)

        logger.info("FnLxc v2 后端就绪 (aiohttp, socket: %s)", SOCKET_PATH)
        loop.run_forever()
    else:
        logger.warning("aiohttp 未安装，回退 stdlib HTTP server")
        def wsgi_app(environ, start_response):
            path = environ.get("PATH_INFO", "")
            method = environ.get("REQUEST_METHOD", "GET")
            response_data = b'{"error":"not found"}'
            status = "404 Not Found"
            headers = [("Content-Type", "application/json")]

            if path in ("/", GATEWAY_PREFIX, GATEWAY_PREFIX + "/"):
                ui_idx = os.path.join(UI_DIR, "index.html")
                if os.path.isfile(ui_idx):
                    with open(ui_idx, "rb") as f:
                        response_data = f.read()
                    headers = [("Content-Type", "text/html; charset=utf-8")]
                    status = "200 OK"
            elif path.startswith(GATEWAY_PREFIX + "/api/") or path.startswith("/api/"):
                # Strip gateway prefix
                api_path = path[len(GATEWAY_PREFIX):] if path.startswith(GATEWAY_PREFIX) else path

                if api_path == "/api/lxc/list" and method == "GET":
                    response_data = json.dumps({"success": True, "data": list_containers()}).encode()
                    status = "200 OK"
                elif api_path == "/api/first-run" and method == "GET":
                    is_first = not os.path.isfile(SETTINGS_FILE)
                    response_data = json.dumps({"success": True, "data": {"first_run": is_first}}).encode()
                    status = "200 OK"
                elif api_path == "/api/stats" and method == "GET":
                    cons = list_containers()
                    response_data = json.dumps({"success": True, "data": {
                        "total": len(cons),
                        "running": sum(1 for c in cons if c["state"] == "running"),
                        "stopped": sum(1 for c in cons if c["state"] == "stopped"),
                        "frozen": sum(1 for c in cons if c["state"] == "frozen"),
                        "snapshots": 0, "backups": 0,
                        "lxc_version": "", "lxc_path": LXC_PATH,
                    }}).encode()
                    status = "200 OK"
                elif api_path == "/api/interfaces" and method == "GET":
                    response_data = json.dumps({"success": True, "data": list_interfaces()}).encode()
                    status = "200 OK"
                elif api_path == "/api/cpus" and method == "GET":
                    response_data = json.dumps({"success": True, "data": get_cpu_info()}).encode()
                    status = "200 OK"
                elif api_path == "/api/settings" and method == "GET":
                    response_data = json.dumps({"success": True, "data": load_settings()}).encode()
                    status = "200 OK"
                elif api_path == "/api/zfs/pools" and method == "GET":
                    response_data = json.dumps({"success": True, "data": list_storage_volumes()}).encode()
                    status = "200 OK"
                elif re.match(r"/api/lxc/[^/]+$", api_path) and method == "GET":
                    name = api_path.split("/")[-1]
                    cons = list_containers()
                    found = None
                    for c in cons:
                        if c["name"] == name:
                            found = c
                            break
                    if found:
                        response_data = json.dumps({"success": True, "data": found}).encode()
                    else:
                        response_data = json.dumps({"success": False, "error": f"容器 {name} 未找到"}).encode()
                        status = "404 Not Found"
                else:
                    response_data = json.dumps({"success": False, "error": f"stdlib 回退不支持: {method} {api_path}"}).encode()
                    status = "501 Not Implemented"

            start_response(status, headers)
            return [response_data]

        class ThreadedWSGIServer(ThreadingMixIn, WSGIServer):
            daemon_threads = True

        if os.path.exists(SOCKET_PATH):
            os.unlink(SOCKET_PATH)
        os.makedirs(os.path.dirname(SOCKET_PATH), exist_ok=True)

        import socket as sock_mod
        server = ThreadedWSGIServer(SOCKET_PATH, make_server("", 0, wsgi_app).RequestHandlerClass, bind_and_activate=False)
        server.socket = sock_mod.socket(sock_mod.AF_UNIX, sock_mod.SOCK_STREAM)
        server.server_bind()
        server.server_activate()
        os.chmod(SOCKET_PATH, 0o660)
        logger.info("FnLxc v2 后端就绪 (stdlib, socket: %s)", SOCKET_PATH)
        server.serve_forever()

if __name__ == "__main__":
    main()
