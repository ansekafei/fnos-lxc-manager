/* terminal.js —— 容器交互式终端（WebSocket + xterm.js）
 * xterm.js 已 vendor 到 ui/vendor/，零构建直接引用。
 */

import { openTerminalSocket } from '../api/containers.js';

export function openTerminal(name, mount) {
  const wrap = document.createElement('div');
  wrap.className = 'term';
  wrap.innerHTML = `<div class="term-bar"><span>终端 · ${name}</span><button class="btn term-close">断开</button></div><div class="term-body"></div>`;
  mount.appendChild(wrap);
  const body = wrap.querySelector('.term-body');
  const closeBtn = wrap.querySelector('.term-close');

  let closed = false;
  let ws = null;
  let term = null;

  // 动态加载 xterm（如果还没加载）
  function ensureXterm() {
    return new Promise((resolve, reject) => {
      if (window.Terminal && window.FitAddon) return resolve();
      // 加载 CSS
      if (!document.querySelector('link[href*="xterm.css"]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = '/app/lxcmanager/vendor/xterm.css';
        document.head.appendChild(link);
      }
      // 加载 JS
      const s1 = document.createElement('script');
      s1.src = '/app/lxcmanager/vendor/xterm.min.js';
      s1.onload = () => {
        const s2 = document.createElement('script');
        s2.src = '/app/lxcmanager/vendor/xterm-addon-fit.min.js';
        s2.onload = () => resolve();
        s2.onerror = () => reject(new Error('xterm-addon-fit 加载失败'));
        document.head.appendChild(s2);
      };
      s1.onerror = () => reject(new Error('xterm 加载失败'));
      document.head.appendChild(s1);
    });
  }

  async function init() {
    try {
      await ensureXterm();
    } catch (e) {
      body.innerHTML = `<div style="padding:20px;color:#f87171">${e.message}</div>`;
      return;
    }

    term = new window.Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: 'block',
      theme: {
        background: '#0b1220',
        foreground: '#d7e3f4',
        cursor: '#7fb3ff',
        selection: 'rgba(127, 179, 255, 0.3)',
      },
    });

    const fitAddon = new window.FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(body);

    // 初始 fit + 窗口 resize 时 fit
    setTimeout(() => { try { fitAddon.fit(); } catch { /* ignore */ } }, 50);
    const resizeObserver = new ResizeObserver(() => {
      try { fitAddon.fit(); } catch { /* ignore */ }
    });
    resizeObserver.observe(body);

    term.writeln(`\x1b[1;32m── 正在连接 ${name} 的终端 ──\x1b[0m`);

    ws = openTerminalSocket(name);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      term.writeln(`\x1b[1;32m── 已连接 ──\x1b[0m\r\n`);
      // 发送终端大小
      try {
        const dims = fitAddon.proposeDimensions();
        if (dims) ws.send(JSON.stringify({ cols: dims.cols, rows: dims.rows }));
      } catch { /* ignore */ }
    };

    ws.onmessage = (e) => {
      if (closed || !term) return;
      if (e.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(e.data));
      } else {
        term.write(e.data);
      }
    };

    ws.onclose = () => {
      if (closed) return;
      term.writeln('\r\n\x1b[1;31m── 连接已断开 ──\x1b[0m');
    };

    ws.onerror = () => {
      term.writeln('\r\n\x1b[1;31m── 连接错误 ──\x1b[0m');
    };

    // 用户输入 → 发到 WS
    term.onData((data) => {
      if (!closed && ws?.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    // 终端大小变化 → 通知服务端
    term.onResize(({ cols, rows }) => {
      if (!closed && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ resize: [cols, rows] }));
      }
    });

    term.focus();
  }

  init();

  closeBtn.addEventListener('click', () => api.close());

  const api = {
    close() {
      closed = true;
      try { ws?.close(); } catch { /* ignore */ }
      try { term?.dispose(); } catch { /* ignore */ }
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
.term{display:flex;flex-direction:column;height:100%;background:#0b1220;border-radius:var(--radius);overflow:hidden}
.term-bar{display:flex;justify-content:space-between;align-items:center;padding:8px 14px;color:#cbd5e1;font-size:12.5px;background:#101a2c;flex-shrink:0}
.term-body{flex:1;min-height:400px;padding:8px}
.term-body .xterm{height:100%}
`;
  document.head.appendChild(s);
}