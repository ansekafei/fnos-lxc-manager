/* config.js —— 容器配置 / 资源限制 / 元数据
 * 对应 docs/API.md §2.3。config 读取可能 423（locked），由 client.js 抛 ApiError.locked。
 */
import { lxc, get, put, del } from './client.js';

const p = (name, rest = '') => lxc(`/${encodeURIComponent(name)}${rest}`);

/** GET .../config —— 原始 config 行数组 ["lxc.xxx = yyy", …]，423 时抛 locked */
export const getConfig = (name) => get(p(name, '/config'));

/** PUT .../config —— {updates: {key: value}} */
export const updateConfig = (name, updates) => put(p(name, '/config'), { updates });

/** PUT .../limits —— {cpu, memory}；cpu 支持数字或 cpuset 形式，memory 单位 MB */
export const setLimits = (name, { cpu, memory }) => put(p(name, '/limits'), { cpu, memory });

/** PUT .../description —— {description} */
export const setDescription = (name, description) => put(p(name, '/description'), { description });

/** DELETE .../description */
export const deleteDescription = (name) => del(p(name, '/description'));

/** PUT .../autostart —— {autostart: bool} */
export const setAutostart = (name, autostart) => put(p(name, '/autostart'), { autostart });

/** PUT .../order —— {order: number} */
export const setOrder = (name, order) => put(p(name, '/order'), { order });

/** PUT .../mac —— {mac} */
export const setMac = (name, mac) => put(p(name, '/mac'), { mac });
