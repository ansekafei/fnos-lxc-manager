# LXC Manager — 飞牛 OS LXC 容器管理器

AI开发构建的飞牛 fnOS 上的 LXC 容器图形化管理应用。容器生命周期管理、模板选择、快照、备份、终端等功能，**不依赖 ZFS**——容器存储在 btrfs 子卷上（LXC dir 后端），无 btrfs 时退化为普通目录（容器照常跑，快照/克隆/备份不可用）。

希望能为大佬提供灵感，开发功能、UI都更好的lxc管理应用。
---

## 目录结构

```
fnos-lxc-manager/
├── build.sh                  # 构建脚本（读 manifest 生成 app.tgz/checksum，打包 .fpk）
├── build-fnpack.sh           # 官方 fnpack 打包脚本（结构对齐 developer.fnnas.com）
├── manifest                  # 应用元数据（appname=lxcmanager / version）
├── ui/
│   ├── index.html            # 单页应用入口
│   ├── app.js                # 前端逻辑（约 2100 行）
│   ├── style.css             # 深色主题样式（约 1300 行）
│   └── config                # 前端配置（gatewaySocket / 桌面入口）
├── server/
│   ├── fnlxc.py              # Python aiohttp 后端（约 4800 行）
│   └── fnlxc_server          # 后端启动包装脚本
├── mcp/
│   └── fnlxc_mcp.py          # 零依赖 stdio MCP Server（14 个工具）
├── templates/
│   └── lxc-local             # 本地模板（从缓存 rootfs.tar.xz 创建）
├── wizard/                   # 安装/卸载向导
│   ├── install
│   └── uninstall
├── config/
│   ├── privilege             # 运行权限声明
│   └── resource              # 路径/设备资源声明
├── cmd/                      # 应用中心钩子（只有 9 个标准钩子）
│   ├── main                  # 服务管理器（启动/停止/重启/查询）
│   ├── install_init          # 安装前检查（LXC 检测、sysctl）
│   ├── install_callback      # 安装后初始化（用户、sudoers、模板、向导）
│   ├── config_init           # 配置页入口
│   ├── config_callback       # 配置保存回调
│   ├── upgrade_init          # 升级前清理（停进程、清 socket）
│   ├── upgrade_callback      # 升级后处理
│   ├── uninstall_init        # 卸载确认向导
│   └── uninstall_callback    # 卸载清理（可选删除 LXC / 数据）
├── scripts/
│   └── update.sh             # 本地第三方包升级辅助脚本（绕过应用中心限制）
├── docs/
│   └── 与原版的差异.md
├── ICON.PNG / ICON_256.PNG   # 应用图标
├── LICENSE                   # MIT
├── PLAN.md / API_DESIGN.md   # 设计与接口文档
└── README.md
```

---

## 版本与标识约定

| 项 | 取值 | 说明 |
|---|---|---|
| 应用标识 `appname` | `lxcmanager` | `manifest`、`ui/config`、桌面入口 `lxcmanager.Application` 统一 |
| 应用版本 | `3.1.9` | 以 `manifest` 的 `version` 与后端 `APP_VERSION` 为准，两处必须同步修改 |
| 后端 socket | `lxcmanager.sock` | 主程序、`cmd/main`、`server/fnlxc_server`、MCP 探测一致 |
| 网关前缀 | `/app/lxcmanager/api/...` | 前端 `API` 常量与后端路由注册一致 |
| 兼容项 | `fnlxc` / `fnlxc.sock` / `/var/apps/fnlxc` | 仅作为旧版本回退与残留清理保留，不作为新默认 |

> 历史命名：仓库名、后端文件名（`server/fnlxc.py`、`mcp/fnlxc_mcp.py`）沿用 `fnlxc` 是为了兼容既有部署与 MCP 工具名，内部实现与对外标识已统一到 `lxcmanager`。
> 升级时请同时更新 `manifest` 的 `version` 与 `server/fnlxc.py` 的 `APP_VERSION`，否则应用中心显示的版本与 `/api/health` 返回的版本会不一致。

## 功能模块

### 仪表盘
- **容器统计卡片**：运行中 / 已停止 / 冻结 / 总数，点击跳转对应筛选视图
- **快捷操作**：批量启动、批量停止、批量删除
- **最近容器**：最新 5 个容器状态一览

### 容器管理
- 列表展示（名称、状态、IP、镜像、CPU、内存、快照数）
- 筛选：全部 / 运行中 / 已停止 / 冻结
- 批量操作：批量启动、停止、删除
- 卡片展示容器 IP、流量（rx/tx）

### 容器详情
- **信息**：容器配置项实时读取（IP、状态、镜像、创建时间等）
- **元数据**：描述、WEB-UI 地址、自启动、MAC 地址、排序号
- **配置**：LXC 配置文件在线编辑
- **快照**：创建快照、恢复快照、删除快照、从快照克隆
- **备份**：创建备份、恢复备份、删除备份
- **网络**：查看/修改网络类型（bridge / NAT / OVS / none）、静态 IP、网关、DNS、VLAN、MTU

### 创建容器（5种来源）
1. **模板创建**：选择发行版（debian/ubuntu/alpine/centos/gentoo/gentoo-current）→ 选版本 → 选架构（amd64/i386/arm64）→ 下载镜像 → 创建
2. **本地/已缓存镜像创建**：直接使用本地缓存或上传的 rootfs
3. **克隆**：从现有容器克隆（btrfs CoW）
4. **从快照创建**：从已有快照创建新容器
5. **从备份恢复**：从 `.zfs.xz` 备份恢复（历史后缀，内容是 btrfs send 流）

此外还支持从 **Proxmox 模板清单**（`/api/templates/proxmox`）下载后创建。

### 模板页面
- **系统模板**：从清华镜像源 `https://mirrors.tuna.tsinghua.edu.cn/lxc-images` 获取 lxc-download 支持的发行版列表
- **版本选择**：选完发行版后弹出 Modal 显示所有 amd64 版本（build 号）
- **下载**：调用 lxc-download 模板下载镜像到 `/var/cache/lxc/download/`
- **本地镜像**：扫描本地缓存目录，显示已下载镜像（发行版/版本/架构/大小），支持"创建容器"和"删除"按钮

### 终端
- 点击容器"终端"按钮通过 WebSocket 发送 lxc-attach 命令
- 支持交互式输入（stdin/stdout）
- lxc-sshd 类型容器（rootfs 为空）不支持 lxc-attach，需通过 SSH 连接

### 设置
- 镜像源 URL（默认：`https://mirrors.tuna.tsinghua.edu.cn/lxc-images`）
- 默认网络接口
- 容器默认存储路径
- 备份路径、压缩级别、线程数

---

## 架构

### 前端
- 纯原生 HTML/CSS/JS（无框架依赖）
- 深色专业主题（`--bg-root: #0a0e1a`）
- 导航栏 sticky 固定（滚动时不动）

### 后端
- **Python aiohttp** + Unix Domain Socket （默认 `/var/apps/lxcmanager/lxcmanager.sock`）
- socket 名固定为 `lxcmanager.sock`，完整路径由 `TRIM_SERVICE_SOCKET` 环境变量决定（未设置时回退到安装目录）
- 所有 LXC 操作通过 `lxc-*` 命令行工具调用
- LXC 缓存镜像：`/var/cache/lxc/download/`

### LXC 集成
- 使用系统 `lxc-download` 模板（已 patch）连接清华镜像源
- 支持 nesting 和 lxc-sshd 容器
- 快照命名：`snap0`, `snap1`, ... （lxc-snapshot 自动生成）
- 备份格式：`<时间戳>_<容器名>.zfs.xz`（`btrfs send | xz`，后缀沿用历史命名）

### 安全模型
- **降权运行**：后端进程以专用 `lxc` 系统用户运行，非 root
- **sudo 白名单**：`lxc` 用户通过 `/etc/sudoers.d/lxc` 仅被授权 NOPASSWD 执行 18 条 `lxc-*` 命令
- **ACL 授权**：数据目录 `/var/lib/lxc` 通过 ACL 向 `lxc` 组开放读写权限
- **自动创建**：安装向导自动创建 `lxc` 用户/组和 sudoers 配置，卸载时彻底清理

---

## API 参考

所有路由同时注册两份：裸路径 `/api/...` 与网关前缀 `/app/lxcmanager/api/...`。前端统一走后者。

### 容器
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/lxc/list` | 容器列表（含动态统计） |
| GET | `/api/lxc/{name}` | 容器详情 |
| GET | `/api/lxc/{name}/info` | lxc-info 原始输出 |
| POST | `/api/lxc/{name}/start` `stop` `restart` `freeze` `unfreeze` `kill` | 状态操作（通用 `{action}` 路由） |
| DELETE | `/api/lxc/{name}` | 销毁容器 |
| GET / PUT | `/api/lxc/{name}/config` | 读取 / 更新 LXC 配置 |
| POST | `/api/lxc/{name}/migrate` | 迁移到其他存储卷 |
| PUT | `/api/lxc/{name}/description` | 设置描述 |
| DELETE | `/api/lxc/{name}/description` | 删除描述 |
| PUT | `/api/lxc/{name}/autostart` | 自启动开关 |
| PUT | `/api/lxc/{name}/mac` | 固定 MAC |
| PUT | `/api/lxc/{name}/order` | 排序号 |
| PUT | `/api/lxc/{name}/limits` | CPU/内存/Swap 限制 |
| GET | `/api/lxc/{name}/terminal` | Web 终端（WebSocket upgrade） |

### 创建
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/lxc/create` | 从模板创建 |
| POST | `/api/lxc/create/copy` | 克隆容器 |
| POST | `/api/lxc/create/from-snapshot` | 从快照创建 |
| POST | `/api/lxc/create/from-backup` | 从备份恢复为新容器 |
| POST | `/api/lxc/create/from-proxmox` | 从 Proxmox 模板创建 |
| GET | `/api/lxc/create/{name}/progress` | 创建进度轮询 |

### 快照 / 备份
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/lxc/{name}/snapshots` | 快照列表 |
| POST | `/api/lxc/{name}/snapshot` | 创建快照 |
| POST | `/api/lxc/{name}/snapshot/{snap}/restore` | 恢复快照 |
| DELETE | `/api/lxc/{name}/snapshot/{snap}` | 删除快照 |
| GET | `/api/lxc/{name}/backups` | 备份列表 |
| POST | `/api/lxc/{name}/backup` | 创建备份 |
| GET | `/api/lxc/{name}/backup/progress` | 备份进度 |
| POST | `/api/lxc/{name}/backup/{file}/restore` | 恢复备份 |
| GET | `/api/lxc/{name}/restore/{file}/progress` | 恢复进度 |
| DELETE | `/api/lxc/{name}/backup/{file}` | 删除备份 |
| GET | `/api/backups` | 全量备份列表 |

### 模板
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/lxc/templates` | 可用发行版列表 |
| GET | `/api/lxc/templates/{distro}/versions` | 某发行版版本列表 |
| GET | `/api/templates/proxmox` | Proxmox 模板清单 |
| POST | `/api/templates/proxmox/download` | 下载 Proxmox 模板 |
| GET | `/api/templates/cached` | 本地已缓存镜像 |

### 系统
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/version` | 后端版本（与 `manifest` 的 `version` 一致） |
| GET | `/api/health` | 健康检查 |
| GET | `/api/stats` | 系统统计 |
| GET | `/api/interfaces` | 网络接口列表 |
| GET | `/api/cpus` | CPU 信息 |
| GET | `/api/settings` | 读取设置 |
| PUT | `/api/settings` | 保存设置 |
| DELETE | `/api/settings` | 恢复默认（清空配置） |
| GET | `/api/first-run` | 是否首次运行 |
| GET | `/api/logs` | 运行日志 |
| GET | `/api/zfs/pools` | 存储卷列表（历史命名，实际为 btrfs 卷） |

## 存储后端（btrfs 子卷，无需 ZFS）

本版本移除了对 ZFS 的强制依赖，改用 **LXC dir 后端 + btrfs 子卷**：

```
{LXC_PATH}/{name}/                      容器目录
{LXC_PATH}/{name}/rootfs                 rootfs 子卷（可写）→ lxc.rootfs.path = dir:<绝对路径>
{LXC_PATH}/{name}/.snapshots/{snap}      快照子卷（只读）
```

| 功能 | 实现 |
|------|------|
| 创建容器 | `btrfs subvolume create` + 下载模板后 rsync 进子卷 |
| 快照 | `btrfs subvolume snapshot -r` |
| 回滚 | 删 rootfs 子卷 → 从快照 `snapshot` 出新可写子卷（快照保留，可重复恢复） |
| 克隆 | `btrfs subvolume snapshot`（可写，CoW） |
| 备份 | `btrfs send <snap> | xz`，文件名沿用 `.zfs.xz` 后缀 |
| 恢复 | `xz -dc | btrfs receive <staging>` → rename 成 rootfs |

要求：`LXC_PATH`（如 `/vol1/lxc`）必须落在 btrfs 文件系统上。非 btrfs 时容器仍可创建/启动，但快照、克隆、备份接口会返回明确错误提示。

> 提示：`/api/zfs/pools` 接口路径与 `zfs_pool` 字段名保留未变（前端兼容），实际返回的是 btrfs 存储卷列表。

## MCP 工具（可选）

包内自带 `mcp/fnlxc_mcp.py`（零依赖 stdio MCP server，14 个工具），安装后位于 `<APP_ROOT>/mcp/fnlxc_mcp.py`（`<APP_ROOT>` 通常为 `/var/apps/lxcmanager`）。

socket 探测顺序：`FNLXC_SOCKET` → `lxcmanager.sock` 各处常见路径 → 旧版 `fnlxc.sock`（向后兼容）。
它通过 FnLxc 的 Unix socket 调用后端 API，因此模型侧不需要 root、不需要碰 LXC 命令。

在 DSH profile（`cordis.patch.yml`）里加一条即可注册：

```yaml
- id: mcp-fnlxc
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: fnlxc
    transport: stdio
    command: /usr/bin/python3
    args:
      - /var/apps/lxcmanager/mcp/fnlxc_mcp.py
```

工具清单：`fnlxc_health`、`fnlxc_storage`、`fnlxc_settings`、`lxc_list`、`lxc_info`、
`lxc_control`（start/stop/restart/freeze/unfreeze/kill）、`lxc_exec`、`lxc_config_get`、
`lxc_config_set`、`lxc_snapshot`、`lxc_backup`、`lxc_create`、`lxc_delete`、`fnlxc_logs`。

自检：`python3 mcp/fnlxc_mcp.py --selftest`（打印 socket 探测结果与工具列表）。

## 应用中心升级兼容性（踩坑记录）

飞牛应用中心对第三方 fpk 的升级有若干未写进文档的硬要求，以下是实测结论。

### 1. `desktop_applaunchname` 必须是 `<appname>.Application`

```
对   desktop_applaunchname = lxcmanager.Application
错   desktop_applaunchname = lxcmanager.APPLICATION
```

写成全大写 `APPLICATION` 时，应用中心按 `<appname>.Application` 匹配桌面入口会失败，
拿到 nil 后在 `appenvs.New` 解引用 panic，表现为 `check` 任务每 30 秒崩一次。
而 `check` 是所有操作（更新/卸载/重启）的前置，所以看起来「什么都报服务异常」。
`ui/config` 里 `.url` 的 key 必须与它一致。

### 2. 应用标识（appname）一旦残留脏状态，只能换名

实测：同样的包内容、同样的结构，`appname = fnlxc` 升级必崩
（`InstallFileToDisk` at `operation.go:338`），改成 `appname = lxcmanager` 后一次通过。
数据库层（`app` / `app_service` / `app_open` / `app_shortcut` / `app_package`）
逐字段对比过，清空过全部六类目录（`@appcenter/@appconf/@appdata/@apphome/@apptemp/@appmeta`），
仍然崩 —— 残留标记在应用中心内部存储里，不在 PostgreSQL 的 `appcenter` 库里。

结论：**换一个全新的 appname 是唯一可靠的解法**，不要试图修旧标识。

### 3. 打包方式

`app/` 目录打成 `app.tgz`，根目录的 `cmd/ config/ wizard/ ICON.PNG ICON_256.PNG manifest`
直接进包；`manifest` 的 `checksum` 必须是 `app.tgz` 的 MD5。
`cmd/` 只保留 9 个标准钩子（install_init、install_callback、upgrade_init、upgrade_callback、
uninstall_init、uninstall_callback、config_init、config_callback、main），多余的辅助脚本会触发校验失败。
`wizard/` 可以省略；若保留，tips 项必须用 `helpText` 字段（写 `label` 会被拒：`wizard tips helpText is empty`）。

构建：`bash build.sh`（或 `bash build-fnpack.sh`）→ `dist/lxcmanager-<version>.fpk`，版本号取自 `manifest`。

---

## 上游与致谢

本项目 fork 自 [mg6630/fnos-lxc](https://github.com/mg6630/fnos-lxc)，遵循 MIT 协议。
原项目提供了飞牛 fnOS 上 LXC 图形管理器的完整骨架，本项目在其基础上做了以下改造：

| 改造项 | 说明 |
|---|---|
| 存储后端 | 移除强制 ZFS 依赖，改用 **btrfs 子卷 + LXC dir 后端**；无 btrfs 时退化为普通目录 |
| 网络 | 改用 LXC 原生 OVS 支持（`veth` + OVS 桥自动 `add-port`），不再需要 hook |
| 地址配置 | 支持静态 IPv4/IPv6、固定 MAC、VLAN Tag、MTU |
| 容器访问 | 支持设置 Root 密码、注入 SSH 公钥、环境变量 |
| 创建向导 | 对齐 PVE 创建 CT 的流程：资源限制（内存/Swap/CPU）、DNS |
| 界面 | 亮色/深色主题切换、卡片式模板列表、铺满式日志页 |
| 应用中心兼容 | 修复 `appname` / `desktop_applaunchname` / `config/privilege` 导致的升级崩溃 |

上游版权归 mg6630 所有，本项目的修改部分版权归 ansekafei 所有，均以 MIT 协议发布。
