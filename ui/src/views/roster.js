/* roster.js —— 左侧容器列表。数据只从 state 读，选中写回 state */

import { getState, setState } from '../state.js';

let root = null;

export function init(mountEl) {
  root = mountEl;
  render();
}

export function render() {
  const { containers, selected } = getState();
  if (!root) return;
  root.innerHTML = '<h2></h2>';
  root.querySelector('h2').textContent = `容器（${containers.length}）`;

  if (!containers.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = '暂无容器，去「创建」页新建一个';
    root.appendChild(d);
    return;
  }

  for (const c of containers) {
    const running = (c.state || '').toLowerCase() === 'running';
    const el = document.createElement('div');
    el.className = `ct ${running ? 'run' : ''} ${(c.state || '').toLowerCase() === 'frozen' ? 'frozen' : ''} ${c.name === selected ? 'on' : ''}`;
    el.dataset.name = c.name; // 事件委托用，杜绝内联 onclick
    el.innerHTML = `
      <span class="st"></span>
      <div class="nm"><b></b><span></span></div>
      <div class="load"></div>`;
    el.querySelector('b').textContent = c.name;
    el.querySelector('.nm span').textContent = `${c.os || ''}${c.release ? ' ' + c.release : ''}`;
    el.querySelector('.load').innerHTML = running
      ? `CPU ${fmtPct(c.cpu_usage)}<br>MEM ${fmtMem(c.memory_used)}`
      : '—';
    root.appendChild(el);
  }
}

const fmtPct = (v) => (v == null ? '—' : `${Number(v).toFixed(1)}%`);
// #11 修复：删掉死参数 limit，简化函数签名
const fmtMem = (used) => {
  if (used == null) return '—';
  return `${Math.round(used / 1024 / 1024)}MB`;
};

/* 列表点击走事件委托（main.js 统一接管） */
export const onClickSelector = '.ct[data-name]';
