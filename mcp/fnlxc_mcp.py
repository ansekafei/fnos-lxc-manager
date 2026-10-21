#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""FnLxc MCP Server — 把飞牛 FnLxc 的容器管理能力暴露成 MCP 工具。

设计：零依赖（只用 Python 标准库），stdio JSON-RPC 2.0，通过 Unix socket
调用 FnLxc 后端 HTTP API（后端以 root 运行，实际动作由它执行）。

用法：
    python3 fnlxc_mcp.py                 # stdio 模式（给 MCP 客户端用）
    python3 fnlxc_mcp.py --selftest      # 自检：打印 socket 探测结果

环境变量：
    FNLXC_SOCKET   后端 socket 路径（默认自动探测）
    FNLXC_TIMEOUT  单次请求超时秒数（默认 120）
"""

import json
import os
import socket
import sys
import http.client
import urllib.parse

PROTOCOL_VERSION = "2025-06-18"
SERVER_NAME = "fnlxc"
SERVER_VERSION = "1.0.0"

SOCKET_CANDIDATES = [
    os.environ.get("FNLXC_SOCKET", ""),
    "/var/apps/fnlxc/fnlxc.sock",
    "/usr/local/apps/@appdata/fnlxc/fnlxc.sock",
    "/usr/local/apps/@appcenter/fnlxc/fnlxc.sock",
    "/vol1/@appdata/fnlxc/fnlxc.sock",
    "/var/lib/fnlxc/fnlxc.sock",
]

DEFAULT_TIMEOUT = int(os.environ.get("FNLXC_TIMEOUT", "120"))


# ── 后端通信 ────────────────────────────────────────────────────────────

class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, socket_path, timeout=DEFAULT_TIMEOUT):
        super().__init__("localhost", timeout=timeout)
        self.socket_path = socket_path

    def connect(self):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self.socket_path)
        self.sock = sock


def find_socket():
    for path in SOCKET_CANDIDATES:
        if path and os.path.exists(path):
            return path
    return None


def api(method, path, body=None, timeout=None):
    """调用 FnLxc 后端，返回 (ok, payload)"""
    sock_path = find_socket()
    if not sock_path:
        return False, {
            "error": "找不到 FnLxc 后端 socket。请确认 FnLxc 应用已启动，"
                     "或设置环境变量 FNLXC_SOCKET 指向实际路径。已尝试："
                     + ", ".join(p for p in SOCKET_CANDIDATES if p)
        }
    conn = UnixHTTPConnection(sock_path, timeout=timeout or DEFAULT_TIMEOUT)
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    try:
        conn.request(method, path, body=data, headers=headers)
        resp = conn.getresponse()
        raw = resp.read()
        try:
            return True, json.loads(raw.decode("utf-8", "replace") or "{}")
        except Exception:
            return True, {"raw": raw.decode("utf-8", "replace")[:4000]}
    except Exception as e:
        return False, {"error": f"请求后端失败（{sock_path}）: {e}"}
    finally:
        try:
            conn.close()
        except Exception:
            pass


def q(name):
    return urllib.parse.quote(str(name), safe="")


# ── 工具定义 ────────────────────────────────────────────────────────────

def _s(desc, **extra):
    d = {"type": "string", "description": desc}
    d.update(extra)
    return d


TOOLS = [
    {
        "name": "fnlxc_health",
        "description": "检查 FnLxc 后端是否在线，返回版本、LXC 路径、运行状态。排查第一步先调它。",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "fnlxc_storage",
        "description": "列出可用 btrfs 存储卷（名称/挂载点/容量/剩余），用于确认容器数据放在哪。",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "fnlxc_settings",
        "description": "读取或修改 FnLxc 全局设置（lxc_path、备份路径、镜像源、压缩级别等）。action=get 读取，action=set 需传 data。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": _s("get 或 set", enum=["get", "set"]),
                "data": {"type": "object", "description": "action=set 时提交的设置项，例如 {\"lxc_path\":\"/vol1/lxc\"}"},
            },
            "required": ["action"],
        },
    },
    {
        "name": "lxc_list",
        "description": "列出所有 LXC 容器：名称、状态、IP、镜像、CPU/内存占用、快照数。",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "lxc_info",
        "description": "查看单个容器的详细信息（状态、PID、IP、存储后端、自启动、限制等）。",
        "inputSchema": {
            "type": "object",
            "properties": {"name": _s("容器名")},
            "required": ["name"],
        },
    },
    {
        "name": "lxc_control",
        "description": "开关容器：start 启动 / stop 停止 / restart 重启 / freeze 冻结 / unfreeze 解冻 / kill 强杀。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": _s("容器名"),
                "action": _s("动作", enum=["start", "stop", "restart", "freeze", "unfreeze", "kill"]),
            },
            "required": ["name", "action"],
        },
    },
    {
        "name": "lxc_exec",
        "description": "在容器内执行命令并返回 stdout/stderr/退出码。传数组更安全（不经过 shell 解析）；传字符串会走 sh -c。后端超时 30 秒，且禁止 sudo/su/ssh/curl/chmod 等命令。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": _s("容器名"),
                "cmd": {
                    "description": "命令：字符串（如 \"ls -la /root\"）或字符串数组（如 [\"ls\",\"-la\",\"/root\"]）",
                    "oneOf": [
                        {"type": "string"},
                        {"type": "array", "items": {"type": "string"}},
                    ],
                },
            },
            "required": ["name", "cmd"],
        },
    },
    {
        "name": "lxc_config_get",
        "description": "读取容器的 LXC 配置原文（/var/lib/lxc/<name>/config 内容）。",
        "inputSchema": {
            "type": "object",
            "properties": {"name": _s("容器名")},
            "required": ["name"],
        },
    },
    {
        "name": "lxc_config_set",
        "description": "修改容器配置（键值对）。后端有安全黑名单：rootfs、mount、apparmor、seccomp、hook、cap、cgroup.devices 等键不允许改。改网络/内存/CPU/自启动等常规键可用。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": _s("容器名"),
                "updates": {
                    "type": "object",
                    "description": "要写入的键值对，例如 {\"lxc.cgroup2.memory.max\":\"2G\"}",
                },
            },
            "required": ["name", "updates"],
        },
    },
    {
        "name": "lxc_snapshot",
        "description": "快照管理：action=list 列出 / create 创建（可给 snap 命名）/ restore 回滚到快照 / delete 删除。基于 btrfs 子卷，秒级。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": _s("容器名"),
                "action": _s("动作", enum=["list", "create", "restore", "delete"]),
                "snap": _s("快照名（create 可省略自动命名；restore/delete 必填）"),
            },
            "required": ["name", "action"],
        },
    },
    {
        "name": "lxc_backup",
        "description": "备份管理：action=list 列出 / create 创建（btrfs send | xz，产物 *.zfs.xz）/ restore 从备份恢复到新容器。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": _s("容器名"),
                "action": _s("动作", enum=["list", "create", "restore"]),
                "file": _s("备份文件名（restore 必填）"),
                "newname": _s("restore 时的目标容器名（可省略）"),
            },
            "required": ["name", "action"],
        },
    },
    {
        "name": "lxc_create",
        "description": "从官方模板创建容器（走 lxc-download + 镜像源，下载耗时较长）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": _s("新容器名"),
                "template": _s("发行版：ubuntu/debian/alpine/centos/fedora/archlinux 等", default="debian"),
                "release": _s("版本号，如 bookworm、24.04；省略则用默认"),
                "arch": _s("架构", default="amd64"),
            },
            "required": ["name"],
        },
    },
    {
        "name": "lxc_delete",
        "description": "删除容器（会连同其快照子卷一起销毁）。不可逆。",
        "inputSchema": {
            "type": "object",
            "properties": {"name": _s("容器名")},
            "required": ["name"],
        },
    },
    {
        "name": "fnlxc_logs",
        "description": "读取 FnLxc 后端日志（默认最后 200 行），用于排查容器起不来、接口报错。",
        "inputSchema": {
            "type": "object",
            "properties": {"lines": {"type": "integer", "description": "行数，默认 200", "default": 200}},
        },
    },
]


# ── 工具实现 ────────────────────────────────────────────────────────────

def _wrap(ok, payload):
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    return {"content": [{"type": "text", "text": text}], "isError": not ok}


def call_tool(name, args):
    args = args or {}

    if name == "fnlxc_health":
        ok, r = api("GET", "/api/health")
        if not ok:
            return _wrap(False, r)
        return _wrap(True, {"backend": r, "socket": find_socket()})

    if name == "fnlxc_storage":
        ok, r = api("GET", "/api/zfs/pools")
        return _wrap(ok and r.get("success", True), r)

    if name == "fnlxc_settings":
        action = args.get("action", "get")
        if action == "get":
            ok, r = api("GET", "/api/settings")
            return _wrap(ok and r.get("success", True), r)
        data = args.get("data") or {}
        if not isinstance(data, dict) or not data:
            return _wrap(False, {"error": "action=set 需要非空 data 对象"})
        ok, r = api("PUT", "/api/settings", data)
        return _wrap(ok and r.get("success", True), r)

    if name == "lxc_list":
        ok, r = api("GET", "/api/lxc/list")
        return _wrap(ok and r.get("success", True), r)

    if name == "lxc_info":
        cname = args.get("name", "")
        ok, r = api("GET", f"/api/lxc/{q(cname)}/info")
        return _wrap(ok and r.get("success", True), r)

    if name == "lxc_control":
        cname = args.get("name", "")
        action = args.get("action", "")
        if action not in ("start", "stop", "restart", "freeze", "unfreeze", "kill"):
            return _wrap(False, {"error": f"无效动作: {action}"})
        ok, r = api("POST", f"/api/lxc/{q(cname)}/{action}", {})
        return _wrap(ok and r.get("success", True), r)

    if name == "lxc_exec":
        cname = args.get("name", "")
        cmd = args.get("cmd")
        if not cmd:
            return _wrap(False, {"error": "cmd 不能为空"})
        ok, r = api("POST", f"/api/lxc/{q(cname)}/exec", {"cmd": cmd}, timeout=90)
        return _wrap(ok and r.get("success", True), r)

    if name == "lxc_config_get":
        cname = args.get("name", "")
        ok, r = api("GET", f"/api/lxc/{q(cname)}/config")
        return _wrap(ok and r.get("success", True), r)

    if name == "lxc_config_set":
        cname = args.get("name", "")
        updates = args.get("updates") or {}
        if not isinstance(updates, dict) or not updates:
            return _wrap(False, {"error": "updates 需要是非空对象"})
        ok, r = api("PUT", f"/api/lxc/{q(cname)}/config", {"updates": updates})
        return _wrap(ok and r.get("success", True), r)

    if name == "lxc_snapshot":
        cname = args.get("name", "")
        action = args.get("action", "list")
        snap = args.get("snap", "")
        base = f"/api/lxc/{q(cname)}"
        if action == "list":
            ok, r = api("GET", f"{base}/snapshots")
        elif action == "create":
            payload = {"name": snap} if snap else {}
            ok, r = api("POST", f"{base}/snapshot", payload)
        elif action == "restore":
            if not snap:
                return _wrap(False, {"error": "restore 需要 snap"})
            ok, r = api("POST", f"{base}/snapshot/{q(snap)}/restore", {})
        elif action == "delete":
            if not snap:
                return _wrap(False, {"error": "delete 需要 snap"})
            ok, r = api("DELETE", f"{base}/snapshot/{q(snap)}")
        else:
            return _wrap(False, {"error": f"无效动作: {action}"})
        return _wrap(ok and r.get("success", True), r)

    if name == "lxc_backup":
        cname = args.get("name", "")
        action = args.get("action", "list")
        fname = args.get("file", "")
        base = f"/api/lxc/{q(cname)}"
        if action == "list":
            ok, r = api("GET", f"{base}/backups")
        elif action == "create":
            ok, r = api("POST", f"{base}/backup", {}, timeout=3600)
        elif action == "restore":
            if not fname:
                return _wrap(False, {"error": "restore 需要 file"})
            payload = {"newname": args["newname"]} if args.get("newname") else {}
            ok, r = api("POST", f"{base}/backup/{q(fname)}/restore", payload, timeout=3600)
        else:
            return _wrap(False, {"error": f"无效动作: {action}"})
        return _wrap(ok and r.get("success", True), r)

    if name == "lxc_create":
        payload = {
            "name": args.get("name", ""),
            "template": args.get("template", "debian"),
            "arch": args.get("arch", "amd64"),
        }
        if args.get("release"):
            payload["release"] = args["release"]
        ok, r = api("POST", "/api/lxc/create", payload, timeout=1800)
        return _wrap(ok and r.get("success", True), r)

    if name == "lxc_delete":
        cname = args.get("name", "")
        ok, r = api("DELETE", f"/api/lxc/{q(cname)}", timeout=300)
        return _wrap(ok and r.get("success", True), r)

    if name == "fnlxc_logs":
        n = int(args.get("lines", 200))
        ok, r = api("GET", f"/api/logs?lines={n}")
        return _wrap(ok and r.get("success", True), r)

    return _wrap(False, {"error": f"未知工具: {name}"})


# ── MCP 协议层（stdio，逐行 JSON）──────────────────────────────────────

def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def handle(msg):
    method = msg.get("method")
    mid = msg.get("id")

    # 通知类消息不需要回复
    if mid is None and method:
        return None

    if method == "initialize":
        params = msg.get("params") or {}
        client_ver = params.get("protocolVersion") or PROTOCOL_VERSION
        # 客户端版本比我们新时也照它的版本回，避免握手失败
        return {
            "jsonrpc": "2.0", "id": mid,
            "result": {
                "protocolVersion": client_ver,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                "instructions": (
                    "FnLxc 容器管理。先用 fnlxc_health 确认后端在线；"
                    "lxc_list 看容器；lxc_control 开关；lxc_exec 进容器跑命令；"
                    "lxc_config_get/set 读写配置；lxc_snapshot / lxc_backup 做快照与备份。"
                ),
            },
        }

    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}}

    if method == "tools/call":
        params = msg.get("params") or {}
        tool_name = params.get("name", "")
        arguments = params.get("arguments") or {}
        try:
            result = call_tool(tool_name, arguments)
        except Exception as e:
            result = {"content": [{"type": "text", "text": f"工具执行异常: {e}"}], "isError": True}
        return {"jsonrpc": "2.0", "id": mid, "result": result}

    if method == "ping":
        return {"jsonrpc": "2.0", "id": mid, "result": {}}

    if method in ("resources/list", "prompts/list"):
        key = "resources" if method.startswith("resources") else "prompts"
        return {"jsonrpc": "2.0", "id": mid, "result": {key: []}}

    return {
        "jsonrpc": "2.0", "id": mid,
        "error": {"code": -32601, "message": f"Method not found: {method}"},
    }


def main():
    if "--selftest" in sys.argv:
        sock = find_socket()
        print(json.dumps({
            "socket": sock,
            "candidates": [p for p in SOCKET_CANDIDATES if p],
            "exists": {p: os.path.exists(p) for p in SOCKET_CANDIDATES if p},
            "tools": [t["name"] for t in TOOLS],
        }, ensure_ascii=False, indent=2))
        return

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            send({"jsonrpc": "2.0", "id": None,
                  "error": {"code": -32700, "message": "Parse error"}})
            continue
        try:
            resp = handle(msg)
        except Exception as e:
            resp = {"jsonrpc": "2.0", "id": msg.get("id"),
                    "error": {"code": -32603, "message": f"Internal error: {e}"}}
        if resp is not None:
            send(resp)


if __name__ == "__main__":
    main()
