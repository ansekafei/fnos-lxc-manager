"""guestnet.py —— 容器内 eth0 的静态地址 / DHCP 切换

为什么需要这个：`lxc.net.0.ipv4.address` 只在容器启动的一瞬间由 LXC 配上去，
容器自己的 DHCP 客户端（ifupdown、systemd-networkd、netplan、NetworkManager）
随后跑起来，会把地址抢回 DHCP 分配的那个，或者干脆再加一个地址。界面里配的
静态 IP 因此「重启就变」。

做法：把容器内 eth0 的 DHCP 关掉，再写静态地址。所有改动都带标记：
  - `# fnos-lxc: begin` … `# fnos-lxc: end` 之间是我们整块加进去的内容，撤销时整段删除；
  - `# fnos-lxc: <原行>` 是被我们注释掉的原配置，撤销时原样还原；
  - 我们自己新建的文件第一行是 `# fnos-lxc: generated`，撤销时直接删除。
这样改回 DHCP 只需要撤销带标记的改动，用户手写的其余配置一行不碰，也不需要备份文件。
"""
import ipaddress
import os
import re
import stat

MARK = "# fnos-lxc:"
BEGIN = "# fnos-lxc: begin"
END = "# fnos-lxc: end"
GENERATED = "# fnos-lxc: generated"
NIC = "eth0"

# 我们生成的文件（相对 rootfs）
NETPLAN_DROPIN = "etc/netplan/99-fnos-lxc.yaml"
NM_KEYFILE = "etc/NetworkManager/system-connections/fnos-lxc-eth0.nmconnection"


# ── 文本层：加标记 / 撤销标记 ──────────────────────────────

def is_generated(text):
    return text.lstrip().startswith(GENERATED)


def strip(text):
    """撤销我们做过的全部改动：删掉 begin..end 区块，还原被注释的原行。"""
    out, in_block = [], False
    for line in text.splitlines():
        st = line.strip()
        if st.startswith(BEGIN):
            in_block = True
            continue
        if in_block:
            if st.startswith(END):
                in_block = False
            continue
        if st.startswith(MARK) and not st.startswith(GENERATED):
            orig = st[len(MARK):]
            out.append(orig[1:] if orig.startswith(" ") else orig)
        else:
            out.append(line)
    res = "\n".join(out)
    if text.endswith("\n") and not res.endswith("\n"):
        res += "\n"
    return res


def _comment(lines, pred):
    """把满足条件的行注释掉并记原值，返回 (新行列表, 命中数)。"""
    out, hits = [], 0
    for line in lines:
        if pred(line):
            out.append(f"{MARK} {line}")
            hits += 1
        else:
            out.append(line)
    return out, hits


# ── ifupdown ────────────────────────────────────────────

_IFACE_ETH0 = re.compile(r'^\s*iface\s+' + NIC + r'\s+inet\s+\S+')
_AUTO_ETH0 = re.compile(r'^\s*(auto|allow-hotplug)\s+' + NIC + r'\s*$')


def ifupdown_static(text, addr, plen, gateway=""):
    lines = text.splitlines()
    out, i = [], 0
    while i < len(lines):
        line = lines[i]
        if _IFACE_ETH0.match(line):
            if out and _AUTO_ETH0.match(out[-1]):
                out[-1] = f"{MARK} {out[-1]}"
            out.append(f"{MARK} {line}")
            i += 1
            while i < len(lines) and (lines[i].strip() == "" or lines[i][:1] in (" ", "\t")):
                out.append(f"{MARK} {lines[i]}" if lines[i].strip() else lines[i])
                i += 1
            continue
        out.append(line)
        i += 1

    block = [BEGIN, f"auto {NIC}", f"iface {NIC} inet static", f"    address {addr}/{plen}"]
    if gateway:
        block.append(f"    gateway {gateway}")
    block.append(END)
    return "\n".join(out).rstrip("\n") + "\n\n" + "\n".join(block) + "\n"


# ── systemd-networkd ────────────────────────────────────

def networkd_static(text, addr, plen, gateway=""):
    lines = text.splitlines()
    lines, _ = _comment(lines, lambda l: l.strip().startswith("DHCP="))
    block = [BEGIN, "[Network]", f"Address={addr}/{plen}"]
    if gateway:
        block.append(f"Gateway={gateway}")
    block.append("DHCP=no")
    block.append(END)
    return "\n".join(lines).rstrip("\n") + "\n\n" + "\n".join(block) + "\n"


# ── netplan ─────────────────────────────────────────────

_YAML_DHCP4 = re.compile(r'^(\s*)dhcp4:\s*(true|yes|on)\s*$')


def netplan_disable_dhcp(text):
    """把 dhcp4: true 注释掉（保留缩进，撤销时原样还原）。"""
    lines = text.splitlines()
    out, hits = [], 0
    for line in lines:
        if _YAML_DHCP4.match(line):
            out.append(f"{MARK} {line}")
            hits += 1
        else:
            out.append(line)
    return "\n".join(out) + ("\n" if text.endswith("\n") else ""), hits


def netplan_dropin(addr, plen, gateway=""):
    body = [
        GENERATED,
        "network:",
        "  version: 2",
        "  ethernets:",
        f"    {NIC}:",
        "      dhcp4: false",
        "      dhcp6: false",
        f'      addresses: ["{addr}/{plen}"]',
    ]
    if gateway:
        body.append(f"      gateway4: {gateway}")
    return "\n".join(body) + "\n"


# ── NetworkManager ──────────────────────────────────────

def nm_keyfile(addr, plen, gateway="", dns=()):
    body = [
        GENERATED,
        "[connection]",
        f"id=fnos-lxc-{NIC}",
        "type=ethernet",
        f"interface-name={NIC}",
        "autoconnect=true",
        "autoconnect-priority=100",
        "",
        "[ipv4]",
        "method=manual",
        f"address1={addr}/{plen}" + (f",{gateway}" if gateway else ""),
    ]
    if dns:
        body.append("dns=" + ";".join(dns) + ";")
    body += ["", "[ipv6]", "method=auto"]
    return "\n".join(body) + "\n"


# ── 文件层 ──────────────────────────────────────────────

def _read(path):
    try:
        with open(path, encoding="utf-8", errors="surrogateescape") as f:
            return f.read()
    except (FileNotFoundError, NotADirectoryError, IsADirectoryError, PermissionError):
        return None


def _write(path, text):
    """按原文件权限写回；文件不存在则 0644。"""
    mode = None
    try:
        mode = stat.S_IMODE(os.stat(path).st_mode)
    except OSError:
        pass
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(path, "w", encoding="utf-8", errors="surrogateescape") as f:
        f.write(text)
    if mode is not None:
        os.chmod(path, mode)


def _glob_under(rootfs, rel_dir, suffix=""):
    d = os.path.join(rootfs, rel_dir)
    if not os.path.isdir(d):
        return []
    return [os.path.join(d, n) for n in sorted(os.listdir(d))
            if os.path.isfile(os.path.join(d, n)) and n.endswith(suffix)]


def _ifupdown_files(rootfs):
    files = []
    main = os.path.join(rootfs, "etc/network/interfaces")
    if os.path.isfile(main):
        files.append(main)
    files += _glob_under(rootfs, "etc/network/interfaces.d")
    return files


def _networkd_files(rootfs):
    return _glob_under(rootfs, "etc/systemd/network", ".network")


def _netplan_files(rootfs):
    return _glob_under(rootfs, "etc/netplan", ".yaml")


def _has_eth0_iface(text):
    return any(_IFACE_ETH0.match(l) or _AUTO_ETH0.match(l) for l in text.splitlines())


def _networkd_matches_eth0(text):
    return re.search(r'^\s*Name\s*=\s*' + NIC + r'\s*$', text, re.M) is not None


def detect(rootfs):
    """返回容器内实际在用的网络后端名。"""
    if _netplan_files(rootfs):
        return "netplan"
    if any(_networkd_matches_eth0(_read(p) or "") for p in _networkd_files(rootfs)):
        return "networkd"
    if any(_has_eth0_iface(_read(p) or "") for p in _ifupdown_files(rootfs)):
        return "ifupdown"
    if os.path.isdir(os.path.join(rootfs, "etc/NetworkManager")):
        return "networkmanager"
    return "none"


def rootfs_of(container_dir):
    return os.path.join(container_dir, "rootfs")


def apply_static(rootfs, address, gateway=""):
    """把 eth0 配成静态地址（先撤销上一次的改动，保证幂等）。

    `address` 支持 "192.168.1.50" 或 "192.168.1.50/24"，默认 /24。
    返回 {"backend": str, "files": [...], "warnings": [...]}
    """
    iface = ipaddress.IPv4Interface(address if "/" in address else f"{address}/24")
    addr, plen = str(iface.ip), iface.network.prefixlen
    result = {"backend": detect(rootfs), "files": [], "warnings": []}

    # 幂等：先把自己上一次改的东西还原
    apply_dhcp(rootfs, _quiet=True)

    if result["backend"] in ("ifupdown", "none"):
        target = None
        for p in _ifupdown_files(rootfs):
            if _has_eth0_iface(_read(p) or ""):
                target = p
                break
        if target is None:
            main = os.path.join(rootfs, "etc/network/interfaces")
            if os.path.isfile(main):
                target = main
            else:
                # 落到 interfaces.d/ 时，主文件必须真的 source 过这个目录，
                # 否则我们的配置不会被读 —— 缺就补一行。
                target = os.path.join(rootfs, "etc/network/interfaces.d", "70-fnos-lxc")
                _write(main, "auto lo\niface lo inet loopback\n\nsource /etc/network/interfaces.d/*\n")
        text = _read(target) or ""
        _write(target, ifupdown_static(text, addr, plen, gateway))
        result["files"].append(os.path.relpath(target, rootfs))
        if result["backend"] == "none":
            result["backend"] = "ifupdown"   # 没有后端可用时，按 ifupdown 处理

    elif result["backend"] == "networkd":
        target = None
        for p in _networkd_files(rootfs):
            if _networkd_matches_eth0(_read(p) or ""):
                target = p
                break
        if target is None:
            target = os.path.join(rootfs, "etc/systemd/network", "70-fnos-lxc.network")
            _write(target, f"[Match]\nName={NIC}\n\n[Network]\n")
        text = _read(target) or ""
        _write(target, networkd_static(text, addr, plen, gateway))
        result["files"].append(os.path.relpath(target, rootfs))

    elif result["backend"] == "netplan":
        for p in _netplan_files(rootfs):
            text = _read(p) or ""
            new, hits = netplan_disable_dhcp(text)
            if hits:
                _write(p, new)
                result["files"].append(os.path.relpath(p, rootfs))
        dropin = os.path.join(rootfs, NETPLAN_DROPIN)
        _write(dropin, netplan_dropin(addr, plen, gateway))
        # netplan 要求配置文件权限不能太开，否则警告「Permissions ... too open」
        try:
            os.chmod(dropin, 0o600)
        except OSError:
            pass
        result["files"].append(NETPLAN_DROPIN)

    elif result["backend"] == "networkmanager":
        keyf = os.path.join(rootfs, NM_KEYFILE)
        _write(keyf, nm_keyfile(addr, plen, gateway))
        try:
            os.chmod(keyf, 0o600)
        except OSError:
            pass
        result["files"].append(NM_KEYFILE)

    return result


def apply_dhcp(rootfs, _quiet=False):
    """撤销我们做过的改动，让容器回到 DHCP 自己管。

    只删/还原带标记的东西，用户手写的配置一行不动。
    """
    result = {"backend": detect(rootfs), "files": [], "warnings": []}

    def _clean(path):
        text = _read(path)
        if text is None:
            return
        if is_generated(text):
            try:
                os.remove(path)
                result["files"].append(os.path.relpath(path, rootfs))
            except OSError:
                pass
            return
        new = strip(text)
        if new != text:
            if new.strip() == "":
                # 内容全是我们加的 —— 这文件本来就不存在，删掉
                try:
                    os.remove(path)
                    result["files"].append(os.path.relpath(path, rootfs))
                except OSError:
                    pass
                return
            _write(path, new)
            result["files"].append(os.path.relpath(path, rootfs))

    for p in _ifupdown_files(rootfs) + _networkd_files(rootfs) + _netplan_files(rootfs):
        _clean(p)
    for rel in (NETPLAN_DROPIN, NM_KEYFILE):
        p = os.path.join(rootfs, rel)
        if os.path.isfile(p):
            try:
                os.remove(p)
                result["files"].append(rel)
            except OSError:
                pass
    if not _quiet:
        result["files"] = sorted(set(result["files"]))
    return result
