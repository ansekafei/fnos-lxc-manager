# lxcmanager API 文档

> 依据源码逐条核对：后端 `server/fnlxc.py`（路由表 `setup_routes`，第 4684–4749 行），前端 `ui/app.js`（`ui/index.html` 只做静态骨架）。
> 生成时间：2026-11-18 ｜ 对应版本：3.2.7

---

## 1. 通用约定

| 项 | 值 |
|---|---|
| 网关前缀 | `/app/lxcmanager`（`server/fnlxc.py:77` 的 `GATEWAY_PREFIX`，可用环境变量覆盖） |
| 实际监听 | Unix socket，默认 `/run/lxcmanager/lxcmanager.sock`（旧名 `fnlxc.sock` 保留回退） |
| 数据格式 | 请求与响应均为 `application/json`（终端为 WebSocket） |
| 成功响应 | `{"success": true, "data": <任意>}`，部分写操作另带 `"message"` |
| 失败响应 | `{"success": false, "error": "<中文说明>"}`，同时带 HTTP 状态码 |
| 前端封装 | `lxc(url)` → `/app/lxcmanager/api/lxc` + url；`sys(url)` → `/app/lxcmanager/api` + url（`ui/app.js:2-3, 28-29`）。前端把 `success:false` 或非 2xx 一律抛异常 |

**关键状态码**

| 码 | 含义 |
|---|---|
| 200 | 成功 |
| 202 | 已接受，后台异步执行，需轮询 `.../progress` |
| 400 | 参数不合法（容器名、body 缺失等） |
| 404 | 容器 / 文件 / 资源不存在 |
| **423** | **配置文件被 LXC 运行期锁定**（权限 0000），响应带 `locked: true`；前端据此显示"停止容器后可编辑" |
| 500 | 后端执行异常 |

---

## 2. 后端全部接口（49 条注册，48 条唯一，其中 1 条重复注册）

"前端"列：✅ 表示有实际调用；⛔ 表示无任何调用；🖥 表示只由框架/浏览器直连（非 app.js 调用）。

### 2.1 容器列表与信息

| 方法 | 路径 | 参数 | 说明 | 前端 |
|---|---|---|---|---|
| GET | `/api/lxc/list` | — | 全部容器：`name/state/ips/ipv4/ipv6/pid/autostart/os/release/memory_used/memory_limit/cpu_usage/snapshots…`。内部走 `lxc-ls --fancy` + 逐容器读 config 与 cgroup | ✅ `loadContainers` `refreshContainers` |
| GET | `/api/lxc/{name}` | — | 单个容器对象（从 list 结果里筛出，字段同 list） | ✅ `pollContainerIP` 轮询 IP |
| GET | `/api/lxc/{name}/info` | — | 详细运行态：CPU%、内存、磁盘、进程数、网络接口、IP 等，并合并 config 里的 metadata | ✅ 概览 / 设置 / 资源 / 网络 四处 |
| GET | `/api/stats` | — | 全局统计：`total/running/stopped/frozen/snapshots/backups/lxc_version/lxc_path` | ✅ `loadDashboard` |
| GET | `/api/version` | — | `{version}`，前端用于页脚/关于 | ✅ `setupRefreshTriggers` 内初始化 |
| GET | `/api/health` | — | `{status:"healthy", version}`，供 fnOS 框架 `class=check` 探活 | 🖥 框架调用 |
| GET | `/api/logs` | — | 服务日志文本（支持轮转文件回退） | ✅ `loadLogs` |
| GET | `/api/first-run` | — | `{first_run: bool}`。配置存在或 `LXC_PATH` 下有普通容器目录即为 false | ✅ 启动时判断是否弹向导 |

### 2.2 生命周期动作

| 方法 | 路径 | 参数 | 说明 | 前端 |
|---|---|---|---|---|
| POST | `/api/lxc/{name}/{action}` | — | **通用动作入口**，白名单：`start` `stop` `restart` `freeze` `unfreeze` `kill` `snapshot` `exec`。`snapshot` 转交快照处理器 | ✅ `act`（启停/重启/冻结） |
| POST | `/api/lxc/{name}/exec` | `{cmd: string \| string[]}` | 无独立路由，由上面的通用入口处理（`server/fnlxc.py:2722`）。数组模式逐参数校验，字符串模式按空白切分；带危险命令黑名单（`sudo/su/ssh/chmod/wget/curl/nc…`）。返回 `{stdout,stderr,code}` | ✅ `execCommand`（容器内快速执行） |
| DELETE | `/api/lxc/{name}` | `?force=true` | 删除容器，`force` 跳过运行中检查 | ✅ `delContainer` |
| POST | `/api/lxc/{name}/migrate` | — | 迁移，**当前实现直接返回 410 并提示改用备份+恢复**（功能未启用） | ✅ `openMigrateModal`（调用后即提示不可用） |
| GET | `/api/lxc/{name}/terminal` | — | WebSocket 升级，容器内交互式 shell。前端直接 `new WebSocket('/app/lxcmanager/api/lxc/<name>/terminal')`，不走 `lxc()` | 🖥 `ui/app.js:510` |

### 2.3 配置与资源

| 方法 | 路径 | 参数 | 说明 | 前端 |
|---|---|---|---|---|
| GET | `/api/lxc/{name}/config` | — | 原始 config 行数组（`data: ["lxc.xxx = yyy", …]`）。文件存在但读不到 → **423 `{locked:true}`**；不存在 → 404 | ✅ 网络页读网络模式、设置页回读真实 cgroup 值 |
| PUT | `/api/lxc/{name}/config` | `{updates: {key: value}}` | 按 key 覆盖写入，不存在的 key 追加。`lxc.net.0.type=macvlan` 时后端自动解析父接口。**已移除安全敏感键黑名单**（3.2.5 起可改 `lxc.rootfs.path`） | ✅ `saveConfig` `setNetworkMode` |
| PUT | `/api/lxc/{name}/limits` | `{cpu, memory}` | `cpu` 支持数字（`"2"` → `cgroup2.cpu.max = 200000 100000` + `cpuset.cpus=0-1`）或 cpuset 形式（`"0-3"` / `"0,2"`）；`memory` 单位 MB → `cgroup2.memory.max = <N>M` | ✅ `saveLimits` |
| PUT | `/api/lxc/{name}/description` | `{description}` | 写 config 注释块里的描述 | ✅ `saveMetaDesc` |
| DELETE | `/api/lxc/{name}/description` | — | 删除描述 | ✅ `delMetaDesc` |
| PUT | `/api/lxc/{name}/autostart` | `{autostart}` | 写 `lxc.start.auto` | ✅ `saveMetaAutostart` |
| PUT | `/api/lxc/{name}/order` | `{order}` | 写 `lxc.start.order` | ✅ `saveMetaOrder` |
| PUT | `/api/lxc/{name}/mac` | `{mac}` | 改 `lxc.net.0.hwaddr` | ✅ `saveMetaMac` |

### 2.4 快照

| 方法 | 路径 | 参数 | 说明 | 前端 |
|---|---|---|---|---|
| GET | `/api/lxc/{name}/snapshots` | — | 快照列表（名称 + 时间） | ✅ 数据页 `renderDetailData`/`renderDetailSnapshots` |
| POST | `/api/lxc/{name}/snapshot` | `{snapshot_name}` | 创建快照 | ✅ `createSnapshot` |
| DELETE | `/api/lxc/{name}/snapshot/{snap}` | — | 删除快照 | ✅ `deleteSnapshot` |
| POST | `/api/lxc/{name}/snapshot/{snap}/restore` | — | 回滚到快照 | ✅ `restoreSnapshot` |

### 2.5 备份

| 方法 | 路径 | 参数 | 说明 | 前端 |
|---|---|---|---|---|
| GET | `/api/lxc/{name}/backups` | — | 该容器的备份文件列表（名称/大小/时间） | ✅ 数据页、概览"最近备份" |
| POST | `/api/lxc/{name}/backup` | — | 后台打包（xz，见设置里的压缩等级/线程），立即返回，前端开始轮询进度 | ✅ `createBackup` |
| GET | `/api/lxc/{name}/backup/progress` | — | `{percent, message, done}` | ✅ `startBackupPoll` |
| DELETE | `/api/lxc/{name}/backup/{file}` | — | 删除备份文件 | ✅ `deleteBackup` |
| POST | `/api/lxc/{name}/backup/{file}/restore` | `{newname}` | 从备份恢复。**202 + 后台任务** | ✅ `restoreBackup` |
| GET | `/api/lxc/{name}/restore/{file}/progress` | — | 恢复进度（读任务文件） | ✅ `startRestorePoll` |
| GET | `/api/backups` | — | 全局备份清单，按容器分组；不依赖源容器是否存在（用于"从备份创建"） | ✅ `loadBackupList` |

### 2.6 创建容器

| 方法 | 路径 | 参数 | 说明 | 前端 |
|---|---|---|---|---|
| POST | `/api/lxc/create` | `{name, template, release, arch}` | 走官方 lxc-download + 镜像源创建 | ✅ `handleCreateFromTemplate` |
| POST | `/api/lxc/create/copy` | `{name, source, network_type}` | 子卷克隆 | ✅ `handleClone` |
| POST | `/api/lxc/create/from-snapshot` | `{name, source, snapshot, network_type}` | 从快照建新容器 | ✅ `handleCreateFromSnapshot` |
| POST | `/api/lxc/create/from-backup` | `{name, backup_name, network_type}` | 从备份建新容器（后台任务） | ✅ `handleCreateFromBackup` |
| GET | `/api/lxc/create/{name}/progress` | — | 上述后台创建的进度 | ✅ `startRestorePoll`（同函数按类型拼 URL） |
| POST | `/api/lxc/create/from-proxmox` | `{name, template_file, autostart, unprivileged}` | 从已缓存的 Proxmox 模板建容器 | ✅ `handleCreateFromLocal` |

### 2.7 模板源

| 方法 | 路径 | 参数 | 说明 | 前端 |
|---|---|---|---|---|
| GET | `/api/lxc/templates` | — | 可用模板（官方 distro 列表） | ✅ `refreshTemplateSelect` `loadTemplates` |
| GET | `/api/lxc/templates/{distro}/versions` | — | 某发行版的版本/架构矩阵 | ✅ `handleTemplateChange` `openVersionsModal` |
| GET | `/api/templates/proxmox` | — | 从清华源拉 Proxmox 模板清单（联网） | ✅ `loadProxmoxTemplates` |
| POST | `/api/templates/proxmox/download` | `{url, file}` | 下载模板到 `cache_dir` | ✅ `downloadProxmoxTemplate` |
| GET | `/api/templates/cached` | — | 已缓存的本地模板文件 | ✅ `loadCachedTemplates` `createFromProxmox` `refreshLocalTemplateSelect` |
| POST | `/api/lxc/cache/fetch` | `{distro, release, arch}` | **后端不存在此路由** —— 见第 4 节 | ⚠️ `downloadVersion` 调用会失败 |

### 2.8 系统与设置

| 方法 | 路径 | 参数 | 说明 | 前端 |
|---|---|---|---|---|
| GET | `/api/settings` | — | 全量设置，见下表字段 | ✅ `loadSettings` |
| PUT | `/api/settings` | 任意设置字段 | 保存；`zfs_pool` 为空时按 `lxc_path` 所在文件系统自动识别（btrfs 才启用快照），换卷会清理旧数据集；保存后重建目录并刷新全局路径 | ✅ `handleSaveSettings` `handleSaveWizardSettings` |
| DELETE | `/api/settings` | — | 恢复出厂：停容器 → 删配置 → 下次启动进向导 | ✅ `factoryReset` |
| GET | `/api/zfs/pools` | — | 返回 **btrfs 存储卷**列表（含挂载点与容量）。接口名沿用 `zfs/pools`，实际是 btrfs 子卷，前端无需改 | ✅ 迁移弹窗、设置页、向导 |
| GET | `/api/interfaces` | — | 宿主网卡列表（名称/MAC/状态） | ✅ 网络模式选择、设置页、仪表盘 |
| GET | `/api/cpus` | — | 宿主 CPU 核心数 | ✅ `loadDashboard` |

**设置字段（`DEFAULT_SETTINGS`，`server/fnlxc.py:958`）**

| 字段 | 默认值 | 说明 |
|---|---|---|
| `lxc_path` / `default_path` | `/vol1/1000/lxc` | 容器存储目录 |
| `zfs_pool` | 自动识别 | btrfs 卷名；空则不启用快照 |
| `backup_path` | `/vol1/1000/lxc/bak` | 备份目录 |
| `cache_dir` | `/vol1/1000/lxc/template` | 模板缓存目录 |
| `backup_keep` / `backup_max_per_container` | `7` / `5` | 保留份数 |
| `backup_compression` / `backup_threads` | `6` / `4` | xz 压缩等级与线程 |
| `backup_use_snapshot` | `false` | 备份前是否先打快照 |
| `lxc_mirror` | 清华 lxc-images | 镜像源 |
| `stop_timeout` | `180` | 停止超时秒数 |
| `network_type` | `lxcbr0` | 默认网络模式 |
| `default_interface` | 空 | 默认桥接网卡 |

---

## 3. 前端实际调用（按功能分组，共 69 处调用点）

| 前端函数（`ui/app.js`） | 接口 | 用途 |
|---|---|---|
| `loadDashboard` | `GET /stats`、`GET /cpus`、`GET /interfaces` | 仪表盘汇总卡 |
| `loadContainers` / `refreshContainers` | `GET /api/lxc/list` | 左侧列表 + 自动选中 |
| `pollContainerIP` | `GET /api/lxc/{name}` | 新建后轮询直到拿到 IP（2s × 30 次） |
| `act` | `POST /api/lxc/{name}/{action}` | 启停、重启、冻结、解冻、强杀 |
| `execCommand` | `POST /api/lxc/{name}/exec` | 容器内执行单条命令 |
| `delContainer` | `DELETE /api/lxc/{name}?force=true` | 删除 |
| `renderDetailInfo` | `GET .../info`、`GET .../backups` | 概览（最近备份摘要） |
| `renderDetailSettings` | `GET .../info`、`GET .../config` | 设置页；**config 用于回读真实 cgroup 限制** |
| `saveConfig` | `PUT .../config` | 原始配置编辑 |
| `renderDetailNetwork` / `setNetworkMode` | `GET .../info`、`GET/PUT .../config`、`GET /interfaces` | 网络页 |
| `renderDetailLimits` / `saveLimits` | `GET .../info`、`PUT .../limits` | CPU/内存数字输入 |
| `saveMetaDesc` / `delMetaDesc` / `saveMetaAutostart` / `saveMetaOrder` / `saveMetaMac` | `PUT/DELETE .../description`、`PUT .../autostart`、`.../order`、`.../mac` | 元数据 |
| `renderDetailData` / `renderDetailSnapshots` / `renderDetailBackups` | `GET .../snapshots`、`GET .../backups` | 数据页（按时间合并展示） |
| `createSnapshot` / `deleteSnapshot` / `restoreSnapshot` | `POST .../snapshot`、`DELETE .../snapshot/{s}`、`POST .../snapshot/{s}/restore` | 快照 |
| `createBackup` / `startBackupPoll` / `deleteBackup` / `restoreBackup` / `startRestorePoll` | `POST .../backup`、`GET .../backup/progress`、`DELETE .../backup/{f}`、`POST .../backup/{f}/restore`、`GET .../restore/{f}/progress` | 备份与恢复 |
| `loadBackupList` | `GET /backups` | 从备份创建时的选择列表 |
| `refreshTemplateSelect` / `loadTemplates` | `GET /api/lxc/templates` | 创建表单模板下拉 |
| `handleTemplateChange` / `openVersionsModal` | `GET /api/lxc/templates/{distro}/versions` | 版本矩阵 |
| `handleCreateFromTemplate` | `POST /api/lxc/create` | 官方模板创建 |
| `handleClone` | `POST /api/lxc/create/copy` | 克隆 |
| `handleCreateFromSnapshot` | `POST /api/lxc/create/from-snapshot` | 从快照创建 |
| `handleCreateFromBackup` | `POST /api/lxc/create/from-backup` | 从备份创建 |
| `loadProxmoxTemplates` / `downloadProxmoxTemplate` | `GET /api/templates/proxmox`、`POST .../download` | PVE 模板源 |
| `loadCachedTemplates` / `createFromProxmox` / `refreshLocalTemplateSelect` / `handleCreateFromLocal` | `GET /api/templates/cached`、`POST /api/lxc/create/from-proxmox` | 本地模板 |
| `loadSettings` / `handleSaveSettings` / `handleSaveWizardSettings` / `factoryReset` | `GET/PUT/DELETE /api/settings` | 设置与向导 |
| `loadWizardPools` / `openMigrateModal` | `GET /api/zfs/pools` | 存储卷选择 |
| `loadLogs` | `GET /api/logs` | 日志页 |
| `setupRefreshTriggers` | `GET /api/first-run`、`GET /api/version` | 启动初始化 |
| `openTerminal`（`ui/app.js:510`） | `WS /api/lxc/{name}/terminal` | 交互式终端 |

---

## 4. 对照结论：不一致的地方

### 4.1 前端调用了、后端没有 ⚠️（真实缺陷）

**`POST /api/lxc/cache/fetch`** —— `downloadVersion()`（`ui/app.js:1688`）用它下载 `distro/release/arch` 模板。

后端 `setup_routes` 没有这条路由，请求会落到通用入口 `POST /api/lxc/{name}/{action}`，被解析成 `name="cache"`、`action="fetch"`；`cache` 不是合法容器名，`fetch` 也不在动作白名单里，因此**必然失败**。

影响面：目前"版本"弹窗里的下载按钮会报错。不过该入口本身已半废弃 —— `createFromVersion()` 已改成提示"请使用本地模板或工具栏创建"（`ui/app.js:1678`）。

处理选项（择一）：
1. 删掉 `downloadVersion()` 与版本弹窗里的下载按钮（最省事，与现有交互一致）；
2. 后端补 `POST /api/lxc/cache/fetch`，转调 `handle_proxmox_download` 那套下载逻辑，真正支持按 distro/version 预下载到 `cache_dir`。

### 4.2 后端有、前端完全没用 ⛔

| 接口 | 说明 |
|---|---|
| `GET /api/health` | 只给 fnOS 框架 `class=check` 探活用，正常 |

除此之外**没有死接口** —— 48 条唯一路由里只有 `/api/health` 不对应前端功能（框架探活）；`/api/lxc/{name}/terminal` 由浏览器直连 WebSocket，`/api/lxc/{name}/{action}` 与 `/{name}/exec` 共用通用入口（exec 不是独立路由）。

### 4.3 路由注册冗余

- `POST /api/lxc/create/from-backup` **注册了两次**（`server/fnlxc.py:4698` 与 `:4712`），指向同一 handler。aiohttp 后者覆盖前者，行为无害，但属重复，建议删掉 `:4712` 那行。
- `{name}/{action}` 是**顺序敏感**路由：必须排在所有具体 `/{name}/xxx` 之后，否则会吞掉 `snapshot`、`exec`、`terminal` 等。现有顺序正确，但改动路由表时极易踩坑，已在代码里留有注释提醒。

### 4.4 命名遗留

- `/api/zfs/pools` 实际返回 **btrfs 子卷**（本项目不用 ZFS），接口名沿用旧名以免前端改动；文档与 UI 中已统一表述为"存储卷"。
- 存储能力判定靠 `fs_type_of(lxc_path)`：非 btrfs 时快照/备份能力关闭，`zfs_pool` 置空。

---

## 5. 维护约定

1. **改路由表必须同时改本文档**：`setup_routes` 与本文件的第 2 节要一一对应。
2. 新增 `/{name}/xxx` 类接口，务必插在通用 `{action}` 路由**之前**。
3. 前端新增调用请在本文档第 3 节登记，注明调用函数，便于后续排查"接口存在但没人用"。
4. 返回 423 的接口（`config` 读取/更新、`limits`）前端必须处理 `locked`，提示"停止容器后可编辑"。
