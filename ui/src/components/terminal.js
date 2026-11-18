/* terminal.js —— 容器交互式终端（WebSocket + xterm 风格简易实现）
 * 依赖 api/containers.js 的 openTerminalSocket。零构建，不引外部库：
 * 用 <pre> + 行缓冲实现可用的 shell 视图（方向键历史、Backspace）。
 */

import { openTerminalSocket } from '../api/containers.js';

/**
 * openTerminal(name, mountEl) 返回 {close}
 * 简易行编辑终端：本地回显，回车整行发送；服务端输出追加显示。
 */
export function openTerminal(name, mount) {
  const wrap = document.createElement('div');
  wrap.className = 'term';
  wrap.innerHTML = `<div class="term-bar">终端 · ${name} <button class="btn term-close">断开</button></div><pre class="term-out" tabindex="0"></pre>`;
  mount.appendChild(wrap);
  const out = wrap.querySelector('.term-out');

  let line = '';
  const history = [];
  let histIdx = -1;

  const render = () => {
    // 只重绘最后一行的输入区，历史输出不动
    const cursor = `<span class="cursor"> </span>`;
    out.innerHTML = out.dataset.buf + `<div class="term-line">` + esc(line) + cursor + `</div>`;
    out.scrollTop = out.scrollHeight;
  };
  const commitBuf = () => { out.dataset.buf = out.innerHTML; };
  out.dataset.buf = '';

  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  const ws = openTerminalSocket(name);
  ws.onopen = () => { out.textContent = `── 已连接 ${name} 的终端 ──\n`; };
  ws.onmessage = (e) => {
    commitBuf();
    out.dataset.buf += esc(String(e.data));
    render();
  };
  ws.onclose = () => { commitBuf(); out.dataset.buf += '\n── 连接已断开 ──\n'; render(); };

  out.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      history.push(line); histIdx = history.length;
      ws.send(line + '\n');
      commitBuf();
      out.dataset.buf += `<div class="term-line"><span style="color:var(--sub)">$</span> ${esc(line)}</div>`;
      line = ''; render();
    } else if (e.key === 'Backspace') {
      line = line.slice(0, -1); render();
    } else if (e.key === 'ArrowUp' && histIdx > 0) {
      line = history[--histIdx]; render();
    } else if (e.key === 'ArrowDown') {
      line = histIdx < history.length - 1 ? history[++histIdx] : ''; render();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      line += e.key; render();
    }
    if (e.key !== 'F5' && e.key !== 'F12') e.preventDefault();
  });

  wrap.querySelector('.term-close').addEventListener('click', () => api.close());
  setTimeout(() => out.focus(), 50);

  const api = {
    close() { try { ws.close(); } catch { /* ignore */ } wrap.remove(); },
    el: wrap,
  };
  return api;
}

if (!document.getElementById('term-style')) {
  const s = document.createElement('style');
  s.id = 'term-style';
  s.textContent = `
.term{background:#0b1220;border-radius:var(--radius);overflow:hidden}
.term-bar{display:flex;justify-content:space-between;align-items:center;padding:8px 14px;color:#cbd5e1;font-size:12.5px;background:#101a2c}
.term-out{padding:12px 14px;min-height:280px;max-height:60vh;overflow:auto;color:#d7e3f4;font:12.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;outline:none;white-space:pre-wrap;word-break:break-all}
.term .cursor{display:inline-block;width:7px;height:14px;background:#7fb3ff;vertical-align:-2px;animation:blink 1s step-start infinite}
@keyframes blink{50%{opacity:0}}
`;
  document.head.appendChild(s);
}
