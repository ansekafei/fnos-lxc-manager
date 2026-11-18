/* toast.js —— 全局轻提示。监听 state.toast，也暴露 toast.show() */

import { subscribe } from '../state.js';

let container = null;

function ensureContainer() {
  if (!container || !container.isConnected) {
    container = document.createElement('div');
    container.className = 'toast-root';
    document.body.appendChild(container);
  }
  return container;
}

export function show(text, type = 'ok') {
  const root = ensureContainer();
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = text;
  root.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 3000);
}

/* 自动消费 state.toast（由 state.js 的 toastOk/toastErr 触发） */
subscribe((state, keys) => {
  if (keys.includes('toast') && state.toast) {
    show(state.toast.text, state.toast.type);
  }
});

if (!document.getElementById('toast-style')) {
  const s = document.createElement('style');
  s.id = 'toast-style';
  s.textContent = `
.toast-root{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:200;display:flex;flex-direction:column;gap:8px;align-items:center}
.toast{padding:9px 18px;border-radius:9px;font-size:13px;color:#fff;background:var(--ok);box-shadow:0 4px 14px rgba(15,23,42,.18);opacity:1;transition:opacity .3s}
.toast.err{background:var(--danger)}
.toast.out{opacity:0}
`;
  document.head.appendChild(s);
}
