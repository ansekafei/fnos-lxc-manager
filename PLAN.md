# FnLxc — 全面功能实现计划

## 已实现 ✅
- 容器列表/详情/启停/重启/冻结/销毁
- 容器创建（从模板）
- 快照管理（创建/恢复）
- 配置文件查看/编辑
- 模板列表
- 后端 unix socket + 静态文件服务

## 本期新增 🆕 (模板缓存方案)
### 核心改动
- **lxc-fetch** — 镜像下载器，从 linuxcontainers.org 下载 rootfs.tar.xz 到本地缓存
- **lxc-local** — 自定义 LXC 模板脚本，读取本地缓存解压到容器
- **两条路径分离**：
  - 模板缓存路径：`LXC_TEMPLATE_CACHE_PATH`（默认 `/var/cache/lxc/images`）
  - 容器运行路径：`LXC_PATH`（默认 `/var/lib/lxc`）
- 创建容器流程：`lxc-fetch` 预热 → `lxc-create -t local` 解压，不走 AppArmor 拦截的网络下载
- 前端模板列表显示 ✅已缓存 / 💾点击下载 状态
- 后端新增 API：`/api/cache/list`、`/api/cache/fetch`、`/api/cache/warm`

### 后端 API（20+ 新端点）
- 容器克隆（lxc-copy）
- 从快照/备份创建容器
- 元数据：描述、WebUI URL、排序号（存为 config 注释）
- 备份管理：创建/删除/恢复（.tar.xz）
- 容器 WebUI 快捷打开（[IP] 替换）
- 网络接口列表、CPU 拓扑
- 设置持久化
- 动态统计（cpu_load, mem_usage, network rx/tx）
- 终端（WebSocket）
- 镜像缓存管理（列表/下载/删除/预热）

### 前端完整 UI
- 仪表盘（卡片统计 + 容器概览）
- 容器表格（状态徽标 + IP + 内存 + CPU + 动作按钮）
- 详情弹窗（信息/配置/快照/备份 四页签）
- 创建容器（模板/克隆/从快照/从备份 四种方式）
- 快照管理页
- 备份管理页
- 设置页（支持自定义模板缓存路径）

### 脚本
- lxc-autosnapshot：自动快照轮转脚本
- lxc-fetch：镜像下载 + 缓存管理脚本（新增）
- lxc-local：LXC 自定义本地模板脚本（新增）
