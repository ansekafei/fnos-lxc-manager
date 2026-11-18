/* field.js —— 表单字段构建工具。统一生成 label + 控件结构，避免各 view 手拼 HTML 转义 */

/** 创建字段容器：<div class="field"><label>..</label>控件</div> */
export function field(label, control, { hint } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const lab = document.createElement('label');
  lab.textContent = label;
  wrap.appendChild(lab);
  wrap.appendChild(control);
  if (hint) {
    const h = document.createElement('div');
    h.className = 'hint';
    h.style.cssText = 'font-size:12px;color:var(--sub);margin-top:4px';
    h.textContent = hint;
    wrap.appendChild(h);
  }
  return wrap;
}

/** input 控件 */
export function input({ value = '', type = 'text', placeholder = '' } = {}) {
  const el = document.createElement('input');
  el.type = type;
  el.value = value;
  el.placeholder = placeholder;
  return el;
}

/** select 控件。options: [{value, label}] 或字符串数组 */
export function select(options = [], value) {
  const el = document.createElement('select');
  for (const opt of options) {
    const o = typeof opt === 'string' ? { value: opt, label: opt } : opt;
    const oi = document.createElement('option');
    oi.value = o.value;
    oi.textContent = o.label;
    el.appendChild(oi);
  }
  if (value !== undefined) el.value = value;
  return el;
}

/** textarea 控件 */
export function textarea({ value = '', rows = 6 } = {}) {
  const el = document.createElement('textarea');
  el.rows = rows;
  el.value = value;
  el.style.cssText = 'resize:vertical';
  return el;
}
