/* detail/terminal.js —— 容器详情 · 终端 tab（xterm.js）
 * render(body) 挂载，destroy() 清理资源。
 * main.js 切 tab / 切容器时必须调 destroy()，否则 WS + PTY 进程泄漏。
 */

import { getState } from '../../state.js';
import { openTerminalSocket } from '../../api/containers.js';

// 模块级引用，供 destroy() 访问
let _ws = null;
let _term = null;
let _resizeObserver = null;
let _wrap = null;

export function render(body) {
  const { selected } = getState();
  if (!selected) { body.innerHTML = '<div class="empty">未选择容器</div>'; return; }

  // 先清理旧实例（防止重复挂载）
  destroy();

  const wrap = document.createElement('div');
  wrap.className = 'term';
  wrap.innerHTML = `<div class="term-bar"><span>终端 · ${selected}</span><button class="btn term-close">断开</button></div><div class="term-body"></div>`;
  body.appendChild(wrap);
  _wrap = wrap;
  const termBody = wrap.querySelector('.term-body');
  const closeBtn = wrap.querySelector('.term-close');

  function ensureXterm() {
    return new Promise((resolve, reject) => {
      if (window.Terminal && window.FitAddon) return resolve();
      if (!document.querySelector('link[href*="xterm.css"]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = '/app/lxcmanager/vendor/xterm.css';
        document.head.appendChild(link);
      }
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
    try { await ensureXterm(); } catch (e) {
      termBody.innerHTML = `<div style="padding:20px;color:#f87171">${e.message}</div>`;
      return;
    }

    _term = new window.Terminal({
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
    _term.loadAddon(fitAddon);
    _term.open(termBody);

    setTimeout(() => { try { fitAddon.fit(); } catch {} }, 50);
    _resizeObserver = new ResizeObserver(() => { try { fitAddon.fit(); } catch {} });
    _resizeObserver.observe(termBody);

    _term.writeln(`\x1b[1;32m── 正在连接 ${selected} 的终端 ──\x1b[0m`);

    _ws = openTerminalSocket(selected);
    _ws.binaryType = 'arraybuffer';

    _ws.onopen = () => {
      _term?.writeln(`\x1b[1;32m── 已连接 ──\x1b[0m\r\n`);
      try {
        const dims = fitAddon.proposeDimensions();
        if (dims) _ws?.send(JSON.stringify({ cols: dims.cols, rows: dims.rows }));
      } catch {}
    };

    _ws.onmessage = (e) => {
      if (!_term) return;
      if (e.data instanceof ArrayBuffer) _term.write(new Uint8Array(e.data));
      else _term.write(e.data);
    };

    _ws.onclose = () => { _term?.writeln('\r\n\x1b[1;31m── 连接已断开 ──\x1b[0m'); };
    _ws.onerror = () => { _term?.writeln('\r\n\x1b[1;31m── 连接错误 ──\x1b[0m'); };

    _term.onData((data) => { if (_ws?.readyState === WebSocket.OPEN) _ws.send(data); });
    _term.onResize(({ cols, rows }) => {
      if (_ws?.readyState === WebSocket.OPEN) _ws.send(JSON.stringify({ resize: [cols, rows] }));
    });

    _term.focus();
  }

  init();

  closeBtn.addEventListener('click', () => { destroy(); });
}

/** 销毁当前终端实例：关闭 WS、dispose xterm、disconnect ResizeObserver、移除 DOM */
export function destroy() {
  try { _ws?.close(); } catch {}
  _ws = null;
  try { _term?.dispose(); } catch {}
  _term = null;
  try { _resizeObserver?.disconnect(); } catch {}
  _resizeObserver = null;
  _wrap?.remove();
  _wrap = null;
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