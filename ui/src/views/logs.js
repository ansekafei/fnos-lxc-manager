/* logs.js —— 服务日志页 */

import { getLogs } from '../api/system.js';
import { getState } from '../state.js';

let root = null;
let timer = null;

export function init(mountEl) { root = mountEl; }

export async function load() {
  if (!root) return;
  try {
    const text = await getLogs();
    root.innerHTML = `<pre class="logs-pre" style="background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:16px;font:12.5px/1.7 ui-monospace,Menlo,monospace;overflow:auto;max-height:calc(100vh - 130px);white-space:pre-wrap;word-break:break-all"></pre>`;
    const pre = root.querySelector('pre');
    pre.textContent = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
    pre.scrollTop = pre.scrollHeight;
  } catch (e) {
    root.innerHTML = `<div class="empty">${e.message}</div>`;
  }
  clearInterval(timer);
  // #4 修复：判断 getState().page 而非 document.contains（#page 容器永远在 DOM 里）
  timer = setInterval(() => {
    if (getState().page === 'logs') load();
    else clearInterval(timer);
  }, 10000);
}