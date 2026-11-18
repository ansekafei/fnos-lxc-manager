/* modal.js —— 通用模态框：openModal({title, body, actions}) 返回 {close, el} */

let container = null;

function ensureContainer() {
  if (!container || !container.isConnected) {
    container = document.createElement('div');
    container.className = 'modal-root';
    document.body.appendChild(container);
  }
  return container;
}

/**
 * openModal({ title, body: string|Node, actions: [{label, cls, onClick(close)}], onClose })
 * 返回 {close, el}。点遮罩 / Esc 关闭。
 */
export function openModal({ title, body, actions = [], onClose }) {
  const root = ensureContainer();
  const el = document.createElement('div');
  el.className = 'modal-mask';
  el.innerHTML = `
    <div class="modal">
      <div class="modal-h"><b></b><button class="modal-x" aria-label="关闭">×</button></div>
      <div class="modal-b"></div>
      <div class="modal-f"></div>
    </div>`;
  el.querySelector('.modal-h b').textContent = title || '';
  const bodyEl = el.querySelector('.modal-b');
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else bodyEl.appendChild(body);
  const footEl = el.querySelector('.modal-f');

  const close = () => { el.remove(); onClose && onClose(); };
  el.querySelector('.modal-x').addEventListener('click', close);
  el.addEventListener('click', (e) => { if (e.target === el) close(); });
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  for (const a of actions) {
    const btn = document.createElement('button');
    btn.className = `btn ${a.cls || ''}`;
    btn.textContent = a.label;
    btn.addEventListener('click', () => a.onClick ? a.onClick(close) : close());
    footEl.appendChild(btn);
  }

  root.appendChild(el);
  return { close, el };
}

/* 样式（单例注入一次） */
if (!document.getElementById('modal-style')) {
  const s = document.createElement('style');
  s.id = 'modal-style';
  s.textContent = `
.modal-root .modal-mask{position:fixed;inset:0;background:rgba(15,23,42,.45);display:grid;place-items:center;z-index:100}
.modal{background:var(--panel);border-radius:var(--radius);width:min(560px,92vw);max-height:86vh;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(15,23,42,.2)}
.modal-h{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--line)}
.modal-x{border:0;background:none;font-size:20px;color:var(--sub);line-height:1}
.modal-b{padding:16px 18px;overflow:auto}
.modal-f{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid var(--line)}
.modal-f:empty{display:none}
`;
  document.head.appendChild(s);
}
