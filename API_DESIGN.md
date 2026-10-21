# FnLxc API 设计 v2 — 对标 Unraid LXC Plugin

## 容器操作
| Method | Path | 功能 |
|--------|------|------|
| GET | /api/lxc/list | 列表（含动态统计） |
| GET | /api/lxc/{name} | 详情 |
| GET | /api/lxc/{name}/info | lxc-info 原始输出 |
| POST | /api/lxc/{name}/start | 启动 |
| POST | /api/lxc/{name}/stop | 停止 |
| POST | /api/lxc/{name}/restart | 重启 |
| POST | /api/lxc/{name}/freeze | 冻结 |
| POST | /api/lxc/{name}/unfreeze | 解冻 |
| DELETE | /api/lxc/{name} | 销毁 |
| POST | /api/lxc/{name}/kill | 强制停止 |
| GET | /api/lxc/{name}/config | 查看配置 |
| PUT | /api/lxc/{name}/config | 更新配置 |

## 创建/克隆
| Method | Path | 功能 |
|--------|------|------|
| POST | /api/lxc/create | 从模板创建 |
| POST | /api/lxc/create/copy | 克隆容器 |
| POST | /api/lxc/create/from-snapshot | 从快照创建 |
| POST | /api/lxc/create/from-backup | 从备份恢复为新容器 |

## 快照
| Method | Path | 功能 |
|--------|------|------|
| GET | /api/lxc/{name}/snapshots | 快照列表 |
| POST | /api/lxc/{name}/snapshot | 创建快照 |
| DELETE | /api/lxc/{name}/snapshot/{snap} | 删除快照 |
| POST | /api/lxc/{name}/snapshot/{snap}/restore | 恢复快照 |

## 备份
| Method | Path | 功能 |
|--------|------|------|
| GET | /api/lxc/{name}/backups | 备份列表 |
| POST | /api/lxc/{name}/backup | 创建备份 |
| DELETE | /api/lxc/{name}/backup/{backup} | 删除备份 |
| POST | /api/lxc/{name}/backup/{backup}/restore | 恢复备份 |
| GET | /api/backups/settings | 备份设置 |
| PUT | /api/backups/settings | 更新备份设置 |

## 元数据（写入容器 config 的注释中）
| Method | Path | 功能 |
|--------|------|------|
| PUT | /api/lxc/{name}/description | 设置描述 |
| DELETE | /api/lxc/{name}/description | 清空描述 |
| PUT | /api/lxc/{name}/webui | 设置 WebUI URL |
| DELETE | /api/lxc/{name}/webui | 清空 WebUI URL |
| PUT | /api/lxc/{name}/autostart | 设置自启 |
| PUT | /api/lxc/{name}/mac | 设置 MAC |
| PUT | /api/lxc/{name}/order | 设置排序号 |

## 系统
| Method | Path | 功能 |
|--------|------|------|
| GET | /api/templates | 可用模板 |
| GET | /api/interfaces | 网络接口 |
| GET | /api/cpus | CPU 拓扑 |
| GET | /api/stats | 系统统计 |
| GET | /api/settings | 设置读取 |
| PUT | /api/settings | 设置保存 |

## WebSocket
| Path | 功能 |
|------|------|
| /api/lxc/{name}/terminal | 终端（WebSocket） |
