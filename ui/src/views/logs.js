/* logs.js —— 服务日志页 */

import { getLogs } from '../api/system.js';

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
  timer = setInterval(() => { if (document.contains(root)) load(); else clearInterval(timer); }, 10000);
}
