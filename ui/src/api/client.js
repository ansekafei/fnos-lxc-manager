/* client.js —— fetch 封装：网关前缀、JSON、success:false 抛错、423 locked 识别
 * 契约见 docs/API.md 第 1 节。
 */

const PREFIX = '/app/lxcmanager';
/** lxc() 走 /api/lxc，sys() 走 /api */
export const lxc = (url) => `${PREFIX}/api/lxc${url}`;
export const sys = (url) => `${PREFIX}/api${url}`;

/** API 层统一错误。locked=true 表示 423 配置被运行期锁定 */
export class ApiError extends Error {
  constructor(message, { status, locked } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.locked = locked;
  }
}

async function request(url, options = {}) {
  let resp;
  try {
    resp = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
  } catch (e) {
    throw new ApiError(`网络请求失败：${e.message}`);
  }

  let body = null;
  try { body = await resp.json(); } catch { /* 非 JSON（如日志文本）走原文 */ }

  if (resp.status === 423) {
    throw new ApiError(body?.error || '配置被 LXC 运行期锁定，停止容器后可编辑', { status: 423, locked: true });
  }
  if (!resp.ok || body?.success === false) {
    throw new ApiError(body?.error || `请求失败（HTTP ${resp.status}）`, { status: resp.status });
  }
  // 文本接口（GET /api/logs）返回原文，其余返回 data 字段
  if (body && typeof body === 'object' && 'success' in body) return body.data;
  return body;
}

export const get = (url) => request(url);
export const post = (url, data) =>
  request(url, { method: 'POST', body: data === undefined ? undefined : JSON.stringify(data) });
export const put = (url, data) =>
  request(url, { method: 'PUT', body: JSON.stringify(data) });
export const del = (url) => request(url, { method: 'DELETE' });

/** 终端 WebSocket 地址（不走 lxc()，浏览器直连） */
export const terminalWs = (name) =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${lxc(`/${name}/terminal`)}`;
