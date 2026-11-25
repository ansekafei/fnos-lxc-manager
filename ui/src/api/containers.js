/* containers.js —— 容器列表 / 信息 / 生命周期动作 / exec / 删除
 * 对应 docs/API.md §2.1、§2.2，函数与路由一一对应。
 */
import { lxc, get, post, put, del, terminalWs } from './client.js';

/** GET /api/lxc/list —— 全部容器 */
export const listContainers = () => get(lxc('/list'));

/** GET /api/lxc/{name} —— 单个容器（用于新建后轮询 IP） */
export const getContainer = (name) => get(lxc(`/${encodeURIComponent(name)}`));

/** GET /api/lxc/{name}/info —— 详细运行态 */
export const getContainerInfo = (name) => get(lxc(`/${encodeURIComponent(name)}/info`));

/** POST /api/lxc/{name}/{action} —— 通用动作入口（start/stop/restart/freeze/unfreeze/kill） */
export const containerAction = (name, action) => post(lxc(`/${encodeURIComponent(name)}/${action}`));

/** POST /api/lxc/{name}/exec —— 容器内执行命令，返回 {stdout,stderr,code} */
export const execCommand = (name, cmd) =>
  post(lxc(`/${encodeURIComponent(name)}/exec`), { cmd });

/** PUT /api/lxc/{name}/ip —— 设置静态 IPv4（address 留空 = 改回 DHCP） */
export const setStaticIp = (name, address, gateway = '') =>
  put(lxc(`/${encodeURIComponent(name)}/ip`), { address, gateway });

/** DELETE /api/lxc/{name}?force=true —— 删除容器 */
export const deleteContainer = (name, { force = false } = {}) =>
  del(lxc(`/${encodeURIComponent(name)}${force ? '?force=true' : ''}`));

/** WS /api/lxc/{name}/terminal —— 交互式终端 WebSocket */
export const openTerminalSocket = (name) => new WebSocket(terminalWs(name));
