/* terminal.js —— 容器交互式终端（WebSocket + xterm 风格）
 * 零构建，不引外部库。字符级输入 + 输出缓冲渲染。
 */

import { openTerminalSocket } from '../api/containers.js';

export function openTerminal(name, mount) {
  const wrap = document.createElement('div');
  wrap.className = 'term';
  wrap.innerHTML = `<div class="term-bar"><span>终端 · ${name}</span><button class="btn term-close">断开</button></div><pre class="term-out" tabindex="0"></pre>`;
  mount.appendChild(wrap);
  const out = wrap.querySelector('.term-out');
  const closeBtn = wrap.querySelector('.term-close');

  let line = '';
  const history = [];
  let histIdx = -1;
  let closed = false;

  // 输出缓冲：服务端数据先存数组，再一次性渲染
  let buf = [];
  const MAX_BUF = 500; // 最多保留 500 行

  function flush() {
    // 移除旧的输入行（最后一个 .term-line）
    const prev = out.querySelector('.term-line:last-child');
    if (prev) prev.remove();

    // 追加缓冲的输出
    if (buf.length) {
      const text = buf.join('');
      // 按 \n 拆行，逐行 append
      const lines = text.split('\n');
      for (const l of lines) {
        if (l) {
          const div = document.createElement('div');
          div.textContent = l;
          out.appendChild(div);
        }
      }
      buf = [];
    }

    // 裁剪历史行
    while (out.children.length > MAX_BUF + 1) {
      out.removeChild(out.firstChild);
    }

    // 渲染输入行
    const lineDiv = document.createElement('div');
    lineDiv.className = 'term-line';
    lineDiv.innerHTML = `<span style="color:var(--sub)">$</span> ${esc(line)}<span class="cursor"> </span>`;
    out.appendChild(lineDiv);
    out.scrollTop = out.scrollHeight;
  }

  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  // 过滤 ANSI ESC 序列（颜色、光标移动等）
  function stripAnsi(s) {
    return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b[=>]/g, '');
  }

  const ws = openTerminalSocket(name);
  ws.onopen = () => {
    buf.push(`── 已连接 ${name} 的终端 ──\n`);
    flush();
    // 发送终端大小
    try {
      const cols = Math.floor(out.clientWidth / 8) || 80;
      const rows = Math.floor(out.clientHeight / 20) || 24;
      ws.send(JSON.stringify({ cols, rows }));
    } catch { /* ignore */ }
  };
  ws.onmessage = (e) => {
    if (closed) return;
    const data = typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data);
    buf.push(stripAnsi(data));
    flush();
  };
  ws.onclose = () => {
    if (closed) return;
    buf.push('\n── 连接已断开 ──\n');
    flush();
  };
  ws.onerror = () => {
    buf.push('\n── 连接错误 ──\n');
    flush();
  };

  out.addEventListener('keydown', (e) => {
    if (closed) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      history.push(line); histIdx = history.length;
      ws.send(line + '\n');
      buf.push(`$ ${line}\n`);
      line = ''; flush();
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      line = line.slice(0, -1); flush();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (histIdx > 0) { line = history[--histIdx]; flush(); }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      line = histIdx < history.length - 1 ? history[++histIdx] : ''; flush();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      ws.send('\t');
    } else if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      ws.send('\x03'); // Ctrl+C
    } else if (e.key === 'd' && e.ctrlKey) {
      e.preventDefault();
      ws.send('\x04'); // Ctrl+D
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      ws.send('\x0c'); // Ctrl+L
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      line += e.key; flush();
    }
  });

  closeBtn.addEventListener('click', () => api.close());
  setTimeout(() => out.focus(), 50);

  const api = {
    close() {
      closed = true;
      try { ws.close(); } catch { /* ignore */ }
      wrap.remove();
    },
    el: wrap,
  };
  return api;
}

if (!document.getElementById('term-style')) {
  const s = document.createElement('style');
  s.id = 'term-style';
  s.textContent = `
.term{background:#0b1220;border-radius:var(--radius);overflow:hidden;display:flex;flex-direction:column;height:100%}
.term-bar{display:flex;justify-content:space-between;align-items:center;padding:8px 14px;color:#cbd5e1;font-size:12.5px;background:#101a2c;flex-shrink:0}
.term-out{flex:1;padding:12px 14px;overflow:auto;color:#d7e3f4;font:12.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;outline:none;white-space:pre-wrap;word-break:break-all;min-height:300px}
.term-out div{min-height:1.6em}
.term .cursor{display:inline-block;width:7px;height:14px;background:#7fb3ff;vertical-align:-2px;animation:blink 1s step-start infinite}
@keyframes blink{50%{opacity:0}}
`;
  document.head.appendChild(s);
}