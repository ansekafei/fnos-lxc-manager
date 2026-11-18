/* snapshots.js —— 快照：列表 / 创建 / 删除 / 回滚
 * 对应 docs/API.md §2.4。
 */
import { lxc, get, post, del } from './client.js';

const p = (name, rest = '') => lxc(`/${encodeURIComponent(name)}${rest}`);

/** GET .../snapshots */
export const listSnapshots = (name) => get(p(name, '/snapshots'));

/** POST .../snapshot —— {snapshot_name} */
export const createSnapshot = (name, snapshot_name) => post(p(name, '/snapshot'), { snapshot_name });

/** DELETE .../snapshot/{snap} */
export const deleteSnapshot = (name, snap) => del(p(name, `/snapshot/${encodeURIComponent(snap)}`));

/** POST .../snapshot/{snap}/restore */
export const restoreSnapshot = (name, snap) => post(p(name, `/snapshot/${encodeURIComponent(snap)}/restore`));
