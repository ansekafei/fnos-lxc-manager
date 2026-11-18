/* templates.js —— 官方模板 / 版本矩阵 / Proxmox 源 / 本地缓存 / 容器创建
 * 对应 docs/API.md §2.6、§2.7。
 * 注意：旧前端的 POST /api/lxc/cache/fetch 后端不存在（API.md §4.1），此处不再提供。
 */
import { lxc, sys, get, post } from './client.js';

/* ---- §2.7 模板源 ---- */

/** GET /api/lxc/templates —— 官方 distro 列表 */
export const listTemplates = () => get(lxc('/templates'));

/** GET /api/lxc/templates/{distro}/versions —— 版本/架构矩阵 */
export const listTemplateVersions = (distro) => get(lxc(`/templates/${encodeURIComponent(distro)}/versions`));

/** GET /api/templates/proxmox —— Proxmox 模板清单（联网） */
export const listProxmoxTemplates = () => get(sys('/templates/proxmox'));

/** POST /api/templates/proxmox/download —— {url, file} 下载到 cache_dir */
export const downloadProxmoxTemplate = (url, file) => post(sys('/templates/proxmox/download'), { url, file });

/** GET /api/templates/cached —— 本地缓存模板文件 */
export const listCachedTemplates = () => get(sys('/templates/cached'));

/* ---- §2.6 创建容器 ---- */

/** POST /api/lxc/create —— 官方模板创建 {name, template, release, arch} */
export const createFromTemplate = (payload) => post(lxc('/create'), payload);

/** POST /api/lxc/create/copy —— 子卷克隆 {name, source, network_type} */
export const createFromCopy = (payload) => post(lxc('/create/copy'), payload);

/** POST /api/lxc/create/from-snapshot —— {name, source, snapshot, network_type} */
export const createFromSnapshot = (payload) => post(lxc('/create/from-snapshot'), payload);

/** POST /api/lxc/create/from-backup —— {name, backup_name, network_type}，后台任务 */
export const createFromBackup = (payload) => post(lxc('/create/from-backup'), payload);

/** GET /api/lxc/create/{name}/progress —— 后台创建进度 */
export const createProgress = (name) => get(lxc(`/create/${encodeURIComponent(name)}/progress`));

/** POST /api/lxc/create/from-proxmox —— {name, template_file, autostart, unprivileged} */
export const createFromProxmox = (payload) => post(lxc('/create/from-proxmox'), payload);
