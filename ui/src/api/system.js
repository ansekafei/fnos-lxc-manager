/* system.js —— 统计 / 版本 / 日志 / 首启 / 网卡 / CPU / 存储卷 / 设置
 * 对应 docs/API.md §2.1（stats/version/logs/first-run）与 §2.8。
 * 注意：/api/zfs/pools 名不符实，实际返回 btrfs 存储卷（API.md §4.4）。
 */
import { sys, get, put, del } from './client.js';

/** GET /api/stats —— {total, running, stopped, frozen, snapshots, backups, lxc_version, lxc_path} */
export const getStats = () => get(sys('/stats'));

/** GET /api/version —— {version} */
export const getVersion = () => get(sys('/version'));

/** GET /api/logs —— 服务日志文本（原文，非 {success,data} 包裹也兼容） */
export const getLogs = () => get(sys('/logs'));

/** GET /api/first-run —— {first_run: bool} */
export const getFirstRun = () => get(sys('/first-run'));

/** GET /api/interfaces —— 宿主网卡列表 */
export const listInterfaces = () => get(sys('/interfaces'));

/** GET /api/cpus —— 宿主 CPU 核心数 */
export const getCpus = () => get(sys('/cpus'));

/** GET /api/zfs/pools —— btrfs 存储卷列表（历史命名，勿改） */
export const listStoragePools = () => get(sys('/zfs/pools'));

/** GET /api/settings */
export const getSettings = () => get(sys('/settings'));

/** PUT /api/settings —— 任意设置字段 */
export const saveSettings = (fields) => put(sys('/settings'), fields);

/** DELETE /api/settings —— 恢复出厂 */
export const factoryReset = () => del(sys('/settings'));
