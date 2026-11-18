/* backups.js —— 备份：列表 / 创建（后台+轮询）/ 删除 / 恢复（后台+轮询）/ 全局清单
 * 对应 docs/API.md §2.5。
 */
import { lxc, get, post, del } from './client.js';

const p = (name, rest = '') => lxc(`/${encodeURIComponent(name)}${rest}`);

/** GET .../backups —— 该容器备份文件列表 */
export const listBackups = (name) => get(p(name, '/backups'));

/** POST .../backup —— 后台打包，立即返回；进度走 backupProgress */
export const createBackup = (name) => post(p(name, '/backup'));

/** GET .../backup/progress —— {percent, message, done} */
export const backupProgress = (name) => get(p(name, '/backup/progress'));

/** DELETE .../backup/{file} */
export const deleteBackup = (name, file) => del(p(name, `/backup/${encodeURIComponent(file)}`));

/** POST .../backup/{file}/restore —— {newname}，202 后台任务 */
export const restoreBackup = (name, file, newname) =>
  post(p(name, `/backup/${encodeURIComponent(file)}/restore`), { newname });

/** GET .../restore/{file}/progress */
export const restoreProgress = (name, file) => get(p(name, `/restore/${encodeURIComponent(file)}/progress`));

/** GET /api/backups —— 全局备份清单，按容器分组 */
export const listAllBackups = () => get(lxc('/backups').replace('/api/lxc', '/api'));
